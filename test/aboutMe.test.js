// "About me": the profile text from Settings that goes into the Ask and
// summary system prompts.
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sqliteClient = require('../src/features/common/services/sqliteClient');
const settingsRepo = require('../src/features/settings/repositories/sqlite.repository');
const { MAX_ABOUT_ME_LENGTH, normalizeAboutMe, aboutMePromptSection } = require('../src/features/common/prompts/aboutMe');
const factory = require('../src/features/common/ai/factory');
const modelStateService = require('../src/features/common/services/modelStateService');
const sessionRepository = require('../src/features/common/repositories/session');

// summaryService destructures createLLM when it is required, so the stub has
// to be in place first; each test swaps what it delegates to.
let createLLMImpl = factory.createLLM;
factory.createLLM = (...args) => createLLMImpl(...args);
const SummaryService = require('../src/features/listen/summary/summaryService');

describe('aboutMe prompt helpers', () => {
    test('normalize trims, caps the length and rejects non-strings', () => {
        assert.equal(normalizeAboutMe('  Anna, backend dev \n'), 'Anna, backend dev');
        assert.equal(normalizeAboutMe('x'.repeat(MAX_ABOUT_ME_LENGTH + 50)).length, MAX_ABOUT_ME_LENGTH);
        assert.equal(normalizeAboutMe(null), '');
        assert.equal(normalizeAboutMe(42), '');
    });

    test('an empty profile adds nothing to the prompt', () => {
        assert.equal(aboutMePromptSection(''), '');
        assert.equal(aboutMePromptSection('   '), '');
        assert.equal(aboutMePromptSection(undefined), '');
    });

    test('a profile is wrapped in an <about_me> block', () => {
        const section = aboutMePromptSection('Anna, Go developer');
        assert.match(section, /<about_me>\nAnna, Go developer\n<\/about_me>/);
    });
});

describe('settings sqlite repository: about_me', () => {
    let tmpDir;

    beforeEach(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glass-test-'));
        sqliteClient.connect(path.join(tmpDir, 'test.db'));
        await sqliteClient.initTables();
    });

    afterEach(() => {
        sqliteClient.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('is empty by default and round-trips the saved text', () => {
        const uid = sqliteClient.defaultUserId;
        assert.equal(settingsRepo.getAboutMe(uid), '');

        const result = settingsRepo.setAboutMe(uid, '  I lead the payments team.  ');
        assert.deepEqual(result, { success: true, aboutMe: 'I lead the payments team.' });
        assert.equal(settingsRepo.getAboutMe(uid), 'I lead the payments team.');

        settingsRepo.setAboutMe(uid, '');
        assert.equal(settingsRepo.getAboutMe(uid), '');
    });

    test('creates the user row when it does not exist yet', () => {
        settingsRepo.setAboutMe('new-user', 'Hello');
        assert.equal(settingsRepo.getAboutMe('new-user'), 'Hello');
    });
});

describe('summary analysis prompt', () => {
    async function capturedSystemPrompt(aboutMe) {
        const originals = { info: modelStateService.getCurrentModelInfo, touch: sessionRepository.touch, createLLM: createLLMImpl };
        let messages;
        modelStateService.getCurrentModelInfo = async () => ({ provider: 'openai', model: 'gpt-test', apiKey: 'k' });
        sessionRepository.touch = async () => {};
        createLLMImpl = () => ({
            chat: async m => {
                messages = m;
                return { content: '**Open Questions**\nnone' };
            },
        });
        try {
            await new SummaryService().makeOutlineAndRequests(['me: hi $& there'], null, null, { aboutMe });
        } finally {
            modelStateService.getCurrentModelInfo = originals.info;
            sessionRepository.touch = originals.touch;
            createLLMImpl = originals.createLLM;
        }
        return messages[0].content;
    }

    test('includes the profile and keeps "$" sequences literal', async () => {
        const prompt = await capturedSystemPrompt('Price is $& and $1');
        assert.match(prompt, /<about_me>\nPrice is \$& and \$1\n<\/about_me>/);
        assert.match(prompt, /me: hi \$& there/);
        assert.doesNotMatch(prompt, /\{\{ABOUT_ME\}\}/);
    });

    test('leaves no placeholder when the profile is empty', async () => {
        const prompt = await capturedSystemPrompt('');
        assert.doesNotMatch(prompt, /about_me|\{\{ABOUT_ME\}\}/);
    });
});
