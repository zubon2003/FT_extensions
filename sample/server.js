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

// --- Bootstrap config -------------------------------------------------------

let config = configStore.get();

// Ensure a port exists in the persisted config before we read it below.
if (!config.extension || typeof config.extension.port !== 'number') {
    config.extension = config.extension || {};
    config.extension.port = DEFAULT_EXTENSION_PORT;
    configStore.replace(config);
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

const vvHandler = new VoiceVoxHandler(config.voicevox || {});

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
    io, ledHandler, cameraSwitcher, vvHandler,
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
        router.announce(text);
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

server.keepAliveTimeout = KEEPALIVE_TIMEOUT_MS;
server.headersTimeout = HEADERS_TIMEOUT_MS;

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
    setTimeout(() => process.exit(0), SHUTDOWN_FORCE_EXIT_MS).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
