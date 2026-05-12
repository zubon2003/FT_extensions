// Camera switcher reads its slice from the canonical config-store. The lap
// count is provided dynamically from FPVTrackside's RaceLoaded.targetLaps;
// callers may override via setRaceLapCount.
const configStore = require('../../core/config-store.js');

const DEFAULTS = {
    atem_ip: '192.168.10.240',
    default_camera: 4,
    switching_mode: 'Auto',
    atem_enabled: false,
    race_lap_count: 3,
};

let runtimeLapCount = null;

function getConfig() {
    const full = configStore.get();
    const slice = { ...DEFAULTS, ...(full.camera_switcher || {}) };
    if (runtimeLapCount != null) slice.race_lap_count = runtimeLapCount;
    return slice;
}

function setRaceLapCount(count) {
    if (typeof count === 'number' && count > 0) runtimeLapCount = count;
}

module.exports = { getConfig, setRaceLapCount };
