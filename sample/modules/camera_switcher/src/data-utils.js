// Camera switcher's per-race state. Pilot ranking comes from FPVTrackside's
// positionSnapshot (DetectionExt §7.4) — no need to recompute. We only track
// which pilots have finished, so Auto mode can exclude them from leader pick.

let finishedPilots = new Set();
let currentRaceStatus = {
    state: 'ready', // ready, started, finished
    round: 1,
    heat: 1
};

function resetForRace() {
    finishedPilots = new Set();
}

function markFinished(pilotName) {
    if (pilotName) finishedPilots.add(pilotName);
}

function isFinished(pilotName) {
    return finishedPilots.has(pilotName);
}

function setRaceState(state) {
    currentRaceStatus.state = state;
}

function getRaceStatus() {
    return currentRaceStatus;
}

module.exports = {
    resetForRace,
    markFinished,
    isFinished,
    setRaceState,
    getRaceStatus,
};
