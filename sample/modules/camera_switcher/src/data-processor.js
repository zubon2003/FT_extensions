const {
    resetForRace,
    markFinished,
    isFinished,
    setRaceState,
    getRaceStatus,
} = require('./data-utils');
const { Atem } = require('atem-connection');
const { getConfig } = require('./config');

let atem = null;
let atemState = { program: 0, preview: 0 };

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
    console.log('[ATEM] ATEM is enabled. Initializing connection...');
    atem = new Atem();
    atem.connect(atem_ip);
    atem.on('connected', async () => {
        console.log('[ATEM] Connected to ATEM switcher.');
        if (atem.state?.video?.ME?.[0]) {
            atemState.program = atem.state.video.ME[0].programInput;
            atemState.preview = atem.state.video.ME[0].previewInput;
        }
        if (default_camera) {
            try {
                console.log(`[ATEM] Switching to default camera ${default_camera} on connection.`);
                await withTimeout(atem.changeProgramInput(default_camera), 3000);
            } catch (e) {
                console.error('[ATEM] Error switching to default camera on connection:', e);
            }
        }
    });
    atem.on('disconnected', () => {
        console.log('[ATEM] Disconnected. Attempting to reconnect...');
        atem.connect(atem_ip);
    });
    atem.on('error', (e) => {
        // Only log meaningful errors to avoid cluttering
        if (e.message && e.message.includes('ECONNREFUSED')) {
            console.error(`[ATEM] Connection refused. Is the ATEM IP (${atem_ip}) correct and reachable?`);
        } else {
            console.error('[ATEM] Error:', e.message || e);
        }
    });
    atem.on('stateChanged', (state) => {
        if (state.video?.ME?.[0]) {
            const programInput = state.video.ME[0].programInput;
            const previewInput = state.video.ME[0].previewInput;
            if (programInput !== atemState.program || previewInput !== atemState.preview) {
                atemState.program = programInput;
                atemState.preview = previewInput;
                console.log(`[ATEM] State Changed - Program: ${atemState.program}, Preview: ${atemState.preview}`);
                updateCacheCallback({ atem: atemState });
            }
        }
    });
}

async function applySwitch(cameraInput, atem_enabled, updateCacheCallback, modeLabel) {
    if (!cameraInput || !Number.isInteger(cameraInput) || cameraInput < 1) return;
    if (atem_enabled && atem && atem.state) {
        try {
            await withTimeout(atem.changeProgramInput(cameraInput), 3000);
            // We can add a subtle confirmation log here if needed, but the main log is in processEvents
        } catch (e) {
            console.error('[ATEM] Error changing program input:', e.message || e);
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

    console.log(`[Data Processor] Event: type=${event.type}`);

    if (atem_enabled) {
        await ensureAtemConnection(updateCacheCallback, atem_ip, default_camera);
    }

    let targetPilot = null;

    if (event.type === 'lap') {
        const { seat, sector, pilotName, raceFinishedForPilot, positionSnapshot } = event;

        if (raceFinishedForPilot) {
            markFinished(pilotName);
            console.log(`[Data Processor] Pilot finished: ${pilotName}`);
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
            console.log(`[Camera] Target: ${targetPilot.pilotName} (Lap ${lap} Sec ${sector}) -> Switching to Cam ${targetPilot.cameraInput}`);
        }
    } else if (event.type === 'race_start') {
        resetForRace();
        setRaceState('started');
        targetPilot = null;
        console.log(`[Camera] System: Race PreStart -> Switching to Cam ${default_camera}`);
        await applySwitch(default_camera, atem_enabled, updateCacheCallback, 'race_start');
    } else if (event.type === 'race_end') {
        setRaceState('finished');
        targetPilot = null;
        console.log(`[Camera] System: Race End -> Switching to Cam ${default_camera}`);
        await applySwitch(default_camera, atem_enabled, updateCacheCallback, 'race_end');
    } else if (event.type === 'manual_switch') {
        const { cameraInput } = event;
        console.log(`[Camera] Manual: UI Click -> Switching to Cam ${cameraInput}`);
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
    if (!atem) return;
    try {
        if (typeof atem.disconnect === 'function') {
            await atem.disconnect();
        } else if (typeof atem.destroy === 'function') {
            await atem.destroy();
        }
    } catch (_e) { /* swallow — shutdown best-effort */ }
    atem = null;
}

module.exports = { processEvents, disconnect };
