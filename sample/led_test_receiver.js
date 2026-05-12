/**
 * LED Receiver Test Program (COM7) - Refined for ID 0x01/0x02
 * 
 * 5バイト固定長パケットを受信し、内容を解析して表示します。
 * [Byte1: ID, Byte2: Data/Char, Byte3: G, Byte4: B, Byte5: CRC]
 */

const { SerialPort } = require('serialport');

const PORT_NAME = 'COM7';
const BAUD_RATE = 115200;

console.log(`\n--- LED Receiver Monitor (Fixed Protocol) starting on ${PORT_NAME} ---`);

const port = new SerialPort({
    path: PORT_NAME,
    baudRate: BAUD_RATE,
    autoOpen: false
});

port.open((err) => {
    if (err) {
        console.error(`Error opening port: ${err.message}`);
        process.exit(1);
    }
    console.log(`Connected to ${PORT_NAME} at ${BAUD_RATE}bps`);
    console.log(`Protocol: 0x01 = Pilot Pass (RGB), 0x02 = System Event (Char)`);
    console.log(`Waiting for packets...\n`);
});

let buffer = Buffer.alloc(0);

port.on('data', (data) => {
    // Append new data to the local buffer
    buffer = Buffer.concat([buffer, data]);

    // Process all complete 5-byte packets
    while (buffer.length >= 5) {
        const packet = buffer.slice(0, 5);
        buffer = buffer.slice(5);

        const id  = packet[0];
        const v1  = packet[1];
        const v2  = packet[2];
        const v3  = packet[3];
        const crc = packet[4];

        // XOR CRC Validation: Byte1 ^ Byte2 ^ Byte3 ^ Byte4
        const expectedCrc = id ^ v1 ^ v2 ^ v3;
        const crcOk = (crc === expectedCrc);

        const hexStr = packet.toString('hex').toUpperCase().match(/.{2}/g).join(' ');
        const timestamp = new Date().toLocaleTimeString('ja-JP', { hour12: false });
        
        if (!crcOk) {
            console.log(`[${timestamp}] [INVALID] ${hexStr} (CRC Mismatch: got ${crc.toString(16).toUpperCase()}, expected ${expectedCrc.toString(16).toUpperCase()})`);
            continue;
        }

        if (id === 0x01) {
            // --- ID 0x01: Pilot Pass (V1=R, V2=G, V3=B) ---
            console.log(`[${timestamp}] [PILOT ] RGB:(${v1}, ${v2}, ${v3})  [HEX: ${hexStr}]`);
        } else if (id === 0x02) {
            // --- ID 0x02: System Event (V1=ASCII Char, V2=0, V3=0) ---
            const char = String.fromCharCode(v1);
            console.log(`[${timestamp}] [SYSTEM] Event: '${char}'         [HEX: ${hexStr}]`);
        } else {
            console.log(`[${timestamp}] [UNKNOWN] ID:${id.toString(16).toUpperCase()} ${hexStr}`);
        }
    }
});

port.on('error', (err) => {
    console.error(`\nSerial Error: ${err.message}`);
});

port.on('close', () => {
    console.log('\nPort closed.');
});

// Graceful exit
process.on('SIGINT', () => {
    console.log('\nExiting monitor...');
    port.close();
    process.exit();
});
