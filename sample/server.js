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
const GoogleTtsHandler = require('./modules/core/google-tts-handler.js');
const voiceLogic = require('./modules/core/voice-logic.js');
const voiceTemplates = require('./modules/core/voice-templates.js');
const resultsStore = require('./modules/core/results-store.js');
const cameraSwitcher = require('./modules/camera_switcher');
const ledHandler = require('./modules/core/led-handler.js');
const { createRouter } = require('./modules/core/event-router.js');

// --- Tunables ---------------------------------------------------------------

const DEFAULT_EXTENSION_PORT = 8765;
const DEFAULT_BIND_HOST = '127.0.0.1';
const REQUEST_BODY_LIMIT = '4mb';
// keepAlive ≥ Hello-Heartbeat interval so the sender's persistent connection
// is never closed under us between events; headers is +1s as Node requires.
const KEEPALIVE_TIMEOUT_MS = 360_000;
const HEADERS_TIMEOUT_MS   = 361_000;
const SHUTDOWN_FORCE_EXIT_MS = 2000;

// Out-of-box defaults. Used to seed config.json on first run (or after the
// user deletes it). Module-level DEFAULTS inside each handler still apply at
// runtime, but persisting these here keeps the on-disk config readable and
// makes the Web UI show real values instead of empty fields.
const DEFAULT_CONFIG = {
    extension: {
        port: DEFAULT_EXTENSION_PORT,
    },
    led: {
        enabled: false,
        port: '',
        compensation_ms: 0,
        brightness: 64,
        race_rainbow: false,
        countdown_start: false,
        lap_indicator: false,
    },
    camera_switcher: {
        switching_mode: 'Auto',
        atem_ip: '192.168.10.240',
        default_camera: 4,
        atem_enabled: false,
    },
    tts: {
        // 'voicevox' or 'google'. Picks which TTS backend handles
        // race announcements and the Test Voice button.
        engine: 'google',
        // Filename in the working directory that supplies the phrase
        // templates (e.g. voice_jp.json, voice_en.json). Empty string or
        // missing falls back to voice.json.
        voiceFile: 'voice_en.json',
    },
    voicevox: {
        url: 'http://localhost:50021',
        speaker: 3,
        volume: 2.7,
        speed: 1.2,
        audio_delay_ms: 0,
        enabled: false,
    },
    google_tts: {
        // Operator must paste their own key in the Web UI — never commit one.
        apiKey: '',
        languageCode: 'en-US',
        voiceName: 'en-US-Neural2-A',
        speakingRate: 1,
        pitch: 0,
        volumeGainDb: 0,
        audioEncoding: 'MP3',
        audio_delay_ms: 0,
        enabled: false,
    },
};

// Fill missing keys recursively. Returns true if anything was added. Existing
// user values — including explicit `false`, `0`, `""`, `null` — are left as-is;
// only keys absent from `target` get pulled from `defaults`.
function fillMissing(target, defaults) {
    let changed = false;
    for (const k of Object.keys(defaults)) {
        const dv = defaults[k];
        const isPlainObj = dv !== null && typeof dv === 'object' && !Array.isArray(dv);
        if (!(k in target)) {
            target[k] = isPlainObj ? { ...dv } : dv;
            changed = true;
        } else if (isPlainObj) {
            if (target[k] === null || typeof target[k] !== 'object' || Array.isArray(target[k])) {
                target[k] = { ...dv };
                changed = true;
            } else if (fillMissing(target[k], dv)) {
                changed = true;
            }
        }
    }
    return changed;
}

// --- Bootstrap config -------------------------------------------------------

let config = configStore.get();

if (fillMissing(config, DEFAULT_CONFIG)) {
    configStore.replace(config);
    logger.info('[Bootstrap] config.json seeded with defaults for missing keys');
}
const PORT = config.extension.port;
// Default to loopback only. Set extension.bindHost to "0.0.0.0" (or a specific
// interface IP) in config.json to expose the receiver to other machines on the
// LAN, e.g. when overlays run on a separate OBS PC.
const HOST = (config.extension && typeof config.extension.bindHost === 'string')
    ? config.extension.bindHost
    : DEFAULT_BIND_HOST;
if (HOST === '0.0.0.0') {
    logger.warn('[Bootstrap] bindHost=0.0.0.0 — receiver is reachable from the network. /api/config has no auth; restrict via firewall.');
}

// --- HTTP server + Socket.IO -----------------------------------------------
// Constructed before any module callback that might want to emit on `io`, so
// the `typeof io !== 'undefined'` guard is no longer needed.

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

// --- LED + camera + VOICEVOX modules ---------------------------------------
// Wired AFTER `io` exists so onStatusChange can emit immediately and safely.

ledHandler.reconfigure(config.led);

cameraSwitcher.onStatusChange((status) => {
    io.emit('camera_update', status);
});

// Engine selector — only the active backend is instantiated, but we hang both
// configs off the handler so the Web UI can edit either pane without churn.
function createTtsHandler(cfg) {
    const engine = cfg.tts?.engine === 'google' ? 'google' : 'voicevox';
    if (engine === 'google') {
        return { engine, handler: new GoogleTtsHandler(cfg.google_tts || {}) };
    }
    return { engine, handler: new VoiceVoxHandler(cfg.voicevox || {}) };
}

let { engine: ttsEngine, handler: ttsHandler } = createTtsHandler(config);
logger.info(`[Bootstrap] TTS engine = ${ttsEngine}`);

// Honour the persisted voiceFile selection if it points at an existing file;
// otherwise stay on whatever voice-templates loaded by default (voice.json).
if (config.tts?.voiceFile && config.tts.voiceFile !== voiceTemplates.currentFileName()) {
    if (!voiceTemplates.setFile(config.tts.voiceFile)) {
        // Persist the resolved (fallback) file so the Web UI reflects reality.
        config.tts.voiceFile = voiceTemplates.currentFileName();
        configStore.replace(config);
    }
}

if (config.camera_switcher && config.camera_switcher.enabled) {
    cameraSwitcher.init();
}

app.use(express.json({ limit: REQUEST_BODY_LIMIT }));
app.use(express.static(path.join(__dirname, 'public')));

// Vendored assets served from node_modules (offline-friendly).
// Tailwind is in public/vendor/tailwind.js (served by the static mount above).
const NM = path.join(__dirname, 'node_modules');
const VENDOR_MOUNTS = [
    { url: '/vendor/bootstrap',        src: ['bootstrap', 'dist'] },
    { url: '/vendor/fontawesome',      src: ['@fortawesome', 'fontawesome-free'] },
    { url: '/vendor/fonts/orbitron',       src: ['@fontsource', 'orbitron'] },
    { url: '/vendor/fonts/noto-sans-jp',   src: ['@fontsource', 'noto-sans-jp'] },
    { url: '/vendor/fonts/titillium-web',  src: ['@fontsource', 'titillium-web'] },
    { url: '/vendor/fonts/roboto-mono',    src: ['@fontsource', 'roboto-mono'] },
    { url: '/vendor/fonts/audiowide',      src: ['@fontsource', 'audiowide'] },
];
for (const m of VENDOR_MOUNTS) {
    app.use(m.url, express.static(path.join(NM, ...m.src)));
}

// Event router holds per-stream state (seat map, seq, dedup, last detection)
// and the type→handler dictionary. server.js stays thin: HTTP + bootstrap.
const router = createRouter({
    io, ledHandler, cameraSwitcher,
    ttsHandler: () => ttsHandler,
    voiceLogic, voiceTemplates, resultsStore,
    configStore, logger,
});

// PUT receiver — must ack BEFORE processing (§2.3).
const fpvtQueue = [];
let draining = false;

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
                router.dispatch(evt);
            } catch (e) {
                logger.error(`[Dispatch] type=${evt?.type} ${e.stack || e.message}`);
            }
        }
    } finally {
        draining = false;
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

        // Re-trigger camera switching if we have a recent detection so a
        // mode change (Auto/PosN/SeatN) takes effect without waiting for the
        // next lap.
        const lastDetection = router.getLastDetection();
        if (lastDetection) {
            const seat = router.getSeat(lastDetection.pilotName);
            const camEvt = router.mapDetectionToCameraEvent(lastDetection, seat);
            if (camEvt) cameraSwitcher.triggerEvent(camEvt);
        }

        // Live-switch the voice template file if the operator picked a
        // different one. Templates are reloaded; failures fall back to the
        // previous file so announcements never go silent.
        if (config.tts?.voiceFile && config.tts.voiceFile !== voiceTemplates.currentFileName()) {
            if (!voiceTemplates.setFile(config.tts.voiceFile)) {
                config.tts.voiceFile = voiceTemplates.currentFileName();
            }
        }

        // TTS engine swap — if the operator flipped engines, drop the old
        // handler's queue and instantiate the new one. Otherwise live-update
        // settings on the existing handler so the next announcement uses them.
        const desiredEngine = config.tts?.engine === 'google' ? 'google' : 'voicevox';
        if (desiredEngine !== ttsEngine) {
            try { ttsHandler.clearQueue(); } catch (_e) { /* best-effort */ }
            ({ engine: ttsEngine, handler: ttsHandler } = createTtsHandler(config));
            logger.info(`[Config] TTS engine switched to ${ttsEngine}`);
        } else if (ttsEngine === 'voicevox' && config.voicevox) {
            // Skip null/undefined speaker — assigning it would send
            // `speaker=null` to VOICEVOX (HTTP 422, silent no-audio).
            if (config.voicevox.speaker != null) {
                ttsHandler.speaker = config.voicevox.speaker;
            }
            ttsHandler.volume = config.voicevox.volume;
            ttsHandler.enabled = !!config.voicevox.enabled;
            if (typeof config.voicevox.url === 'string' && config.voicevox.url) {
                ttsHandler.url = config.voicevox.url;
            }
            if (typeof config.voicevox.speed === 'number') {
                ttsHandler.speed = config.voicevox.speed;
            }
        } else if (ttsEngine === 'google' && config.google_tts) {
            const g = config.google_tts;
            ttsHandler.enabled = !!g.enabled;
            if (typeof g.apiKey === 'string') ttsHandler.apiKey = g.apiKey;
            if (typeof g.languageCode === 'string' && g.languageCode) ttsHandler.languageCode = g.languageCode;
            if (typeof g.voiceName === 'string' && g.voiceName) ttsHandler.voiceName = g.voiceName;
            if (typeof g.speakingRate === 'number') ttsHandler.speakingRate = g.speakingRate;
            if (typeof g.pitch === 'number') ttsHandler.pitch = g.pitch;
            if (typeof g.volumeGainDb === 'number') ttsHandler.volumeGainDb = g.volumeGainDb;
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

// Server-side proxy for VOICEVOX /speakers. The browser can't fetch
// http://localhost:50021/speakers directly because VOICEVOX doesn't send CORS
// headers by default. `?url=` lets the Web UI preview a not-yet-saved URL.
app.get('/api/voicevox/speakers', async (req, res) => {
    const fallbackUrl = (ttsEngine === 'voicevox' && ttsHandler.url)
        ? ttsHandler.url
        : (config.voicevox?.url || 'http://localhost:50021');
    const target = (typeof req.query.url === 'string' && req.query.url)
        ? req.query.url
        : fallbackUrl;
    try {
        const r = await fetch(`${target.replace(/\/+$/, '')}/speakers`);
        if (!r.ok) {
            res.status(r.status).json({ error: `VOICEVOX HTTP ${r.status}` });
            return;
        }
        res.json(await r.json());
    } catch (e) {
        res.status(502).json({ error: e.message });
    }
});

// Lists voice*.json files in the working directory and reports which one is
// currently active. The Web UI uses this to populate the file-picker so the
// operator can swap phrasing (language, tone, …) without restarting.
app.get('/api/voice_files', (_req, res) => {
    res.json({
        files: voiceTemplates.listAvailable(),
        current: voiceTemplates.currentFileName(),
    });
});

// Aggregates the unique language codes exposed by Google's voice catalogue.
// Same auth surface as /api/google_tts/voices (server-held key, optional
// `?apiKey=` preview) so the Web UI can pick a language before saving.
app.get('/api/google_tts/languages', async (req, res) => {
    const apiKey = (typeof req.query.apiKey === 'string' && req.query.apiKey)
        ? req.query.apiKey
        : (ttsEngine === 'google' ? ttsHandler.apiKey : config.google_tts?.apiKey);
    if (!apiKey) {
        res.status(400).json({ error: 'Google TTS apiKey is not configured' });
        return;
    }
    try {
        const r = await fetch(`https://texttospeech.googleapis.com/v1/voices?key=${encodeURIComponent(apiKey)}`);
        if (!r.ok) {
            const errText = await r.text().catch(() => '');
            res.status(r.status).json({ error: `Google TTS HTTP ${r.status}: ${errText.slice(0, 300)}` });
            return;
        }
        const data = await r.json();
        const set = new Set();
        for (const v of (data.voices || [])) {
            for (const lc of (v.languageCodes || [])) set.add(lc);
        }
        res.json([...set].sort());
    } catch (e) {
        res.status(502).json({ error: e.message });
    }
});

// Server-side proxy for Google Cloud TTS /v1/voices. Keeps the API key on the
// server (the browser only sees the resulting voice list). `?apiKey=` lets the
// Web UI preview a not-yet-saved key; `?lang=` filters by language code.
app.get('/api/google_tts/voices', async (req, res) => {
    const apiKey = (typeof req.query.apiKey === 'string' && req.query.apiKey)
        ? req.query.apiKey
        : (ttsEngine === 'google' ? ttsHandler.apiKey : config.google_tts?.apiKey);
    if (!apiKey) {
        res.status(400).json({ error: 'Google TTS apiKey is not configured' });
        return;
    }
    const params = new URLSearchParams({ key: apiKey });
    if (typeof req.query.lang === 'string' && req.query.lang) {
        params.set('languageCode', req.query.lang);
    }
    try {
        const r = await fetch(`https://texttospeech.googleapis.com/v1/voices?${params.toString()}`);
        if (!r.ok) {
            const errText = await r.text().catch(() => '');
            res.status(r.status).json({ error: `Google TTS HTTP ${r.status}: ${errText.slice(0, 300)}` });
            return;
        }
        const data = await r.json();
        res.json(data.voices || []);
    } catch (e) {
        res.status(502).json({ error: e.message });
    }
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
    // English default for Google TTS / sample_en; VOICEVOX falls back to it too.
    const defaultText = ttsEngine === 'google'
        ? 'This is a connection test. Race announcements will sound like this.'
        : '接続テストです。この声で読み上げを行います。';
    const text = (req.query.text || defaultText).toString();
    try {
        // Always play through the server-side OS player (PowerShell / afplay /
        // ffplay), independent of `enabled`. The browser-side socket path is
        // not used here — Test Voice is for the operator at the receiver
        // machine.
        await ttsHandler.speakOnServer(text);
        res.json({ success: true, text, engine: ttsEngine });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Operator-facing LED test cues fired from the web settings page.
// kind=rainbow → persistent rainbow base; R/G/B/Y → single pilot-pass flash.
const LED_TEST_COLORS = {
    R: [255, 0, 0],
    G: [0, 255, 0],
    B: [0, 0, 255],
    Y: [255, 255, 0],
};
app.get('/api/led_test', (req, res) => {
    const kind = (req.query.kind || '').toString();
    if (kind === 'rainbow') {
        ledHandler.testRainbow();
    } else if (LED_TEST_COLORS[kind]) {
        const [r, g, b] = LED_TEST_COLORS[kind];
        ledHandler.testColor(kind, r, g, b);
    } else {
        return res.status(400).json({ error: `unknown kind: ${kind}` });
    }
    res.json({ success: true, kind });
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

server.keepAliveTimeout = KEEPALIVE_TIMEOUT_MS;
server.headersTimeout = HEADERS_TIMEOUT_MS;

server.listen(PORT, HOST, () => {
    console.log('────────────────────────────────────────────────────────────');
    console.log(' FPVTrackside Extension Sample — receiver');
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
    try { ttsHandler.clearQueue(); } catch (_e) { /* best-effort */ }

    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), SHUTDOWN_FORCE_EXIT_MS).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
