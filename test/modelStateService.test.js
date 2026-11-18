const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sqliteClient = require('../src/features/common/services/sqliteClient');
const whisperService = require('../src/features/common/services/whisperService');
const modelStateService = require('../src/features/common/services/modelStateService');

let tmpDir;
let installed;
const originalGetInstalledModels = whisperService.getInstalledModels;

beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glass-modelstate-'));
    sqliteClient.connect(path.join(tmpDir, 'test.db'));
    await sqliteClient.initTables();
    installed = new Set();
    whisperService.getInstalledModels = async () =>
        ['whisper-tiny', 'whisper-base', 'whisper-small', 'whisper-medium', 'whisper-large-v3-turbo']
            .map(id => ({ id, installed: installed.has(id) }));
});

afterEach(() => {
    whisperService.getInstalledModels = originalGetInstalledModels;
    sqliteClient.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function selectWhisper(modelId) {
    const repo = require('../src/features/common/repositories/providerSettings');
    await repo.upsert('whisper', { api_key: 'local' });
    await modelStateService.setSelectedModel('stt', modelId);
}

describe('Whisper STT selection', () => {
    test('keeps the selected model when the whisper service reports not running', async () => {
        installed = new Set(['whisper-tiny', 'whisper-medium']);
        await selectWhisper('whisper-medium');

        // What the 30 s periodic sync emits before whisperService is initialized.
        await modelStateService.handleLocalAIStateChange('whisper', { installed: false, running: false });

        assert.equal((await modelStateService.getSelectedModels()).stt, 'whisper-medium');
    });

    test('re-picks an installed model once the selected weights are deleted', async () => {
        installed = new Set(['whisper-medium']);
        await selectWhisper('whisper-tiny');

        await modelStateService.handleLocalAIStateChange('whisper', { installed: true, running: true });

        assert.equal((await modelStateService.getSelectedModels()).stt, 'whisper-medium');
    });
});

describe('WhisperProvider.createSTT', () => {
    test('refuses to start without a model instead of defaulting to tiny', async () => {
        const { WhisperProvider } = require('../src/features/common/ai/providers/whisper');
        const provider = new WhisperProvider();
        provider.whisperService = { ensureModelAvailable: async () => { throw new Error('must not download'); } };

        await assert.rejects(provider.createSTT({ sessionType: 'my' }), /requires a model/);
    });
});

describe('LLM selection survives unrelated state changes', () => {
    async function selectOpenAi(model) {
        const repo = require('../src/features/common/repositories/providerSettings');
        await repo.upsert('openai', { api_key: 'sk-test' });
        await modelStateService.setSelectedModel('llm', model);
    }

    test('a stopped Ollama does not replace a chosen cloud model', async () => {
        await selectOpenAi('gpt-4.1');
        // What the 30 s local AI sync emits while Ollama is not running.
        await modelStateService.handleLocalAIStateChange('ollama', { installed: true, running: false });
        assert.equal((await modelStateService.getSelectedModels()).llm, 'gpt-4.1');
    });

    test('removing an unrelated key keeps the current selection', async () => {
        await selectOpenAi('gpt-4.1');
        const repo = require('../src/features/common/repositories/providerSettings');
        await repo.upsert('gemini', { api_key: 'g-test' });
        await modelStateService.removeApiKey('gemini');
        assert.equal((await modelStateService.getSelectedModels()).llm, 'gpt-4.1');
    });
});
