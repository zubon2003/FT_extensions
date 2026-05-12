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

    async enqueueText(text, callback) {
        if (!this.enabled || !text) return;
        
        logger.debug(`[VoiceVox] synthesis start: "${text}"`);
        
        try {
            // 1. Immediately start synthesis (rendering)
            const base64Data = await this.generateAudioInternal(text);
            if (!base64Data) return;

            // 2. Trigger browser callback if needed
            if (callback) callback(base64Data);

            // 3. For server-side playback, add the generated buffer to the playback queue
            if (this.playOnServer && this.psProcess) {
                const buffer = Buffer.from(base64Data, 'base64');
                this.playQueue.push(buffer);
                this.processNextInQueue();
            }
        } catch (e) {
            logger.error(`[VoiceVox] pipeline error: ${e.message}`);
        }
    }

    async generateAudioInternal(text) {
        try {
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
        } catch (e) {
            throw e;
        }
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
