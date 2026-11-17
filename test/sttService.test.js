const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// sttService destructures createSTT at require time: route it through a stub first.
const factory = require('../src/features/common/ai/factory');
let createSttImpl;
factory.createSTT = (...args) => createSttImpl(...args);
const modelStateService = require('../src/features/common/services/modelStateService');
modelStateService.getCurrentModelInfo = async () => ({ provider: 'openai', model: 'gpt-4o-mini-transcribe', apiKey: 'k' });

const SttService = require('../src/features/listen/stt/sttService');

function fakeSession() {
    const session = { closed: false, sent: [], close: async () => (session.closed = true), sendRealtimeInput: async p => session.sent.push(p) };
    return session;
}

describe('SttService sessions', () => {
    let service;
    beforeEach(() => {
        service = new SttService();
        service.sendToRenderer = () => {};
    });

    test('when one session fails to connect, the other one is closed, not leaked', async () => {
        const opened = [];
        createSttImpl = async (_provider, options) => {
            if (options.sessionType === 'their') throw new Error('socket refused');
            const s = fakeSession();
            opened.push(s);
            return s;
        };
        await assert.rejects(service.initializeSttSessions('ru'), /socket refused/);
        assert.equal(opened.length, 1);
        assert.equal(opened[0].closed, true);
        assert.equal(service.isSessionActive(), false);
    });

    test('sessions that finish connecting after Stop are closed', async () => {
        const opened = [];
        let release;
        const gate = new Promise(resolve => (release = resolve));
        createSttImpl = async () => {
            await gate;
            const s = fakeSession();
            opened.push(s);
            return s;
        };
        const init = service.initializeSttSessions('ru');
        await service.closeSessions();
        release();
        await assert.rejects(init, /closed while connecting/);
        assert.equal(opened.length, 2);
        assert.ok(opened.every(s => s.closed));
        assert.equal(service.isSessionActive(), false);
    });

    test('Stop flushes the turn still waiting for the debounce, per speaker', async () => {
        createSttImpl = async () => fakeSession();
        const turns = [];
        service.setCallbacks({ onTranscriptionComplete: (speaker, text) => turns.push([speaker, text]) });
        await service.initializeSttSessions('ru');

        service.handleMessage('Them', { type: 'conversation.item.input_audio_transcription.completed', transcript: 'Расскажи о себе' });
        service.handleMessage('Me', { type: 'conversation.item.input_audio_transcription.delta', delta: 'Я ' });
        service.handleMessage('Me', { type: 'conversation.item.input_audio_transcription.delta', delta: 'разработчик' });
        await service.closeSessions();

        assert.deepEqual(turns, [
            ['Me', 'Я разработчик'],
            ['Them', 'Расскажи о себе'],
        ]);
    });
});

describe('SttService audio helpers', () => {
    test('stereo to mono keeps the left channel', () => {
        const stereo = Buffer.alloc(8);
        stereo.writeInt16LE(100, 0);
        stereo.writeInt16LE(-5, 2);
        stereo.writeInt16LE(-200, 4);
        stereo.writeInt16LE(7, 6);
        const mono = SttService.convertStereoToMono(stereo);
        assert.deepEqual([mono.readInt16LE(0), mono.readInt16LE(2)], [100, -200]);
    });

    test('payload shape follows the provider', () => {
        const b64 = Buffer.from([1, 2]).toString('base64');
        assert.deepEqual(SttService.toProviderPayload('gemini', b64), { audio: { data: b64, mimeType: 'audio/pcm;rate=24000' } });
        assert.ok(Buffer.isBuffer(SttService.toProviderPayload('deepgram', b64)));
        assert.equal(SttService.toProviderPayload('openai', b64), b64);
    });
});
