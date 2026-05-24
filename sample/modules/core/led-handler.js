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
        // No-countdown mode cues (sent as TYPE_PILOT, full 8-bit RGB).
        this.announcementColor = DEFAULT_ANNOUNCEMENT_COLOR;
        this.announcementRgb   = parseHexColor(DEFAULT_ANNOUNCEMENT_COLOR);
        this.randomStartColor  = DEFAULT_RANDOM_START_COLOR;
        this.randomStartRgb    = parseHexColor(DEFAULT_RANDOM_START_COLOR);
        this.countdownTimers = [];
    }

    reconfigure(config) {
        const {
            enabled, port: portName, compensation_ms,
            countdown_start, lap_indicator,
            countdown_color, announcement_color, random_start_color,
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
        if (delay <= 0) {
            // Already past — fire immediately so the receiver doesn't miss it.
            this.sendPacket(TYPE_PILOT, c.r, c.g, c.b);
            logger.info(`[LED] Race-start cue: ${this.randomStartColor} (immediate; scheduled time already past by ${(-delay)}ms)`);
            return;
        }
        const timer = setTimeout(() => {
            this.sendPacket(TYPE_PILOT, c.r, c.g, c.b);
            logger.info(`[LED] Race-start cue: ${this.randomStartColor}`);
        }, delay);
        this.countdownTimers.push(timer);
        logger.info(`[LED] Start cue scheduled (${this.randomStartColor} in ${(delay/1000).toFixed(2)}s, compensation=${this.compensationMs}ms)`);
    }
}

module.exports = new LedHandler();
