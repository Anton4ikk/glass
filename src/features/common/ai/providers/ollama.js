const { StringDecoder } = require('string_decoder');
const fetch = require('node-fetch');

/**
 * Sends requests to Ollama one at a time (it runs one generation per model
 * anyway) and lets the live summary yield to everything else.
 *
 * A background request (the summary: ~20 s with a screenshot on gemma4:e4b)
 * would otherwise hold up the question detector and Ask. A new foreground
 * request jumps ahead of queued background ones and aborts a running one;
 * the aborted request goes back to the queue and runs again from scratch.
 * Aborting closes the HTTP connection, so Ollama stops generating it.
 *
 * A streaming request counts as done once the response headers arrive: the
 * stream itself goes on, and Ollama queues later requests behind it.
 */
class RequestQueue {
    constructor() {
        this.queue = [];
        this.running = null;
    }

    /**
     * @param {(signal: AbortSignal) => Promise<any>} requestFn may be called
     *   again after a preemption, so it must not consume one-off state.
     * @param {{background?: boolean}} [options]
     */
    add(requestFn, { background = false } = {}) {
        return new Promise((resolve, reject) => {
            const job = { requestFn, background, resolve, reject, controller: null };
            if (background) {
                this.queue.push(job);
            } else {
                this.queue.splice(this._firstBackgroundIndex(), 0, job);
                if (this.running?.background) {
                    console.log('[Ollama Queue] Preempting a background request');
                    this.running.controller.abort();
                }
            }
            this._next();
        });
    }

    _firstBackgroundIndex() {
        const index = this.queue.findIndex(job => job.background);
        return index === -1 ? this.queue.length : index;
    }

    _next() {
        if (this.running || this.queue.length === 0) return;
        const job = this.queue.shift();
        job.controller = new AbortController();
        this.running = job;

        Promise.resolve()
            .then(() => job.requestFn(job.controller.signal))
            .then(job.resolve, error => {
                if (job.background && job.controller.signal.aborted) {
                    // Ahead of newer background requests, behind the foreground ones.
                    this.queue.splice(this._firstBackgroundIndex(), 0, job);
                } else {
                    job.reject(error);
                }
            })
            .finally(() => {
                this.running = null;
                this._next();
            });
    }
}

const requestQueue = new RequestQueue();

const DEFAULT_BASE_URL = 'http://localhost:11434';

// Without num_ctx Ollama loads gemma4 with its full 131072-token context:
// 2.1 GB of KV cache and 0.9 GB of compute buffers, ~2.3 GB more than at 8192
// on a 16 GB Mac that also runs whisper and a video call. The largest request
// (Ask: ~3000 prompt tokens with 30 transcript turns and a screenshot, plus up
// to 4096 tokens with reasoning) fits in 8192. Every request must send the
// same value: a different num_ctx makes Ollama reload the model.
const NUM_CTX = 8192;

// Reasoning models (gemma4, qwen3, ...) think by default. On gemma4:e4b that is
// ~1000 hidden tokens, ~30 s before the first visible word. The 'think' flag is
// sent only to models that report the capability: other models reject it.
const thinkingCapabilityCache = new Map();

async function supportsThinking(baseUrl, model) {
    const key = `${baseUrl}|${model}`;
    if (!thinkingCapabilityCache.has(key)) {
        const lookup = fetch(`${baseUrl}/api/show`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model }),
        })
            .then(res => (res.ok ? res.json() : null))
            .then(info => Array.isArray(info?.capabilities) && info.capabilities.includes('thinking'))
            .catch(() => {
                thinkingCapabilityCache.delete(key); // Ollama may be starting: ask again next time
                return false;
            });
        thinkingCapabilityCache.set(key, lookup);
    }
    return thinkingCapabilityCache.get(key);
}

// Returns the request fields for the given think setting ({} = model default).
async function thinkFields(baseUrl, model, think) {
    if (typeof think !== 'boolean') return {};
    return (await supportsThinking(baseUrl, model)) ? { think } : {};
}

// Ollama unloads a model 5 min after its last request, and reloading
// gemma4:e4b costs ~7 s on the next Ask. While a listen session runs the model
// is held in memory; the hold is renewed periodically instead of using
// keep_alive=-1, so a crashed app cannot pin the model in memory forever.
const HOLD_KEEP_ALIVE = '15m';
// Ollama's own default. A request without keep_alive does not shorten the
// timer of an already loaded model, so the release has to name it.
const DEFAULT_KEEP_ALIVE = '5m';
const HOLD_RENEW_MS = 10 * 60 * 1000;
let heldModel = null;
let holdTimer = null;

function keepAliveFields(model) {
    return heldModel === model ? { keep_alive: HOLD_KEEP_ALIVE } : {};
}

// An empty messages array loads the model (or resets its unload timer) without generating.
async function sendLoadRequest(model, extra = {}) {
    try {
        const res = await fetch(`${DEFAULT_BASE_URL}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, messages: [], ...extra, options: { num_ctx: NUM_CTX } }),
        });
        if (!res.ok) console.warn(`[Ollama Provider] Load request for ${model} failed: ${res.status}`);
    } catch (error) {
        console.warn(`[Ollama Provider] Load request for ${model} failed: ${error.message}`);
    }
}

function holdModelLoaded(model) {
    if (!model) return;
    if (heldModel && heldModel !== model) releaseModel();
    heldModel = model;
    console.log(`[Ollama Provider] Holding ${model} in memory for the listen session`);
    sendLoadRequest(model, { keep_alive: HOLD_KEEP_ALIVE });
    clearInterval(holdTimer);
    holdTimer = setInterval(() => sendLoadRequest(model, { keep_alive: HOLD_KEEP_ALIVE }), HOLD_RENEW_MS);
}

function releaseModel() {
    clearInterval(holdTimer);
    holdTimer = null;
    if (!heldModel) return;
    const model = heldModel;
    heldModel = null;
    console.log(`[Ollama Provider] Releasing ${model} (back to Ollama's default unload timer)`);
    sendLoadRequest(model, { keep_alive: DEFAULT_KEEP_ALIVE });
}

class OllamaProvider {
    static async validateApiKey() {
        try {
            const response = await fetch('http://localhost:11434/api/tags');
            if (response.ok) {
                return { success: true };
            } else {
                return { success: false, error: 'Ollama service is not running. Please start Ollama first.' };
            }
        } catch (error) {
            return { success: false, error: 'Cannot connect to Ollama. Please ensure Ollama is installed and running.' };
        }
    }
}


function convertMessagesToOllamaFormat(messages) {
    return messages.map(msg => {
        if (Array.isArray(msg.content)) {
            let textContent = '';
            const images = [];
            
            for (const part of msg.content) {
                if (part.type === 'text') {
                    textContent += part.text;
                } else if (part.type === 'image_url') {
                    const base64 = part.image_url.url.replace(/^data:image\/[^;]+;base64,/, '');
                    images.push(base64);
                }
            }
            
            return {
                role: msg.role,
                content: textContent,
                ...(images.length > 0 && { images })
            };
        } else {
            return msg;
        }
    });
}

/**
 * @param {object} opts
 * @param {boolean} [opts.background] yields to other requests (see RequestQueue)
 * @param {'json'|object} [opts.format] Ollama structured output: 'json' or a JSON schema
 */
function createLLM({ 
    model, 
    temperature = 0.7, 
    maxTokens = 2048, 
    baseUrl = DEFAULT_BASE_URL,
    think,
    background = false,
    format,
    ...config 
}) {
    if (!model) {
        throw new Error('Model parameter is required for Ollama LLM. Please specify a model name (e.g., "llama3.2:latest", "gemma3:4b")');
    }
    return {
        generateContent: async (parts) => {
            let systemPrompt = '';
            const userContent = [];

            for (const part of parts) {
                if (typeof part === 'string') {
                    if (systemPrompt === '' && part.includes('You are')) {
                        systemPrompt = part;
                    } else {
                        userContent.push(part);
                    }
                } else if (part.inlineData) {
                    userContent.push({
                        type: 'image',
                        image: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`
                    });
                }
            }

            const messages = [];
            if (systemPrompt) {
                messages.push({ role: 'system', content: systemPrompt });
            }
            messages.push({ role: 'user', content: userContent.join('\n') });

            return await requestQueue.add(async signal => {
                try {
                    const response = await fetch(`${baseUrl}/api/chat`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        signal,
                        body: JSON.stringify({
                            model,
                            messages,
                            stream: false,
                            ...(await thinkFields(baseUrl, model, think)),
                            ...keepAliveFields(model),
                            options: {
                                temperature,
                                num_predict: maxTokens,
                                num_ctx: NUM_CTX,
                            }
                        })
                    });

                    if (!response.ok) {
                        throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
                    }

                    const result = await response.json();
                    
                    return {
                        response: {
                            text: () => result.message.content
                        },
                        raw: result
                    };
                } catch (error) {
                    console.error('Ollama LLM error:', error);
                    throw error;
                }
            });
        },

        chat: async (messages) => {
            const ollamaMessages = convertMessagesToOllamaFormat(messages);

            const request = async signal => {
                try {
                    const response = await fetch(`${baseUrl}/api/chat`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        signal,
                        body: JSON.stringify({
                            model,
                            messages: ollamaMessages,
                            stream: false,
                            ...(format && { format }),
                            ...(await thinkFields(baseUrl, model, think)),
                            ...keepAliveFields(model),
                            options: {
                                temperature,
                                num_predict: maxTokens,
                                num_ctx: NUM_CTX,
                            },
                        }),
                    });

                    if (!response.ok) {
                        throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
                    }

                    const result = await response.json();
                    return { content: result.message.content, raw: result };
                } catch (error) {
                    // A preempted background request is re-run by the queue.
                    if (!signal.aborted) console.error('Ollama chat error:', error);
                    throw error;
                }
            };
            return await requestQueue.add(request, { background });
        }
    };
}

/**
 * Turns Ollama's NDJSON chat stream into OpenAI-style SSE chunks.
 *
 * The consumer may cancel at any time (Ask does on a new question or when the
 * window closes). The controller is then closed, so later 'data'/'end' events
 * must not touch it: close() on a closed stream throws and crashes the app.
 * Cancelling also destroys the HTTP body, so Ollama stops generating.
 */
function ollamaStreamSource(body) {
    let finished = false;
    const encoder = new TextEncoder();

    return {
        start(controller) {
            let buffer = '';
            const send = payload => {
                if (!finished) controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
            };

            // A chunk can end inside a multi-byte character (any Cyrillic letter):
            // StringDecoder holds the partial bytes until the rest arrives.
            const decoder = new StringDecoder('utf8');
            body.on('data', chunk => {
                if (finished) return;
                buffer += decoder.write(chunk);
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (line.trim() === '') continue;

                    let data;
                    try {
                        data = JSON.parse(line);
                    } catch (e) {
                        console.error('[Ollama Provider] Failed to parse chunk:', e);
                        continue;
                    }

                    // Reasoning is forwarded separately so the UI can show
                    // progress; it never becomes part of the answer.
                    if (data.message?.thinking) {
                        send(JSON.stringify({ choices: [{ delta: { reasoning: data.message.thinking } }] }));
                    }
                    if (data.message?.content) {
                        send(JSON.stringify({ choices: [{ delta: { content: data.message.content } }] }));
                    }
                    if (data.done) {
                        send('[DONE]');
                    }
                }
            });

            body.on('end', () => {
                if (finished) return;
                finished = true;
                controller.close();
                console.log('[Ollama Provider] Streaming completed');
            });

            body.on('error', error => {
                if (finished) return;
                finished = true;
                console.error('[Ollama Provider] Streaming error:', error);
                controller.error(error);
            });
        },

        cancel(reason) {
            finished = true;
            console.log(`[Ollama Provider] Stream cancelled by consumer${reason ? `: ${reason}` : ''}`);
            body.destroy();
        },
    };
}

function createStreamingLLM({ 
    model, 
    temperature = 0.7, 
    maxTokens = 2048, 
    baseUrl = DEFAULT_BASE_URL,
    think,
    ...config 
}) {
    if (!model) {
        throw new Error('Model parameter is required for Ollama streaming LLM. Please specify a model name (e.g., "llama3.2:latest", "gemma3:4b")');
    }
    return {
        streamChat: async (messages) => {
            console.log('[Ollama Provider] Starting streaming request');

            const ollamaMessages = convertMessagesToOllamaFormat(messages);
            // Summary only: the full messages carry the screenshot as ~100 KB of base64.
            const imageCount = ollamaMessages.reduce((n, m) => n + (m.images?.length || 0), 0);
            const textChars = ollamaMessages.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0);
            console.log(`[Ollama Provider] ${ollamaMessages.length} messages, ${textChars} text chars, ${imageCount} image(s), model ${model}`);

            // Foreground: preempts a queued or running background summary.
            return await requestQueue.add(async () => {
                try {
                    const response = await fetch(`${baseUrl}/api/chat`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            model,
                            messages: ollamaMessages,
                            stream: true,
                            ...(await thinkFields(baseUrl, model, think)),
                            ...keepAliveFields(model),
                            options: {
                                temperature,
                                num_predict: maxTokens,
                                num_ctx: NUM_CTX,
                            }
                        })
                    });

                    if (!response.ok) {
                        throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
                    }

                    console.log('[Ollama Provider] Got streaming response');

                    const stream = new ReadableStream(ollamaStreamSource(response.body));

                    return {
                        ok: true,
                        body: stream
                    };
                    
                } catch (error) {
                    console.error('[Ollama Provider] Request error:', error);
                    throw error;
                }
            });
        }
    };
}

module.exports = {
    OllamaProvider,
    createLLM,
    createStreamingLLM,
    convertMessagesToOllamaFormat,
    holdModelLoaded,
    NUM_CTX,
    // Exported for tests.
    ollamaStreamSource,
    RequestQueue,
    releaseModel,
}; 