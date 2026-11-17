const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { PROVIDERS, createLLM, createSTT, getAvailableProviders, getProviderClass } = require('../src/features/common/ai/factory');

describe('AI provider factory', () => {
    test('every provider module loads and exposes its class', () => {
        for (const id of Object.keys(PROVIDERS)) {
            const ProviderClass = getProviderClass(id);
            assert.equal(typeof ProviderClass, 'function', `provider "${id}" has no class`);
        }
    });

    test('model ids are unique across the registry', () => {
        const seen = new Map();
        for (const [providerId, provider] of Object.entries(PROVIDERS)) {
            for (const model of [...provider.llmModels, ...provider.sttModels]) {
                assert.ok(!seen.has(model.id), `model "${model.id}" is listed by both ${seen.get(model.id)} and ${providerId}`);
                seen.set(model.id, providerId);
            }
        }
    });

    test('getAvailableProviders splits providers by capability', () => {
        const { llm, stt } = getAvailableProviders();
        assert.ok(llm.includes('openai') && stt.includes('openai'));
        assert.ok(llm.includes('anthropic') && !stt.includes('anthropic'));
        assert.ok(stt.includes('deepgram') && !llm.includes('deepgram'));
        assert.ok(stt.includes('whisper') && !llm.includes('whisper'));
    });

    test('unknown providers are rejected', () => {
        assert.throws(() => createLLM('nope', {}), /LLM not supported for provider: nope/);
        assert.throws(() => createSTT('nope', {}), /STT not supported for provider: nope/);
    });
});
