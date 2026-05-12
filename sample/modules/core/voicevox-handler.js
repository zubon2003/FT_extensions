const logger = require('./logger.js');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

class VoiceVoxHandler {
    constructor(config) {
        this.enabled = config.enabled || false;
        this.url = config.url || 'http://localhost:50021';
        this.speaker = config.speaker !== undefined ? config.speaker : 1;
        this.speed = config.speed || 1.2;
        this.volume = config.volume || 1.0;
        this.playOnServer = config.play_on_server || false;

        this.playQueue = [];
        this.isPlaying = false;
        this.psProcess = null;

        // Tail of a per-call promise chain so synth completions are delivered
        // to the browser (and to the server-side playback queue) in the order
        // enqueueText was called, regardless of how long each /synthesis takes.
        // The chain is fire-and-forget; rejections are swallowed in the catch.
        this._emitTail = Promise.resolve();
        // Bumped by clearQueue(); any pending synth whose captured generation
        // is older is dropped before the browser / server emit runs.
        this._generation = 0;

        if (this.enabled) {
            logger.info(`[VoiceVox] init speaker=${this.speaker} volume=${this.volume} speed=${this.speed}`);
            this.checkStatus();
            if (this.playOnServer) this.initPersistentPlayer();
        }
    }

    initPersistentPlayer() {
        // PowerShell script for sequential background playback
        const script = `
            Add-Type -AssemblyName PresentationCore
            $player = New-Object System.Windows.Media.MediaPlayer
            while($true) {
                $path = [Console]::ReadLine()
                if (!$path -or $path -eq "exit") { break }
                try {
                    $player.Open($path)
                    $player.Play()
                    # Wait for duration to be loaded
                    while($player.NaturalDuration.HasTimeSpan -eq $false) { [System.Threading.Thread]::Sleep(10) }
                    # Wait for playback to finish
                    [System.Threading.Thread]::Sleep($player.NaturalDuration.TimeSpan.TotalMilliseconds)
                    $player.Close()
                    # Clean up temp file if needed
                    if ($path -match "vv_temp_") { Remove-Item $path -ErrorAction SilentlyContinue }
                } catch {}
                Write-Host "DONE"
            }
        `;
        
        this.psProcess = spawn('powershell', ['-NoProfile', '-Command', script]);
        
        this.psProcess.stdout.on('data', (data) => {
            if (data.toString().trim().includes("DONE")) {
                this.isPlaying = false;
                this.processNextInQueue();
            }
        });

        this.psProcess.on('error', (err) => {
            logger.error(`[VoiceVox] Player error: ${err.message}`);
        });

        logger.info("[VoiceVox] persistent player ready (PowerShell)");
    }

    async checkStatus() {
        try {
            const res = await fetch(`${this.url}/version`);
            if (res.ok) logger.info('[VoiceVox] engine reachable');
        } catch (_e) { /* engine offline */ }
    }

    enqueueText(text, callback) {
        if (!this.enabled || !text) return;

        logger.debug(`[VoiceVox] synthesis start: "${text}"`);

        // Kick off /synthesis immediately so multiple calls run in parallel —
        // VOICEVOX is the rate-limit, not us. The deferred work (browser emit
        // and server playback enqueue) is then serialized through _emitTail so
        // a slow synth never overtakes a faster one queued after it.
        const gen = this._generation;
        const synthPromise = this.generateAudioInternal(text)
            .catch(e => {
                logger.error(`[VoiceVox] pipeline error: ${e.message}`);
                return null;
            });

        this._emitTail = this._emitTail.then(async () => {
            const base64Data = await synthPromise;
            if (!base64Data) return;
            // Race ended (or otherwise cleared) while this was synthesising —
            // drop the stale announcement instead of playing it into the
            // silence after RaceEnd.
            if (gen !== this._generation) return;

            if (callback) {
                try { callback(base64Data); } catch (e) { logger.error(`[VoiceVox] emit error: ${e.message}`); }
            }

            if (this.playOnServer && this.psProcess) {
                const buffer = Buffer.from(base64Data, 'base64');
                this.playQueue.push(buffer);
                this.processNextInQueue();
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

    processNextInQueue() {
        if (this.isPlaying || this.playQueue.length === 0 || !this.psProcess) return;

        this.isPlaying = true;
        const buffer = this.playQueue.shift();

        // Write buffer to a temp file for MediaPlayer to read
        const tempPath = path.join(os.tmpdir(), `vv_temp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.wav`);
        try {
            fs.writeFileSync(tempPath, buffer);
            // Send path to PowerShell player
            this.psProcess.stdin.write(path.normalize(tempPath) + "\n");
        } catch (e) {
            logger.error(`[VoiceVox] Playback error: ${e.message}`);
            this.isPlaying = false;
        }
    }

    clearQueue() {
        this._generation++;             // drops any synth in-flight when this returns
        const count = this.playQueue.length;
        this.playQueue = [];
        if (count) logger.info(`[VoiceVox] queue cleared (${count})`);
    }

    // Legacy support
    async generateAudio(text) {
        return this.generateAudioInternal(text).catch(() => null);
    }
}

module.exports = VoiceVoxHandler;
