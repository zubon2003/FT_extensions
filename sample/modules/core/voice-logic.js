const logger = require('./logger.js');
const configStore = require('./config-store.js');
const voiceTemplates = require('./voice-templates.js');

// Phonetic comes from PilotInfoExt.phonetic (§6.2). Falls back to the display
// name when phonetic is not provided.
function pilotSpeak(pilotInfo, fallbackName) {
    if (pilotInfo?.phonetic) return pilotInfo.phonetic;
    if (pilotInfo?.name) return pilotInfo.name;
    return fallbackName || '';
}

function fmtSec(value) {
    if (value == null || !Number.isFinite(value)) return null;
    const dp = configStore.decimalPlaces();
    return Number(value).toFixed(dp);
}

// Persistent state across detections (re-entered each race via resetForRace).
let pilotsByName = new Map();   // name -> PilotInfoExt
let finishedPilots = new Set();
let raceActive = false;

function resetForRace() {
    finishedPilots.clear();
    logger.info('[Voice] state reset for new race');
}

function loadPilots(pilots) {
    pilotsByName = new Map();
    for (const p of pilots || []) {
        if (p?.name) pilotsByName.set(p.name, p);
    }
}

function setRaceActive(active) {
    raceActive = active;
}

// Build a TTS line for one DetectionExt and dispatch it to the announcer.
function onDetection(evt, announce) {
    if (!raceActive) return;
    if (!evt.isLapEnd) return;        // splits do not get announced
    if (evt.valid === false) return;  // sender filtered this detection

    const pilot = pilotsByName.get(evt.pilotName);
    const speak = pilotSpeak(pilot, evt.pilotName);
    const key = evt.pilotName;

    // raceFinishedForPilot wins over a duplicate Lap announcement.
    if (finishedPilots.has(key) && !evt.raceFinishedForPilot) return;

    let ttsText;
    if (evt.raceFinishedForPilot) {
        const total = fmtSec(evt.raceTime);
        ttsText = voiceTemplates.render(total ? 'goal' : 'goalNoTime', { pilot: speak, total });
        finishedPilots.add(key);
    } else if (evt.lapNumber === 0) {
        // Holeshot crossing (only emitted when primaryTimingSystemLocation = Holeshot)
        ttsText = voiceTemplates.render('start', { pilot: speak });
    } else {
        const lapT = fmtSec(evt.lapTimeSoFar);
        ttsText = voiceTemplates.render(lapT ? 'lap' : 'lapNoTime', {
            pilot: speak, lap: evt.lapNumber, time: lapT,
        });
    }

    if (!ttsText) return;
    logger.info(`[Voice] ${ttsText}`);
    announce(ttsText);
}

function onCrash(evt, announce) {
    const speak = pilotSpeak(evt.pilot, evt.pilot?.name);
    if (!speak) return;
    const text = voiceTemplates.render('crash', { pilot: speak });
    if (!text) return;
    logger.info(`[Voice] ${text}`);
    announce(text);
}

module.exports = {
    resetForRace,
    loadPilots,
    setRaceActive,
    onDetection,
    onCrash,
};
