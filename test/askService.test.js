const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const askService = require('../src/features/ask/askService');

function fakeResponse(chunks) {
    let cancelled = false;
    const body = new ReadableStream({
        start(controller) {
            for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
        },
        cancel() {
            cancelled = true;
        },
    });
    return { response: { body }, wasCancelled: () => cancelled };
}

describe('AskService request replacement', () => {
    test('a request aborted before its stream started is cancelled, not read', () => {
        const controller = new AbortController();
        controller.abort('New request received.');
        const { response, wasCancelled } = fakeResponse(['data: {"choices":[{"delta":{"content":"old"}}]}\n\n']);

        assert.equal(askService._readerUnlessAborted(response, controller.signal), null);
        assert.equal(wasCancelled(), true);
    });

    test('a replaced request does not overwrite the window state of the newer one', async () => {
        const controller = new AbortController();
        const { response } = fakeResponse(['data: {"choices":[{"delta":{"content":"old answer"}}]}\n\n']);
        const reader = askService._readerUnlessAborted(response, controller.signal);

        // The newer request owns the window by now.
        askService.state = { ...askService.state, isLoading: true, currentQuestion: 'new', currentResponse: '' };
        controller.abort('New request received.');

        const originalBroadcast = askService._broadcastState;
        askService._broadcastState = () => {};
        try {
            await askService._processStream(reader, null, null, controller.signal);
        } finally {
            askService._broadcastState = originalBroadcast;
        }

        assert.equal(askService.state.currentQuestion, 'new');
        assert.equal(askService.state.currentResponse, '');
        assert.equal(askService.state.isLoading, true);
    });
});

describe('AskService SSE parsing', () => {
    const { createSseParser } = askService;

    test('a data line split across network chunks is kept, not dropped', () => {
        const parser = createSseParser();
        const enc = s => new TextEncoder().encode(s);
        assert.deepEqual(parser.push(enc('data: {"a":')), []);
        assert.deepEqual(parser.push(enc('1}\n\ndata: [DONE]\n')), ['{"a":1}', '[DONE]']);
    });

    test('a multi-byte character split across chunks is decoded intact', () => {
        const parser = createSseParser();
        const bytes = new TextEncoder().encode('data: Да\n');
        const cut = bytes.length - 2; // inside "а"
        assert.deepEqual(parser.push(bytes.subarray(0, cut)), []);
        assert.deepEqual(parser.push(bytes.subarray(cut)), ['Да']);
    });

    test('streamed tokens reach the state even when a line is split', async () => {
        const controller = new AbortController();
        const payload = 'data: {"choices":[{"delta":{"content":"Привет, мир"}}]}\n\ndata: [DONE]\n\n';
        const bytes = new TextEncoder().encode(payload);
        // Raw byte halves: the cut falls inside the JSON line and a Cyrillic letter.
        const body = new ReadableStream({
            start(c) {
                c.enqueue(bytes.subarray(0, 41));
                c.enqueue(bytes.subarray(41));
                c.close();
            },
        });
        const reader = askService._readerUnlessAborted({ body }, controller.signal);

        const originalBroadcast = askService._broadcastState;
        askService._broadcastState = () => {};
        try {
            await askService._processStream(reader, null, null, controller.signal);
        } finally {
            askService._broadcastState = originalBroadcast;
        }
        assert.equal(askService.state.currentResponse, 'Привет, мир');
        assert.equal(askService.state.isStreaming, false);
    });
});

describe('AskService request ownership', () => {
    test('only an unfinished request the user asked counts as answering the user', () => {
        const saved = { state: askService.state, source: askService.requestSource };
        try {
            askService.state = { ...askService.state, isLoading: true };
            askService.requestSource = 'user';
            assert.equal(askService.isAnsweringUser(), true);
            askService.requestSource = 'auto';
            assert.equal(askService.isAnsweringUser(), false);
            askService.requestSource = 'user';
            askService.state = { ...askService.state, isLoading: false, isStreaming: false };
            assert.equal(askService.isAnsweringUser(), false);
        } finally {
            askService.state = saved.state;
            askService.requestSource = saved.source;
        }
    });
});


describe('AskService answer history', () => {
    function withHistory(t) {
        const saved = { answers: askService.answers, live: askService.liveEntry, view: askService.view, state: askService.state };
        t.after(() => Object.assign(askService, { answers: saved.answers, liveEntry: saved.live, view: saved.view, state: saved.state }));
        askService.answers = [];
        askService.view = null;
        const sent = [];
        t.mock.method(askService, '_askWindow', () => ({ webContents: { send: (channel, state) => sent.push(state) } }));
        const answer = (question, response, status = 'done') => {
            const entry = askService._addAnswer({ question, subject: question, kind: 'question', source: 'auto' });
            Object.assign(entry, { response, status });
            askService.liveEntry = entry;
            return entry;
        };
        return { sent, answer };
    }

    test('the shortcuts step through earlier answers and back, stopping at both ends', t => {
        const { sent, answer } = withHistory(t);
        answer('A?', 'answer A');
        answer('B?', 'answer B');
        askService.state = { ...askService.state, isLoading: false, isStreaming: false, currentQuestion: 'B?', currentResponse: 'answer B' };

        askService.showPreviousAnswer();
        assert.equal(sent.at(-1).currentResponse, 'answer A');
        assert.equal(sent.at(-1).currentQuestion, 'A?');
        assert.deepEqual([sent.at(-1).view.number, sent.at(-1).view.count, sent.at(-1).view.replay], [1, 2, false]);

        askService.showPreviousAnswer();
        assert.equal(sent.at(-1).currentResponse, 'answer A');

        askService.showNextAnswer();
        askService.showNextAnswer();
        assert.equal(sent.at(-1).currentResponse, 'answer B');
        assert.equal(sent.at(-1).view.number, 2);
    });

    test('an earlier answer shown again is marked as a replay', t => {
        const { sent, answer } = withHistory(t);
        const first = answer('A?', 'answer A');
        answer('B?', 'answer B');

        assert.equal(askService.showAnswer(first.id, { replay: true }), true);
        assert.equal(sent.at(-1).currentResponse, 'answer A');
        assert.equal(sent.at(-1).view.replay, true);
        assert.equal(sent.at(-1).view.at, first.createdAt);
        assert.equal(askService.showAnswer(-1), false);
    });

    test('a live answer streams on behind an earlier one and shows when stepped to', t => {
        const { sent, answer } = withHistory(t);
        answer('A?', 'answer A');
        answer('B?', '', 'pending');
        askService.state = { ...askService.state, isLoading: false, isStreaming: true, currentQuestion: 'B?', currentResponse: 'answer B so far' };

        askService.showPreviousAnswer();
        const count = sent.length;
        askService._scheduleBroadcast(0);
        assert.equal(sent.length, count, 'the live answer does not replace the earlier one on screen');

        askService.showNextAnswer();
        assert.equal(sent.at(-1).currentResponse, 'answer B so far');
        assert.equal(sent.at(-1).isStreaming, true);
    });

    test('a streamed answer is recorded, and a replaced one is marked as cut off', async t => {
        withHistory(t);
        t.mock.method(askService, '_broadcastState', () => {});
        const stream = text => ({
            body: new ReadableStream({
                start(c) {
                    c.enqueue(new TextEncoder().encode(`data: {"choices":[{"delta":{"content":"${text}"}}]}\n\ndata: [DONE]\n\n`));
                    c.close();
                },
            }),
        });

        const done = askService._addAnswer({ question: 'A?', subject: 'A?', kind: 'question', source: 'auto' });
        const controller = new AbortController();
        await askService._processStream(askService._readerUnlessAborted(stream('answer A'), controller.signal), null, null, controller.signal, done);
        assert.deepEqual([done.status, done.response], ['done', 'answer A']);

        const cut = askService._addAnswer({ question: 'B?', subject: 'B?', kind: 'question', source: 'auto' });
        const replaced = new AbortController();
        const reader = askService._readerUnlessAborted(stream('answer B'), replaced.signal);
        replaced.abort('New request received.');
        await askService._processStream(reader, null, null, replaced.signal, cut);
        assert.equal(cut.status, 'interrupted');
    });
});
