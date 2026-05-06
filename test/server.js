#!/usr/bin/env node
// FPVTrackside Extension test receiver.
// Implements the receiver side of FT_extensions/INTERFACE.en.md.
//
// Run: node server.js
// The listening port is taken from config.json -> extension.port (default 8765).
// Edit that field and restart to change the port.

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const HOST = '127.0.0.1';
const DEFAULT_PORT = 8765;
const CONFIG_PATH = path.join(__dirname, 'config.json');

// ---------- config.json (atomic, preserves `extension` block) ----------

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const obj = JSON.parse(raw);
    if (!obj.extension || typeof obj.extension !== 'object') obj.extension = {};
    return obj;
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.error(`[warn] failed to read ${CONFIG_PATH}: ${e.message} — starting fresh`);
    }
    return { fpvt: null, extension: {} };
  }
}

function writeConfigAtomic(cfg) {
  const tmp = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
  fs.renameSync(tmp, CONFIG_PATH);
}

let config = loadConfig();

// Materialize extension.port on first run so the operator has something to edit.
if (typeof config.extension.port !== 'number') {
  config.extension.port = DEFAULT_PORT;
  writeConfigAtomic(config);
}
const PORT = config.extension.port;

// ---------- runtime state ----------

const queue = [];
let draining = false;
let lastSeq = 0;
const seenDetections = new Set();

// ---------- helpers ----------

function ts() {
  return new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
}

function log(tag, detail) {
  console.log(`[${ts()}] ${tag.padEnd(16)} ${detail ?? ''}`);
}

function dp() {
  return config.fpvt?.decimalPlaces ?? 2;
}

function fmt(n, places) {
  if (n == null) return 'null';
  return Number(n).toFixed(places ?? dp());
}

function resolveMedia(rel) {
  if (!rel) return null;
  const wd = config.fpvt?.paths?.workingDirectory;
  return wd ? path.join(wd, rel) : rel;
}

function ch(c) {
  if (!c) return '?';
  return `${c.band}${c.number}@${c.frequency}MHz`;
}

// ---------- event dispatch ----------

function handleHello(evt) {
  // §3.5: preserve `extension` and any other top-level keys across Hello
  // updates. Reload from disk so concurrent edits by the Extension's own
  // code (or the operator) are not clobbered by our stale in-memory copy.
  const onDisk = loadConfig();
  config = { ...onDisk, ...config, extension: onDisk.extension };

  // §3.5: overwrite the entire fpvt block on every Hello — never merge.
  // We additionally persist decimalPlaces and timingSystem so the Extension
  // can format times and route per-gate even when FPVTrackside is offline.
  config.fpvt = {
    lastHelloAt: evt.ts,
    fpvtVersion: evt.fpvtVersion,
    platform: evt.platform,
    paths: evt.paths,
    profile: evt.profile,
    decimalPlaces: evt.decimalPlaces,
    timingSystem: evt.timingSystem,
    eventSettings: evt.eventSettings,
  };
  writeConfigAtomic(config);

  const tsys = evt.timingSystem || {};
  const es = evt.eventSettings || {};
  log('Hello',
    `v${evt.fpvtVersion} ${evt.platform} profile=${evt.profile?.name} ` +
    `decimals=${evt.decimalPlaces} ` +
    `timers=${tsys.count}(prime=${tsys.primeCount}/split=${tsys.splitCount}) ` +
    `sectorsPerLap=${tsys.splitsPerLap}${tsys.allDummy ? ' [DUMMY]' : ''}`);
  log('  paths', `wd=${evt.paths?.workingDirectory}`);
  for (const s of tsys.systems || []) {
    log('  timer', `idx=${s.index} ${s.role.padEnd(5)} ${s.type}`);
  }
  log('  event', `ignoreFirst=${es.raceStartIgnoreDetections ?? '?'}s minLap=${es.minLapTime ?? '?'}s loc=${es.primaryTimingSystemLocation ?? '?'}`);
  log('  config', `→ ${CONFIG_PATH}`);
}

function dispatch(evt, rawBody) {
  // §5: detect resets and gaps.
  if (typeof evt.seq === 'number') {
    if (evt.seq < lastSeq) {
      log('seq-reset', `seq ${evt.seq} < ${lastSeq} — sender restart suspected`);
      seenDetections.clear();
    } else if (lastSeq !== 0 && evt.seq > lastSeq + 1) {
      log('seq-gap', `expected ${lastSeq + 1}, got ${evt.seq} (lost ${evt.seq - lastSeq - 1})`);
    }
    lastSeq = evt.seq;
  }

  switch (evt.type) {
    case 'Hello':
      handleHello(evt);
      break;

    case 'RaceLoaded': {
      log('RaceLoaded',
        `R${evt.round}.${evt.race} ${evt.raceType} ` +
        `pilots=${evt.pilots?.length ?? 0} laps=${evt.targetLaps} ` +
        `length=${fmt(evt.raceLength, 1)}s sectors=${evt.sectors?.length ?? 0}` +
        (evt.stage ? ` stage=${evt.stage.name}` : ''));
      for (const p of evt.pilots ?? []) {
        log('  pilot', `${p.name} ${ch(p.channel)} photo=${resolveMedia(p.photoPath) ?? '(none)'}`);
      }
      break;
    }

    case 'NextRace':
      if (evt.round == null) {
        log('NextRace', '(no next race)');
      } else {
        log('NextRace', `R${evt.round}.${evt.race} pilots=${evt.pilots?.length ?? 0}`);
      }
      break;

    case 'RacePreStart':
      console.log(`[RAW] RacePreStart: ${JSON.stringify(evt, null, 2)}`);
      // fall through
    case 'RaceStart':
    case 'RaceTimesUp':
    case 'RaceEnd':
    case 'RaceCancelled': {
      const start = evt.actualStart ? ` t0=${evt.actualStart}` : '';
      const plan = evt.scheduledStart ? ` plan=${evt.scheduledStart}` : '';
      const fail = evt.failure ? ' (FAILURE)' : '';
      const eventTs = evt.ts ? ` ts=${evt.ts}` : '';
      log(evt.type, `R${evt.round}.${evt.race}${start}${plan}${fail}${eventTs}`);
      break;
    }

    case 'DetectionExt': {
      // §10: defensive dedup even though sender filters.
      if (evt.detectionId && seenDetections.has(evt.detectionId)) {
        log('DetectionExt', `dup ${evt.detectionId.slice(0, 8)} ignored`);
        break;
      }
      if (evt.detectionId) seenDetections.add(evt.detectionId);

      // Logical mapping based on timingSystemIndex:
      // - timingSystemIndex 0 is ALWAYS Gate 0 / Goal (S$N).
      // - timingSystemIndex n (n > 0) is Gate n / Sector n (Sn).
      const tsys = config.fpvt?.timingSystem;
      const logicalGate = evt.timingSystemIndex;
      let logicalSector = logicalGate;
      const isGoalGate = (logicalGate === 0);

      if (isGoalGate && tsys) {
        logicalSector = tsys.splitsPerLap;
      }

      // Validation: logical mapping vs sender flags
      if (isGoalGate && !evt.isLapEnd) {
        log('error', `Gate ${logicalGate} (Goal) but isLapEnd=false!`);
      } else if (!isGoalGate && evt.isLapEnd) {
        log('error', `Gate ${logicalGate} (Split) but isLapEnd=true!`);
      }

      // Whether holeshot exists at all is dictated by the Event setting
      // "Primary Timing System Location":
      //   "Holeshot"  -> the goal gate is at the start line, so the first lap-end
      //                  crossing IS a holeshot (lap 0 -> lap 1, not a real lap).
      //   "EndOfLap"  -> the goal gate is past the start line, so the first lap-end
      //                  crossing IS the end of lap 1 (no holeshot exists).
      const ptl = config.fpvt?.eventSettings?.primaryTimingSystemLocation ?? 'Holeshot';
      const holeshotMode = (ptl === 'Holeshot');
      const isHoleshot = holeshotMode && isGoalGate && (evt.sectorTime == null);

      const minLap = config.fpvt?.eventSettings?.minLapTime ?? 0;
      const ignoreFirst = config.fpvt?.eventSettings?.raceStartIgnoreDetections ?? 0;

      // Holeshot uses RaceStartIgnoreDetections as the threshold (early goal-gate
      // crossings right after race start are noise); normal lap-ends use MinLapTime
      // (sub-min-lap detections are duplicates). Both match FPVTrackside's filtering.
      const isUnderIgnoreFirst = isHoleshot
        && evt.lapTimeSoFar != null
        && ignoreFirst > 0
        && evt.lapTimeSoFar < ignoreFirst;
      const isUnderMinLap = evt.isLapEnd
        && !isHoleshot
        && evt.lapTimeSoFar != null
        && minLap > 0
        && evt.lapTimeSoFar < minLap;

      if (isUnderIgnoreFirst || isUnderMinLap) break;

      const kind = isHoleshot ? 'HOLE' : (evt.isLapEnd ? 'LAP ' : 'sec ');
      const sectLabel = `.S${logicalSector}`;
      const sectTimeStr = evt.sectorTime != null ? `+${fmt(evt.sectorTime)}s` : '';
      const lapTime = isGoalGate && !isHoleshot ? ` lap=${fmt(evt.lapTimeSoFar)}s` : '';
      const flags =
        (evt.valid ? '' : ' INVALID') +
        (evt.raceFinishedForPilot ? ' [FINISHED]' : '');

      log('DetectionExt',
        `${kind} gate#${logicalGate} ${evt.pilotName} ` +
        `L${evt.lapNumber}${sectLabel} ` +
        `${sectTimeStr} pos=${evt.position}${lapTime}${flags}`);
      break;
    }

    case 'RaceResult':
      log('RaceResult', `R${evt.round}.${evt.race} ${evt.pilots?.length ?? 0} pilots`);
      for (const p of evt.pilots ?? []) {
        const best = p.bestLap != null ? `${fmt(p.bestLap)}s` : '-';
        const cons = p.bestConsecutive
          ? ` ${p.bestConsecutive.laps}cons=${fmt(p.bestConsecutive.time)}s`
          : '';
        log('  result',
          `${p.position}. ${p.pilot?.name} laps=${p.totalLaps} ` +
          `total=${fmt(p.totalTime)}s best=${best}${cons}${p.dnf ? ' DNF' : ''}`);
      }
      break;

    case 'StageRanking':
      log('StageRanking',
        `${evt.stage?.name} (${evt.stage?.stageType}) ${evt.ranking?.length ?? 0} pilots`);
      for (const r of evt.ranking ?? []) {
        const best = r.bestLap != null ? `${fmt(r.bestLap)}s` : '-';
        log('  rank',
          `${r.position}. ${r.pilot?.name} pts=${r.points ?? '-'} best=${best}`);
      }
      break;

    case 'PilotCrashedOut':
      log('PilotCrashedOut',
        `${evt.pilot?.name} ${ch(evt.pilot?.channel)} ${evt.manuallySet ? '(manual)' : '(auto)'}`);
      break;

    case 'PilotRaceState':
      log('PilotRaceState',
        `R${evt.round}.${evt.race} roster=${evt.pilots?.length ?? 0} (${(evt.pilots ?? []).map(p => p.name).join(', ')})`);
      break;

    default: {
      // §10: silently ignore unknown types — log at debug level for diagnosis.
      // Distinguish missing/null type (likely legacy RemoteNotifier or non-conformant
      // sender) from a literal "undefined" string.
      const t = evt?.type;
      let label;
      if (t === undefined) label = 'type=<missing>';
      else if (t === null) label = 'type=null';
      else label = `type="${t}" (${typeof t})`;
      const keys = evt && typeof evt === 'object' ? Object.keys(evt).join(',') : '<not-object>';
      const preview = (rawBody ?? '').slice(0, 2000).replace(/\s+/g, ' ');
      log('ignored', `${label} keys=[${keys}] body=${preview}`);
      break;
    }
  }
}

function drainQueue() {
  if (draining) return;
  draining = true;
  try {
    while (queue.length > 0) {
      const body = queue.shift();
      let evt;
      try {
        evt = JSON.parse(body);
      } catch (e) {
        log('parse-error', `${e.message} — body=${body.slice(0, 120)}`);
        continue;
      }
      try {
        dispatch(evt, body);
      } catch (e) {
        log('dispatch-error', `type=${evt?.type} ${e.message}`);
      }
    }
  } finally {
    draining = false;
  }
}

// ---------- HTTP server (immediate ack — §2.3) ----------

const server = http.createServer((req, res) => {
  if (req.method !== 'PUT') {
    // Be lenient: also accept POST for ad-hoc curl testing.
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Allow': 'PUT' });
      res.end();
      return;
    }
  }

  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    // ★ Ack BEFORE processing the body — see §2.3.
    res.writeHead(200);
    res.end();

    const body = Buffer.concat(chunks).toString('utf8');
    queue.push(body);
    // Drain on the next tick so the response flush is not blocked.
    setImmediate(drainQueue);
  });
  req.on('error', () => {
    try { res.writeHead(400); res.end(); } catch { /* ignore */ }
  });
});

server.on('clientError', (_err, socket) => {
  try { socket.destroy(); } catch { /* ignore */ }
});

// Must exceed the sender's PooledConnectionIdleTimeout (5 min). The receiver
// keeps connections alive longer than the sender's idle timeout so that the
// sender always recycles BEFORE the server closes — never the other way around.
server.keepAliveTimeout = 360000;
server.headersTimeout = 361000;

server.listen(PORT, HOST, () => {
  console.log('────────────────────────────────────────────────────────────');
  console.log(' FPVTrackside Extension — test receiver');
  console.log(`  URL    : http://${HOST}:${PORT}/  (port from config.extension.port)`);
  console.log(`  Config : ${CONFIG_PATH}`);
  console.log('  Set FPVTrackside profile NotificationURL to the URL above');
  console.log('  and "Use new POST format (Extension)" = true. Waiting for Hello...');
  console.log('────────────────────────────────────────────────────────────');
});

function shutdown(sig) {
  console.log(`\n${sig} received — shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
