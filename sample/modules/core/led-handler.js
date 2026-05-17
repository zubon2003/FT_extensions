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

class LedHandler {
    constructor() {
        this.port = null;
        this.currentPortName = null;
        this.enabled = false;
        this.compensationMs = 0;
        this.countdownTimers = [];
    }

    reconfigure(config) {
        const { enabled, port: portName, compensation_ms } = config || {};
        
        const newEnabled = !!enabled;
        const newCompensation = parseInt(compensation_ms) || 0;

        if (this.enabled !== newEnabled || this.currentPortName !== portName || this.compensationMs !== newCompensation) {
            this.enabled = newEnabled;
            this.currentPortName = portName;
            this.compensationMs = newCompensation;

            if (this.port && this.port.isOpen) {
                this.port.close();
            }
            this.port = null;

            if (this.enabled && this.currentPortName) {
                this.connect();
            }
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
        const dropped = !this.enabled || !this.port || !this.port.isOpen;
        this.sendPacket(TYPE_PILOT, r || 0, g || 0, b || 0);
        if (dropped) {
            logger.info(`[LED] Pilot Pass seat=${seatIndex} RGB(${r},${g},${b}) — port not open, skipped`);
        } else {
            logger.info(`[LED] Pilot Pass seat=${seatIndex} RGB(${r},${g},${b})`);
        }
    }

    /**
     * System event: Byte1 = TYPE_SYSTEM, Byte2 = ASCII Char
     */
    sendSystemEvent(char) {
        const dropped = !this.enabled || !this.port || !this.port.isOpen;
        this.sendPacket(TYPE_SYSTEM, char.charCodeAt(0), 0, 0);
        if (dropped) {
            logger.info(`[LED] System Event: '${char}' — port not open, skipped`);
        } else {
            logger.info(`[LED] System Event: '${char}'`);
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
}

module.exports = new LedHandler();
