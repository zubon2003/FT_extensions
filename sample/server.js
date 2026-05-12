#!/usr/bin/env node
//
// FPVTrackside Extension receiver — INTERFACE.en.md v1.1.
// Hosts:
//   • PUT receiver for FPVTrackside events (Hello, RaceLoaded, DetectionExt …)
//   • Socket.IO broadcast to overlays (race_start countdown, announce_text)
//   • REST API consumed by overlays (/api/leaderboard, /api/heatresult …)
//   • VOICEVOX TTS, ATEM camera switching
//
'use strict';

const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server: IoServer } = require('socket.io');
const { performance } = require('perf_hooks');
const { SerialPort } = require('serialport');

const logger = require('./modules/core/logger.js');
const configStore = require('./modules/core/config-store.js');
const VoiceVoxHandler = require('./modules/core/voicevox-handler.js');
const voiceLogic = require('./modules/core/voice-logic.js');
const voiceTemplates = require('./modules/core/voice-templates.js');
const resultsStore = require('./modules/core/results-store.js');
const cameraSwitcher = require('./modules/camera_switcher');
const ledHandler = require('./modules/core/led-handler.js');

// --- Bootstrap config -------------------------------------------------------

let config = configStore.get();
ledHandler.reconfigure(config.led);
// ... (omitted port config) ...

// --- Real-time camera updates to UI when status actually changes ------------
cameraSwitcher.onStatusChange((status) => {
    if (typeof io !== 'undefined') {
        io.emit('camera_update', status);
    }
});
if (!config.extension || typeof config.extension.port !== 'number') {
    config.extension = config.extension || {};
    config.extension.port = 8765;
    configStore.replace(config);
}
const PORT = config.extension.port;
// Default to loopback only. Set extension.bindHost to "0.0.0.0" (or a specific
// interface IP) in config.json to expose the receiver to other machines on the
// LAN, e.g. when overlays run on a separate OBS PC.
const HOST = (config.extension && typeof config.extension.bindHost === 'string')
    ? config.extension.bindHost
    : '127.0.0.1';
if (HOST === '0.0.0.0') {
    logger.warn('[Bootstrap] bindHost=0.0.0.0 — receiver is reachable from the network. /api/config has no auth; restrict via firewall.');
}

// --- VOICEVOX & camera modules ---------------------------------------------

const vvHandler = new VoiceVoxHandler(config.voicevox || {});

if (config.camera_switcher && config.camera_switcher.enabled) {
    cameraSwitcher.init();
}

// --- HTTP server + Socket.IO -----------------------------------------------

const app = express();
const server = http.createServer(app);

// Socket.IO CORS: default to loopback origins. Set extension.allowAllOrigins=true
// in config.json when overlays load from another origin (e.g. LAN OBS PC).
function isOriginAllowed(origin) {
    if (!origin) return true;                      // same-origin or non-browser client
    if (config.extension?.allowAllOrigins) return true;
    try {
        const { hostname } = new URL(origin);
        return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
    } catch { return false; }
}
const io = new IoServer(server, {
    cors: { origin: (origin, cb) => cb(null, isOriginAllowed(origin)) },
});

app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Vendored assets served from node_modules (offline-friendly).
// Tailwind is in public/vendor/tailwind.js (served by the static mount above).
const NM = path.join(__dirname, 'node_modules');
app.use('/vendor/bootstrap',   express.static(path.join(NM, 'bootstrap', 'dist')));
app.use('/vendor/fontawesome', express.static(path.join(NM, '@fortawesome', 'fontawesome-free')));
app.use('/vendor/fonts/orbitron',      express.static(path.join(NM, '@fontsource', 'orbitron')));
app.use('/vendor/fonts/noto-sans-jp',  express.static(path.join(NM, '@fontsource', 'noto-sans-jp')));
app.use('/vendor/fonts/titillium-web', express.static(path.join(NM, '@fontsource', 'titillium-web')));
app.use('/vendor/fonts/roboto-mono',   express.static(path.join(NM, '@fontsource', 'roboto-mono')));
app.use('/vendor/fonts/audiowide',     express.static(path.join(NM, '@fontsource', 'audiowide')));

// PUT receiver — must ack BEFORE processing (§2.3).
const fpvtQueue = [];
let draining = false;
let lastSeq = 0;
let lastDetection = null;

// Bounded de-dup window. Detections that disappear from the window can be
// re-processed on a network retry; that's acceptable because de-dup is a
// defensive measure (the sender already filters duplicates per §10).
const SEEN_MAX = 10000;
const seenDetections = new Set();
const seenOrder = [];

function rememberDetection(id) {
    if (seenDetections.has(id)) return true;
    seenDetections.add(id);
    seenOrder.push(id);
    if (seenOrder.length > SEEN_MAX) {
        const evicted = seenOrder.shift();
        seenDetections.delete(evicted);
    }
    return false;
}

function clearSeenDetections() {
    seenDetections.clear();
    seenOrder.length = 0;
}

app.put('/', (req, res) => {
    res.status(200).end();
    enqueue(req.body);
});
app.put('/api/fpvtrackside/notification', (req, res) => {
    res.status(200).end();
    enqueue(req.body);
});

// Lenient: accept POST with the same shape (e.g. test clients / curl).
app.post('/api/fpvtrackside/notification', (req, res) => {
    res.status(200).end();
    enqueue(req.body);
});

// JSON parse failures from express.json end up here. Per spec §2.3 the sender
// expects an immediate 200 even when its payload is malformed — otherwise it
// retries and we get the same garbage again. Log and drop.
app.use((err, _req, res, next) => {
    if (err && err.type === 'entity.parse.failed') {
        logger.warn(`[PUT] JSON parse error: ${err.message}`);
        return res.status(200).end();
    }
    return next(err);
});

function enqueue(body) {
    // Minimal shape check. Anything without a string `type` cannot be
    // dispatched and would just waste a queue slot.
    if (!body || typeof body !== 'object' || typeof body.type !== 'string') {
        const preview = (() => { try { return JSON.stringify(body); } catch { return String(body); } })();
        logger.warn(`[PUT] dropped malformed body: ${preview.slice(0, 200)}`);
        return;
    }
    fpvtQueue.push(body);
    setImmediate(drainQueue);
}

function drainQueue() {
    if (draining) return;
    draining = true;
    try {
        while (fpvtQueue.length > 0) {
            const evt = fpvtQueue.shift();
            try {
                dispatch(evt);
            } catch (e) {
                logger.error(`[Dispatch] type=${evt?.type} ${e.message}`);
            }
        }
    } finally {
        draining = false;
    }
}

// --- Event dispatch --------------------------------------------------------

function announce(text) {
    io.emit('announce_text', { text });
    if (vvHandler.enabled) {
        vvHandler.enqueueText(text, (audioData) => {
            if (audioData) io.emit('play_audio', { data: audioData });
        });
    }
}

// Map a DetectionExt to a camera_switcher event.
// timingSystemIndex 0 is the Goal/Prime gate; the rest are splits in track
// order. Sector is the pilot's current position on the lap:
//   index 0 (Goal)  → sector = splitsPerLap (last sector of the lap)
//   index n (Split) → sector = n
// ATEM input number == sector. We also pass FPVTrackside's authoritative
// positionSnapshot so the switcher can resolve Auto/PosN modes without
// recomputing ranks. Each entry is enriched with cameraInput derived from
// raceSector (cumulative sector counter from the spec).
function detectionToCameraEvent(evt, seatIndex) {
    const tsys = configStore.get().fpvt?.timingSystem;
    const splitsPerLap = tsys?.splitsPerLap ?? 4;
    const logicalGate = evt.timingSystemIndex;
    const isGoalGate = (logicalGate === 0);

    if (isGoalGate && !evt.isLapEnd) {
        logger.warn(`[Detection] gate 0 (Goal) but isLapEnd=false (pilot=${evt.pilotName})`);
    } else if (!isGoalGate && evt.isLapEnd) {
        logger.warn(`[Detection] gate ${logicalGate} (Split) but isLapEnd=true (pilot=${evt.pilotName})`);
    }

    const sector = isGoalGate ? splitsPerLap : logicalGate;

    // raceSector encoding (per INTERFACE.md): lap × 100 + timingSystemIndex.
    // The "100" is a fixed multiplier in Core's RaceSectorCalculator (assumes
    // splitsPerLap ≤ 100), so the index portion is the raw timingSystemIndex
    // with Goal = 0 and splits = 1..(splitsPerLap-1). Map each timer to its
    // own ATEM input (TSI N → camera N+1), capped to splitsPerLap so a stale
    // or oversized index never points past the configured cameras.
    const camInputCap = Math.max(1, splitsPerLap);
    const snap = (evt.positionSnapshot || []).map(e => {
        const sIdx = e.raceSector % 100;
        const camInput = Math.min(sIdx, camInputCap - 1) + 1;

        return {
            pilotName: e.pilotName,
            position: e.position,
            raceSector: e.raceSector,
            lastDetectionTime: e.lastDetectionTime,
            cameraInput: camInput,
            seat: pilotSeatByName.get(e.pilotName),
        };
    });

    return {
        type: 'lap',
        seat: seatIndex,
        sector,
        isLapEnd: !!evt.isLapEnd,
        pilotName: evt.pilotName,
        raceFinishedForPilot: !!evt.raceFinishedForPilot,
        positionSnapshot: snap,
    };
}

const pilotSeatByName = new Map();    // current race only

function updateSeatMap(pilots) {
    if (!pilots || !Array.isArray(pilots)) return;
    // Rebuild fresh — stale entries from the previous race would mis-map seats
    // when pilot rosters change between heats.
    pilotSeatByName.clear();
    pilots.forEach((p, idx) => {
        // p might be PilotInfoExt or PilotResultEntry (with p.pilot)
        const pilot = p.pilot || p;
        if (pilot?.name) {
            pilotSeatByName.set(pilot.name, idx);
        }
    });
}

function dispatch(evt) {
    if (!evt || typeof evt !== 'object') return;

    if (typeof evt.seq === 'number') {
        if (evt.seq < lastSeq) {
            logger.warn(`[Seq] reset ${evt.seq} < ${lastSeq} — sender restart suspected`);
            clearSeenDetections();
        } else if (lastSeq !== 0 && evt.seq > lastSeq + 1) {
            logger.warn(`[Seq] gap expected ${lastSeq + 1} got ${evt.seq}`);
        }
        lastSeq = evt.seq;
    }

    switch (evt.type) {
        case 'Hello': {
            config = configStore.applyHello(evt);
            const tsys = evt.timingSystem || {};
            logger.info(`[Hello] v${evt.fpvtVersion} ${evt.platform} profile=${evt.profile?.name} timers=${tsys.count} sectorsPerLap=${tsys.splitsPerLap}`);
            break;
        }

        case 'RaceLoaded': {
            updateSeatMap(evt.pilots);
            voiceLogic.loadPilots(evt.pilots);
            voiceLogic.setRaceActive(false);
            resultsStore.onRaceLoaded(evt);
            cameraSwitcher.setRaceLapCount(evt.targetLaps || null);
            break;
        }

        case 'NextRace': {
            updateSeatMap(evt.pilots);
            resultsStore.onNextRace(evt);
            break;
        }

        case 'RacePreStart': {
            // Visual countdown only
            if (evt.scheduledStart) {
                const scheduledWallMs = new Date(evt.scheduledStart).getTime();
                const nowWallMs = Date.now();
                const nowMonotonic = performance.now() / 1000;
                const startMonotonic = nowMonotonic + (scheduledWallMs - nowWallMs) / 1000;
                io.emit('race_start', { startTime: startMonotonic });
                logger.info(`[RacePreStart] R${evt.round}.${evt.race} in ${((scheduledWallMs - nowWallMs)/1000).toFixed(2)}s`);
                
                // LED Countdown scheduling
                ledHandler.scheduleCountdown(scheduledWallMs);
            } else {
                logger.info(`[RacePreStart] R${evt.round}.${evt.race} (no scheduledStart)`);
            }
            // Trigger camera default on PreStart
            cameraSwitcher.triggerEvent({ type: 'race_start' });
            break;
        }

        case 'RaceStart': {
            voiceLogic.resetForRace();
            voiceLogic.setRaceActive(true);
            // We already switched to default in PreStart, but this ensures 
            // the state is ready for incoming detections.
            const seats = pilotSeatByName.size > 0
                ? Array.from(pilotSeatByName.values())
                : [];
            cameraSwitcher.triggerEvent({ type: 'race_start', args: seats });
            logger.info(`[RaceStart] R${evt.round}.${evt.race} t0=${evt.actualStart}`);
            break;
        }

        case 'RaceTimesUp': {
            logger.info(`[RaceTimesUp] R${evt.round}.${evt.race}`);
            break;
        }

        case 'RaceEnd':
        case 'RaceCancelled': {
            voiceLogic.setRaceActive(false);
            cameraSwitcher.triggerEvent({ type: 'race_end' });
            ledHandler.onRaceEnd();
            vvHandler.clearQueue();
            resultsStore.onRaceEnd(evt);
            const endKey = evt.type === 'RaceEnd'
                ? 'raceEnd'
                : (evt.failure ? 'raceFailed' : 'raceCancelled');
            const endText = voiceTemplates.render(endKey);
            if (endText) announce(endText);
            break;
        }

        case 'DetectionExt': {
            // §10: defensive de-dup even though sender filters.
            if (evt.detectionId && rememberDetection(evt.detectionId)) return;

            // Save for re-triggering on mode change
            if (evt.valid !== false) lastDetection = evt;

            // TTS for lap end (and finish).
            voiceLogic.onDetection(evt, announce);

            const seat = pilotSeatByName.get(evt.pilotName);

            // LED notification: Packet with RGB (Lap end only)
            if (seat !== undefined && evt.isLapEnd) {
                const c = evt.channel || {};
                ledHandler.onPilotPass(seat, c.colorR || 0, c.colorG || 0, c.colorB || 0);
            }

            // Camera switching: fire on every valid detection so manual modes
            // (Pos/Seat) update lastServerId for splits too.
            if (evt.valid !== false) {
                const camEvt = detectionToCameraEvent(evt, seat);

                if (camEvt) {
                    cameraSwitcher.triggerEvent(camEvt);
                } else {
                    const seatMapSize = pilotSeatByName.size;
                    logger.debug(`[Camera] camEvt is null. pilot="${evt.pilotName}", seat=${seat}, mapSize=${seatMapSize}`);
                    if (seatMapSize === 0) {
                        logger.warn(`[Camera] Seat map is empty! Reload the race in FPVTrackside.`);
                    }
                }
            } else {
                logger.debug(`[Camera] evt.valid is false for pilot=${evt.pilotName}`);
            }
            break;
        }

        case 'RaceResult': {
            updateSeatMap(evt.pilots);
            resultsStore.onRaceResult(evt);
            break;
        }

        case 'StageRanking': {
            resultsStore.onStageRanking(evt);
            break;
        }

        case 'PilotCrashedOut': {
            resultsStore.onPilotCrashed(evt);
            voiceLogic.onCrash(evt, announce);
            break;
        }

        case 'PilotRaceState': {
            updateSeatMap(evt.pilots);
            voiceLogic.loadPilots(evt.pilots);
            break;
        }

        default: {
            // §10: silently ignore unknown types.
            logger.debug(`[ignored] type=${evt?.type ?? '<missing>'}`);
        }
    }
}

// --- REST API --------------------------------------------------------------

app.get('/api/config', (_req, res) => {
    res.json(configStore.get());
});

app.post('/api/config', (req, res) => {
    try {
        const next = req.body;
        configStore.replace(next);
        config = configStore.get();

        // Update handlers
        ledHandler.reconfigure(config.led);

        // Re-trigger camera switching if we have a recent detection
        if (lastDetection) {
            const seat = pilotSeatByName.get(lastDetection.pilotName);
            const camEvt = detectionToCameraEvent(lastDetection, seat);
            if (camEvt) cameraSwitcher.triggerEvent(camEvt);
        }

        // Live-update VOICEVOX settings
        if (config.voicevox) {
            vvHandler.speaker = config.voicevox.speaker;
            vvHandler.volume = config.voicevox.volume;
            vvHandler.enabled = !!config.voicevox.enabled;
            vvHandler.playOnServer = !!config.voicevox.play_on_server;
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/status', (_req, res) => {
    res.json({
        camera: cameraSwitcher.getStatus(),
        fpvt: configStore.get().fpvt || null,
    });
});

app.post('/api/camera/switch', express.json(), (req, res) => {
    const { cameraInput } = req.body;
    if (cameraInput) {
        cameraSwitcher.triggerEvent({ type: 'manual_switch', cameraInput });
        res.json({ success: true, cameraInput });
    } else {
        res.status(400).json({ error: 'Missing cameraInput' });
    }
});

app.get('/api/leaderboard', (_req, res) => {
    res.json(resultsStore.snapshot());
});

app.get('/api/heatresult', (_req, res) => {
    const snap = resultsStore.snapshot();
    res.json({
        heatName: snap.latestHeatName,
        pilots: snap.latestHeatPilots,
    });
});

app.get('/api/nextheat', (_req, res) => {
    const snap = resultsStore.snapshot();
    res.json({
        heatName: snap.nextHeatName,
        pilots: snap.nextHeatPilots,
    });
});

app.get('/api/test_voice', async (req, res) => {
    const text = (req.query.text || '接続テストです。この声で読み上げを行います。').toString();
    if (!vvHandler.enabled) return res.status(400).json({ error: 'VOICEVOX disabled' });
    try {
        announce(text);
        res.json({ success: true, text });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/serial_ports', async (req, res) => {
    try {
        const ports = await SerialPort.list();
        res.json(ports);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/pilot_image', (req, res) => {
    const rel = (req.query.path || '').toString();
    if (!rel) return res.status(400).send('Path required');

    // Reject anything that could escape the pilots root before resolving.
    // Absolute paths and parent-traversal segments are not legitimate inputs
    // — Core only ever sends paths relative to the event working directory.
    if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) {
        logger.warn(`[Media] Rejected suspicious path: "${rel}"`);
        return res.status(403).send('Forbidden');
    }

    const wd = configStore.workingDirectory();
    if (!wd) {
        logger.warn('[Media] No working directory configured (Hello not received yet)');
        return res.status(404).send('Not found');
    }

    const allowedRoot = path.resolve(wd, 'pilots');
    const requested = path.resolve(allowedRoot, rel);
    // After resolution, verify we are still scoped under allowedRoot.
    // The trailing separator on allowedRoot prevents "pilotsX/..." aliasing.
    if (requested !== allowedRoot && !requested.startsWith(allowedRoot + path.sep)) {
        logger.warn(`[Media] Rejected out-of-root path: "${requested}"`);
        return res.status(403).send('Forbidden');
    }

    if (!fs.existsSync(requested)) {
        logger.warn(`[Media] File not found: "${requested}" (requested: "${rel}")`);
        return res.status(404).send('Not found');
    }

    return res.sendFile(requested);
});

// HTML routing: /html/<category>[/<variant>]
//   default    → public/html/<dir>/<base>.html
//   variant=k  → public/html/<dir>/<base><K>.html  (e.g. f1 → leaderboardF1.html)
const HTML_CATEGORIES = {
    overlay:     { dir: 'overlay',     base: 'obsOverlay' },
    leaderboard: { dir: 'leaderboard', base: 'leaderboard' },
    heatresult:  { dir: 'heatresult',  base: 'heatResult' },
    nextheat:    { dir: 'nextheat',    base: 'nextHeat' },
};

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'html', 'index.html')));

app.get('/html/:category/:variant?', (req, res, next) => {
    const meta = HTML_CATEGORIES[req.params.category];
    if (!meta) return next();
    const { dir, base } = meta;
    const v = req.params.variant;
    const filename = v
        ? `${base}${v.charAt(0).toUpperCase()}${v.slice(1)}.html`
        : `${base}.html`;
    const filePath = path.join(__dirname, 'public', 'html', dir, filename);
    if (fs.existsSync(filePath)) return res.sendFile(filePath);
    next();
});

// --- Socket.IO clock sync (used by obs_overlay) ----------------------------

io.on('connection', (socket) => {
    logger.debug(`[io] connected ${socket.id}`);
    // Browser sends ts_server_time → return monotonic seconds for offset calc.
    socket.on('ts_server_time', (cb) => {
        if (cb) cb(performance.now() / 1000);
    });
    socket.on('disconnect', () => logger.debug(`[io] disconnect ${socket.id}`));
});

// --- Lifecycle --------------------------------------------------------------

server.keepAliveTimeout = 360000;
server.headersTimeout = 361000;

server.listen(PORT, HOST, () => {
    console.log('────────────────────────────────────────────────────────────');
    console.log(' tvpas-integrated v2 — FPVTrackside Extension receiver');
    console.log(`  PUT      : http://127.0.0.1:${PORT}/  (NotificationURL)`);
    console.log(`  Web UI   : http://127.0.0.1:${PORT}/`);
    console.log(`  Overlay  : http://127.0.0.1:${PORT}/html/overlay`);
    console.log(`  Next     : http://127.0.0.1:${PORT}/html/nextheat`);
    console.log(`  Result   : http://127.0.0.1:${PORT}/html/heatresult`);
    console.log(`  Ranking  : http://127.0.0.1:${PORT}/html/leaderboard`);
    console.log(`  Ranking2 : http://127.0.0.1:${PORT}/html/leaderboard/f1`);
    console.log('────────────────────────────────────────────────────────────');
});

let shuttingDown = false;
function shutdown(sig) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${sig} received — shutting down`);

    // Release external resources before exiting so a re-launch doesn't trip
    // over a busy COM port or a half-open ATEM TCP connection.
    try { ledHandler.shutdown(); } catch (e) { logger.warn(`[LED] shutdown error: ${e.message}`); }
    Promise.resolve(cameraSwitcher.shutdown())
        .catch(e => logger.warn(`[Camera] shutdown error: ${e.message}`));
    try { vvHandler.clearQueue(); } catch (_e) { /* best-effort */ }

    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
