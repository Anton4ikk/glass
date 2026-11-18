let spawn, EventEmitter;

if (typeof window === 'undefined') {
    spawn = require('child_process').spawn;
    EventEmitter = require('events').EventEmitter;
} else {
    class DummyEventEmitter {
        on() {}
        emit() {}
        removeAllListeners() {}
    }
    EventEmitter = DummyEventEmitter;
}

// listenCapture.js records PCM16 mono at 24 kHz; the WAV header must say so,
// otherwise whisper hears the audio slowed down and pitched down by 1.5x.
const INPUT_SAMPLE_RATE = 24000;
const BYTES_PER_SECOND = INPUT_SAMPLE_RATE * 2;

// Energy-based segmentation. Whisper hallucinates on silence/music
// ("[Музыка]", "Редактор субтитров А.Синецкая") and loses words when speech is
// cut into fixed 1.5 s slices, so audio is sent only as whole utterances.
const SPEECH_RMS_THRESHOLD = 0.01;      // same level the [MicRMS] diagnostics treat as speech
const END_OF_SPEECH_SILENCE_MS = 700;   // pause that closes an utterance
const MAX_UTTERANCE_MS = 12000;         // force a cut during long monologues
const MIN_SPEECH_MS = 300;              // ignore clicks and short bursts
const PRE_ROLL_MS = 300;                // keep audio just before speech onset
const CLOSE_DRAIN_TIMEOUT_MS = 10000;   // total time close() may wait for the last utterances
// Half the cores of an 8-core M1: the LLM, the browser and the call share the machine.
const { WHISPER_THREADS } = require('../../services/whisperServer');

// Phrases whisper produces from non-speech audio (artifacts of its subtitle
// training data). Bracketed tags are stripped separately.
const HALLUCINATION_PATTERNS = [
    /редактор субтитров/i,
    /корректор\s+[А-ЯЁ]\.\s?[А-ЯЁ]/,
    /субтитры (сделал|создавал|подготовил)/i,
    /продолжение следует/i,
    /спасибо за просмотр/i,
    /подписывайтесь на (наш )?канал/i,
    /thank you for watching/i,
    /subtitles by/i,
];

function chunkRms(buffer) {
    const samples = Math.floor(buffer.length / 2);
    if (samples === 0) return 0;
    let sumSq = 0;
    for (let i = 0; i < samples; i++) {
        const s = buffer.readInt16LE(i * 2) / 32768;
        sumSq += s * s;
    }
    return Math.sqrt(sumSq / samples);
}

// Resolves true if the promise settled within ms, false on timeout.
function withTimeout(promise, ms) {
    let timer;
    const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(false), Math.max(0, ms)); });
    return Promise.race([promise.then(() => true), timeout]).finally(() => clearTimeout(timer));
}

function cleanTranscription(text) {
    const cleaned = text
        .replace(/\[[^\]]*\]/g, ' ')
        .replace(/\([^)]*\)/g, ' ')
        .replace(/\*[^*]*\*/g, ' ')
        .replace(/\s+/g, ' ')
        // Decoder loops: "Это не надо. Это не надо. Это не надо." -> "Это не надо."
        .replace(/(\S.{2,}?)(?:[\s,.!?…-]*\1){2,}/giu, '$1')
        .trim();
    if (!cleaned) return '';
    if (HALLUCINATION_PATTERNS.some(re => re.test(cleaned))) return '';
    // All-caps lines like "ДИНАМИЧНАЯ МУЗЫКА" are sound captions, not speech.
    if (/^[^a-zа-яё]*$/.test(cleaned) && /[A-ZА-ЯЁ]{5,}/.test(cleaned)) return '';
    return cleaned;
}

class WhisperSTTSession extends EventEmitter {
    constructor(model, whisperService, sessionId, language = 'auto') {
        super();
        this.model = model;
        this.whisperService = whisperService;
        this.language = language || 'auto';
        this.sessionId = sessionId || `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        this.process = null;
        this.isRunning = false;
        this.audioBuffer = Buffer.alloc(0);
        this.processingInterval = null;
        this.lastTranscription = '';
        // Utterance state, see the segmentation constants above.
        this.speechStartedAt = 0;
        this.lastSpeechAt = 0;
        this.speechMs = 0;
        this.isProcessing = false;
        this.currentRun = null;
        // Shared whisper-server with the model loaded; null means whisper-cli per utterance.
        this.server = null;
        this.inflight = null;
    }

    async initialize() {
        try {
            await this.whisperService.ensureModelAvailable(this.model);
            await this.acquireServer();
            this.isRunning = true;
            this.startProcessingLoop();
            return true;
        } catch (error) {
            console.error('[WhisperSTT] Initialization error:', error);
            this.emit('error', error);
            return false;
        }
    }

    async acquireServer() {
        try {
            const [cliPath, modelPath] = await Promise.all([this.whisperService.getWhisperPath?.(), this.whisperService.getModelPath?.(this.model)]);
            if (!cliPath || !modelPath) return;
            this.server = await require('../../services/whisperServer').acquire(cliPath, modelPath);
        } catch (error) {
            console.warn(`[WhisperSTT-${this.sessionId}] whisper-server unavailable, using whisper-cli per utterance:`, error.message);
            this.server = null;
        }
    }

    startProcessingLoop() {
        this.processingInterval = setInterval(async () => {
            if (!this.speechStartedAt || this.isProcessing) return;

            const now = Date.now();
            const pauseEnded = now - this.lastSpeechAt >= END_OF_SPEECH_SILENCE_MS;
            const tooLong = now - this.speechStartedAt >= MAX_UTTERANCE_MS;
            if (!pauseEnded && !tooLong) return;

            const enoughSpeech = this.speechMs >= MIN_SPEECH_MS;
            const audioData = this.audioBuffer;
            this.audioBuffer = Buffer.alloc(0);
            this.speechStartedAt = 0;
            this.speechMs = 0;

            if (enoughSpeech) {
                console.log(`[WhisperSTT-${this.sessionId}] Processing utterance, ${(audioData.length / BYTES_PER_SECOND).toFixed(1)}s`);
                this.isProcessing = true;
                await this.processAudioChunk(audioData);
            }
        }, 200);
    }

    // Resolves once whisper-cli has exited and the transcription (if any) was emitted.
    processAudioChunk(audioData) {
        this.currentRun = this._runWhisper(audioData);
        return this.currentRun;
    }

    async _runWhisper(audioData) {
        if (!this.isRunning || audioData.length === 0) {
            this.isProcessing = false;
            return;
        }

        try {
            let result = null;
            if (this.server) {
                try {
                    result = await this._transcribeWithServer(audioData);
                } catch (error) {
                    // close() aborted the request on purpose: nothing to fall back to.
                    if (!this.isRunning) return;
                    console.warn(`[WhisperSTT-${this.sessionId}] whisper-server failed, using whisper-cli:`, error.message);
                }
            }
            if (!result) result = await this._transcribeWithCli(audioData);
            if (result) await this._handleResult(audioData, result);
        } catch (error) {
            console.error('[WhisperSTT] Processing error:', error);
            this.emit('error', error);
        } finally {
            this.isProcessing = false;
        }
    }

    /** @returns {Promise<{code: number, output: string, errorOutput: string}>} */
    async _transcribeWithServer(audioData) {
        const wav = Buffer.concat([this.whisperService.createWavHeader(audioData.length, INPUT_SAMPLE_RATE), audioData]);
        this.inflight = new AbortController();
        try {
            const output = await this.server.transcribe(wav, this.language, this.inflight.signal);
            return { code: 0, output, errorOutput: '' };
        } finally {
            this.inflight = null;
        }
    }

    /** One whisper-cli run (loads the model each time). Null if it could not start. */
    async _transcribeWithCli(audioData) {
        const tempFile = await this.whisperService.saveAudioToTemp(audioData, this.sessionId, INPUT_SAMPLE_RATE);
        if (!tempFile || typeof tempFile !== 'string') {
            console.error('[WhisperSTT] Invalid temp file path:', tempFile);
            return null;
        }
        try {
            const whisperPath = await this.whisperService.getWhisperPath();
            const modelPath = await this.whisperService.getModelPath(this.model);
            if (!whisperPath || !modelPath) {
                console.error('[WhisperSTT] Invalid whisper or model path:', { whisperPath, modelPath });
                return null;
            }
            // close() may have given up waiting while the file was being written.
            if (!this.isRunning) return null;

            // No --output-txt/--output-json: the text is read from stdout (those
            // files are named "<input>.wav.txt" and piled up in temp/). No
            // --print-progress: it is a valueless toggle, and a value after it is
            // parsed as a second input file.
            this.process = spawn(whisperPath, [
                '-m', modelPath,
                '-f', tempFile,
                '--no-timestamps',
                '--language', this.language,
                '--threads', String(WHISPER_THREADS),
            ]);

            let output = '';
            let errorOutput = '';
            this.process.stdout.on('data', data => { output += data.toString(); });
            this.process.stderr.on('data', data => { errorOutput += data.toString(); });
            // Without a listener a failed spawn would throw from the event emitter.
            this.process.on('error', error => { errorOutput += error.message; });

            const code = await new Promise(resolve => this.process.on('close', resolve));
            this.process = null;
            return { code, output, errorOutput };
        } finally {
            await this.whisperService.cleanupTempFile(tempFile);
        }
    }

    async _handleResult(audioData, { code, output, errorOutput }) {
        let transcription = '';
        let emitted = false;
        if (code === 0 && output.trim()) {
            transcription = cleanTranscription(output);
            if (transcription && transcription !== this.lastTranscription) {
                emitted = true;
                this.lastTranscription = transcription;
                this.emit('transcription', {
                    text: transcription,
                    timestamp: Date.now(),
                    confidence: 1.0,
                    sessionId: this.sessionId,
                });
            }
        } else if (errorOutput && this.isRunning) {
            // Not logged after close(): then the run was killed on purpose.
            console.error(`[WhisperSTT-${this.sessionId}] Process error:`, errorOutput);
        }

        // Includes chunks the filters dropped, which the DB never sees.
        await this.whisperService.logTranscription?.({
            session: this.sessionId,
            model: this.model,
            language: this.language,
            audioSec: +(audioData.length / BYTES_PER_SECOND).toFixed(2),
            code,
            raw: output.trim(),
            text: transcription,
            emitted,
            ...(code !== 0 && errorOutput ? { error: errorOutput.slice(-500) } : {}),
        });
    }

    sendRealtimeInput(audioData) {
        if (!this.isRunning) {
            console.warn(`[WhisperSTT-${this.sessionId}] Session not running, cannot accept audio`);
            return;
        }

        if (typeof audioData === 'string') {
            try {
                audioData = Buffer.from(audioData, 'base64');
            } catch (error) {
                console.error('[WhisperSTT] Failed to decode base64 audio data:', error);
                return;
            }
        } else if (audioData instanceof ArrayBuffer) {
            audioData = Buffer.from(audioData);
        } else if (!Buffer.isBuffer(audioData) && !(audioData instanceof Uint8Array)) {
            console.error('[WhisperSTT] Invalid audio data type:', typeof audioData);
            return;
        }

        if (!Buffer.isBuffer(audioData)) {
            audioData = Buffer.from(audioData);
        }

        if (audioData.length > 0) {
            this.audioBuffer = Buffer.concat([this.audioBuffer, audioData]);

            if (chunkRms(audioData) >= SPEECH_RMS_THRESHOLD) {
                const now = Date.now();
                if (!this.speechStartedAt) this.speechStartedAt = now;
                this.lastSpeechAt = now;
                this.speechMs += (audioData.length / BYTES_PER_SECOND) * 1000;
            } else if (!this.speechStartedAt) {
                // No speech yet: keep only a short pre-roll instead of the whole silence.
                const preRollBytes = Math.floor(BYTES_PER_SECOND * PRE_ROLL_MS / 1000) & ~1;
                if (this.audioBuffer.length > preRollBytes) {
                    this.audioBuffer = this.audioBuffer.subarray(this.audioBuffer.length - preRollBytes);
                }
            }
        }
    }

    async close() {
        console.log(`[WhisperSTT-${this.sessionId}] Closing session`);

        if (this.processingInterval) {
            clearInterval(this.processingInterval);
            this.processingInterval = null;
        }

        // Finish the utterance in flight and the one still being spoken, so the
        // last phrase before Stop isn't lost. Listeners are still attached here.
        // One deadline for both steps keeps Stop from hanging (e.g. on a cold model load).
        if (this.isRunning) {
            const deadline = Date.now() + CLOSE_DRAIN_TIMEOUT_MS;
            const inFlightDone = this.currentRun ? await withTimeout(this.currentRun, deadline - Date.now()) : true;
            // If the in-flight run timed out, don't start a second whisper next to it.
            if (inFlightDone && this.speechMs >= MIN_SPEECH_MS && Date.now() < deadline) {
                const audioData = this.audioBuffer;
                this.audioBuffer = Buffer.alloc(0);
                this.speechStartedAt = 0;
                this.speechMs = 0;
                this.isProcessing = true;
                await withTimeout(this.processAudioChunk(audioData), deadline - Date.now());
            }
        }
        this.isRunning = false;

        if (this.process) {
            this.process.kill('SIGTERM');
            this.process = null;
        }
        this.inflight?.abort();
        this.server?.release();
        this.server = null;

        this.removeAllListeners();
    }
}

class WhisperProvider {
    static async validateApiKey() {
        // Whisper is a local service, no API key validation needed.
        return { success: true };
    }

    constructor() {
        this.whisperService = null;
    }

    async initialize() {
        if (!this.whisperService) {
            this.whisperService = require('../../services/whisperService');
            if (!this.whisperService.isInitialized) {
                await this.whisperService.initialize();
            }
        }
    }

    async createSTT(config) {
        await this.initialize();
        
        // No silent default: falling back to a model nobody selected would also
        // download its weights behind the user's back.
        const model = config.model;
        if (!model) {
            throw new Error('Whisper STT requires a model; none is selected.');
        }
        const sessionType = config.sessionType || 'unknown';
        // Falls back to 'auto' only when nothing was configured; the user's
        // explicit choice beats whisper's own detection, which is unreliable
        // on chunks this short.
        const language = config.language || 'auto';
        console.log(`[WhisperProvider] Creating ${sessionType} STT session with model: ${model}, language: ${language}`);

        // Create unique session ID based on type
        const sessionId = `${sessionType}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
        const session = new WhisperSTTSession(model, this.whisperService, sessionId, language);
        
        // Log session creation
        console.log(`[WhisperProvider] Created session: ${sessionId}`);
        
        const initialized = await session.initialize();
        if (!initialized) {
            throw new Error('Failed to initialize Whisper STT session');
        }

        if (config.callbacks) {
            if (config.callbacks.onmessage) {
                session.on('transcription', config.callbacks.onmessage);
            }
            if (config.callbacks.onerror) {
                session.on('error', config.callbacks.onerror);
            }
            if (config.callbacks.onclose) {
                session.on('close', config.callbacks.onclose);
            }
        }

        return session;
    }

    async createLLM() {
        throw new Error('Whisper provider does not support LLM functionality');
    }

    async createStreamingLLM() {
        console.warn('[WhisperProvider] Streaming LLM is not supported by Whisper.');
        throw new Error('Whisper does not support LLM.');
    }
}

module.exports = {
    WhisperProvider,
    WhisperSTTSession,
    // Exported for tests.
    cleanTranscription,
    chunkRms,
};