'use strict';

const logger = require('./logger.js');
const { AudioPlayer } = require('./audio-player.js');

class VoiceVoxHandler {
    constructor(config) {
        this.enabled = config.enabled || false;
        this.url = config.url || 'http://localhost:50021';
        // Loose `!= null` catches both undefined AND explicit null in
        // config.json — an explicit null would otherwise be sent as
        // `speaker=null`, which VOICEVOX rejects with HTTP 422 (no audio).
        this.speaker = config.speaker != null ? config.speaker : 3;
        this.speed = config.speed || 1.2;
        this.volume = config.volume || 1.0;

        this.player = new AudioPlayer({ tag: 'VoiceVox', tmpPrefix: 'vv_temp_', ext: '.wav' });

        // Tail of a per-call promise chain so synth completions are delivered
        // to the browser (and to the server-side playback queue) in the order
        // enqueueText was called, regardless of how long each /synthesis takes.
        this._emitTail = Promise.resolve();
        // Bumped by clearQueue(); any pending synth whose captured generation
        // is older is dropped before the browser / server emit runs.
        this._generation = 0;

        if (this.enabled) {
            logger.info(`[VoiceVox] init speaker=${this.speaker} volume=${this.volume} speed=${this.speed}`);
            this.checkStatus();
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

    async checkStatus() {
        try {
            const res = await fetch(`${this.url}/version`);
            if (res.ok) logger.info('[VoiceVox] engine reachable');
        } catch (_e) { /* engine offline */ }
    }

    enqueueText(text, callback) {
        if (!this.enabled || !text) return;

        // Lazy-init the OS player so flipping enabled=false→true at runtime
        // wires up server-side playback for the next race-driven announcement.
        this.ensurePlayer();

        logger.debug(`[VoiceVox] synthesis start: "${text}"`);

        const gen = this._generation;
        const synthPromise = this.generateAudioInternal(text)
            .catch(e => {
                logger.error(`[VoiceVox] pipeline error: ${e.message}`);
                return null;
            });

        this._emitTail = this._emitTail.then(async () => {
            const base64Data = await synthPromise;
            if (!base64Data) return;
            if (gen !== this._generation) return;

            if (callback) {
                try { callback(base64Data); } catch (e) { logger.error(`[VoiceVox] emit error: ${e.message}`); }
            }

            if (this.player.available()) {
                this.player.enqueue(Buffer.from(base64Data, 'base64'));
            }
        }).catch(() => { /* keep the chain alive on any unexpected error */ });
    }

    async generateAudioInternal(text) {
        const queryRes = await fetch(`${this.url}/audio_query?text=${encodeURIComponent(text)}&speaker=${this.speaker}`, {
            method: 'POST'
        });
        const query = await queryRes.json();
        query.speedScale = this.speed;
        query.volumeScale = this.volume;

        const synthRes = await fetch(`${this.url}/synthesis?speaker=${this.speaker}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(query)
        });
        const buffer = await synthRes.arrayBuffer();
        return Buffer.from(buffer).toString('base64');
    }

    clearQueue() {
        this._generation++;
        const count = this.player.clear();
        if (count) logger.info(`[VoiceVox] queue cleared (${count})`);
    }

    async generateAudio(text) {
        return this.generateAudioInternal(text).catch(() => null);
    }
}

module.exports = VoiceVoxHandler;
