// In-memory cache of the latest events that drive the overlays:
//   - RaceLoaded   → current race roster + identifiers
//   - NextRace     → upcoming race for /nextheat
//   - RaceResult   → finished race table for /heatresult
//   - StageRanking → cumulative stage standings for /leaderboard
//
// Pilot bests across the session are accumulated from RaceResult.

const logger = require('./logger.js');
const configStore = require('./config-store.js');

const state = {
    eventName: null,
    currentRace: null,        // RaceLoaded payload
    nextRace: null,           // NextRace payload
    latestResult: null,       // RaceResult payload
    latestRanking: null,      // StageRanking payload
    pilotBests: {},           // keyed by pilot name
    allPilots: {},            // name -> PilotInfoExt (most recent)
    crashed: new Set(),       // pilot names crashed in current race
};

function recordPilot(p) {
    if (!p?.name) return;
    state.allPilots[p.name] = p;
}

function bestEntry() {
    return {
        time: Number.POSITIVE_INFINITY,
        heatName: null,
    };
}

function ensureBests(name) {
    if (!state.pilotBests[name]) {
        state.pilotBests[name] = {
            bestLap: bestEntry(),
            consecutive2Lap: bestEntry(),
            consecutive3Lap: bestEntry(),
            raceTime: bestEntry(),
            laps: { count: 0, time: Number.POSITIVE_INFINITY, heatName: null },
        };
    }
    return state.pilotBests[name];
}

function updateBest(slot, time, heatName) {
    if (!Number.isFinite(time)) return;
    if (time < slot.time) {
        slot.time = time;
        slot.heatName = heatName;
    }
}

function raceLabel(round, race, raceType) {
    const r = round == null ? 'N/A' : round;
    const t = raceType || 'Race';
    return `${t} ${r}-${race ?? '?'}`;
}

function onRaceLoaded(evt) {
    state.currentRace = evt;
    state.crashed.clear();
    for (const p of evt.pilots || []) recordPilot(p);
    logger.info(`[Results] RaceLoaded ${raceLabel(evt.round, evt.race, evt.raceType)} pilots=${evt.pilots?.length ?? 0}`);
}

function onNextRace(evt) {
    state.nextRace = evt;
    for (const p of evt.pilots || []) recordPilot(p);
}

function onRaceResult(evt) {
    state.latestResult = evt;
    const heatName = raceLabel(evt.round, evt.race, evt.raceType);
    for (const entry of evt.pilots || []) {
        const name = entry.pilot?.name;
        if (!name) continue;
        recordPilot(entry.pilot);
        const bests = ensureBests(name);
        if (entry.bestLap != null) updateBest(bests.bestLap, entry.bestLap, heatName);
        if (entry.bestConsecutive?.time != null) {
            const slot = entry.bestConsecutive.laps === 3 ? bests.consecutive3Lap : bests.consecutive2Lap;
            updateBest(slot, entry.bestConsecutive.time, heatName);
        }
        if (!entry.dnf && entry.totalTime != null) {
            updateBest(bests.raceTime, entry.totalTime, heatName);
        }
        if (entry.totalLaps != null) {
            if (entry.totalLaps > bests.laps.count
                || (entry.totalLaps === bests.laps.count && (entry.totalTime ?? Infinity) < bests.laps.time)) {
                bests.laps = {
                    count: entry.totalLaps,
                    time: entry.totalTime ?? Number.POSITIVE_INFINITY,
                    heatName,
                };
            }
        }
    }
    logger.info(`[Results] RaceResult ${heatName} pilots=${evt.pilots?.length ?? 0}`);
}

function onStageRanking(evt) {
    state.latestRanking = evt;
    for (const r of evt.ranking || []) recordPilot(r.pilot);
    logger.info(`[Results] StageRanking ${evt.stage?.name} entries=${evt.ranking?.length ?? 0}`);
}

function onPilotCrashed(evt) {
    if (evt.pilot?.name) state.crashed.add(evt.pilot.name);
}

function onRaceEnd(evt) {
    // Per-race transient state lives only during an active race. Once the race
    // has ended (or was cancelled), the crashed set should not leak into the
    // /api/leaderboard snapshot served before the next RaceLoaded.
    state.crashed.clear();
    if (evt) {
        logger.info(`[Results] Race ended ${raceLabel(evt.round, evt.race, evt.raceType)}`);
    }
}

function buildRankingFromStage() {
    if (!state.latestRanking?.ranking) return null;
    return state.latestRanking.ranking
        .slice()
        .sort((a, b) => (a.position ?? 99) - (b.position ?? 99))
        .map(r => ({
            pilotName: r.pilot?.name ?? 'Unknown',
            pilotPhonetic: r.pilot?.phonetic ?? null,
            time: r.bestLap ?? null,
            count: null,
            points: r.points ?? null,
        }));
}

function buildRankingFromBests(sortBy) {
    const entries = Object.entries(state.pilotBests);
    const ranked = entries
        .map(([name, b]) => {
            if (sortBy === 'laps') {
                if (!b.laps || b.laps.count === 0) return null;
                return { name, time: b.laps.time, count: b.laps.count };
            }
            const slot = b[sortBy];
            if (!slot || !Number.isFinite(slot.time)) return null;
            return { name, time: slot.time, count: null };
        })
        .filter(Boolean)
        .sort((a, b) => {
            if (sortBy === 'laps') {
                if (b.count !== a.count) return b.count - a.count;
                return a.time - b.time;
            }
            return a.time - b.time;
        });
    return ranked.map(r => ({
        pilotName: r.name,
        pilotPhonetic: state.allPilots[r.name]?.phonetic ?? null,
        time: r.time,
        count: r.count,
    }));
}

function buildLatestHeat() {
    if (!state.latestResult) return { name: null, pilots: [] };
    const r = state.latestResult;
    
    // Sort pilots by frequency (Ascending)
    const sortedPilots = (r.pilots || []).slice().sort((a, b) => {
        const freqA = a.pilot?.channel?.frequency ?? 9999;
        const freqB = b.pilot?.channel?.frequency ?? 9999;
        return freqA - freqB;
    });

    const pilots = sortedPilots.map(entry => {
        const p = entry.pilot;
        const c = p?.channel;
        
        // Find in StageRanking for official round result
        const stageRankingEntry = state.latestRanking?.ranking?.find(sr => sr.pilot?.name === p.name);
        
        // Band name: 1st char of band + number (e.g. F5)
        const bandShort = c ? `${c.band.charAt(0)}${c.number}` : '??';

        // LOGIC: Use stage ranking if available, otherwise fall back to heat result
        const displayRank = stageRankingEntry?.position ?? entry.position;
        const displayTime = stageRankingEntry?.bestLap ?? entry.totalTime;
        const displayCount = stageRankingEntry ? null : entry.totalLaps;

        return {
            pilotId: p?.name ?? null,
            name: p?.name ?? 'Unknown',
            pilotPhonetic: p?.phonetic ?? null,
            photopath: p?.photoPath || null,
            band: bandShort,
            frequency: c?.frequency ?? null,
            color: c ? { r: c.colorR, g: c.colorG, b: c.colorB } : null,
            rank: displayRank ?? null,
            time: displayTime ?? null,
            count: displayCount ?? null,
            bestLap: entry.bestLap ?? null
        };
    });

    return {
        name: raceLabel(r.round, r.race, r.raceType),
        pilots: pilots
    };
}

function buildNextHeat(rankingByName) {
    if (!state.nextRace || state.nextRace.round == null) return { name: null, pilots: [] };
    const r = state.nextRace;
    
    // Sort actual pilots by frequency (Ascending)
    const sortedPilots = (r.pilots || []).slice().sort((a, b) => {
        const freqA = a.channel?.frequency ?? 9999;
        const freqB = b.channel?.frequency ?? 9999;
        return freqA - freqB;
    });

    const pilots = sortedPilots.map(p => {
        const c = p.channel;
        
        // Find in StageRanking specifically (if available)
        const stageRankingEntry = state.latestRanking?.ranking?.find(r => r.pilot?.name === p.name);
        
        // Band name: 1st char of band + number (e.g. F5)
        const bandShort = c ? `${c.band.charAt(0)}${c.number}` : '??';

        return {
            pilotId: p.name,
            name: p.name,
            pilotPhonetic: p.phonetic ?? null,
            photopath: p.photoPath || null,
            band: bandShort,
            frequency: c?.frequency ?? null,
            color: c ? { r: c.colorR, g: c.colorG, b: c.colorB } : null,
            rank: stageRankingEntry?.position ?? null,
            time: stageRankingEntry?.bestLap ?? null,
            count: null // we only show bestLap for ranking
        };
    });

    return {
        name: raceLabel(r.round, r.race, r.raceType),
        pilots: pilots
    };
}

function snapshot() {
    const title = state.latestRanking?.stage?.name || 'Leaderboard';
    const stageRanking = buildRankingFromStage();
    
    // Use the official StageRanking as the primary ranking if available,
    // otherwise fall back to session bests.
    const ranking = stageRanking || buildRankingFromBests('bestLap');

    const latest = buildLatestHeat();
    const next = buildNextHeat(new Map()); // dummy map since we don't need ranking in buildNextHeat anymore

    return {
        title,
        eventName: state.eventName || state.currentRace?.eventName || 'N/A',
        roundName: state.latestRanking?.stage?.name || state.currentRace?.raceType || 'N/A',
        sortedByDisplayName: 'Official Position',
        ranking,
        stageRanking,
        latestHeatName: latest.name,
        latestHeatPilots: latest.pilots,
        nextHeatName: next.name,
        nextHeatPilots: next.pilots,
        lastHeatPilotIds: latest.pilots.map(p => p.pilotId).filter(Boolean),
        crashed: Array.from(state.crashed),
    };
}

module.exports = {
    onRaceLoaded,
    onNextRace,
    onRaceResult,
    onStageRanking,
    onPilotCrashed,
    onRaceEnd,
    snapshot,
};
