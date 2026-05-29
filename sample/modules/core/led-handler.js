const { SerialPort } = require('serialport');
const logger = require('./logger.js');

// Serial-protocol constants. See led_test_receiver.js for the wire-format
// reference: every frame is 5 bytes [Type, V1, V2, V3, CRC] where CRC is the
// XOR of the first four bytes. The microcontroller distinguishes packets by
// the leading TYPE_* byte.
const BAUD_RATE = 115_200;
const PACKET_SIZE = 5;
const TYPE_PILOT = 0x01;     // Pilot pass with RGB
const TYPE_SYSTEM = 0x02;    // System / countdown event (ASCII char in V1)

// Countdown schedule: seconds-before-start → character emitted to the LED
// controller. 'R' arms the panel, '5'..'1' count down, 'G' is the start cue.
const COUNTDOWN_SCHEDULE = [
    { sec: 8, char: 'R' },
    { sec: 5, char: '5' },
    { sec: 4, char: '4' },
    { sec: 3, char: '3' },
    { sec: 2, char: '2' },
    { sec: 1, char: '1' },
    { sec: 0, char: 'G' },
];
const RACE_END_CHAR = 'E';

// Pilot-pass cues for the "no countdown" mode (countdown_start = false). Sent
// as TYPE_PILOT packets so any LED firmware that already handles pilot-pass
// will light up — no firmware change required. Operators using a random
// start delay (MinStartDelay != MaxStartDelay) typically pick this mode
// because a fixed N-second countdown can't represent the random window.
// Colours are operator-configurable (announcement_color / random_start_color);
// these constants are the defaults applied when config is missing.
const DEFAULT_ANNOUNCEMENT_COLOR = '#0000FF';   // blue:  announcement begins
const DEFAULT_RANDOM_START_COLOR = '#00FF00';   // green: scheduled start moment

// Countdown digit chars carry an RGB565 colour in V2/V3 so matrix-style LED
// firmware can render the digit in the configured colour. R/G/E keep V2=V3=0
// — they have no per-event colour and older firmware ignores the bytes anyway.
const COUNTDOWN_DIGIT_CHARS = new Set(['5', '4', '3', '2', '1']);

function parseHexColor(hex) {
    if (typeof hex !== 'string') return { r: 0, g: 0, b: 0 };
    let s = hex.trim();
    if (s.startsWith('#')) s = s.slice(1);
    // Accept 6-digit and 3-digit forms; anything else falls back to black.
    if (s.length === 3) {
        s = s.split('').map(c => c + c).join('');
    }
    if (s.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(s)) return { r: 0, g: 0, b: 0 };
    return {
        r: parseInt(s.slice(0, 2), 16),
        g: parseInt(s.slice(2, 4), 16),
        b: parseInt(s.slice(4, 6), 16),
    };
}

// Pack 24-bit RGB into 16-bit RGB565, big-endian byte pair.
// high = RRRRR GGG | low = GGG BBBBB
function rgbToRGB565Bytes(r, g, b) {
    const r5 = (r >> 3) & 0x1F;
    const g6 = (g >> 2) & 0x3F;
    const b5 = (b >> 3) & 0x1F;
    const packed = (r5 << 11) | (g6 << 5) | b5;
    return { high: (packed >> 8) & 0xFF, low: packed & 0xFF };
}

class LedHandler {
    constructor() {
        this.port = null;
        this.currentPortName = null;
        this.enabled = false;
        this.compensationMs = 0;
        // countdown_start defaults to true so existing installations keep the
        // 8/5/4/3/2/1/G behaviour without touching config.
        this.countdownStart = true;
        // lap_indicator defaults to true — gates the per-lap pilot-color flash.
        // When false, blue/red start cues (which call sendPacket directly) are
        // still emitted; only DetectionExt-driven pilot flashes are suppressed.
        this.lapIndicator = true;
        // countdown_color defaults to red. Encoded as RGB565 and shipped in
        // V2/V3 of the 5/4/3/2/1 system packets (R/G/E stay zero).
        this.countdownColor = '#FF0000';
        this.countdownColorBytes = rgbToRGB565Bytes(0xFF, 0, 0);
        // Strip brightness 1..255 — shipped to slaves via TYPE_SYSTEM 'B'.
        // 64 matches the firmware BRIGHTNESS constant so a slave that never
        // receives a 'B' packet still looks the same as before this feature.
        this.brightness = 64;
        // Race-rainbow lifecycle: ON means the slave paints fast rainbow during
        // the race and slow rainbow after race end (R/countdown stays dark).
        // OFF reproduces the legacy "lights off on G/E" behaviour. Shipped as
        // TYPE_SYSTEM 'M' with V2 = 0/1.
        this.raceRainbow = false;
        // No-countdown mode cues (sent as TYPE_PILOT, full 8-bit RGB).
        this.announcementColor = DEFAULT_ANNOUNCEMENT_COLOR;
        this.announcementRgb   = parseHexColor(DEFAULT_ANNOUNCEMENT_COLOR);
        this.randomStartColor  = DEFAULT_RANDOM_START_COLOR;
        this.randomStartRgb    = parseHexColor(DEFAULT_RANDOM_START_COLOR);
        this.countdownTimers = [];
        // Single-shot timer for the Web-UI Test Rainbow button auto-clear.
        // Tracked so a fresh test cancels any pending clear from a previous
        // press — otherwise a stale 'E' would arrive mid-fade of a colour test.
        this.testRainbowTimer = null;
    }

    clearTestRainbowTimer() {
        if (this.testRainbowTimer) {
            clearTimeout(this.testRainbowTimer);
            this.testRainbowTimer = null;
        }
    }

    reconfigure(config) {
        const {
            enabled, port: portName, compensation_ms,
            countdown_start, lap_indicator,
            countdown_color, announcement_color, random_start_color,
            brightness, race_rainbow,
        } = config || {};

        const newEnabled = !!enabled;
        const newCompensation = parseInt(compensation_ms) || 0;
        const newCountdownStart = countdown_start !== false;  // default true
        const newLapIndicator = lap_indicator !== false;      // default true
        const newCountdownColor = countdown_color || '#FF0000';
        const colorRgb = parseHexColor(newCountdownColor);
        const newCountdownColorBytes = rgbToRGB565Bytes(colorRgb.r, colorRgb.g, colorRgb.b);
        const newAnnouncementColor = announcement_color || DEFAULT_ANNOUNCEMENT_COLOR;
        const newAnnouncementRgb = parseHexColor(newAnnouncementColor);
        const newRandomStartColor = random_start_color || DEFAULT_RANDOM_START_COLOR;
        const newRandomStartRgb = parseHexColor(newRandomStartColor);
        // Clamp brightness to 1..255. parseInt('') === NaN falls back to the
        // previous value so a missing config key doesn't reset to 1.
        const parsedBrightness = parseInt(brightness);
        const newBrightness = Number.isFinite(parsedBrightness)
            ? Math.max(1, Math.min(255, parsedBrightness))
            : this.brightness;
        const brightnessChanged = (this.brightness !== newBrightness);
        const newRaceRainbow = !!race_rainbow;
        const raceRainbowChanged = (this.raceRainbow !== newRaceRainbow);

        // Port-related changes require a reconnect; flag-only changes (timing
        // compensation, countdown mode) must NOT touch the port. Reopening on
        // every flag flip creates an async window during which inbound packets
        // are dropped — exactly the symptom of "toggling the switch at runtime
        // doesn't take effect until restart".
        const portChanged = (this.enabled !== newEnabled) || (this.currentPortName !== portName);
        const modeChanged = (this.countdownStart !== newCountdownStart);

        this.enabled = newEnabled;
        this.currentPortName = portName;
        this.compensationMs = newCompensation;
        this.countdownStart = newCountdownStart;
        this.lapIndicator = newLapIndicator;
        this.countdownColor = newCountdownColor;
        this.countdownColorBytes = newCountdownColorBytes;
        this.announcementColor = newAnnouncementColor;
        this.announcementRgb = newAnnouncementRgb;
        this.randomStartColor = newRandomStartColor;
        this.randomStartRgb = newRandomStartRgb;
        this.brightness = newBrightness;
        this.raceRainbow = newRaceRainbow;

        if (portChanged) {
            if (this.port && this.port.isOpen) {
                this.port.close();
            }
            this.port = null;
            if (this.enabled && this.currentPortName) {
                this.connect();
            }
            this.clearCountdown();
        } else if (modeChanged) {
            // Mode flip mid-race: cancel any pending countdown chars / red cue
            // that were scheduled under the old setting so they don't fire
            // after the operator switched away from that mode.
            this.clearCountdown();
        }

        // Push brightness to the slave only when it actually changed and the
        // port stayed open. New-port connects re-send brightness from the
        // open callback below, so we'd double-send otherwise.
        if (brightnessChanged && !portChanged) {
            this.sendBrightness();
        }
        if (raceRainbowChanged && !portChanged) {
            this.sendRaceRainbowMode();
        }
    }

    connect() {
        if (!this.currentPortName) return;
        this.port = new SerialPort({
            path: this.currentPortName,
            baudRate: BAUD_RATE,
            autoOpen: false
        });

        this.port.open((err) => {
            if (err) {
                logger.error(`[LED] Error opening port ${this.currentPortName}: ${err.message}`);
                return;
            }
            logger.info(`[LED] Connected to ${this.currentPortName} at ${BAUD_RATE}bps (Packet Mode)`);
            // Push current brightness so a slave that just powered on (or that
            // we've reconnected to) matches the operator's chosen value
            // without needing them to touch the slider.
            this.sendBrightness();
            // Same idea for the race-rainbow mode — the slave persists it in
            // EEPROM, but if the operator toggled the switch while the slave
            // was offline we need to push the current value on reconnect.
            this.sendRaceRainbowMode();
        });

        this.port.on('error', (err) => logger.error(`[LED] Serial error: ${err.message}`));
        this.port.on('close', () => logger.info(`[LED] Port closed.`));
    }

    /**
     * Sends a 5-byte fixed packet with XOR CRC.
     * [Type, V1/R, V2/G, V3/B, CRC]
     */
    sendPacket(byte1, byte2, byte3, byte4) {
        if (!this.enabled || !this.port || !this.port.isOpen) return;

        const packet = Buffer.alloc(PACKET_SIZE);
        packet[0] = byte1 & 0xFF;
        packet[1] = byte2 & 0xFF;
        packet[2] = byte3 & 0xFF;
        packet[3] = byte4 & 0xFF;

        // XOR CRC Calculation
        packet[4] = packet[0] ^ packet[1] ^ packet[2] ^ packet[3];

        this.port.write(packet, (err) => {
            if (err) logger.error(`[LED] Write error: ${err.message}`);
        });
    }

    /**
     * Pilot pass: Byte1 = 0x01, Data = RGB
     */
    onPilotPass(seatIndex, r, g, b) {
        if (!this.lapIndicator) {
            logger.debug(`[LED] Pilot Pass seat=${seatIndex} RGB(${r},${g},${b}) — lap_indicator=false, suppressed`);
            return;
        }
        const dropped = !this.enabled || !this.port || !this.port.isOpen;
        this.sendPacket(TYPE_PILOT, r || 0, g || 0, b || 0);
        if (dropped) {
            logger.info(`[LED] Pilot Pass seat=${seatIndex} RGB(${r},${g},${b}) — port not open, skipped`);
        } else {
            logger.info(`[LED] Pilot Pass seat=${seatIndex} RGB(${r},${g},${b})`);
        }
    }

    /**
     * Staggered-start cue: same wire format as onPilotPass but always emits,
     * even when lap_indicator is off. Per-pilot go signal during TimeTrial
     * staggered start (PilotStaggeredStart §7.9) is the only visible cue for
     * that pilot's start moment, so it must not be silenced by the per-lap
     * suppression toggle.
     */
    onStaggeredStartCue(seatIndex, r, g, b) {
        const dropped = !this.enabled || !this.port || !this.port.isOpen;
        this.sendPacket(TYPE_PILOT, r || 0, g || 0, b || 0);
        if (dropped) {
            logger.info(`[LED] Staggered Start seat=${seatIndex} RGB(${r},${g},${b}) — port not open, skipped`);
        } else {
            logger.info(`[LED] Staggered Start seat=${seatIndex} RGB(${r},${g},${b})`);
        }
    }

    /**
     * System event: Byte1 = TYPE_SYSTEM, Byte2 = ASCII Char.
     * For countdown digits (5/4/3/2/1) V3/V4 carry the configured countdown
     * color encoded as RGB565 (high byte, low byte). Other chars send zero —
     * receivers that ignore V3/V4 see no behavioural change.
     */
    sendSystemEvent(char) {
        const dropped = !this.enabled || !this.port || !this.port.isOpen;
        let v2 = 0, v3 = 0;
        if (COUNTDOWN_DIGIT_CHARS.has(char)) {
            v2 = this.countdownColorBytes.high;
            v3 = this.countdownColorBytes.low;
        }
        this.sendPacket(TYPE_SYSTEM, char.charCodeAt(0), v2, v3);
        if (dropped) {
            logger.info(`[LED] System Event: '${char}' rgb565=${v2.toString(16).padStart(2,'0')}${v3.toString(16).padStart(2,'0')} — port not open, skipped`);
        } else {
            logger.info(`[LED] System Event: '${char}' rgb565=${v2.toString(16).padStart(2,'0')}${v3.toString(16).padStart(2,'0')}`);
        }
    }

    // Race-rainbow mode packet: TYPE_SYSTEM 'M' with V2 = 0 (off) or 1 (on).
    // Slave persists it to EEPROM; older firmware ignores the unknown char.
    sendRaceRainbowMode() {
        const dropped = !this.enabled || !this.port || !this.port.isOpen;
        const v = this.raceRainbow ? 1 : 0;
        this.sendPacket(TYPE_SYSTEM, 'M'.charCodeAt(0), v, 0);
        if (dropped) {
            logger.info(`[LED] Race-rainbow mode ${this.raceRainbow ? 'ON' : 'OFF'} — port not open, skipped`);
        } else {
            logger.info(`[LED] Race-rainbow mode ${this.raceRainbow ? 'ON' : 'OFF'}`);
        }
    }

    // Brightness packet: TYPE_SYSTEM 'B' with the 1..255 value in V2. Receivers
    // that don't know 'B' fall through the default case in onSystem() and
    // ignore it, so this is backward compatible with older slave firmware.
    sendBrightness() {
        const dropped = !this.enabled || !this.port || !this.port.isOpen;
        this.sendPacket(TYPE_SYSTEM, 'B'.charCodeAt(0), this.brightness, 0);
        if (dropped) {
            logger.info(`[LED] Brightness ${this.brightness} — port not open, skipped`);
        } else {
            logger.info(`[LED] Brightness ${this.brightness}`);
        }
    }

    // Test cue from the web UI's "LED Test" buttons. Rainbow latches the slave
    // into BASE_RAINBOW; we auto-clear it ~3 s later by sending 'E' so the
    // operator doesn't have to manually blank the strip. Colour tests reuse
    // the pilot-pass path (fades ~2 s and clears itself).
    static TEST_RAINBOW_AUTO_CLEAR_MS = 3000;

    testRainbow() {
        this.clearTestRainbowTimer();
        // 'T' (test rainbow) and 'X' (force clear) are mode-independent on the
        // slave, so the test button shows colours regardless of the operator's
        // Race-Rainbow switch and the auto-clear blanks the strip even when
        // race-rainbow ON would otherwise turn 'E' into a slow rainbow.
        this.sendPacket(TYPE_SYSTEM, 'T'.charCodeAt(0), 0, 0);
        const dropped = !this.enabled || !this.port || !this.port.isOpen;
        logger.info(`[LED] Test rainbow${dropped ? ' — port not open, skipped' : ''}`);
        this.testRainbowTimer = setTimeout(() => {
            this.sendPacket(TYPE_SYSTEM, 'X'.charCodeAt(0), 0, 0);
            logger.info(`[LED] Test rainbow auto-clear (${LedHandler.TEST_RAINBOW_AUTO_CLEAR_MS}ms)`);
            this.testRainbowTimer = null;
        }, LedHandler.TEST_RAINBOW_AUTO_CLEAR_MS);
    }

    testColor(name, r, g, b) {
        // Cancel any pending rainbow auto-clear; otherwise its 'E' would fire
        // mid-colour-fade and blank the strip earlier than the operator expects.
        this.clearTestRainbowTimer();
        this.sendPacket(TYPE_PILOT, r, g, b);
        const dropped = !this.enabled || !this.port || !this.port.isOpen;
        logger.info(`[LED] Test ${name} RGB(${r},${g},${b})${dropped ? ' — port not open, skipped' : ''}`);
    }

    onRaceEnd() {
        this.clearCountdown();
        logger.info(`[LED] Race ended — sending '${RACE_END_CHAR}'`);
        this.sendSystemEvent(RACE_END_CHAR);
    }

    clearCountdown() {
        this.countdownTimers.forEach(t => clearTimeout(t));
        this.countdownTimers = [];
    }

    shutdown() {
        this.clearCountdown();
        this.clearTestRainbowTimer();
        this.enabled = false;
        if (this.port && this.port.isOpen) {
            try { this.port.close(); } catch (_e) { /* ignore */ }
        }
        this.port = null;
    }

    scheduleCountdown(startTimeMs) {
        if (!this.countdownStart) {
            logger.info(`[LED] Countdown skipped (countdown_start=false; using blue/red cues instead)`);
            return;
        }
        if (!this.enabled || !this.port || !this.port.isOpen) {
            logger.info(`[LED] Countdown not scheduled — port not open`);
            return;
        }
        this.clearCountdown();

        const now = Date.now();
        const scheduled = [];
        COUNTDOWN_SCHEDULE.forEach(t => {
            const targetTime = startTimeMs - (t.sec * 1000) - this.compensationMs;
            const delay = targetTime - now;

            if (delay > 0) {
                const timer = setTimeout(() => {
                    this.sendSystemEvent(t.char);
                }, delay);
                this.countdownTimers.push(timer);
                scheduled.push(`${t.char}@+${(delay/1000).toFixed(2)}s`);
            }
        });
        const total = ((startTimeMs - now) / 1000).toFixed(2);
        logger.info(`[LED] Countdown scheduled (start in ${total}s, compensation=${this.compensationMs}ms): ${scheduled.join(', ') || '(none — all thresholds already past)'}`);
    }

    // No-countdown mode (countdown_start=false) cue 1/2: blue pilot-pass at the
    // moment the "Arm your quads…" announcement begins. Receiver-side analog of
    // RaceStartAnnouncement — gives operators a visible "preparation begins"
    // signal when a fixed countdown is not in use.
    onRaceStartAnnouncement() {
        if (this.countdownStart) return;   // countdown mode handles its own cues
        if (!this.enabled || !this.port || !this.port.isOpen) {
            logger.info(`[LED] RaceStartAnnouncement cue skipped — port not open`);
            return;
        }
        const c = this.announcementRgb;
        this.sendPacket(TYPE_PILOT, c.r, c.g, c.b);
        logger.info(`[LED] Race-start announcement cue: ${this.announcementColor}`);
    }

    // No-countdown mode cue 2/2: red pilot-pass at the scheduled-start moment,
    // pre-rolled by compensationMs to absorb LED firmware/serial latency
    // (same compensation value used by the countdown path).
    scheduleStartCue(startTimeMs) {
        if (this.countdownStart) return;   // countdown handles GO already
        if (!this.enabled || !this.port || !this.port.isOpen) {
            logger.info(`[LED] Start cue not scheduled — port not open`);
            return;
        }
        // Reuse countdownTimers so clearCountdown() / onRaceEnd() also cancels
        // a pending red cue if the race is reset before the start moment.
        this.clearCountdown();
        const now = Date.now();
        const targetTime = startTimeMs - this.compensationMs;
        const delay = targetTime - now;
        const c = this.randomStartRgb;
        // Random-start mode skips the 5-1 countdown digits, so without an
        // explicit 'G' the slave never learns the race actually started — that
        // matters for race-rainbow mode, where 'G' is what flips the base into
        // BASE_RAINBOW_FAST. Send 'G' first, then the pilot-pass colour cue so
        // the fade renders over the new fast-rainbow base. In legacy mode 'G'
        // sets BASE_OFF, which matches the existing visual (no behaviour
        // change for race_rainbow=false users).
        const fireStart = () => {
            this.sendSystemEvent('G');
            this.sendPacket(TYPE_PILOT, c.r, c.g, c.b);
        };
        if (delay <= 0) {
            // Already past — fire immediately so the receiver doesn't miss it.
            fireStart();
            logger.info(`[LED] Race-start cue: ${this.randomStartColor} (immediate; scheduled time already past by ${(-delay)}ms)`);
            return;
        }
        const timer = setTimeout(() => {
            fireStart();
            logger.info(`[LED] Race-start cue: ${this.randomStartColor}`);
        }, delay);
        this.countdownTimers.push(timer);
        logger.info(`[LED] Start cue scheduled (${this.randomStartColor} in ${(delay/1000).toFixed(2)}s, compensation=${this.compensationMs}ms)`);
    }
}

module.exports = new LedHandler();
