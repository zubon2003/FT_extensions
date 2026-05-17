// Shared OS-side audio playback queue used by TTS handlers (VOICEVOX, Google).
//
// Windows: long-lived PowerShell MediaPlayer process; paths are streamed via
// stdin so we don't pay the ~1-2s PowerShell start-up per clip.
// macOS/Linux: spawn an external CLI player (afplay / aplay / paplay / play /
// ffplay) per clip — startup is cheap there.
'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const logger = require('./logger.js');

const PLATFORM = os.platform();

function detectExternalPlayer() {
    if (PLATFORM === 'darwin') {
        return { cmd: 'afplay', baseArgs: [] };
    }
    if (PLATFORM === 'linux') {
        const candidates = [
            { cmd: 'ffplay', baseArgs: ['-nodisp', '-autoexit', '-loglevel', 'quiet'] },
            { cmd: 'play',   baseArgs: ['-q'] }, // sox
            { cmd: 'paplay', baseArgs: [] },
            { cmd: 'aplay',  baseArgs: ['-q'] },
        ];
        for (const c of candidates) {
            const r = spawnSync(c.cmd, ['--version'], { stdio: 'ignore' });
            if (r.status !== null) return c;
        }
    }
    return null;
}

class AudioPlayer {
    // tag:   short label used in log prefixes, e.g. "VoiceVox" / "GoogleTTS"
    // tmpPrefix: temp-file prefix; the PS host deletes files whose path
    //   contains this prefix after playback. Must be unique per handler so a
    //   sibling handler's tempfiles aren't reaped early.
    // ext:   tempfile extension including dot (".wav", ".mp3").
    constructor({ tag, tmpPrefix, ext }) {
        this.tag = tag;
        this.tmpPrefix = tmpPrefix;
        this.ext = ext;

        this.playQueue = [];
        this.isPlaying = false;
        this.psProcess = null;        // win32
        this.externalPlayer = null;   // darwin/linux
    }

    available() {
        return !!(this.psProcess || this.externalPlayer);
    }

    ensureReady() {
        if (this.available()) return true;
        this.init();
        return this.available();
    }

    init() {
        if (PLATFORM === 'win32') {
            // PowerShell MediaPlayer plays both WAV and MP3. The pattern in
            // `Remove-Item` is bound at spawn time so each handler only deletes
            // its own tempfiles.
            const script = `
                Add-Type -AssemblyName PresentationCore
                $player = New-Object System.Windows.Media.MediaPlayer
                while($true) {
                    $path = [Console]::ReadLine()
                    if (!$path -or $path -eq "exit") { break }
                    try {
                        $player.Open($path)
                        $player.Play()
                        while($player.NaturalDuration.HasTimeSpan -eq $false) { [System.Threading.Thread]::Sleep(10) }
                        [System.Threading.Thread]::Sleep($player.NaturalDuration.TimeSpan.TotalMilliseconds)
                        $player.Close()
                        if ($path -match "${this.tmpPrefix}") { Remove-Item $path -ErrorAction SilentlyContinue }
                    } catch {}
                    Write-Host "DONE"
                }
            `;

            this.psProcess = spawn('powershell', ['-NoProfile', '-Command', script]);
            this.psProcess.stdout.on('data', (data) => {
                if (data.toString().trim().includes('DONE')) {
                    this.isPlaying = false;
                    this.processNext();
                }
            });
            this.psProcess.on('error', (err) => {
                logger.error(`[${this.tag}] Player error: ${err.message}`);
            });
            logger.info(`[${this.tag}] persistent player ready (PowerShell)`);
            return;
        }

        this.externalPlayer = detectExternalPlayer();
        if (!this.externalPlayer) {
            logger.warn(`[${this.tag}] no audio player found on ${PLATFORM}. ` +
                'Install one of: ffplay (ffmpeg), play (sox), paplay (pulseaudio), aplay (alsa-utils).');
            return;
        }
        logger.info(`[${this.tag}] player ready (${PLATFORM}: ${this.externalPlayer.cmd})`);
    }

    enqueue(buffer) {
        this.playQueue.push(buffer);
        this.processNext();
    }

    clear() {
        const count = this.playQueue.length;
        this.playQueue = [];
        return count;
    }

    processNext() {
        if (this.isPlaying || this.playQueue.length === 0) return;
        if (!this.available()) return;

        this.isPlaying = true;
        const buffer = this.playQueue.shift();

        const tempPath = path.join(
            os.tmpdir(),
            `${this.tmpPrefix}${Date.now()}_${Math.random().toString(36).slice(2, 11)}${this.ext}`,
        );
        try {
            fs.writeFileSync(tempPath, buffer);
        } catch (e) {
            logger.error(`[${this.tag}] Playback error: ${e.message}`);
            this.isPlaying = false;
            return;
        }

        if (this.psProcess) {
            try {
                this.psProcess.stdin.write(path.normalize(tempPath) + '\n');
            } catch (e) {
                logger.error(`[${this.tag}] Playback error: ${e.message}`);
                this.isPlaying = false;
            }
            return;
        }

        const { cmd, baseArgs } = this.externalPlayer;
        const proc = spawn(cmd, [...baseArgs, tempPath]);
        const cleanup = () => {
            fs.unlink(tempPath, () => { /* best-effort */ });
            this.isPlaying = false;
            this.processNext();
        };
        proc.on('exit', cleanup);
        proc.on('error', (err) => {
            logger.error(`[${this.tag}] ${cmd} error: ${err.message}`);
            cleanup();
        });
    }
}

module.exports = { AudioPlayer, PLATFORM };
