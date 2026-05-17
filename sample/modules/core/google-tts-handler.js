// Google Cloud Text-to-Speech handler.
//
// Uses the v1 REST endpoint with an API key — no SDK / service-account JSON
// dependency. Same surface as VoiceVoxHandler so server.js / event-router can
// treat them interchangeably via `ttsHandler`.
'use strict';

const logger = require('./logger.js');
const { AudioPlayer } = require('./audio-player.js');

const ENDPOINT = 'https://texttospeech.googleapis.com/v1/text:synthesize';

class GoogleTtsHandler {
    constructor(config = {}) {
        this.enabled = !!config.enabled;
        this.apiKey = config.apiKey || '';
        this.languageCode = config.languageCode || 'en-US';
        this.voiceName = config.voiceName || 'en-US-Neural2-J';
        this.speakingRate = typeof config.speakingRate === 'number' ? config.speakingRate : 1.0;
        this.pitch = typeof config.pitch === 'number' ? config.pitch : 0.0;
        this.volumeGainDb = typeof config.volumeGainDb === 'number' ? config.volumeGainDb : 0.0;
        // MP3 is the smallest payload and is playable by Windows MediaPlayer,
        // afplay, ffplay and sox. LINEAR16 / OGG_OPUS are also acceptable.
        this.audioEncoding = config.audioEncoding || 'MP3';

        this.player = new AudioPlayer({
            tag: 'GoogleTTS',
            tmpPrefix: 'gtts_temp_',
            ext: this.audioEncoding === 'LINEAR16' ? '.wav' : (this.audioEncoding === 'OGG_OPUS' ? '.ogg' : '.mp3'),
        });

        this._emitTail = Promise.resolve();
        this._generation = 0;

        if (this.enabled) {
            logger.info(`[GoogleTTS] init voice=${this.voiceName} (${this.languageCode}) encoding=${this.audioEncoding}`);
            if (!this.apiKey) {
                logger.warn('[GoogleTTS] enabled but apiKey is empty — synthesis will fail until a key is set');
            }
            this.player.init();
        }
    }

    ensurePlayer() {
        return this.player.ensureReady();
    }

    async speakOnServer(text) {
        if (!text) return;
        if (!this.ensurePlayer()) {
            throw new Error('no audio player available');
        }
        const base64Data = await this.generateAudioInternal(text);
        if (!base64Data) return;
        this.player.enqueue(Buffer.from(base64Data, 'base64'));
    }

    enqueueText(text, callback) {
        if (!this.enabled || !text) return;
        this.ensurePlayer();

        logger.debug(`[GoogleTTS] synthesis start: "${text}"`);

        const gen = this._generation;
        const synthPromise = this.generateAudioInternal(text)
            .catch(e => {
                logger.error(`[GoogleTTS] pipeline error: ${e.message}`);
                return null;
            });

        this._emitTail = this._emitTail.then(async () => {
            const base64Data = await synthPromise;
            if (!base64Data) return;
            if (gen !== this._generation) return;

            if (callback) {
                try { callback(base64Data); } catch (e) { logger.error(`[GoogleTTS] emit error: ${e.message}`); }
            }

            if (this.player.available()) {
                this.player.enqueue(Buffer.from(base64Data, 'base64'));
            }
        }).catch(() => { /* keep the chain alive */ });
    }

    async generateAudioInternal(text) {
        if (!this.apiKey) {
            throw new Error('Google TTS apiKey not configured');
        }
        const body = {
            input: { text },
            voice: { languageCode: this.languageCode, name: this.voiceName },
            audioConfig: {
                audioEncoding: this.audioEncoding,
                speakingRate: this.speakingRate,
                pitch: this.pitch,
                volumeGainDb: this.volumeGainDb,
            },
        };
        const res = await fetch(`${ENDPOINT}?key=${encodeURIComponent(this.apiKey)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const errText = await res.text().catch(() => '');
            throw new Error(`Google TTS HTTP ${res.status}: ${errText.slice(0, 200)}`);
        }
        const data = await res.json();
        // Google returns `audioContent` already base64-encoded.
        return data.audioContent || null;
    }

    clearQueue() {
        this._generation++;
        const count = this.player.clear();
        if (count) logger.info(`[GoogleTTS] queue cleared (${count})`);
    }

    async generateAudio(text) {
        return this.generateAudioInternal(text).catch(() => null);
    }
}

module.exports = GoogleTtsHandler;
