// YLED slave (normal) — pilot-pass fade + rainbow idle.
//
// Receives 5-byte packets via ESP-NOW from ledmaster and renders them on a
// local WS2812B strip. Non-blocking fade state machine so a burst of pilot
// passes never gets queued behind a 2-second blocking delay — every new
// detection restarts the fade immediately.
//
// Rainbow speeds (system events change the speed; the rainbow itself never
// stops):
//   boot / E (end-of-race) → RAINBOW_DELAY_DEFAULT  (slow)
//   R (ready)              → RAINBOW_DELAY_READY    (medium)
//   G (go / race start)    → RAINBOW_DELAY_GO       (fast)
//
// Countdown digits (5/4/3/2/1) are ignored here — see ledslave_countdown.

#include <FastLED.h>
#include <esp_now.h>
#include <WiFi.h>
#include <esp_wifi.h>

// --- Hardware -------------------------------------------------------------

#define DATA_PIN    10
#define NUM_LEDS    300
#define BRIGHTNESS  64              // 0-255

// --- Network --------------------------------------------------------------

#define CHANNEL     11              // Must match ledmaster.

// --- Protocol -------------------------------------------------------------

#define PACKET_SIZE  5
#define TYPE_PILOT   0x01
#define TYPE_SYSTEM  0x02

// --- Fade tuning ----------------------------------------------------------
// Tweak these to adjust the pilot-pass visual without touching state logic.

#define FADE_IN_MS    500
#define FADE_HOLD_MS 1000
#define FADE_OUT_MS   500

// --- Rainbow tuning -------------------------------------------------------

#define RAINBOW_DELAY_DEFAULT 20    // ms between hue advances (idle)
#define RAINBOW_DELAY_READY   10    // 'R' system event — slow build-up
#define RAINBOW_DELAY_GO       2    // 'G' system event — max speed

// --- LED state ------------------------------------------------------------

static CRGB         leds[NUM_LEDS];
static bool         rainbowMode = true;
static uint8_t      rainbowDelay = RAINBOW_DELAY_DEFAULT;
static uint8_t      gHue = 0;
static unsigned long lastRainbowUpdate = 0;

// --- Fade state machine ---------------------------------------------------

enum FadeState : uint8_t { FADE_IDLE, FADE_IN, FADE_HOLD, FADE_OUT };
static FadeState     fadeState     = FADE_IDLE;
static unsigned long fadeStateStart = 0;
static CRGB          fadeTarget    = CRGB::Black;

static void fadeStartPilot(CRGB color) {
    // A new pilot pass while a previous fade is still running just restarts
    // fade-in with the new colour — the user sees the most recent detection
    // immediately rather than waiting for the previous fade to complete.
    fadeTarget     = color;
    fadeState      = FADE_IN;
    fadeStateStart = millis();
}

static void fadeCancel() {
    fadeState = FADE_IDLE;
}

// --- Rainbow rendering ----------------------------------------------------

static void updateRainbowBuffer() {
    unsigned long now = millis();
    if (now - lastRainbowUpdate >= rainbowDelay) {
        gHue += 5;
        lastRainbowUpdate = now;
    }
}

static CRGB getRainbowColor(int i) {
    return CHSV(gHue + (i * 10), 255, 255);
}

static void renderRainbow() {
    updateRainbowBuffer();
    for (int i = 0; i < NUM_LEDS; i++) leds[i] = getRainbowColor(i);
}

// --- Fade rendering -------------------------------------------------------
// All three phases keep the rainbow advancing in the background so the
// "underlay" looks alive even mid-fade. The blend amount drives how much of
// the pilot colour overrides it.

static void renderFadeBlend(fract8 amount) {
    updateRainbowBuffer();
    for (int i = 0; i < NUM_LEDS; i++) {
        CRGB base = getRainbowColor(i);
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

static void onSystem(char cmd) {
    switch (cmd) {
        case 'R':
            // Pre-race ready — slightly faster than idle to signal something
            // is about to happen.
            rainbowDelay = RAINBOW_DELAY_READY;
            rainbowMode  = true;
            break;
        case 'G':
            // Race start — max-speed rainbow.
            rainbowDelay = RAINBOW_DELAY_GO;
            rainbowMode  = true;
            break;
        case 'E':
            // Race ended / cancelled — cancel any in-flight pilot fade and
            // return to the slow idle rainbow. (Earlier revisions blanked
            // the strip here; the panel now stays alive between races.)
            fadeCancel();
            rainbowDelay = RAINBOW_DELAY_DEFAULT;
            rainbowMode  = true;
            break;
        // 5/4/3/2/1 countdown chars are deliberately ignored here; that's
        // ledslave_countdown's responsibility.
        default:
            break;
    }
}

static void processPacket(const uint8_t* p) {
    uint8_t id = p[0];
    if (id == TYPE_PILOT) {
        fadeStartPilot(CRGB(p[1], p[2], p[3]));
    } else if (id == TYPE_SYSTEM) {
        onSystem((char)p[1]);
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
    } else if (rainbowMode) {
        renderRainbow();
    }
    // rainbowMode stays true across all system events (R/G/E all keep the
    // rainbow running, at different speeds); the flag is kept as a hook for
    // any future "blank" command that wants to suppress rendering.
    if (fadeState != FADE_IDLE || rainbowMode) {
        FastLED.show();
    }
}
