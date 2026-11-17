const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const whisperService = require('../src/features/common/services/whisperService');

let tmpDir;
const saved = {};

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glass-whisper-'));
    saved.tempDir = whisperService.tempDir;
    saved.logsDir = whisperService.logsDir;
    whisperService.tempDir = path.join(tmpDir, 'temp');
    whisperService.logsDir = path.join(tmpDir, 'logs');
    fs.mkdirSync(whisperService.tempDir);
    fs.mkdirSync(whisperService.logsDir);
});

afterEach(() => {
    whisperService.tempDir = saved.tempDir;
    whisperService.logsDir = saved.logsDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

const tempFiles = () => fs.readdirSync(whisperService.tempDir).sort();

describe('whisper temp files', () => {
    test('cleanupTempFile removes the outputs whisper-cli names "<input>.wav.txt"', async () => {
        const wav = path.join(whisperService.tempDir, 'audio_my_1_abc.wav');
        for (const f of [wav, `${wav}.txt`, `${wav}.json`]) fs.writeFileSync(f, 'x');

        await whisperService.cleanupTempFile(wav);

        assert.deepEqual(tempFiles(), []);
    });

    test('sweepTempDir removes leftover utterance files and keeps the rest', async () => {
        for (const f of ['audio_their_1.wav', 'audio_their_1.wav.txt', 'audio_my_2.wav.json', 'whisper-binary.zip']) {
            fs.writeFileSync(path.join(whisperService.tempDir, f), 'x');
        }

        assert.equal(await whisperService.sweepTempDir(), 3);
        assert.deepEqual(tempFiles(), ['whisper-binary.zip']);
    });
});

describe('transcription debug log', () => {
    const logFile = () => path.join(whisperService.logsDir, 'transcriptions.jsonl');

    test('appends one JSON line per run', async () => {
        await whisperService.logTranscription({ model: 'whisper-medium', raw: '[Музыка]', text: '', emitted: false });
        await whisperService.logTranscription({ model: 'whisper-medium', raw: 'Привет', text: 'Привет', emitted: true });

        const lines = fs.readFileSync(logFile(), 'utf8').trim().split('\n').map(JSON.parse);
        assert.equal(lines.length, 2);
        assert.equal(lines[0].raw, '[Музыка]');
        assert.equal(lines[1].emitted, true);
        assert.ok(lines[0].ts);
    });

    test('rotates to .1 once the log reaches 5 MB', async () => {
        fs.writeFileSync(logFile(), 'x'.repeat(5 * 1024 * 1024));

        await whisperService.logTranscription({ text: 'new' });

        assert.equal(fs.statSync(`${logFile()}.1`).size, 5 * 1024 * 1024);
        assert.equal(JSON.parse(fs.readFileSync(logFile(), 'utf8')).text, 'new');
    });
});
