const { SerialPort } = require('serialport');
const logger = require('./logger.js');

class LedHandler {
    constructor() {
        this.port = null;
        this.currentPortName = null;
        this.enabled = false;
        this.compensationMs = 0;
        this.countdownTimers = [];

        // Command Types
        this.TYPE_PILOT  = 0x01; // Pilot pass with RGB
        this.TYPE_SYSTEM = 0x02; // System/Countdown event
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
            baudRate: 115200,
            autoOpen: false
        });

        this.port.open((err) => {
            if (err) {
                logger.error(`[LED] Error opening port ${this.currentPortName}: ${err.message}`);
                return;
            }
            logger.info(`[LED] Connected to ${this.currentPortName} at 115200bps (Packet Mode)`);
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

        const packet = Buffer.alloc(5);
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
        this.sendPacket(this.TYPE_PILOT, r || 0, g || 0, b || 0);
        logger.debug(`[LED] Pilot Pass RGB(${r},${g},${b})`);
    }

    /**
     * System event: Byte1 = 0x02, Byte2 = ASCII Char
     */
    sendSystemEvent(char) {
        this.sendPacket(this.TYPE_SYSTEM, char.charCodeAt(0), 0, 0);
        logger.info(`[LED] System Event: '${char}'`);
    }

    onRaceEnd() {
        this.clearCountdown();
        this.sendSystemEvent('E');
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
        if (!this.enabled || !this.port || !this.port.isOpen) return;
        this.clearCountdown();
        
        const now = Date.now();
        const thresholds = [
            { sec: 8, char: 'R' },
            { sec: 5, char: '5' },
            { sec: 4, char: '4' },
            { sec: 3, char: '3' },
            { sec: 2, char: '2' },
            { sec: 1, char: '1' },
            { sec: 0, char: 'G' }
        ];

        thresholds.forEach(t => {
            const targetTime = startTimeMs - (t.sec * 1000) - this.compensationMs;
            const delay = targetTime - now;

            if (delay > 0) {
                const timer = setTimeout(() => {
                    this.sendSystemEvent(t.char);
                }, delay);
                this.countdownTimers.push(timer);
            }
        });
    }
}

module.exports = new LedHandler();
