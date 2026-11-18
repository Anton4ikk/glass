const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { RequestQueue } = require('../src/features/common/ai/providers/ollama');

/** A request that resolves when told to, or rejects when its signal aborts (like fetch). */
function controllable(log, name) {
    const control = { runs: 0 };
    control.fn = signal =>
        new Promise((resolve, reject) => {
            control.runs++;
            log.push(`start ${name}`);
            control.finish = () => resolve(name);
            signal.addEventListener('abort', () => {
                log.push(`abort ${name}`);
                reject(new Error('AbortError'));
            });
        });
    return control;
}

const tick = () => new Promise(resolve => setImmediate(resolve));

describe('Ollama RequestQueue', () => {
    test('runs requests one at a time, in order', async () => {
        const queue = new RequestQueue();
        const log = [];
        const a = controllable(log, 'a');
        const b = controllable(log, 'b');
        const results = [queue.add(a.fn), queue.add(b.fn)];
        await tick();
        assert.deepEqual(log, ['start a']);
        a.finish();
        await tick();
        b.finish();
        assert.deepEqual(await Promise.all(results), ['a', 'b']);
    });

    test('a foreground request aborts a running background one, which then runs again', async () => {
        const queue = new RequestQueue();
        const log = [];
        const summary = controllable(log, 'summary');
        const ask = controllable(log, 'ask');
        const summaryResult = queue.add(summary.fn, { background: true });
        await tick();

        const askResult = queue.add(ask.fn);
        await tick();
        assert.deepEqual(log, ['start summary', 'abort summary', 'start ask']);
        ask.finish();
        assert.equal(await askResult, 'ask');

        await tick();
        assert.equal(summary.runs, 2);
        summary.finish();
        assert.equal(await summaryResult, 'summary');
    });

    test('foreground requests go ahead of queued background ones', async () => {
        const queue = new RequestQueue();
        const log = [];
        const first = controllable(log, 'first');
        const summary = controllable(log, 'summary');
        const detector = controllable(log, 'detector');
        queue.add(first.fn);
        queue.add(summary.fn, { background: true });
        queue.add(detector.fn);
        await tick();
        first.finish();
        await tick();
        assert.deepEqual(log, ['start first', 'start detector']);
    });

    test('a failing foreground request is rejected, not retried', async () => {
        const queue = new RequestQueue();
        let runs = 0;
        await assert.rejects(
            queue.add(async () => {
                runs++;
                throw new Error('Ollama API error: 500');
            }),
            /500/
        );
        assert.equal(runs, 1);
        // The queue keeps working afterwards.
        assert.equal(await queue.add(async () => 'ok'), 'ok');
    });
});

describe('Ollama context length', () => {
    test('every request sends the same num_ctx, so the model is never reloaded for it', () => {
        const fs = require('node:fs');
        const path = require('node:path');
        const { NUM_CTX } = require('../src/features/common/ai/providers/ollama');
        assert.equal(NUM_CTX, 8192);

        // Every request body that sets options (chat, streaming, load, warm-up) carries num_ctx.
        for (const file of ['src/features/common/ai/providers/ollama.js', 'src/features/common/services/ollamaService.js']) {
            const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
            const optionBlocks = source.match(/options:\s*\{[^}]*\}/g) || [];
            assert.ok(optionBlocks.length > 0, file);
            for (const block of optionBlocks) assert.match(block, /num_ctx: NUM_CTX/, `${file}: ${block}`);
        }
    });
});
