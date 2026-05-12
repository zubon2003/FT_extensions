const fs = require('fs');
const path = require('path');
const logger = require('./logger.js');

const VOICE_PATH = path.resolve(process.cwd(), 'voice.json');

// Default phrases. Edit voice.json to override; missing keys fall back to these.
// Placeholders: {pilot}, {lap}, {time}, {total}
const DEFAULTS = {
    lap:           '{pilot}、ラップ{lap}、{time}秒',
    lapNoTime:     '{pilot}、ラップ{lap}',
    goal:          '{pilot}、ゴール!トータル{total}秒',
    goalNoTime:    '{pilot}、ゴール!',
    start:         '{pilot}、スタート',
    crash:         '{pilot}、クラッシュアウト',
    raceEnd:       'レース終了',
    raceCancelled: 'レース中止',
    raceFailed:    'レース失敗',
};

let templates = { ...DEFAULTS };

function load() {
    try {
        const raw = fs.readFileSync(VOICE_PATH, 'utf8');
        const user = JSON.parse(raw);
        templates = { ...DEFAULTS, ...user };
    } catch (e) {
        if (e.code === 'ENOENT') {
            // First run: seed voice.json with defaults so the user can edit it.
            try {
                fs.writeFileSync(VOICE_PATH, JSON.stringify(DEFAULTS, null, 2), 'utf8');
                logger.info(`voice.json created at ${VOICE_PATH}`);
            } catch (writeErr) {
                logger.warn(`voice.json could not be created: ${writeErr.message}`);
            }
        } else {
            logger.warn(`voice.json read failed: ${e.message} — using defaults`);
        }
    }
}

// Render a template by key, substituting {placeholders} with vars.
// Returns '' if the template is empty (i.e. the user disabled this phrase).
function render(key, vars = {}) {
    const tpl = templates[key];
    if (tpl == null) return null;
    if (tpl === '') return '';
    return tpl.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m));
}

load();

module.exports = { render, load, VOICE_PATH };
