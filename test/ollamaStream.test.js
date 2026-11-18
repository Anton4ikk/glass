const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');

const { ollamaStreamSource } = require('../src/features/common/ai/providers/ollama');

const line = obj => JSON.stringify(obj) + '\n';

describe('ollamaStreamSource', () => {
    test('converts NDJSON to SSE chunks and closes on end', async () => {
        const body = new PassThrough();
        const reader = new ReadableStream(ollamaStreamSource(body)).getReader();

        body.write(line({ message: { content: 'Hi' } }));
        body.end(line({ message: { content: '' }, done: true }));

        const chunks = [];
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(new TextDecoder().decode(value));
        }
        assert.deepEqual(chunks, ['data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n', 'data: [DONE]\n\n']);
    });

    test('a cancelled reader does not crash on later data/end and stops the HTTP body', async () => {
        const body = new PassThrough();
        const reader = new ReadableStream(ollamaStreamSource(body)).getReader();

        body.write(line({ message: { content: 'first' } }));
        await reader.read();
        await reader.cancel('New request received.');

        // Must not reach the closed controller (uncaught "Controller is already closed").
        body.emit('data', Buffer.from(line({ message: { content: 'late' } })));
        body.emit('end');
        await new Promise(resolve => setImmediate(resolve));

        assert.equal(body.destroyed, true);
    });

    test('a Cyrillic letter split across two chunks is decoded intact', async () => {
        const body = new PassThrough();
        const reader = new ReadableStream(ollamaStreamSource(body)).getReader();

        const bytes = Buffer.from(line({ message: { content: 'Привет' } }));
        // Cut inside the two-byte "П".
        const cut = bytes.indexOf(Buffer.from('П')) + 1;
        body.write(bytes.subarray(0, cut));
        body.write(bytes.subarray(cut));

        const { value } = await reader.read();
        assert.equal(new TextDecoder().decode(value), 'data: {"choices":[{"delta":{"content":"Привет"}}]}\n\n');
    });
});
