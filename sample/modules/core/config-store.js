const fs = require('fs');
const path = require('path');
const logger = require('./logger.js');

const CONFIG_PATH = path.resolve(process.cwd(), 'config.json');
const FPVT_PATH = path.resolve(process.cwd(), 'fpvt.json');

// Top-level keys that belong to the user-editable config (config.json).
// Anything else in /api/config POST that's not 'fpvt' is also written here.
const USER_KEYS = ['extension', 'camera_switcher', 'voicevox', 'google_tts', 'tts', 'leaderboard'];

function readJson(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
        if (e.code !== 'ENOENT') {
            logger.warn(`${path.basename(filePath)} read failed: ${e.message} — starting fresh`);
        }
        return {};
    }
}

function load() {
    const userCfg = readJson(CONFIG_PATH);
    const fpvtState = readJson(FPVT_PATH);
    const merged = { ...userCfg };
    if (Object.keys(fpvtState).length > 0) merged.fpvt = fpvtState;
    return merged;
}

let current = load();

function writeAtomic(filePath, obj) {
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
}

function get() { return current; }

// Replaces the whole config in memory + on disk. Used by /api/config POST.
// Splits the payload: USER_KEYS go to config.json, fpvt goes to fpvt.json.
function replace(next) {
    current = next;
    const userCfg = {};
    for (const k of Object.keys(next)) {
        if (k !== 'fpvt') userCfg[k] = next[k];
    }
    writeAtomic(CONFIG_PATH, userCfg);
    if (next.fpvt) writeAtomic(FPVT_PATH, next.fpvt);
}

// §3.5: overwrite the entire `fpvt` block on every Hello — never merge.
// Only fpvt.json is touched; config.json is left alone so concurrent UI edits
// are never clobbered.
function applyHello(evt) {
    current = load(); // pick up any external edits to config.json
    current.fpvt = {
        lastHelloAt: evt.ts,
        fpvtVersion: evt.fpvtVersion,
        platform: evt.platform,
        paths: evt.paths,
        profile: evt.profile,
        decimalPlaces: evt.decimalPlaces,
        timingSystem: evt.timingSystem,
        eventSettings: evt.eventSettings,
        channelSettings: evt.channelSettings,
    };
    writeAtomic(FPVT_PATH, current.fpvt);
    return current;
}

function decimalPlaces() {
    return current.fpvt?.decimalPlaces ?? 2;
}

function workingDirectory() {
    return current.fpvt?.paths?.workingDirectory || null;
}

function resolveMedia(rel) {
    if (!rel) return null;
    if (path.isAbsolute(rel)) return rel;
    const wd = workingDirectory();
    if (!wd) return rel;

    // Always look inside the 'pilots' subfolder relative to working directory
    return path.join(wd, 'pilots', rel);
}

module.exports = {
    CONFIG_PATH,
    FPVT_PATH,
    get,
    replace,
    applyHello,
    decimalPlaces,
    workingDirectory,
    resolveMedia,
};
