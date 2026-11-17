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

