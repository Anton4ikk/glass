let spawn, path, EventEmitter;

if (typeof window === 'undefined') {
    spawn = require('child_process').spawn;
    path = require('path');
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

function cleanTranscription(text) {
    const cleaned = text
        .replace(/\[[^\]]*\]/g, ' ')
        .replace(/\([^)]*\)/g, ' ')
        .replace(/\*[^*]*\*/g, ' ')
        .replace(/\s+/g, ' ')
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
    }

    async initialize() {
        try {
            await this.whisperService.ensureModelAvailable(this.model);
            this.isRunning = true;
            this.startProcessingLoop();
            return true;
        } catch (error) {
            console.error('[WhisperSTT] Initialization error:', error);
            this.emit('error', error);
            return false;
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

    async processAudioChunk(audioData) {
        if (!this.isRunning || audioData.length === 0) return;

        try {
            const tempFile = await this.whisperService.saveAudioToTemp(audioData, this.sessionId, INPUT_SAMPLE_RATE);
            
            if (!tempFile || typeof tempFile !== 'string') {
                console.error('[WhisperSTT] Invalid temp file path:', tempFile);
                this.isProcessing = false;
                return;
            }
            
            const whisperPath = await this.whisperService.getWhisperPath();
            const modelPath = await this.whisperService.getModelPath(this.model);

            if (!whisperPath || !modelPath) {
                console.error('[WhisperSTT] Invalid whisper or model path:', { whisperPath, modelPath });
                this.isProcessing = false;
                return;
            }

            this.process = spawn(whisperPath, [
                '-m', modelPath,
                '-f', tempFile,
                '--no-timestamps',
                '--output-txt',
                '--output-json',
                '--language', this.language,
                '--threads', '4'
                // No --print-progress: it is a valueless toggle in whisper-cli,
                // so the 'false' that used to follow it was parsed as a second
                // input file ("error: input file not found 'false'") and could
                // make the run exit non-zero, discarding a good transcription.
                // Progress printing is off by default anyway.
            ]);

            let output = '';
            let errorOutput = '';

            this.process.stdout.on('data', (data) => {
                output += data.toString();
            });

            this.process.stderr.on('data', (data) => {
                errorOutput += data.toString();
            });

            this.process.on('close', async (code) => {
                this.process = null;
                this.isProcessing = false;
                
                if (code === 0 && output.trim()) {
                    const transcription = cleanTranscription(output);
                    if (transcription && transcription !== this.lastTranscription) {
                        this.lastTranscription = transcription;
                        console.log(`[WhisperSTT-${this.sessionId}] Transcription: "${transcription}"`);
                        this.emit('transcription', {
                            text: transcription,
                            timestamp: Date.now(),
                            confidence: 1.0,
                            sessionId: this.sessionId
                        });
                    }
                } else if (errorOutput) {
                    console.error(`[WhisperSTT-${this.sessionId}] Process error:`, errorOutput);
                }

                await this.whisperService.cleanupTempFile(tempFile);
            });

        } catch (error) {
            this.isProcessing = false;
            console.error('[WhisperSTT] Processing error:', error);
            this.emit('error', error);
        }
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
        this.isRunning = false;

        if (this.processingInterval) {
            clearInterval(this.processingInterval);
            this.processingInterval = null;
        }

        if (this.process) {
            this.process.kill('SIGTERM');
            this.process = null;
        }

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
        
        const model = config.model || 'whisper-tiny';
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
    WhisperSTTSession
};