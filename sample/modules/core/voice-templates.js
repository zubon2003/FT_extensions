const fs = require('fs');
const path = require('path');
const logger = require('./logger.js');

const CWD = process.cwd();
// Filename pattern accepted by setFile() / listAvailable(). Only files that
// match this — and live in the working directory (no path separators) — are
// honoured, so /api/config can't be used to read arbitrary files.
const FILE_PATTERN = /^voice([_-][A-Za-z0-9._-]+)?\.json$/i;

// Default phrases. Used as a fallback when a key is missing in the active
// voice file. Edit voice.json (or a voice_XX.json variant) to override.
// Placeholders: {pilot}, {lap}, {time}, {total}
const DEFAULTS = {
    lap:            '{pilot}、ラップ{lap}、{time}秒',
    lapNoTime:      '{pilot}、ラップ{lap}',
    goal:           '{pilot}、ゴール!トータル{total}秒',
    goalNoTime:     '{pilot}、ゴール!',
    // `start` is the holeshot (HS) crossing — fired when a pilot crosses the
    // start line for the first time at lap 0 (primaryTimingSystemLocation=Holeshot).
    start:          '{pilot}、スタート',
    // `staggeredStart` is the per-pilot go signal in a TimeTrial staggered start
    // — emitted on the wire as PilotStaggeredStart (spec §7.9), independent of
    // any detection. Kept separate from `start` so operators can phrase them
    // differently (e.g. add a countdown beep before the holeshot text).
    staggeredStart: '{pilot}、スタート',
    crash:          '{pilot}、クラッシュアウト',
    raceEnd:        'レース終了',
    raceCancelled:  'レース中止',
    raceFailed:     'レース失敗',
};

let currentFile = 'voice.json';
let templates = { ...DEFAULTS };

function currentPath() {
    return path.resolve(CWD, currentFile);
}

function load() {
    const target = currentPath();
    try {
        const raw = fs.readFileSync(target, 'utf8');
        const user = JSON.parse(raw);
        templates = { ...DEFAULTS, ...user };
        logger.info(`[Voice] templates loaded from ${currentFile}`);
    } catch (e) {
        if (e.code === 'ENOENT' && currentFile === 'voice.json') {
            // First run: seed voice.json with defaults so the user can edit
            // it. We only ever auto-create the base file; voice_XX.json
            // variants must be authored explicitly.
            try {
                fs.writeFileSync(target, JSON.stringify(DEFAULTS, null, 2) + '\n', 'utf8');
                templates = { ...DEFAULTS };
                logger.info(`voice.json created at ${target}`);
            } catch (writeErr) {
                logger.warn(`voice.json could not be created: ${writeErr.message}`);
            }
        } else {
            templates = { ...DEFAULTS };
            logger.warn(`[Voice] ${currentFile} read failed: ${e.message} — using defaults`);
        }
    }
}

// Switch the active voice file. Returns true on success, false if the name
// failed validation or the file does not exist (in which case `currentFile`
// is left unchanged). Pass an empty string / undefined to reset to voice.json.
function setFile(filename) {
    const desired = (filename && typeof filename === 'string') ? filename : 'voice.json';
    const base = path.basename(desired);
    if (!FILE_PATTERN.test(base)) {
        logger.warn(`[Voice] rejected invalid file name "${desired}"`);
        return false;
    }
    if (base === currentFile) {
        return true;
    }
    const target = path.resolve(CWD, base);
    // voice.json is auto-seeded if missing, so accept it unconditionally.
    if (base !== 'voice.json' && !fs.existsSync(target)) {
        logger.warn(`[Voice] file not found: ${target}`);
        return false;
    }
    currentFile = base;
    load();
    return true;
}

// Returns the basenames of all voice*.json files in the working directory,
// sorted. voice.json (when present) sorts first so the canonical fallback is
// always at the top of the UI dropdown.
function listAvailable() {
    let entries;
    try {
        entries = fs.readdirSync(CWD, { withFileTypes: true });
    } catch (e) {
        logger.warn(`[Voice] listAvailable failed: ${e.message}`);
        return [];
    }
    const files = entries
        .filter(d => d.isFile() && FILE_PATTERN.test(d.name))
        .map(d => d.name);
    files.sort((a, b) => {
        if (a === 'voice.json') return -1;
        if (b === 'voice.json') return 1;
        return a.localeCompare(b);
    });
    return files;
}

// Render a template by key, substituting {placeholders} with vars.
// Returns '' if the template is empty (i.e. the user disabled this phrase).
function render(key, vars = {}) {
    const tpl = templates[key];
    if (tpl == null) return null;
    if (tpl === '') return '';
    return tpl.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m));
}

function currentFileName() {
    return currentFile;
}

load();

module.exports = {
    render,
    load,
    setFile,
    listAvailable,
    currentFileName,
    get VOICE_PATH() { return currentPath(); },
};
