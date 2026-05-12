const {
    resetForRace,
    markFinished,
    isFinished,
    setRaceState,
    getRaceStatus,
} = require('./data-utils');
const { Atem } = require('atem-connection');
const { getConfig } = require('./config');
const logger = require('../../core/logger.js');

// ATEM tunables. The switch is a real-time device; 3s is generous for a LAN
// hop. Reconnect with exponential backoff so an unreachable switcher doesn't
// busy-loop reconnection attempts in the ATEM library.
const ATEM_CMD_TIMEOUT_MS = 3000;
const ATEM_RECONNECT_INITIAL_MS = 500;
const ATEM_RECONNECT_MAX_MS = 30_000;

let atem = null;
let atemState = { program: 0, preview: 0 };
let reconnectDelayMs = ATEM_RECONNECT_INITIAL_MS;
let reconnectTimer = null;

function withTimeout(promise, ms) {
    const timeout = new Promise((_, reject) => {
        const id = setTimeout(() => {
            clearTimeout(id);
            reject(new Error(`Operation timed out after ${ms} ms`));
        }, ms);
    });
    return Promise.race([promise, timeout]);
}

function dummySwitchCamera(cameraInput, updateCacheCallback) {
    if (atemState.program !== cameraInput) {
        atemState.program = cameraInput;
        updateCacheCallback({ atem: atemState });
    }
}

async function ensureAtemConnection(updateCacheCallback, atem_ip, default_camera) {
    if (atem) return;
    logger.info('[ATEM] ATEM is enabled. Initializing connection...');
    atem = new Atem();
    atem.connect(atem_ip);
    atem.on('connected', async () => {
        logger.info('[ATEM] Connected to ATEM switcher.');
        reconnectDelayMs = ATEM_RECONNECT_INITIAL_MS;       // reset backoff
        if (atem.state?.video?.ME?.[0]) {
            atemState.program = atem.state.video.ME[0].programInput;
            atemState.preview = atem.state.video.ME[0].previewInput;
        }
        if (default_camera) {
            try {
                logger.info(`[ATEM] Switching to default camera ${default_camera} on connection.`);
                await withTimeout(atem.changeProgramInput(default_camera), ATEM_CMD_TIMEOUT_MS);
            } catch (e) {
                logger.error(`[ATEM] Error switching to default camera on connection: ${e.message || e}`);
            }
        }
    });
    atem.on('disconnected', () => {
        if (!atem) return;                                   // shutdown already nulled it
        if (reconnectTimer) clearTimeout(reconnectTimer);
        logger.warn(`[ATEM] Disconnected. Reconnecting in ${reconnectDelayMs}ms…`);
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            if (atem) atem.connect(atem_ip);
        }, reconnectDelayMs);
        reconnectDelayMs = Math.min(reconnectDelayMs * 2, ATEM_RECONNECT_MAX_MS);
    });
    atem.on('error', (e) => {
        // Only log meaningful errors to avoid cluttering
        if (e.message && e.message.includes('ECONNREFUSED')) {
            logger.error(`[ATEM] Connection refused. Is the ATEM IP (${atem_ip}) correct and reachable?`);
        } else {
            logger.error(`[ATEM] Error: ${e.message || e}`);
        }
    });
    atem.on('stateChanged', (state) => {
        if (state.video?.ME?.[0]) {
            const programInput = state.video.ME[0].programInput;
            const previewInput = state.video.ME[0].previewInput;
            if (programInput !== atemState.program || previewInput !== atemState.preview) {
                atemState.program = programInput;
                atemState.preview = previewInput;
                logger.info(`[ATEM] State Changed - Program: ${atemState.program}, Preview: ${atemState.preview}`);
                updateCacheCallback({ atem: atemState });
            }
        }
    });
}

async function applySwitch(cameraInput, atem_enabled, updateCacheCallback, _modeLabel) {
    if (!cameraInput || !Number.isInteger(cameraInput) || cameraInput < 1) return;
    if (atem_enabled && atem && atem.state) {
        try {
            await withTimeout(atem.changeProgramInput(cameraInput), ATEM_CMD_TIMEOUT_MS);
        } catch (e) {
            logger.error(`[ATEM] Error changing program input: ${e.message || e}`);
        }
    } else if (atem_enabled === false) {
        dummySwitchCamera(cameraInput, updateCacheCallback);
    }
}

// Pick the camera input from the position snapshot, optionally filtering out
// finished pilots (Auto mode only). Returns the whole pilot entry or null.
function pickFromSnapshot(snapshot, targetPosition, excludeFinished) {
    if (!Array.isArray(snapshot) || snapshot.length === 0) return null;

    // Filter out finished pilots if requested
    const candidates = excludeFinished
        ? snapshot.filter(e => !isFinished(e.pilotName))
        : snapshot;

    if (candidates.length === 0) return null;

    if (targetPosition == null) {
        // Auto: pick the best position among remaining candidates.
        return candidates.reduce(
            (best, e) => (best == null || e.position < best.position) ? e : best,
            null
        );
    }

    return candidates.find(e => e.position === targetPosition) || null;
}

async function processEvents(updateCacheCallback, event) {
    const config = getConfig();
    const { atem_ip, switching_mode, default_camera, atem_enabled } = config;

    logger.debug(`[Data Processor] Event: type=${event.type}`);

    if (atem_enabled) {
        await ensureAtemConnection(updateCacheCallback, atem_ip, default_camera);
    }

    let targetPilot = null;

    if (event.type === 'lap') {
        const { pilotName, raceFinishedForPilot, positionSnapshot } = event;

        if (raceFinishedForPilot) {
            markFinished(pilotName);
            logger.info(`[Data Processor] Pilot finished: ${pilotName}`);
        }

        if (switching_mode === 'Auto') {
            targetPilot = pickFromSnapshot(positionSnapshot, null, true);
        } else if (typeof switching_mode === 'string' && switching_mode.startsWith('Pos')) {
            const targetPos = parseInt(switching_mode.substring(3), 10);
            targetPilot = pickFromSnapshot(positionSnapshot, targetPos, false);
        } else if (typeof switching_mode === 'string' && switching_mode.startsWith('Seat')) {
            const targetSeatIdx = parseInt(switching_mode.substring(4), 10); // "Seat0" -> 0
            targetPilot = positionSnapshot.find(p => p.seat === targetSeatIdx);
        }

        const cameraInputToSwitch = targetPilot?.cameraInput ?? null;
        await applySwitch(cameraInputToSwitch, atem_enabled, updateCacheCallback, switching_mode);

        if (targetPilot) {
            const lap = Math.floor(targetPilot.raceSector / 100);
            const sector = targetPilot.raceSector % 100;
            logger.info(`[Camera] Target: ${targetPilot.pilotName} (Lap ${lap} Sec ${sector}) -> Switching to Cam ${targetPilot.cameraInput}`);
        }
    } else if (event.type === 'race_start') {
        resetForRace();
        setRaceState('started');
        logger.info(`[Camera] System: Race PreStart -> Switching to Cam ${default_camera}`);
        await applySwitch(default_camera, atem_enabled, updateCacheCallback, 'race_start');
    } else if (event.type === 'race_end') {
        setRaceState('finished');
        logger.info(`[Camera] System: Race End -> Switching to Cam ${default_camera}`);
        await applySwitch(default_camera, atem_enabled, updateCacheCallback, 'race_end');
    } else if (event.type === 'manual_switch') {
        const { cameraInput } = event;
        logger.info(`[Camera] Manual: UI Click -> Switching to Cam ${cameraInput}`);
        targetPilot = { pilotName: 'Manual', cameraInput }; // Mark as manual target
        await applySwitch(cameraInput, atem_enabled, updateCacheCallback, 'Manual');
    }

    // Unified status update at the end of every event
    updateCacheCallback({
        atem: atemState,
        raceStatus: getRaceStatus(),
        targetPilot: targetPilot ? {
            pilotName: targetPilot.pilotName,
            cameraInput: targetPilot.cameraInput,
            raceSector: targetPilot.raceSector,
            position: targetPilot.position
        } : null
    });
}

async function disconnect() {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    if (!atem) return;
    const handle = atem;
    atem = null;
    try {
        if (typeof handle.disconnect === 'function') {
            await handle.disconnect();
        } else if (typeof handle.destroy === 'function') {
            await handle.destroy();
        }
    } catch (_e) { /* swallow — shutdown best-effort */ }
}

module.exports = { processEvents, disconnect };
