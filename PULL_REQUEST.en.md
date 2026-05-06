# Add ExtensionNotifier (Extension Mode) — FPVTracksideCore

Branch: `POST-Notefication-Extension`  
Companion repository: `FT_extensions` (same branch name) — contains the wire-format spec.

## Summary

Adds an opt-in **Extension Mode** to FPVTrackside. When enabled it runs a new
`ExtensionNotifier` alongside the existing `RemoteNotifier`. The new notifier
emits a richer set of race events (race load, sector-aware detections with
position snapshots, race results, stage rankings, pilot media paths, etc.) over
the same HTTP PUT / serial transports already configured for Gate / LED POST
notifications.

The full wire format is documented in `FT_extensions/INTERFACE.en.md` and
`INTERFACE.ja.md` (the spec is intentionally self-contained — a test client
can be built from those files alone).

## Why

The existing `RemoteNotifier` lacks the data needed to drive a separate
real-time race display, TTS announcements and LED control — notably:

- pilot phonetic / photo / video paths,
- sector indices and per-sector times,
- a position snapshot at every detection (so receivers don't recompute),
- pre-race scheduled start time (at countdown start),
- next race / final race result / stage ranking events,
- a Hello handshake that carries FPVTrackside's filesystem paths so the
  Extension can resolve `PhotoPath` and other relative references.

The Extension that consumes these events lives outside this repository
(`FT_extensions`). This PR is the FPVTrackside-side contract.

## Files changed

| File | Change |
|---|---|
| `UI/ApplicationProfileSettings.cs` | **+5 lines.** Adds `bool ExtensionMode` (default `false`, `[NeedsRestart]`) under the existing *Gate / LED POST notifications* category. No other property is altered. |
| `UI/EventLayer.cs` | **+15 lines.** Declares the field, instantiates `ExtensionNotifier` only when `ExtensionMode` is `true`, and disposes it. When `ExtensionMode = true` the legacy `RemoteNotifier` is **suppressed** regardless of `NotificationEnabled` (avoids duplicate emission on the same URL / serial port). Existing `RemoteNotifier` startup condition is the only line touched. |
| `ExternalData/ExtensionNotifier.cs` | **New file.** Implements the full wire contract. Subscribes to `RaceManager.OnRacePreStart` so `RacePreStart` fires for staggered / delayed / immediate start paths uniformly. |

`ExternalData/RemoteNotifier.cs` is **not modified** — verified via `git diff`.

## Behavior

### When `ExtensionMode = false` (default)

Identical to current behavior. `ExtensionNotifier` is never instantiated, no
new HTTP traffic, no new serial writes, no new event subscriptions, no Hello
heartbeat. Pre-existing bugs in `RemoteNotifier` (notably the duplicate-fire
of `OnSplitDetection` + `OnLapDetected` for lap ends) are preserved verbatim.

### When `ExtensionMode = true`

`ExtensionNotifier` starts (and the legacy `RemoteNotifier` is suppressed). It:

1. Sends a `Hello` PUT every 2 s on startup until the first 2xx response,
   delivering FPVTrackside's resolved paths
   (`workingDirectory`, `baseDirectory`, `eventsDirectory`, `profileDirectory`,
   `pilotsDirectory`), active profile name, the `decimalPlaces` rendering
   preference, a `timingSystem` snapshot (count, splits per lap,
   per-system role/connected state), and an `eventSettings` block
   (`raceStartIgnoreDetections`, `minLapTime`, `primaryTimingSystemLocation`).
   Heartbeat-phase connection failures (TCP refused / DNS / timeout) are
   silently swallowed per spec §3.2 — only the successful handshake is logged.
2. Subscribes to and processes:
   - `RaceManager.OnRaceChanged` → emits `RaceLoaded` + `NextRace`
   - `RaceManager.OnRacePreStart` → emits `RacePreStart` with
     `scheduledStart` (best-effort from `Event.MaxStartDelay`); fires for
     **all** start paths (staggered / delayed / immediate)
   - `OnRaceStart` / `OnRaceEnd` / `OnRaceCancelled` / `OnRaceTimesUp` → lifecycle events
   - `RaceManager.OnSplitDetection` + `OnLapDetected` → unified `DetectionExt`
     with per-detection `PositionSnapshot` for all pilots, deduplicated by
     `Detection.ID` to suppress the upstream double-fire bug
   - `RaceManager.OnPilotAdded` / `OnPilotRemoved` → `PilotRaceState`
   - `RaceManager.OnChannelCrashedOut` → `PilotCrashedOut`
   - `ResultManager.RaceResultsChanged` → `RaceResult`, plus `StageRanking`
     when the race belongs to a stage (`Race.Round.Stage != null`)

## Latency / robustness improvements vs. legacy RemoteNotifier

The new path was designed for real-time use, fixing several latency bottlenecks
in the legacy RemoteNotifier:

| Aspect | Legacy `RemoteNotifier` | `ExtensionNotifier` |
|---|---|---|
| Worker queues | 1 shared (HTTP + Serial) | 2 separate (`-HTTP`, `-Serial`) |
| HTTP wait | 10 s `WaitOne` per event | 1.5 s `task.Wait` per event, with `HttpClient` keep-alive |
| Serial WriteTimeout | 12 s | 100 ms (fire-and-forget, no reads) |
| Detection double-emit | yes (lap-end fires twice) | filtered by `Detection.ID` |
| Queue capacity | unbounded | bounded (HTTP 200, Serial 50) — drops new events when full and logs once |
| Position computation | none in payload | `Race.GetTrackPosition()` snapshot for **all** pilots in payload (sector-aware) |
| Sequence numbers | none | monotonic `seq` on every event |

These changes apply only to `ExtensionNotifier`. The legacy notifier keeps its
original behavior.

## Configuration

In *Application Profile Settings* → *Gate / LED POST notifications*:

- **Extension Mode** — new checkbox (off by default). Restart required.
- **Notification URL** — reused (the same URL receives the new event types).
- **Notification Serial Port** — reused. The Extension may set its own,
  separate COM port for downstream LED control.
- **Notification Enabled** — controls only the legacy `RemoteNotifier`.
  When *Extension Mode* is on, `RemoteNotifier` is suppressed regardless of
  this flag (prevents duplicate traffic on the same URL / COM port).

The two notifiers do **not** run in parallel — *Extension Mode* takes
precedence and supersedes the legacy stream.

## Receiver requirements (summary)

Documented in detail in `FT_extensions/INTERFACE.en.md` §10. Highlights:

1. Respond `200 OK` **before** processing the body — otherwise sender queue
   stalls cascade.
2. Tolerate unknown `type` values (legacy notifier may also be active).
3. On `Hello`, persist the `paths` block to `config.json` atomically.
4. Resolve `PhotoPath` against `paths.workingDirectory`.

## Test plan

- [ ] Build the solution (`dotnet build "FPVTrackside - Core.sln"`) — passes
      with 0 errors (verified).
- [ ] Launch FPVTrackside with `ExtensionMode = false` and `NotificationEnabled = false`.
      Confirm there is no HTTP traffic to `NotificationURL` and no serial writes.
- [ ] Launch FPVTrackside with `ExtensionMode = false` and `NotificationEnabled = true`.
      Confirm legacy `RemoteNotifier` payloads still arrive identically.
- [ ] Launch FPVTrackside with `ExtensionMode = true`, no extension running.
      Confirm Hello PUT retries every ~2 s and sender continues to operate (no
      log noise per retry).
- [ ] Launch a minimal HTTP test server (per INTERFACE §11), confirm:
  - Hello arrives once, retries stop after first 2xx.
  - `RaceLoaded` + `NextRace` fire on race switch.
  - `RacePreStart` arrives with `ScheduledStart` at countdown start.
  - `RaceStart` arrives with `ActualStart` when Go fires.
  - `DetectionExt` arrives once per detection (no duplicate `DetectionId`).
  - `PositionSnapshot[]` length equals the number of pilots in the race.
  - `RaceResult` arrives after race end with all pilots ordered by `Position`.
  - `StageRanking` arrives only when `Race.Round.Stage != null`.
- [ ] Verify that `PhotoPath` resolves correctly via
      `path.join(paths.workingDirectory, PhotoPath)`.
- [ ] Stress: extension responds to PUT in < 5 ms; multiple sectors per second
      do not back up the sender queue.
- [ ] Negative: extension intentionally hangs after 200 OK. Sender continues
      because timeout is 1.5 s and queue is bounded.

## Backward compatibility

Pre-existing user installations with `ExtensionMode` absent from
`ProfileSettings.xml` will read it as `false` on startup (C# `bool` default),
producing identical behavior to before.
