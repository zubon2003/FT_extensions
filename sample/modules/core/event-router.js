// Event router for FPVTrackside Extension notifications.
//
// Holds per-event-stream state (current race's seat map, the last detection,
// seq tracking, defensive de-dup window) and dispatches each parsed event to
// the right handler. Created once at boot with all services wired in, then
// `dispatch(evt)` is called from the PUT receiver's drain loop.
//
// Each handler signature: `function (evt, ctx)` where `ctx` is the router
// instance — so handlers can reach announce(), mapDetectionToCameraEvent(),
// the seat map helpers, and the bound services.
'use strict';

const { performance } = require('perf_hooks');

const SEEN_DETECTION_MAX = 10_000;

function createRouter(services) {
    const {
        io, ledHandler, cameraSwitcher, ttsHandler: ttsHandlerRef,
        voiceLogic, voiceTemplates, resultsStore,
        configStore, logger,
    } = services;
    // server.js may pass either the handler itself or a getter function so the
    // active TTS engine can be hot-swapped via /api/config. Normalise both.
    const getTts = typeof ttsHandlerRef === 'function' ? ttsHandlerRef : () => ttsHandlerRef;

    // --- State (per-event-stream, lives for the process lifetime) ----------

    const pilotSeatByName = new Map();
    let lastSeq = 0;
    let lastDetection = null;

    // Bounded de-dup window. Detections that disappear from the window can be
    // re-processed on a network retry; that's acceptable because de-dup is a
    // defensive measure (the sender already filters duplicates per §10).
    const seenDetections = new Set();
    const seenOrder = [];

    function rememberDetection(id) {
        if (seenDetections.has(id)) return true;
        seenDetections.add(id);
        seenOrder.push(id);
        if (seenOrder.length > SEEN_DETECTION_MAX) {
            const evicted = seenOrder.shift();
            seenDetections.delete(evicted);
        }
        return false;
    }

    function clearSeenDetections() {
        seenDetections.clear();
        seenOrder.length = 0;
    }

    function updateSeatMap(pilots) {
        if (!pilots || !Array.isArray(pilots)) return;
        // Rebuild fresh — stale entries from the previous race would mis-map
        // seats when pilot rosters change between heats.
        pilotSeatByName.clear();
        pilots.forEach((p, idx) => {
            // p might be PilotInfoExt or PilotResultEntry (with p.pilot)
            const pilot = p.pilot || p;
            if (pilot?.name) pilotSeatByName.set(pilot.name, idx);
        });
    }

    // --- Announce: text to overlays + TTS pipeline -------------------------

    function announce(text) {
        io.emit('announce_text', { text });
        const tts = getTts();
        if (tts && tts.enabled) {
            tts.enqueueText(text, (audioData) => {
                if (audioData) io.emit('play_audio', { data: audioData });
            });
        }
    }

    // --- DetectionExt → camera_switcher event ------------------------------
    //
    // timingSystemIndex 0 is the Goal/Prime gate; the rest are splits in track
    // order. Sector is the pilot's current position on the lap:
    //   index 0 (Goal)  → sector = splitsPerLap (last sector of the lap)
    //   index n (Split) → sector = n
    //
    // We pass FPVTrackside's authoritative positionSnapshot so the switcher
    // can resolve Auto/PosN modes without recomputing ranks. Each snapshot
    // entry is enriched with cameraInput derived from raceSector (per
    // INTERFACE.md: lap × 100 + timingSystemIndex; the index portion is the
    // raw 0-based TSI). TSI N → ATEM input N+1, capped to splitsPerLap.
    function mapDetectionToCameraEvent(evt, seatIndex) {
        const tsys = configStore.get().fpvt?.timingSystem;
        const splitsPerLap = tsys?.splitsPerLap ?? 4;
        const logicalGate = evt.timingSystemIndex;
        const isGoalGate = (logicalGate === 0);

        if (isGoalGate && !evt.isLapEnd) {
            logger.warn(`[Detection] gate 0 (Goal) but isLapEnd=false (pilot=${evt.pilotName})`);
        } else if (!isGoalGate && evt.isLapEnd) {
            logger.warn(`[Detection] gate ${logicalGate} (Split) but isLapEnd=true (pilot=${evt.pilotName})`);
        }

        const sector = isGoalGate ? splitsPerLap : logicalGate;
        const camInputCap = Math.max(1, splitsPerLap);
        const snap = (evt.positionSnapshot || []).map(e => {
            const sIdx = e.raceSector % 100;
            const camInput = Math.min(sIdx, camInputCap - 1) + 1;
            return {
                pilotName: e.pilotName,
                position: e.position,
                raceSector: e.raceSector,
                lastDetectionTime: e.lastDetectionTime,
                cameraInput: camInput,
                seat: pilotSeatByName.get(e.pilotName),
            };
        });

        return {
            type: 'lap',
            seat: seatIndex,
            sector,
            isLapEnd: !!evt.isLapEnd,
            pilotName: evt.pilotName,
            raceFinishedForPilot: !!evt.raceFinishedForPilot,
            positionSnapshot: snap,
        };
    }

    // --- Handlers (one per FPVTrackside event type) ------------------------

    const handlers = {
        Hello(evt) {
            configStore.applyHello(evt);
            const tsys = evt.timingSystem || {};
            const chans = evt.channelSettings?.channels || [];
            logger.info(`[Hello] v${evt.fpvtVersion} ${evt.platform} profile=${evt.profile?.name} timers=${tsys.count} sectorsPerLap=${tsys.splitsPerLap}`);
            const chanSummary = chans.length
                ? chans.map(c => `${c.band}${c.number}`).join(',')
                : '(none)';
            logger.info(`[Hello] channels=${chans.length} [${chanSummary}]`);
        },

        RaceLoaded(evt) {
            updateSeatMap(evt.pilots);
            voiceLogic.loadPilots(evt.pilots);
            voiceLogic.setRaceActive(false);
            resultsStore.onRaceLoaded(evt);
            cameraSwitcher.setRaceLapCount(evt.targetLaps || null);
        },

        NextRace(evt) {
            updateSeatMap(evt.pilots);
            resultsStore.onNextRace(evt);
        },

        RacePreStart(evt) {
            if (evt.scheduledStart) {
                const scheduledWallMs = new Date(evt.scheduledStart).getTime();
                const nowWallMs = Date.now();
                const nowMonotonic = performance.now() / 1000;
                const startMonotonic = nowMonotonic + (scheduledWallMs - nowWallMs) / 1000;
                io.emit('race_start', { startTime: startMonotonic });
                logger.info(`[RacePreStart] R${evt.round}.${evt.race} in ${((scheduledWallMs - nowWallMs)/1000).toFixed(2)}s`);
                ledHandler.scheduleCountdown(scheduledWallMs);
            } else {
                logger.info(`[RacePreStart] R${evt.round}.${evt.race} (no scheduledStart)`);
            }
            cameraSwitcher.triggerEvent({ type: 'race_start' });
        },

        RaceStart(evt) {
            voiceLogic.resetForRace();
            voiceLogic.setRaceActive(true);
            // race_start is also emitted on PreStart; this re-confirmation
            // ensures the switcher is in default-camera state before
            // detections start arriving.
            const seats = pilotSeatByName.size > 0
                ? Array.from(pilotSeatByName.values())
                : [];
            cameraSwitcher.triggerEvent({ type: 'race_start', args: seats });
            logger.info(`[RaceStart] R${evt.round}.${evt.race} t0=${evt.actualStart}`);
        },

        RaceTimesUp(evt) {
            logger.info(`[RaceTimesUp] R${evt.round}.${evt.race}`);
        },

        RaceEnd(evt)       { return handlers._raceEnded(evt); },
        RaceCancelled(evt) { return handlers._raceEnded(evt); },
        _raceEnded(evt) {
            voiceLogic.setRaceActive(false);
            cameraSwitcher.triggerEvent({ type: 'race_end' });
            ledHandler.onRaceEnd();
            try { getTts().clearQueue(); } catch (_e) { /* best-effort */ }
            resultsStore.onRaceEnd(evt);
            const endKey = evt.type === 'RaceEnd'
                ? 'raceEnd'
                : (evt.failure ? 'raceFailed' : 'raceCancelled');
            const endText = voiceTemplates.render(endKey);
            if (endText) announce(endText);
        },

        DetectionExt(evt) {
            // §10: defensive de-dup even though sender filters.
            if (evt.detectionId && rememberDetection(evt.detectionId)) return;
            if (evt.valid !== false) lastDetection = evt;

            voiceLogic.onDetection(evt, announce);

            const seat = pilotSeatByName.get(evt.pilotName);

            if (seat !== undefined && evt.isLapEnd) {
                const c = evt.channel || {};
                ledHandler.onPilotPass(seat, c.colorR || 0, c.colorG || 0, c.colorB || 0);
            }

            // Fire on every valid detection so manual modes (Pos/Seat) keep
            // their lastServerId updated for splits too.
            if (evt.valid !== false) {
                const camEvt = mapDetectionToCameraEvent(evt, seat);
                if (camEvt) {
                    cameraSwitcher.triggerEvent(camEvt);
                } else {
                    const seatMapSize = pilotSeatByName.size;
                    logger.debug(`[Camera] camEvt is null. pilot="${evt.pilotName}", seat=${seat}, mapSize=${seatMapSize}`);
                    if (seatMapSize === 0) {
                        logger.warn(`[Camera] Seat map is empty! Reload the race in FPVTrackside.`);
                    }
                }
            } else {
                logger.debug(`[Camera] evt.valid is false for pilot=${evt.pilotName}`);
            }
        },

        RaceResult(evt) {
            updateSeatMap(evt.pilots);
            resultsStore.onRaceResult(evt);
        },

        StageRanking(evt) {
            resultsStore.onStageRanking(evt);
        },

        PilotCrashedOut(evt) {
            resultsStore.onPilotCrashed(evt);
            voiceLogic.onCrash(evt, announce);
        },

        PilotRaceState(evt) {
            updateSeatMap(evt.pilots);
            voiceLogic.loadPilots(evt.pilots);
        },

        // Per-pilot go signal during TimeTrial staggered start (§7.9).
        // Light the pilot's lane with their channel color (same routine as a
        // gate-pass detection) and queue a "<pilot> START" TTS using the
        // dedicated `staggeredStart` template, kept separate from holeshot.
        PilotStaggeredStart(evt) {
            const p = evt.pilot;
            if (!p) return;
            logger.info(`[StaggeredStart] ${p.name} (${evt.orderIndex + 1}/${evt.totalPilots}, delay=${evt.delaySeconds}s)`);
            voiceLogic.onStaggeredStart(evt, announce);
            // LED fires regardless of pilotSeatByName state — the receiver may
            // have missed RaceLoaded/PilotRaceState (e.g. started mid-race)
            // and have an empty seat map, but the wire payload already carries
            // the pilot's channel color. The hardware lane is selected by the
            // firmware from the RGB, not seat. Fall back to orderIndex so the
            // log line still shows a meaningful position.
            const c = p.channel || {};
            const seat = pilotSeatByName.get(p.name) ?? evt.orderIndex;
            ledHandler.onPilotPass(seat, c.colorR || 0, c.colorG || 0, c.colorB || 0);
        },
    };

    // --- Dispatch ----------------------------------------------------------

    function checkSequence(evt) {
        if (typeof evt.seq !== 'number') return;
        if (evt.seq < lastSeq) {
            logger.warn(`[Seq] reset ${evt.seq} < ${lastSeq} — sender restart suspected`);
            clearSeenDetections();
        } else if (lastSeq !== 0 && evt.seq > lastSeq + 1) {
            logger.warn(`[Seq] gap expected ${lastSeq + 1} got ${evt.seq}`);
        }
        lastSeq = evt.seq;
    }

    function dispatch(evt) {
        if (!evt || typeof evt !== 'object') return;
        checkSequence(evt);

        const handler = handlers[evt.type];
        if (typeof handler === 'function' && !evt.type.startsWith('_')) {
            handler(evt);
        } else {
            // §10: silently ignore unknown types.
            logger.debug(`[ignored] type=${evt?.type ?? '<missing>'}`);
        }
    }

    return {
        dispatch,
        announce,
        mapDetectionToCameraEvent,
        getSeat: (pilotName) => pilotSeatByName.get(pilotName),
        getLastDetection: () => lastDetection,
    };
}

module.exports = { createRouter };
