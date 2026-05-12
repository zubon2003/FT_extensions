// Camera switcher reads its slice of the project-level config.json. The lap
// count is provided dynamically from FPVTrackside's RaceLoaded.targetLaps;
// callers may override via setRaceLapCount.
const fs = require('fs');
const path = require('path');

const configPath = path.resolve(process.cwd(), 'config.json');
const credentialsPath = path.resolve(process.cwd(), 'credentials.json');

const DEFAULTS = {
    atem_ip: "192.168.10.240",
    default_camera: 4,
    switching_mode: "Auto",
    atem_enabled: false,
    race_lap_count: 3,
};

let runtimeLapCount = null;

function loadConfig() {
    try {
        if (fs.existsSync(configPath)) {
            const full = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            const slice = { ...DEFAULTS, ...(full.camera_switcher || {}) };
            if (runtimeLapCount != null) slice.race_lap_count = runtimeLapCount;
            return slice;
        }
        return { ...DEFAULTS };
    } catch (error) {
        console.error('[CameraSwitcher] config read failed:', error.message);
        return { ...DEFAULTS };
    }
}

function getConfig() { return loadConfig(); }

function setRaceLapCount(count) {
    if (typeof count === 'number' && count > 0) runtimeLapCount = count;
}

function reloadConfig() { return loadConfig(); }

module.exports = {
    loadConfig,
    getConfig,
    reloadConfig,
    setRaceLapCount,
    credentialsPath,
    configPath,
};
