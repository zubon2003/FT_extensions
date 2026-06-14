// YLED master — Serial → ESP-NOW bridge.
//
// Receives 5-byte fixed-length packets from USB-Serial (115200 bps) and
// broadcasts them via ESP-NOW to every slave on the same Wi-Fi channel.
// This board drives NO LEDs of its own; render-side logic lives in
// ledslave_normal (pilot fades + rainbow) and ledslave_countdown (countdown).
//
// Packet layout: [Type, V1, V2, V3, CRC] where CRC = XOR of the first 4.

#include <esp_now.h>
#include <WiFi.h>
#include <esp_wifi.h>

// --- Config ---------------------------------------------------------------

#define CHANNEL 11                  // World-safe 2.4GHz channel (US/EU/JP).
#define DEBUG   1

// --- Protocol -------------------------------------------------------------

#define PACKET_SIZE  5
#define TYPE_PILOT   0x01
#define TYPE_SYSTEM  0x02

// Stale-byte timeout: if the next byte of a packet doesn't arrive within this
// window we treat the buffer as garbage and resync from the next byte. Without
// this, a single dropped or extra byte permanently desyncs the receiver.
#define SERIAL_FRAME_TIMEOUT_MS 100

static uint8_t broadcastAddr[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};

// --- Serial framing -------------------------------------------------------

static uint8_t        serialBuf[PACKET_SIZE];
static int            bufIdx = 0;
static unsigned long  lastByteMs = 0;

static bool isKnownType(uint8_t b) {
    return b == TYPE_PILOT || b == TYPE_SYSTEM;
}

// Slide the buffer one byte forward; used when the first byte we just
// received does not look like a valid TYPE, indicating a framing slip.
static void slideBuffer() {
    for (int i = 1; i < bufIdx; i++) serialBuf[i - 1] = serialBuf[i];
    bufIdx--;
}

static void onPacket(const uint8_t* p) {
#if DEBUG
    if (p[0] == TYPE_PILOT) {
        Serial.printf("PILOT  RGB(%d,%d,%d)\n", p[1], p[2], p[3]);
    } else if (p[0] == TYPE_SYSTEM) {
        Serial.printf("SYSTEM '%c'\n", (char)p[1]);
    }
#endif
    esp_now_send(broadcastAddr, p, PACKET_SIZE);
}

static void handleByte(uint8_t b) {
    lastByteMs = millis();

    // The first byte of a packet must be a known TYPE; otherwise skip it
    // to find the next plausible frame boundary.
    if (bufIdx == 0 && !isKnownType(b)) {
#if DEBUG
        Serial.printf("framing: dropped 0x%02X (waiting for TYPE)\n", b);
#endif
        return;
    }

    serialBuf[bufIdx++] = b;

    if (bufIdx >= PACKET_SIZE) {
        uint8_t crc = serialBuf[0] ^ serialBuf[1] ^ serialBuf[2] ^ serialBuf[3];
        if (crc == serialBuf[4]) {
            onPacket(serialBuf);
            bufIdx = 0;
        } else {
#if DEBUG
            Serial.printf("CRC error: expected %02X got %02X — resyncing\n", crc, serialBuf[4]);
#endif
            // Drop the leading byte and re-evaluate. If the next byte is a
            // valid TYPE the remainder of the frame may still be intact.
            slideBuffer();
            if (bufIdx > 0 && !isKnownType(serialBuf[0])) bufIdx = 0;
        }
    }
}

// --- Setup / loop ---------------------------------------------------------

void setup() {
    Serial.begin(115200);
    delay(2000);
    Serial.println("YLED master (bridge) starting");

    WiFi.mode(WIFI_STA);
    esp_wifi_set_ps(WIFI_PS_NONE);
    WiFi.disconnect();
    delay(500);

#if DEBUG
    Serial.print("MAC: ");
    Serial.println(WiFi.macAddress());
#endif

    esp_wifi_set_channel(CHANNEL, WIFI_SECOND_CHAN_NONE);

    if (esp_now_init() != ESP_OK) {
        Serial.println("ESP-NOW init failed");
        return;
    }
    Serial.println("ESP-NOW ready");

    esp_now_peer_info_t peerInfo = {};
    memcpy(peerInfo.peer_addr, broadcastAddr, 6);
    peerInfo.channel = CHANNEL;
    peerInfo.encrypt = false;
    if (esp_now_add_peer(&peerInfo) != ESP_OK) {
        Serial.println("Failed to add broadcast peer");
    }

    Serial.printf("Channel %d — waiting for 5-byte packets [Type, V1, V2, V3, CRC]\n", CHANNEL);

    // --- TEMP self-test: broadcast SYSTEM 'T' once so slaves rainbow without
    // needing the web UI. Remove this block when ESP-NOW path is verified.
    delay(5000);
    {
        uint8_t pkt[PACKET_SIZE] = { TYPE_SYSTEM, 'T', 0x00, 0x00, 0 };
        pkt[4] = pkt[0] ^ pkt[1] ^ pkt[2] ^ pkt[3];
        esp_err_t r = esp_now_send(broadcastAddr, pkt, PACKET_SIZE);
        Serial.printf("SELF-TEST: sent SYSTEM 'T' (esp_now_send=%d)\n", (int)r);
    }
}

void loop() {
    while (Serial.available()) {
        handleByte(Serial.read());
    }

    // Reset partial frames that have stalled. Without this, a single byte
    // dropped mid-frame would keep bufIdx > 0 forever and every subsequent
    // packet would be misaligned.
    if (bufIdx > 0 && (millis() - lastByteMs) > SERIAL_FRAME_TIMEOUT_MS) {
#if DEBUG
        Serial.printf("framing: stale buffer (%d bytes) — resetting\n", bufIdx);
#endif
        bufIdx = 0;
    }
}
