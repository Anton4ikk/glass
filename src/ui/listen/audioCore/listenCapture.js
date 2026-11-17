const createAecModule = require('./aec.js');

const SAMPLE_RATE = 24000;
// 100 ms chunks go to STT.
const SAMPLES_PER_CHUNK = SAMPLE_RATE / 10;
const BUFFER_SIZE = 4096;
// Speech is quiet after the OS processing: both streams are boosted before STT.
const GAIN = 4.0;
const MIME_TYPE = 'audio/pcm;rate=24000';

// The Rust echo canceller works on 10 ms frames at 24 kHz.
const AEC_FRAME = 160;
// System audio arrives every 100 ms; anything older means it has stopped.
const AEC_REFERENCE_MAX_AGE_MS = 500;

const MIC_CONSTRAINTS = {
    audio: { sampleRate: SAMPLE_RATE, channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: false,
};

const isLinux = window.api.platform.isLinux;
const isMacOS = window.api.platform.isMacOS;

let mediaStream = null;
let micMediaStream = null;
let audioContext = null;
let audioProcessor = null;
let systemAudioContext = null;
let systemAudioProcessor = null;

// Latest system audio chunk, the echo reference for the microphone.
let latestSystemAudio = null;

// ---------------------------------------------------------------------------
// Echo cancellation (WASM)
// ---------------------------------------------------------------------------
let aecPromise = null;

/** Loads the WASM canceller once. Resolves to null if it can't load: capture then runs without AEC. */
function getAec() {
    if (!aecPromise) {
        aecPromise = createAecModule()
            .then(mod => {
                const create = mod.cwrap('AecNew', 'number', ['number', 'number', 'number', 'number']);
                const cancel = mod.cwrap('AecCancelEcho', null, ['number', 'number', 'number', 'number', 'number']);
                const bytes = AEC_FRAME * 2;
                // One canceller and one set of frame buffers, reused for every frame.
                return {
                    mod,
                    cancel,
                    ptr: create(AEC_FRAME, 1600, SAMPLE_RATE, 1),
                    micPtr: mod._malloc(bytes),
                    echoPtr: mod._malloc(bytes),
                    outPtr: mod._malloc(bytes),
                };
            })
            .catch(error => {
                console.warn('[listenCapture] AEC unavailable, continuing without echo cancellation:', error);
                return null;
            });
    }
    return aecPromise;
}

function writeInt16(target, source) {
    for (let i = 0; i < source.length; i++) {
        const s = Math.max(-1, Math.min(1, source[i]));
        target[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
}

/** Subtracts the system audio (what the speakers play) from the microphone signal. */
function runAec(aec, micF32, sysF32) {
    const { mod, cancel, ptr, micPtr, echoPtr, outPtr } = aec;
    const out = new Float32Array(micF32.length);
    const echo = new Float32Array(micF32.length);
    echo.set(sysF32.subarray(0, Math.min(micF32.length, sysF32.length)));

    for (let offset = 0; offset + AEC_FRAME <= micF32.length; offset += AEC_FRAME) {
        // Views are made per frame: WASM memory growth detaches older ones.
        const heap = mod.HEAP16 ? mod.HEAP16.buffer : mod.HEAPU8.buffer;
        writeInt16(new Int16Array(heap, micPtr, AEC_FRAME), micF32.subarray(offset, offset + AEC_FRAME));
        writeInt16(new Int16Array(heap, echoPtr, AEC_FRAME), echo.subarray(offset, offset + AEC_FRAME));
        cancel(ptr, micPtr, echoPtr, outPtr, AEC_FRAME);
        const result = new Int16Array(mod.HEAP16 ? mod.HEAP16.buffer : mod.HEAPU8.buffer, outPtr, AEC_FRAME);
        for (let i = 0; i < AEC_FRAME; i++) out[offset + i] = result[i] / 32768;
    }
    return out;
}

// ---------------------------------------------------------------------------
// PCM helpers
// ---------------------------------------------------------------------------
function base64ToFloat32Array(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const int16 = new Int16Array(bytes.buffer);
    const out = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) out[i] = int16[i] / 32768;
    return out;
}

/** Applies the gain and encodes as base64 16-bit PCM. */
function encodeChunk(f32) {
    const boosted = new Float32Array(f32.length);
    for (let i = 0; i < f32.length; i++) boosted[i] = f32[i] * GAIN;
    const int16 = new Int16Array(f32.length);
    writeInt16(int16, boosted);

    const bytes = new Uint8Array(int16.buffer);
    let binary = '';
    // fromCharCode over slices instead of one call per byte.
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
}

/**
 * Collects the processor's 4096-sample callbacks into fixed 100 ms chunks
 * in a preallocated buffer (no per-sample array pushes on the audio thread).
 */
function createChunker(onChunk) {
    const pending = new Float32Array(SAMPLES_PER_CHUNK);
    let filled = 0;
    return input => {
        let read = 0;
        while (read < input.length) {
            const n = Math.min(SAMPLES_PER_CHUNK - filled, input.length - read);
            pending.set(input.subarray(read, read + n), filled);
            filled += n;
            read += n;
            if (filled === SAMPLES_PER_CHUNK) {
                onChunk(pending.slice());
                filled = 0;
            }
        }
    };
}

window.api.listenCapture.onSystemAudioData((event, { data }) => {
    latestSystemAudio = { data, timestamp: Date.now() };
});

// ---------------------------------------------------------------------------
// Audio graphs
// ---------------------------------------------------------------------------
async function setupMicProcessing(micStream) {
    const aec = await getAec();

    const micAudioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
    await micAudioContext.resume();
    const micSource = micAudioContext.createMediaStreamSource(micStream);
    const micProcessor = micAudioContext.createScriptProcessor(BUFFER_SIZE, 1, 1);

    const chunker = createChunker(chunk => {
        // Only with a fresh reference: a stale chunk (system audio stopped or
        // never started) would make the canceller subtract the wrong signal.
        const reference = latestSystemAudio;
        const processed =
            aec && reference && Date.now() - reference.timestamp <= AEC_REFERENCE_MAX_AGE_MS
                ? runAec(aec, chunk, base64ToFloat32Array(reference.data))
                : chunk;
        window.api.listenCapture.sendMicAudioContent({ data: encodeChunk(processed), mimeType: MIME_TYPE }).catch(() => {});
    });
    micProcessor.onaudioprocess = e => chunker(e.inputBuffer.getChannelData(0));

    micSource.connect(micProcessor);
    micProcessor.connect(micAudioContext.destination);
    return { context: micAudioContext, processor: micProcessor };
}

function setupSystemAudioProcessing(systemStream, existingContext = null) {
    // Reusing the mic AudioContext avoids a second one that Chromium may leave
    // suspended (no user gesture for autoplay).
    const context = existingContext || new AudioContext({ sampleRate: SAMPLE_RATE });
    if (context.state === 'suspended') context.resume();

    const source = context.createMediaStreamSource(systemStream);
    const processor = context.createScriptProcessor(BUFFER_SIZE, 1, 1);
    const chunker = createChunker(chunk => {
        window.api.listenCapture
            .sendSystemAudioContent({ data: encodeChunk(chunk), mimeType: MIME_TYPE })
            .catch(error => console.error('[listenCapture] Failed to send system audio:', error));
    });
    processor.onaudioprocess = e => chunker(e.inputBuffer.getChannelData(0));

    source.connect(processor);
    processor.connect(context.destination);
    return { context, processor };
}

async function startMicrophone() {
    try {
        micMediaStream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
        const { context, processor } = await setupMicProcessing(micMediaStream);
        audioContext = context;
        audioProcessor = processor;
    } catch (error) {
        console.warn('[listenCapture] Microphone capture failed:', error);
    }
}

/** macOS: SystemAudioDump runs in the main process and feeds STT directly. */
async function startMacSystemAudio() {
    let result = await window.api.listenCapture.startMacosSystemAudio();
    if (!result.success && result.error === 'already_running') {
        await window.api.listenCapture.stopMacosSystemAudio();
        await new Promise(r => setTimeout(r, 500));
        result = await window.api.listenCapture.startMacosSystemAudio();
    }
    // The microphone is still worth capturing without system audio.
    if (!result.success) console.warn('[listenCapture] macOS system audio failed:', result.error);
}

/** Windows: system audio comes from Electron's loopback (setDisplayMediaRequestHandler in index.js). */
async function startLoopbackSystemAudio() {
    try {
        // Electron requires a video track to hand out the loopback audio.
        mediaStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        if (mediaStream.getAudioTracks().length === 0) {
            throw new Error('No audio track in native loopback stream');
        }
        const { context, processor } = setupSystemAudioProcessing(mediaStream, audioContext);
        systemAudioContext = context;
        systemAudioProcessor = processor;
        window.api.listenCapture.log('[SysCapture] loopback audio started');
    } catch (error) {
        window.api.listenCapture.log(`[SysCapture] FAILED: ${error?.message || error}`);
        console.error('[listenCapture] Loopback system audio failed:', error);
    }
}

async function startCapture() {
    try {
        if (!(await window.api.listenCapture.isSessionActive())) {
            throw new Error('STT sessions not initialized - please wait for initialization to complete');
        }
        if (isMacOS) {
            await startMacSystemAudio();
            await startMicrophone();
        } else if (isLinux) {
            // No system audio source on Linux: microphone only.
            await startMicrophone();
        } else {
            // The mic context is created first so system audio can share it.
            await startMicrophone();
            await startLoopbackSystemAudio();
        }
    } catch (error) {
        console.error('[listenCapture] Error starting capture:', error);
    }
}

function stopCapture() {
    audioProcessor?.disconnect();
    systemAudioProcessor?.disconnect();
    audioProcessor = null;
    systemAudioProcessor = null;

    // On Windows both graphs share one context: close it once.
    const contexts = new Set([audioContext, systemAudioContext].filter(Boolean));
    contexts.forEach(context => context.close().catch(() => {}));
    audioContext = null;
    systemAudioContext = null;

    mediaStream?.getTracks().forEach(track => track.stop());
    micMediaStream?.getTracks().forEach(track => track.stop());
    mediaStream = null;
    micMediaStream = null;
    latestSystemAudio = null;

    if (isMacOS) {
        window.api.listenCapture.stopMacosSystemAudio().catch(err => console.error('[listenCapture] Error stopping macOS audio:', err));
    }
}

module.exports = { startCapture, stopCapture, isLinux, isMacOS };
