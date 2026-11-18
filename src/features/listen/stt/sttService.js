const { spawn } = require('child_process');
const { createSTT } = require('../../common/ai/factory');
const modelStateService = require('../../common/services/modelStateService');

// A turn ends after this much silence from the STT provider.
const COMPLETION_DEBOUNCE_MS = 2000;
// Keep-alives stay well below the 2-5 min idle timeout of provider websockets.
const KEEP_ALIVE_INTERVAL_MS = 60 * 1000;
// Sessions are recreated before the 30-minute hard limit some providers enforce.
const SESSION_RENEW_INTERVAL_MS = 20 * 60 * 1000;
// Old and new sockets run in parallel this long, so no audio is lost at the swap.
const SOCKET_OVERLAP_MS = 2 * 1000;

const WHISPER_NOISE = ['[BLANK_AUDIO]', '[INAUDIBLE]', '[MUSIC]', '[SOUND]', '[NOISE]', '(BLANK_AUDIO)', '(INAUDIBLE)', '(MUSIC)', '(SOUND)', '(NOISE)'];

// SystemAudioDump writes 24 kHz 16-bit stereo PCM; STT gets 100 ms mono chunks.
const SYSTEM_AUDIO_SAMPLE_RATE = 24000;
const SYSTEM_AUDIO_CHUNK_BYTES = SYSTEM_AUDIO_SAMPLE_RATE * 2 /* bytes */ * 2 /* channels */ * 0.1;

// "Me" is the microphone, "Them" the system audio.
const SPEAKERS = ['Me', 'Them'];
const newTurn = () => ({ buffer: '', utterance: '', timer: null });

/** Wraps base64 PCM in the shape each provider's sendRealtimeInput expects. */
function toProviderPayload(provider, base64Data, mimeType) {
    if (provider === 'gemini') return { audio: { data: base64Data, mimeType: mimeType || 'audio/pcm;rate=24000' } };
    if (provider === 'deepgram') return Buffer.from(base64Data, 'base64');
    return base64Data;
}

/** Keeps the left channel of 16-bit interleaved stereo PCM. */
function convertStereoToMono(stereoBuffer) {
    const samples = stereoBuffer.length / 4;
    const mono = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i++) {
        mono.writeInt16LE(stereoBuffer.readInt16LE(i * 4), i * 2);
    }
    return mono;
}

class SttService {
    constructor() {
        this.sessions = { Me: null, Them: null };
        this.turns = { Me: newTurn(), Them: newTurn() };
        this.systemAudioProc = null;
        this.keepAliveInterval = null;
        this.sessionRenewTimeout = null;
        // Bumped by closeSessions(), so sessions that finish connecting after
        // Stop (an in-flight init or renewal) are closed instead of leaking.
        this.generation = 0;
        this.modelInfo = null;

        this.onTranscriptionComplete = null;
        this.onStatusUpdate = null;
    }

    setCallbacks({ onTranscriptionComplete, onStatusUpdate }) {
        this.onTranscriptionComplete = onTranscriptionComplete;
        this.onStatusUpdate = onStatusUpdate;
    }

    // Listen events go to the listen window only (the Ask window would react to them too).
    sendToRenderer(channel, data) {
        const { windowPool } = require('../../../window/windowManager');
        const listenWindow = windowPool?.get('listen');
        if (listenWindow && !listenWindow.isDestroyed()) {
            listenWindow.webContents.send(channel, data);
        }
    }

    sendPartial(speaker, text) {
        this.sendToRenderer('stt-update', { speaker, text, isPartial: true, isFinal: false, timestamp: Date.now() });
    }

    /** Ends the speaker's turn. Returns the save promise so closeSessions() can wait for it. */
    flushCompletion(speaker) {
        const turn = this.turns[speaker];
        if (turn.timer) {
            clearTimeout(turn.timer);
            turn.timer = null;
        }
        const finalText = (turn.buffer + turn.utterance).trim();
        if (!this.modelInfo || !finalText) return;

        const saved = this.onTranscriptionComplete?.(speaker, finalText);
        this.sendToRenderer('stt-update', { speaker, text: finalText, isPartial: false, isFinal: true, timestamp: Date.now() });

        turn.buffer = '';
        turn.utterance = '';
        this.onStatusUpdate?.('Listening...');
        return saved;
    }

    debounceCompletion(speaker, text) {
        const turn = this.turns[speaker];
        // Gemini streams word pieces with their own spacing.
        const separator = this.modelInfo?.provider === 'gemini' || !turn.buffer ? '' : ' ';
        turn.buffer += separator + text;

        if (turn.timer) clearTimeout(turn.timer);
        turn.timer = setTimeout(() => this.flushCompletion(speaker), COMPLETION_DEBOUNCE_MS);
    }

    /** An interim result means the speaker is still talking: hold the turn open. */
    holdCompletion(speaker) {
        const turn = this.turns[speaker];
        if (turn.timer) clearTimeout(turn.timer);
        turn.timer = null;
    }

    handleMessage(speaker, message) {
        if (!message || typeof message !== 'object' || !this.modelInfo) return;
        const turn = this.turns[speaker];

        switch (this.modelInfo.provider) {
            case 'whisper': {
                const text = message.text?.trim();
                if (!text) return;
                if (text.length <= 2 || WHISPER_NOISE.some(p => text.includes(p))) return;
                this.debounceCompletion(speaker, text);
                // A growing partial; the debounced flush replaces it with the final turn.
                this.sendPartial(speaker, turn.buffer);
                return;
            }

            case 'gemini': {
                if (message.serverContent?.turnComplete) {
                    if (turn.timer) this.flushCompletion(speaker);
                    return;
                }
                const chunk = message.serverContent?.inputTranscription?.text;
                if (!chunk || !chunk.trim() || chunk.trim() === '<noise>') return;
                this.debounceCompletion(speaker, chunk);
                this.sendPartial(speaker, turn.buffer);
                return;
            }

            case 'deepgram': {
                const text = message.channel?.alternatives?.[0]?.transcript;
                if (!text || !text.trim()) return;
                if (message.is_final) {
                    turn.utterance = '';
                    this.debounceCompletion(speaker, text);
                } else {
                    this.holdCompletion(speaker);
                    turn.utterance = text;
                    this.sendPartial(speaker, `${turn.buffer} ${turn.utterance}`.trim());
                }
                return;
            }

            default: {
                // OpenAI realtime transcription events.
                const text = message.transcript || message.delta || message.alternatives?.[0]?.transcript || '';
                if (message.type === 'conversation.item.input_audio_transcription.delta') {
                    this.holdCompletion(speaker);
                    turn.utterance += text;
                    if (text && !text.includes('vq_lbr_audio_')) {
                        this.sendPartial(speaker, turn.buffer + (turn.buffer ? ' ' : '') + turn.utterance);
                    }
                } else if (message.type === 'conversation.item.input_audio_transcription.completed' && text.trim()) {
                    turn.utterance = '';
                    this.debounceCompletion(speaker, text.trim());
                }
                if (message.error) console.error(`[SttService] ${speaker} STT session error:`, message.error);
            }
        }
    }

    async initializeSttSessions(language = 'en') {
        const effectiveLanguage = (process.env.OPENAI_TRANSCRIBE_LANG || language || 'en').trim();
        const generation = this.generation;

        const modelInfo = await modelStateService.getCurrentModelInfo('stt');
        if (!modelInfo || !modelInfo.apiKey) {
            throw new Error('AI model or API key is not configured.');
        }
        this.modelInfo = modelInfo;
        console.log(`[SttService] Initializing STT for ${modelInfo.provider} using model ${modelInfo.model}`);

        const optionsFor = speaker => ({
            apiKey: modelInfo.apiKey,
            // Cloud providers ignore the model (they use a fixed one); Whisper needs it.
            model: modelInfo.model,
            language: effectiveLanguage,
            // Whisper keeps a separate segmenter per session type.
            sessionType: speaker === 'Me' ? 'my' : 'their',
            callbacks: {
                onmessage: message => this.handleMessage(speaker, message),
                onerror: error => console.error(`[SttService] ${speaker} STT session error:`, error.message),
                onclose: event => console.log(`[SttService] ${speaker} STT session closed:`, event?.reason),
            },
        });

        // allSettled: if one session fails, the other one must still be closed,
        // or every retry of the caller leaks an open socket (or whisper process).
        const results = await Promise.allSettled(SPEAKERS.map(speaker => createSTT(modelInfo.provider, optionsFor(speaker))));
        const created = results.filter(r => r.status === 'fulfilled').map(r => r.value);
        const failure = results.find(r => r.status === 'rejected');
        if (failure || generation !== this.generation) {
            created.forEach(session => Promise.resolve(session?.close?.()).catch(() => {}));
            if (failure) throw failure.reason;
            throw new Error('STT sessions were closed while connecting.');
        }
        [this.sessions.Me, this.sessions.Them] = created;

        if (this.keepAliveInterval) clearInterval(this.keepAliveInterval);
        this.keepAliveInterval = setInterval(() => this._sendKeepAlive(), KEEP_ALIVE_INTERVAL_MS);

        if (this.sessionRenewTimeout) clearTimeout(this.sessionRenewTimeout);
        this.sessionRenewTimeout = setTimeout(() => {
            this.renewSessions(language).catch(err => console.error('[SttService] Failed to renew STT sessions:', err));
        }, SESSION_RENEW_INTERVAL_MS);

        return true;
    }

    // Only OpenAI needs it: Gemini's SDK sends its own heartbeats.
    _sendKeepAlive() {
        if (!this.isSessionActive() || this.modelInfo?.provider !== 'openai') return;
        try {
            this.sessions.Me?.keepAlive?.();
            this.sessions.Them?.keepAlive?.();
        } catch (err) {
            console.error('[SttService] keepAlive error:', err.message);
        }
    }

    /** Replaces the sessions with fresh ones; audio capture keeps running through the swap. */
    async renewSessions(language = 'en') {
        if (!this.isSessionActive()) return;
        const oldSessions = [this.sessions.Me, this.sessions.Them];

        await this.initializeSttSessions(language);

        setTimeout(() => {
            for (const session of oldSessions) {
                Promise.resolve(session?.close?.()).catch(err => console.error('[SttService] Error closing old STT session:', err.message));
            }
        }, SOCKET_OVERLAP_MS);
    }

    async sendAudio(speaker, data, mimeType) {
        const session = this.sessions[speaker];
        if (!session || !this.modelInfo) {
            throw new Error(`${speaker} STT session not active`);
        }
        await session.sendRealtimeInput(toProviderPayload(this.modelInfo.provider, data, mimeType));
    }

    async sendMicAudioContent(data, mimeType) {
        await this.sendAudio('Me', data, mimeType);
    }

    async sendSystemAudioContent(data, mimeType) {
        await this.sendAudio('Them', data, mimeType);
        return { success: true };
    }

    /** System audio from the renderer (Windows loopback); echoed back as the AEC reference. */
    async handleSendSystemAudioContent(data, mimeType) {
        try {
            await this.sendSystemAudioContent(data, mimeType);
            this.sendToRenderer('system-audio-data', { data });
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    killExistingSystemAudioDump() {
        return new Promise(resolve => {
            const killProc = spawn('pkill', ['-f', 'SystemAudioDump'], { stdio: 'ignore' });
            const timeout = setTimeout(() => {
                killProc.kill();
                resolve();
            }, 2000);
            const done = () => {
                clearTimeout(timeout);
                resolve();
            };
            killProc.on('close', done);
            killProc.on('error', done);
        });
    }

    isMacOSAudioRunning() {
        return !!this.systemAudioProc;
    }

    async startMacOSAudioCapture() {
        if (process.platform !== 'darwin' || !this.sessions.Them) return false;

        await this.killExistingSystemAudioDump();

        const { app } = require('electron');
        const path = require('path');
        const systemAudioPath = app.isPackaged
            ? path.join(process.resourcesPath, 'app.asar.unpacked', 'src', 'ui', 'assets', 'SystemAudioDump')
            : path.join(app.getAppPath(), 'src', 'ui', 'assets', 'SystemAudioDump');

        const proc = spawn(systemAudioPath, [], { stdio: ['ignore', 'pipe', 'pipe'] });
        if (!proc.pid) {
            console.error('[SttService] Failed to start SystemAudioDump');
            return false;
        }
        this.systemAudioProc = proc;
        console.log('[SttService] SystemAudioDump started with PID:', proc.pid);

        // Collected chunks are copied out once per 100 ms chunk instead of
        // re-concatenating the whole pending buffer on every stdout read.
        const pending = [];
        let pendingBytes = 0;
        proc.stdout.on('data', data => {
            pending.push(data);
            pendingBytes += data.length;
            if (pendingBytes < SYSTEM_AUDIO_CHUNK_BYTES) return;

            let buffer = Buffer.concat(pending, pendingBytes);
            pending.length = 0;
            while (buffer.length >= SYSTEM_AUDIO_CHUNK_BYTES) {
                const base64Data = convertStereoToMono(buffer.subarray(0, SYSTEM_AUDIO_CHUNK_BYTES)).toString('base64');
                buffer = buffer.subarray(SYSTEM_AUDIO_CHUNK_BYTES);

                // The AEC reference for the microphone in the renderer.
                this.sendToRenderer('system-audio-data', { data: base64Data });
                if (this.sessions.Them) {
                    this.sendAudio('Them', base64Data).catch(err => console.error('[SttService] Error sending system audio:', err.message));
                }
            }
            if (buffer.length) pending.push(buffer);
            pendingBytes = buffer.length;
        });

        proc.stderr.on('data', data => console.error('[SttService] SystemAudioDump stderr:', data.toString()));

        // A late 'close' from a stopped process must not forget its successor.
        const forget = () => {
            if (this.systemAudioProc === proc) this.systemAudioProc = null;
        };
        proc.on('close', code => {
            console.log('[SttService] SystemAudioDump exited with code:', code);
            forget();
        });
        proc.on('error', err => {
            console.error('[SttService] SystemAudioDump process error:', err);
            forget();
        });

        return true;
    }

    stopMacOSAudioCapture() {
        if (this.systemAudioProc) {
            this.systemAudioProc.kill('SIGTERM');
            this.systemAudioProc = null;
        }
    }

    isSessionActive() {
        return !!this.sessions.Me && !!this.sessions.Them;
    }

    async closeSessions() {
        this.generation++;
        this.stopMacOSAudioCapture();

        clearInterval(this.keepAliveInterval);
        clearTimeout(this.sessionRenewTimeout);
        this.keepAliveInterval = null;
        this.sessionRenewTimeout = null;

        // Close first: providers like Whisper still deliver the final utterance
        // while closing, which lands in the turn buffers flushed below.
        const closing = SPEAKERS.map(speaker => this.sessions[speaker]?.close());
        this.sessions = { Me: null, Them: null };
        await Promise.all(closing);

        // Flush instead of dropping the turns still waiting for the debounce,
        // and wait until they are saved so the caller sees the full conversation.
        await Promise.all(SPEAKERS.map(speaker => this.flushCompletion(speaker)));

        this.turns = { Me: newTurn(), Them: newTurn() };
        this.modelInfo = null;
    }
}

module.exports = SttService;
// Exported for tests.
module.exports.convertStereoToMono = convertStereoToMono;
module.exports.toProviderPayload = toProviderPayload;
