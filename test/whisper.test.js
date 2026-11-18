const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { WhisperSTTSession, cleanTranscription, chunkRms } = require('../src/features/common/ai/providers/whisper');

// PCM16 mono @ 24 kHz, as produced by listenCapture.js.
const BYTES_PER_SECOND = 24000 * 2;

function pcm(seconds, amplitude) {
    const samples = Math.round(seconds * 24000);
    const buf = Buffer.alloc(samples * 2);
    const value = Math.round(amplitude * 32767);
    for (let i = 0; i < samples; i++) buf.writeInt16LE(value, i * 2);
    return buf;
}

function newSession() {
    const fakeWhisperService = { ensureModelAvailable: async () => {} };
    const session = new WhisperSTTSession('whisper-tiny', fakeWhisperService, 'test');
    // Skip initialize(): it starts a 200 ms polling interval.
    session.isRunning = true;
    return session;
}

describe('cleanTranscription', () => {
    test('keeps normal speech and collapses whitespace', () => {
        assert.equal(cleanTranscription('  Привет,   как   дела?  '), 'Привет, как дела?');
        assert.equal(cleanTranscription('Let us ship it on Friday.'), 'Let us ship it on Friday.');
    });

    test('strips bracketed, parenthesized and starred sound tags', () => {
        assert.equal(cleanTranscription('[Музыка]'), '');
        assert.equal(cleanTranscription('Hello (laughs) world *applause*'), 'Hello world');
    });

    test('drops known subtitle hallucinations', () => {
        assert.equal(cleanTranscription('Редактор субтитров А.Синецкая Корректор А.Егорова'), '');
        assert.equal(cleanTranscription('Продолжение следует...'), '');
        assert.equal(cleanTranscription('Thank you for watching!'), '');
    });

    test('drops all-caps sound captions but keeps short acronyms', () => {
        assert.equal(cleanTranscription('ДИНАМИЧНАЯ МУЗЫКА'), '');
        assert.equal(cleanTranscription('OK'), 'OK');
    });

    test('collapses decoder loops', () => {
        assert.equal(cleanTranscription('Это не надо. Это не надо. Это не надо.'), 'Это не надо.');
    });
});

describe('chunkRms', () => {
    test('is 0 for silence and empty buffers', () => {
        assert.equal(chunkRms(Buffer.alloc(0)), 0);
        assert.equal(chunkRms(pcm(0.1, 0)), 0);
    });

    test('equals the amplitude of a constant signal', () => {
        assert.ok(Math.abs(chunkRms(pcm(0.1, 0.5)) - 0.5) < 0.001);
    });
});

describe('WhisperSTTSession segmentation', () => {
    test('keeps only a short pre-roll while there is no speech', () => {
        const session = newSession();
        session.sendRealtimeInput(pcm(1, 0));
        session.sendRealtimeInput(pcm(1, 0));

        assert.equal(session.speechStartedAt, 0);
        // PRE_ROLL_MS = 300
        assert.equal(session.audioBuffer.length, BYTES_PER_SECOND * 0.3);
    });

    test('starts an utterance on speech and keeps the pre-roll in front of it', () => {
        const session = newSession();
        session.sendRealtimeInput(pcm(1, 0));
        session.sendRealtimeInput(pcm(0.5, 0.2));

        assert.ok(session.speechStartedAt > 0);
        assert.equal(Math.round(session.speechMs), 500);
        assert.equal(session.audioBuffer.length, BYTES_PER_SECOND * (0.3 + 0.5));

        // Silence after speech belongs to the utterance and is not trimmed.
        session.sendRealtimeInput(pcm(0.2, 0));
        assert.equal(session.audioBuffer.length, BYTES_PER_SECOND * (0.3 + 0.5 + 0.2));
        assert.equal(Math.round(session.speechMs), 500);
    });

    test('accepts base64 strings and ArrayBuffers', () => {
        const session = newSession();
        session.sendRealtimeInput(pcm(0.1, 0.2).toString('base64'));
        const chunk = pcm(0.1, 0.2);
        session.sendRealtimeInput(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.length));
        assert.equal(Math.round(session.speechMs), 200);
    });

    test('ignores audio when the session is not running', () => {
        const session = newSession();
        session.isRunning = false;
        session.sendRealtimeInput(pcm(0.5, 0.2));
        assert.equal(session.audioBuffer.length, 0);
    });
});

describe('WhisperSTTSession.close', () => {
    test('transcribes the utterance still being spoken when Stop is pressed', async () => {
        const session = newSession();
        const processed = [];
        session.processAudioChunk = async audio => { processed.push(audio.length); };

        session.sendRealtimeInput(pcm(0.5, 0.2));
        await session.close();

        assert.deepEqual(processed, [BYTES_PER_SECOND * 0.5]);
        assert.equal(session.isRunning, false);
    });

    test('drops a too-short burst instead of sending it to whisper', async () => {
        const session = newSession();
        const processed = [];
        session.processAudioChunk = async audio => { processed.push(audio.length); };

        session.sendRealtimeInput(pcm(0.1, 0.2)); // MIN_SPEECH_MS = 300
        await session.close();

        assert.deepEqual(processed, []);
    });
});

describe('WhisperSTTSession with whisper-server', () => {
    function serverSession(server) {
        const calls = { cli: 0 };
        const service = {
            ensureModelAvailable: async () => {},
            createWavHeader: () => Buffer.alloc(44),
            logTranscription: async () => {},
        };
        const session = new WhisperSTTSession('whisper-medium', service, 'test', 'ru');
        session.isRunning = true;
        session.server = server;
        session._transcribeWithCli = async () => {
            calls.cli++;
            return { code: 0, output: 'из cli', errorOutput: '' };
        };
        const texts = [];
        session.on('transcription', m => texts.push(m.text));
        return { session, calls, texts };
    }

    test('an utterance goes to the loaded server, not to a new whisper-cli run', async () => {
        const sent = [];
        const { session, calls, texts } = serverSession({
            transcribe: async (wav, language) => {
                sent.push([wav.length, language]);
                return ' Как развернуть связный список?\n';
            },
            release() {},
        });
        await session._runWhisper(pcm(1, 0.5));
        assert.deepEqual(texts, ['Как развернуть связный список?']);
        assert.deepEqual(sent, [[44 + BYTES_PER_SECOND, 'ru']]);
        assert.equal(calls.cli, 0);
        assert.equal(session.isProcessing, false);
    });

    test('falls back to whisper-cli when the server request fails', async () => {
        const { session, calls, texts } = serverSession({
            transcribe: async () => {
                throw new Error('ECONNREFUSED');
            },
            release() {},
        });
        await session._runWhisper(pcm(1, 0.5));
        assert.equal(calls.cli, 1);
        assert.deepEqual(texts, ['из cli']);
    });

    test('close() releases the shared server', async () => {
        let released = 0;
        const { session } = serverSession({ transcribe: async () => '', release: () => released++ });
        await session.close();
        assert.equal(released, 1);
        assert.equal(session.server, null);
    });
});
