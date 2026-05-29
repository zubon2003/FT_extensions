// YLED slave (normal) — ledslave_all minus the start-sequence reactions.
//
// Same firmware as ledslave_all (pilot fades over a base layer, race-rainbow
// toggle persisted in EEPROM, brightness over the air) except the slave does
// not react to the ready ('R') or countdown ('5'/'4'/'3'/'2'/'1') SYSTEM
// commands. Race start ('G') and race end ('E') still update the base layer.
//
// Base layer:
//   boot / E (race end)    → BASE_OFF or BASE_RAINBOW (per rainbowMode)
//   G (go / race start)    → BASE_OFF or BASE_RAINBOW_FAST (per rainbowMode)
//
// Overlay:
//   TYPE_PILOT             → fade-in → hold → fade-out in the pilot colour,
//                            blended over the current base layer.

#include <FastLED.h>
#include <esp_now.h>
#include <WiFi.h>
#include <esp_wifi.h>
#include <EEPROM.h>

// --- Hardware -------------------------------------------------------------

#define DATA_PIN    10
#define NUM_LEDS    300
#define BRIGHTNESS  64              // 0-255, used until EEPROM has a valid value

// --- EEPROM ---------------------------------------------------------------
// 3-byte layout: addr 0 holds a magic marker so we can distinguish a freshly
// erased flash from a saved value; addr 1 holds the brightness (1..255);
// addr 2 holds the race-rainbow mode flag (0 = lights off on G/E, 1 = rainbow).
#define EEPROM_SIZE         3
#define EEPROM_ADDR_MAGIC   0
#define EEPROM_ADDR_BRIGHT  1
#define EEPROM_ADDR_RBMODE  2
#define EEPROM_MAGIC        0xB7    // arbitrary, just != 0xFF (erased flash)

// --- Network --------------------------------------------------------------

#define CHANNEL     11              // Must match ledmaster.

// --- Protocol -------------------------------------------------------------

#define PACKET_SIZE  5
#define TYPE_PILOT   0x01
#define TYPE_SYSTEM  0x02

// --- Fade tuning ----------------------------------------------------------

#define FADE_IN_MS    500
#define FADE_HOLD_MS 1000
#define FADE_OUT_MS   500

// --- Rainbow tuning -------------------------------------------------------
// Hue advance interval. Smaller = faster cycling. SLOW is the "calm" rainbow
// used after race; FAST is the energetic in-race rainbow.
#define RAINBOW_DELAY_SLOW 20
#define RAINBOW_DELAY_FAST 4

// --- Base layer state -----------------------------------------------------

enum BaseMode : uint8_t {
    BASE_OFF,
    BASE_RAINBOW,        // slow rainbow
    BASE_RAINBOW_FAST,   // in-race energetic rainbow
};

// Race-rainbow mode flag. When true the G/E SYSTEM commands paint rainbows
// at race milestones; when false the slave keeps the historical behaviour
// (G = off, E = off). Toggled at runtime by the host via SYSTEM 'M' and
// persisted to EEPROM so the slave boots in the chosen mode.
static bool rainbowMode = false;

static CRGB         leds[NUM_LEDS];
static BaseMode     baseMode       = BASE_OFF;
static uint8_t      gHue           = 0;
static unsigned long lastRainbowUpdate = 0;

// --- Fade state machine ---------------------------------------------------

enum FadeState : uint8_t { FADE_IDLE, FADE_IN, FADE_HOLD, FADE_OUT };
static FadeState     fadeState      = FADE_IDLE;
static unsigned long fadeStateStart = 0;
static CRGB          fadeTarget     = CRGB::Black;

static void fadeStartPilot(CRGB color) {
    // Restart fade-in even if a previous fade is mid-flight so the most
    // recent detection is always shown immediately.
    fadeTarget     = color;
    fadeState      = FADE_IN;
    fadeStateStart = millis();
}

static void fadeCancel() {
    fadeState = FADE_IDLE;
}

// --- Base layer rendering -------------------------------------------------

static void advanceRainbowHue() {
    unsigned long now = millis();
    uint16_t interval = (baseMode == BASE_RAINBOW_FAST)
        ? RAINBOW_DELAY_FAST
        : RAINBOW_DELAY_SLOW;
    if (now - lastRainbowUpdate >= interval) {
        gHue += 5;
        lastRainbowUpdate = now;
    }
}

static bool isRainbowBase(BaseMode m) {
    return m == BASE_RAINBOW || m == BASE_RAINBOW_FAST;
}

// Compute the base-layer colour for one LED. Called both for direct base
// rendering and for fade blending so the overlay sits on top of the live
// base — e.g. a pilot pass during the rainbow blends over the rainbow.
static CRGB getBaseColor(int i) {
    switch (baseMode) {
        case BASE_RAINBOW:
        case BASE_RAINBOW_FAST:
            return CHSV(gHue + (i * 10), 255, 255);
        case BASE_OFF:
        default:
            return CRGB::Black;
    }
}

static void renderBase() {
    if (isRainbowBase(baseMode)) advanceRainbowHue();
    for (int i = 0; i < NUM_LEDS; i++) leds[i] = getBaseColor(i);
}

// --- Fade rendering -------------------------------------------------------
// Blend the pilot target over the live base. The base keeps advancing
// (rainbow hue, etc.) so the underlay still looks alive mid-fade.

static void renderFadeBlend(fract8 amount) {
    if (isRainbowBase(baseMode)) advanceRainbowHue();
    for (int i = 0; i < NUM_LEDS; i++) {
        CRGB base = getBaseColor(i);
        leds[i] = nblend(base, fadeTarget, amount);
    }
}

static void tickFade() {
    if (fadeState == FADE_IDLE) return;

    unsigned long elapsed = millis() - fadeStateStart;

    switch (fadeState) {
        case FADE_IN:
            if (elapsed >= FADE_IN_MS) {
                fadeState      = FADE_HOLD;
                fadeStateStart = millis();
                fill_solid(leds, NUM_LEDS, fadeTarget);
            } else {
                renderFadeBlend(map(elapsed, 0, FADE_IN_MS, 0, 255));
            }
            break;

        case FADE_HOLD:
            if (elapsed >= FADE_HOLD_MS) {
                fadeState      = FADE_OUT;
                fadeStateStart = millis();
            } else {
                fill_solid(leds, NUM_LEDS, fadeTarget);
            }
            break;

        case FADE_OUT:
            if (elapsed >= FADE_OUT_MS) {
                fadeState = FADE_IDLE;
            } else {
                renderFadeBlend(map(elapsed, 0, FADE_OUT_MS, 255, 0));
            }
            break;

        default:
            break;
    }
}

// --- Packet handling ------------------------------------------------------

static void onSystem(char cmd, uint8_t v2, uint8_t /*v3*/) {
    switch (cmd) {
        // 'R' and 5/4/3/2/1 are deliberately ignored on the normal slave —
        // start-sequence cues belong to ledslave_all / ledslave_countdown.
        case 'G':
            // Race started. Default: blank so pilot fades pop on dark.
            // Race-rainbow mode: kick off the fast rainbow as the race energy.
            baseMode = rainbowMode ? BASE_RAINBOW_FAST : BASE_OFF;
            break;
        case 'E':
            // Race ended. Default: blank. Race-rainbow mode: slow rainbow as
            // a calm post-race ambient.
            fadeCancel();
            baseMode = rainbowMode ? BASE_RAINBOW : BASE_OFF;
            break;
        case 'M': {
            // Mode toggle. V2 = 0 → race-rainbow OFF (legacy), V2 != 0 → ON.
            // Persist only on actual change. When the mode actually flips AND
            // the slave is idle (no race in progress, no pilot fade), reflect
            // the new mode visually right away so the operator sees the toggle
            // take effect without waiting for the next race event. Mid-race
            // toggles leave the live state alone.
            bool newMode = (v2 != 0);
            if (rainbowMode != newMode) {
                rainbowMode = newMode;
                EEPROM.write(EEPROM_ADDR_MAGIC, EEPROM_MAGIC);
                EEPROM.write(EEPROM_ADDR_RBMODE, newMode ? 1 : 0);
                EEPROM.commit();
                bool idle = fadeState == FADE_IDLE
                         && baseMode != BASE_RAINBOW_FAST;
                if (idle) {
                    baseMode = rainbowMode ? BASE_RAINBOW : BASE_OFF;
                }
            }
            break;
        }
        case 'T':
            // Test rainbow from the web UI — always show slow rainbow,
            // independent of rainbowMode (so the operator's test button
            // always shows colours, even when race-rainbow is disabled).
            fadeCancel();
            baseMode = BASE_RAINBOW;
            break;
        case 'X':
            // Test clear — force-blank the strip regardless of rainbowMode.
            // Pairs with 'T' to provide a mode-independent reset for tests.
            fadeCancel();
            baseMode = BASE_OFF;
            break;
        case 'B': {
            // Brightness update — V2 carries 1..255. Zero would blank the
            // strip entirely; the host clamps to 1 so a stray 0 from old
            // firmware doesn't accidentally turn everything off.
            uint8_t b = (v2 == 0) ? 1 : v2;
            FastLED.setBrightness(b);
            // Persist only on actual change to avoid wearing NVS on every
            // host reconnect (host re-sends current brightness on open).
            if (EEPROM.read(EEPROM_ADDR_MAGIC) != EEPROM_MAGIC ||
                EEPROM.read(EEPROM_ADDR_BRIGHT) != b) {
                EEPROM.write(EEPROM_ADDR_MAGIC, EEPROM_MAGIC);
                EEPROM.write(EEPROM_ADDR_BRIGHT, b);
                EEPROM.commit();
            }
            break;
        }
        default:
            break;
    }
}

static void processPacket(const uint8_t* p) {
    uint8_t id = p[0];
    if (id == TYPE_PILOT) {
        fadeStartPilot(CRGB(p[1], p[2], p[3]));
    } else if (id == TYPE_SYSTEM) {
        onSystem((char)p[1], p[2], p[3]);
    }
}

static void onReceiveData(const esp_now_recv_info_t* /*info*/, const uint8_t* data, int len) {
    if (len != PACKET_SIZE) return;
    uint8_t crc = data[0] ^ data[1] ^ data[2] ^ data[3];
    if (crc != data[4]) return;
    processPacket(data);
}

// --- Setup / loop ---------------------------------------------------------

void setup() {
    EEPROM.begin(EEPROM_SIZE);
    uint8_t storedBrightness = BRIGHTNESS;
    if (EEPROM.read(EEPROM_ADDR_MAGIC) == EEPROM_MAGIC) {
        uint8_t b = EEPROM.read(EEPROM_ADDR_BRIGHT);
        if (b != 0) storedBrightness = b;   // 0 would blank the strip
        // Treat anything other than exactly 1 (incl. 0xFF from older flash
        // layouts that only wrote 2 bytes) as "feature off" — preserves the
        // legacy behaviour for slaves upgraded without re-saving the mode.
        rainbowMode = (EEPROM.read(EEPROM_ADDR_RBMODE) == 1);
    }
    // Race-rainbow mode's idle visual is the slow rainbow itself, so the strip
    // shows it from boot even before the host has sent any packet. Legacy mode
    // keeps the historical "boot dark" behaviour.
    if (rainbowMode) baseMode = BASE_RAINBOW;

    FastLED.addLeds<WS2812B, DATA_PIN, GRB>(leds, NUM_LEDS);
    FastLED.setBrightness(storedBrightness);
    FastLED.clear();
    FastLED.show();

    Serial.begin(115200);
    delay(2000);
    Serial.println("YLED slave (normal) starting");

    WiFi.mode(WIFI_STA);
    esp_wifi_set_ps(WIFI_PS_NONE);
    WiFi.disconnect();
    delay(500);

    esp_wifi_set_channel(CHANNEL, WIFI_SECOND_CHAN_NONE);
    if (esp_now_init() != ESP_OK) {
        Serial.println("ESP-NOW init failed");
        return;
    }
    esp_now_register_recv_cb(onReceiveData);
    Serial.printf("Channel %d, %d LEDs — ready\n", CHANNEL, NUM_LEDS);
}

void loop() {
    if (fadeState != FADE_IDLE) {
        tickFade();
    } else {
        renderBase();
    }
    FastLED.show();
}
