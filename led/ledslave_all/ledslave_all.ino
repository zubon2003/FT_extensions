// YLED slave (all) — strip firmware that merges normal + countdown on one
// WS2812B strip. Receives 5-byte packets via ESP-NOW from ledmaster and
// renders them.
//
// Base layer (what fills the strip when no pilot fade is active):
//   boot / E (race end)    → BASE_OFF       (all black)
//   R (ready, ~8 s before) → BASE_RAINBOW   (slow rainbow)
//   5/4/3/2/1 (countdown)  → BASE_COUNTDOWN (first N*10 LEDs red, rest off)
//   G (go / race start)    → BASE_OFF       (blank — pilot fades pop on dark)
//
// Overlay:
//   TYPE_PILOT             → fade-in → hold → fade-out in the pilot colour,
//                            blended over the current base layer.
//
// A new pilot pass while a previous fade is still running restarts fade-in
// immediately with the new colour — every detection is seen, never queued.

#include <FastLED.h>
#include <esp_now.h>
#include <WiFi.h>
#include <esp_wifi.h>

// --- Hardware -------------------------------------------------------------

#define DATA_PIN    10
#define NUM_LEDS    50
#define BRIGHTNESS  64              // 0-255

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

#define RAINBOW_DELAY_SLOW 20       // ms between hue advances (slow rainbow)

// --- Countdown tuning -----------------------------------------------------
// LEDs lit per countdown digit: digit N → N * COUNTDOWN_STEP LEDs from the
// strip tail. 5 → 50, 4 → 40, …, 1 → 10. Clamped to NUM_LEDS in render.
#define COUNTDOWN_STEP 10
#define COUNTDOWN_COLOR_DEFAULT CRGB::Red

// --- Base layer state -----------------------------------------------------

enum BaseMode : uint8_t {
    BASE_OFF,
    BASE_RAINBOW,
    BASE_COUNTDOWN,
};

static CRGB         leds[NUM_LEDS];
static BaseMode     baseMode       = BASE_OFF;
static uint8_t      countdownDigit = 0;   // 1..5, only meaningful in BASE_COUNTDOWN
// Host packs an RGB565 colour into V2/V3 of the 5/4/3/2/1 SYSTEM packets so the
// operator can pick the countdown colour from the sample's web UI. Default red
// is used if no SYSTEM packet has updated it yet (host < v?, or first frame).
static CRGB         countdownColor = COUNTDOWN_COLOR_DEFAULT;
static uint8_t      gHue           = 0;
static unsigned long lastRainbowUpdate = 0;

// Unpack RGB565 (big-endian: hi=RRRRR GGG, lo=GGG BBBBB) to CRGB. Inputs are
// the two payload bytes that follow the digit char in TYPE_SYSTEM packets.
static CRGB rgb565ToCRGB(uint8_t hi, uint8_t lo) {
    uint16_t v = (uint16_t)hi << 8 | lo;
    uint8_t r5 = (v >> 11) & 0x1F;
    uint8_t g6 = (v >> 5)  & 0x3F;
    uint8_t b5 =  v        & 0x1F;
    // Expand to 8-bit by replicating the high bits into the low slots.
    uint8_t r8 = (r5 << 3) | (r5 >> 2);
    uint8_t g8 = (g6 << 2) | (g6 >> 4);
    uint8_t b8 = (b5 << 3) | (b5 >> 2);
    return CRGB(r8, g8, b8);
}

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
    if (now - lastRainbowUpdate >= RAINBOW_DELAY_SLOW) {
        gHue += 5;
        lastRainbowUpdate = now;
    }
}

// Compute the base-layer colour for one LED. Called both for direct base
// rendering and for fade blending so the overlay sits on top of the live
// base — e.g. a pilot pass during the rainbow blends over the rainbow.
static CRGB getBaseColor(int i) {
    switch (baseMode) {
        case BASE_RAINBOW:
            return CHSV(gHue + (i * 10), 255, 255);
        case BASE_COUNTDOWN: {
            // Lit segment is anchored to the END of the strip (highest indices).
            // Going 5 → 4 drops 10 LEDs from the LOW end of the lit segment,
            // so the strip visually shrinks "from the start" each step and the
            // remaining glow stays clustered near the strip's tail.
            int litCount = (int)countdownDigit * COUNTDOWN_STEP;
            if (litCount > NUM_LEDS) litCount = NUM_LEDS;
            return (i >= NUM_LEDS - litCount) ? countdownColor : CRGB::Black;
        }
        case BASE_OFF:
        default:
            return CRGB::Black;
    }
}

static void renderBase() {
    if (baseMode == BASE_RAINBOW) advanceRainbowHue();
    for (int i = 0; i < NUM_LEDS; i++) leds[i] = getBaseColor(i);
}

// --- Fade rendering -------------------------------------------------------
// Blend the pilot target over the live base. The base keeps advancing
// (rainbow hue, etc.) so the underlay still looks alive mid-fade.

static void renderFadeBlend(fract8 amount) {
    if (baseMode == BASE_RAINBOW) advanceRainbowHue();
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

static void onSystem(char cmd, uint8_t v2, uint8_t v3) {
    switch (cmd) {
        case 'R':
            baseMode = BASE_RAINBOW;
            break;
        case '5': case '4': case '3': case '2': case '1':
            baseMode       = BASE_COUNTDOWN;
            countdownDigit = (uint8_t)(cmd - '0');
            // V2/V3 carry an RGB565 packed colour. Zero is sent by older
            // hosts (and yields black, an obviously-broken display) so treat
            // 0x0000 as "no colour update" and keep the previous value.
            if (v2 != 0 || v3 != 0) {
                countdownColor = rgb565ToCRGB(v2, v3);
            }
            break;
        case 'G':
            // Race started — drop to blank base so pilot fades pop on dark.
            baseMode = BASE_OFF;
            break;
        case 'E':
            // Race ended — cancel any in-flight pilot fade and go dark.
            fadeCancel();
            baseMode = BASE_OFF;
            break;
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
    FastLED.addLeds<WS2812B, DATA_PIN, GRB>(leds, NUM_LEDS);
    FastLED.setBrightness(BRIGHTNESS);
    FastLED.clear();
    FastLED.show();

    Serial.begin(115200);
    delay(2000);
    Serial.println("YLED slave (all) starting");

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
