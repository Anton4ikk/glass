const { createStreamingLLM } = require('../common/ai/factory');
const internalBridge = require('../../bridge/internalBridge');
const sessionRepository = require('../common/repositories/session');
const askRepository = require('./repositories');
const { getSystemPrompt } = require('../common/prompts/promptBuilder');
const { aboutMePromptSection } = require('../common/prompts/aboutMe');
const modelStateService = require('../common/services/modelStateService');
const { captureScreenshot } = require('../common/utils/screenCapture');
const { isTextOnly, markTextOnly } = require('../common/ai/textOnlyModels');

// Lazy: the window manager requires feature services itself.
const getWindowPool = () => {
    try {
        return require('../../window/windowManager').windowPool;
    } catch {
        return null;
    }
};
// Lazy: settingsService pulls in the window manager.
const getSettingsService = () => require('../settings/settingsService');

// The RU/EN switch in Settings sets the language of the conversation; answers
// follow it, whatever language the question or the screen is in.
const ANSWER_LANGUAGE_RULES = {
    ru: 'IMPORTANT: Write your entire answer in Russian.',
    en: 'IMPORTANT: Write your entire answer in English.',
};

// The whole state (with the full answer so far) goes over IPC on every
// update, so streaming updates are batched to about one per frame pair.
const STREAM_BROADCAST_MS = 40;
// Reasoning only moves a progress counter: a slower rate is enough.
const REASONING_BROADCAST_MS = 250;

const MAX_HISTORY_TURNS = 30;
// Answers kept in memory: for the previous/next answer shortcuts, and to show
// an answer again when its question is repeated instead of generating a new one.
const MAX_ANSWERS = 50;

const initialState = () => ({
    isVisible: false,
    isLoading: false,
    isStreaming: false,
    currentQuestion: '',
    currentResponse: '',
    showTextInput: true,
    reasoningChars: 0,
});

/**
 * Splits an OpenAI-style SSE byte stream into the JSON payloads of its
 * "data:" lines. A network chunk can end in the middle of a line or of a
 * multi-byte UTF-8 character (any Cyrillic letter), so both are buffered.
 * @returns {{push(bytes: Uint8Array): Array<string>}}
 */
function createSseParser() {
    const decoder = new TextDecoder();
    let pending = '';
    return {
        push(bytes) {
            pending += decoder.decode(bytes, { stream: true });
            const lines = pending.split('\n');
            pending = lines.pop();
            const payloads = [];
            for (const raw of lines) {
                const line = raw.trim();
                if (line.startsWith('data:')) payloads.push(line.slice(5).trim());
            }
            return payloads;
        },
    };
}

function isMultimodalError(error) {
    const message = error?.message?.toLowerCase() || '';
    return ['vision', 'image', 'multimodal', 'unsupported', 'not supported', 'invalid', '400'].some(s => message.includes(s));
}

class AskService {
    constructor() {
        this.abortController = null;
        // 'user' (typed, clicked or the shortcut) or 'auto' (live analysis).
        this.requestSource = null;
        this.state = initialState();
        this.broadcastTimer = null;
        this.lastBroadcast = 0;

        // Every request, oldest first: {id, question, subject, kind, source,
        // response, status: 'pending'|'done'|'interrupted', createdAt}.
        // liveEntry is the newest one, the one this.state describes.
        this.answers = [];
        this.nextAnswerId = 1;
        this.liveEntry = null;
        // An older answer shown instead of the live one: {entry, replay}.
        // `replay` marks an answer shown again for a repeated question.
        this.view = null;
    }

    /**
     * What the window shows: the live state, or an older answer in its place.
     * `view` tells the window which answer of how many it is and when it was given.
     */
    _viewState() {
        if (!this.view) return { ...this.state, view: null };
        const { entry, replay } = this.view;
        const browsable = this._browsableAnswers();
        const view = { number: browsable.indexOf(entry) + 1, count: browsable.length, at: entry.createdAt, replay };
        if (entry === this.liveEntry && entry.status === 'pending') return { ...this.state, view };
        return {
            ...this.state,
            isLoading: false,
            isStreaming: false,
            reasoningChars: 0,
            showTextInput: false,
            currentQuestion: entry.question,
            currentResponse: entry.response,
            view,
        };
    }

    /** Whether an older answer covers the live one (its updates then wait). */
    _showingOlderAnswer() {
        return !!this.view && this.view.entry !== this.liveEntry;
    }

    /** Answers the shortcuts step through: those with text, and the one in progress. */
    _browsableAnswers() {
        return this.answers.filter(entry => entry.response || entry.status === 'pending');
    }

    _addAnswer({ question, subject, kind, source }) {
        const entry = { id: this.nextAnswerId++, question, subject, kind, source, response: '', status: 'pending', createdAt: Date.now() };
        this.answers.push(entry);
        if (this.answers.length > MAX_ANSWERS) this.answers.shift();
        return entry;
    }

    /** Answers given since `sinceId` (inclusive), oldest first. */
    getAnswers(sinceId = 0) {
        return this.answers.filter(entry => entry.id >= sinceId);
    }

    /** The id the next answer will get: a session marks where its answers start. */
    peekNextAnswerId() {
        return this.nextAnswerId;
    }

    /**
     * Shows an answer already given, without asking the model again.
     * @param {{replay?: boolean}} [options] replay: shown again for a repeated question
     * @returns {boolean} false if the answer is no longer kept
     */
    showAnswer(id, { replay = false } = {}) {
        const entry = this.answers.find(e => e.id === id);
        if (!entry) return false;
        this.view = { entry, replay };
        internalBridge.emit('window:requestVisibility', { name: 'ask', visible: true });
        this._broadcastState();
        return true;
    }

    showPreviousAnswer() {
        this._stepAnswer(-1);
    }

    showNextAnswer() {
        this._stepAnswer(1);
    }

    _stepAnswer(delta) {
        const browsable = this._browsableAnswers();
        if (browsable.length === 0) return;
        const current = this.view?.entry || this.liveEntry;
        const index = browsable.indexOf(current);
        const from = index === -1 ? browsable.length : index;
        const target = browsable[Math.min(browsable.length - 1, Math.max(0, from + delta))];
        this.view = { entry: target, replay: false };
        this._broadcastState();
    }

    _askWindow() {
        const win = getWindowPool()?.get('ask');
        return win && !win.isDestroyed() ? win : null;
    }

    _broadcastState() {
        this._cancelScheduledBroadcast();
        this.lastBroadcast = Date.now();
        this._askWindow()?.webContents.send('ask:stateUpdate', this._viewState());
    }

    /** Broadcasts at most once per `intervalMs`, always delivering the latest state. */
    _scheduleBroadcast(intervalMs) {
        // The live answer streams on behind an older one; it shows when stepped to.
        if (this.broadcastTimer || this._showingOlderAnswer()) return;
        const wait = this.lastBroadcast + intervalMs - Date.now();
        if (wait <= 0) {
            this._broadcastState();
        } else {
            this.broadcastTimer = setTimeout(() => {
                this.broadcastTimer = null;
                this._broadcastState();
            }, wait);
        }
    }

    _cancelScheduledBroadcast() {
        if (this.broadcastTimer) {
            clearTimeout(this.broadcastTimer);
            this.broadcastTimer = null;
        }
    }

    /** Whether a question the user asked is still being answered (auto answers must not replace it). */
    isAnsweringUser() {
        return this.requestSource === 'user' && this.isAnswering();
    }

    /** Whether any answer (asked by the user or automatic) is still being produced. */
    isAnswering() {
        return this.state.isLoading || this.state.isStreaming;
    }

    async toggleAskButton(inputScreenOnly = false) {
        const askWindow = this._askWindow();
        const isVisible = !!askWindow?.isVisible();

        if (inputScreenOnly && this.state.showTextInput && isVisible) {
            await this.sendMessage('', []);
            return;
        }

        const hasContent = this.state.isLoading || this.state.isStreaming || !!this.state.currentResponse;
        if (isVisible && hasContent) {
            // The text input belongs to the live answer: leave an older one.
            this.view = null;
            this.state.showTextInput = !this.state.showTextInput;
            this._broadcastState();
            return;
        }

        internalBridge.emit('window:requestVisibility', { name: 'ask', visible: !isVisible });
        this.state.isVisible = !isVisible;
        if (this.state.isVisible) {
            this.state.showTextInput = true;
            this._broadcastState();
        }
    }

    async closeAskWindow() {
        if (this.abortController) {
            this.abortController.abort('Window closed by user');
            this.abortController = null;
        }
        this.requestSource = null;
        this.state = initialState();
        this.view = null;
        this._broadcastState();
        internalBridge.emit('window:requestVisibility', { name: 'ask', visible: false });
        return { success: true };
    }

    _formatConversationForPrompt(conversationTexts) {
        if (!conversationTexts || conversationTexts.length === 0) {
            return 'No conversation history available.';
        }
        return conversationTexts.slice(-MAX_HISTORY_TURNS).join('\n');
    }

    /**
     * Answers in the Ask window, replacing (aborting) any answer in progress.
     * @param {string} userPrompt
     * @param {string[]} conversationHistoryRaw live transcript lines
     * @param {{source?: 'user'|'auto', kind?: 'question'|'task', subject?: string}} [options]
     *   kind/subject: what the answer is about, to recognize a repeat later
     *   (subject defaults to the prompt; for 'task' it is the task on screen)
     * @returns {Promise<{success: boolean, aborted?: boolean, error?: string}>}
     */
    async sendMessage(userPrompt, conversationHistoryRaw = [], { source = 'user', kind = 'question', subject } = {}) {
        const prompt = (userPrompt || '').trim();
        // Created before the first await: the caller can read it right after the call.
        const entry = this._addAnswer({ question: prompt, subject: subject ?? prompt, kind, source });
        this.liveEntry = entry;
        this.view = null;
        try {
            return await this._answer(entry, userPrompt, prompt, conversationHistoryRaw, source);
        } finally {
            if (entry.status === 'pending') entry.status = 'interrupted';
        }
    }

    async _answer(entry, userPrompt, prompt, conversationHistoryRaw, source) {
        internalBridge.emit('window:requestVisibility', { name: 'ask', visible: true });
        this.state = {
            ...this.state,
            isLoading: true,
            isStreaming: false,
            currentQuestion: userPrompt,
            currentResponse: '',
            showTextInput: false,
            reasoningChars: 0,
        };
        this._broadcastState();

        this.abortController?.abort('New request received.');
        this.abortController = new AbortController();
        this.requestSource = source;
        const { signal } = this.abortController;

        try {
            const modelInfo = await modelStateService.getCurrentModelInfo('llm');
            if (!modelInfo || !modelInfo.apiKey) {
                throw new Error('AI model or API key not configured.');
            }

            // Independent lookups run together: the screenshot alone takes a
            // few hundred ms, all of it before the first token.
            const settingsService = getSettingsService();
            const [sessionId, screenshotBase64, language, think, aboutMe] = await Promise.all([
                sessionRepository.getOrCreateActive('ask'),
                isTextOnly(modelInfo.model) ? null : captureScreenshot().then(r => (r.success ? r.base64 : null)),
                settingsService.getSttLanguageSetting(),
                settingsService.getAskThinkingSetting(),
                settingsService.getAboutMeSetting(),
            ]);
            await askRepository.addAiMessage({ sessionId, role: 'user', content: prompt });

            const profileSection = aboutMePromptSection(aboutMe);
            const systemPrompt =
                getSystemPrompt('pickle_glass_analysis', this._formatConversationForPrompt(conversationHistoryRaw), false) +
                (profileSection ? `\n\n${profileSection}` : '') +
                (ANSWER_LANGUAGE_RULES[language] ? `\n\n${ANSWER_LANGUAGE_RULES[language]}` : '');
            const requestText = `User Request: ${prompt}`;
            const textMessages = [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: requestText },
            ];
            const imageMessages = screenshotBase64 && [
                { role: 'system', content: systemPrompt },
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: requestText },
                        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${screenshotBase64}` } },
                    ],
                },
            ];

            const streamingLLM = createStreamingLLM(modelInfo.provider, {
                apiKey: modelInfo.apiKey,
                model: modelInfo.model,
                temperature: 0.7,
                // Reasoning tokens count against this limit: leave room for the answer.
                maxTokens: think ? 4096 : 2048,
                think,
            });

            const stream = messages => this._streamAnswer(streamingLLM, messages, sessionId, signal, entry);
            if (!imageMessages) return await stream(textMessages);
            try {
                return await stream(imageMessages);
            } catch (error) {
                if (signal.aborted || !isMultimodalError(error)) throw error;
                console.warn(`[AskService] ${modelInfo.model} rejected the screenshot, answering text-only: ${error.message}`);
                markTextOnly(modelInfo.model);
                return await stream(textMessages);
            }
        } catch (error) {
            // A replaced request must not reset the window the newer one owns.
            if (signal.aborted) return { success: false, aborted: true };
            console.error('[AskService] Error during message processing:', error);
            this.state = { ...this.state, isLoading: false, isStreaming: false, showTextInput: true };
            this._broadcastState();
            this._askWindow()?.webContents.send('ask-response-stream-error', { error: error.message || 'Unknown error occurred' });
            return { success: false, error: error.message };
        }
    }

    async _streamAnswer(streamingLLM, messages, sessionId, signal, entry) {
        // A newer request may have replaced this one while the context was gathered.
        if (signal.aborted) return { success: false, aborted: true };

        const response = await streamingLLM.streamChat(messages);
        const askWin = this._askWindow();
        if (!askWin) {
            response.body.getReader().cancel().catch(() => {});
            return { success: false, error: 'Ask window is not available.' };
        }
        const reader = this._readerUnlessAborted(response, signal);
        if (!reader) return { success: false, aborted: true };

        await this._processStream(reader, askWin, sessionId, signal, entry);
        return { success: true };
    }

    /**
     * Gets the stream reader and ties it to the request's abort signal. The
     * signal may already have fired while the request was starting; an
     * 'abort' listener added now would never run, so cancel right away. The
     * cancel also closes the HTTP stream, so the model stops generating.
     * @returns {ReadableStreamDefaultReader|null} null if already aborted
     */
    _readerUnlessAborted(response, signal) {
        const reader = response.body.getReader();
        const cancel = () => reader.cancel(signal.reason).catch(() => {});
        if (signal.aborted) {
            cancel();
            return null;
        }
        signal.addEventListener('abort', cancel, { once: true });
        return reader;
    }

    /** @param {object} [entry] the answer record that receives the text */
    async _processStream(reader, askWin, sessionId, signal, entry = null) {
        const parser = createSseParser();
        let fullResponse = '';
        let failed = false;

        try {
            // isLoading stays on until the first answer token: a reasoning model
            // can think for tens of seconds first, and the loader (with reasoning
            // progress) says more than an empty response pane.
            this.state.isStreaming = true;
            this._broadcastState();
            while (true) {
                const { done, value } = await reader.read();
                if (done || signal.aborted) break;

                for (const data of parser.push(value)) {
                    if (data === '[DONE]') return;
                    let delta;
                    try {
                        delta = JSON.parse(data).choices?.[0]?.delta || {};
                    } catch {
                        continue;
                    }
                    if (delta.reasoning) {
                        this.state.reasoningChars += delta.reasoning.length;
                        this._scheduleBroadcast(REASONING_BROADCAST_MS);
                    }
                    if (delta.content) {
                        fullResponse += delta.content;
                        this.state.isLoading = false;
                        this.state.currentResponse = fullResponse;
                        this._scheduleBroadcast(STREAM_BROADCAST_MS);
                    }
                }
            }
        } catch (streamError) {
            failed = true;
            if (!signal.aborted) {
                console.error('[AskService] Error while processing stream:', streamError);
                if (askWin && !askWin.isDestroyed()) {
                    askWin.webContents.send('ask-response-stream-error', { error: streamError.message });
                }
            }
        } finally {
            if (entry) {
                entry.response = fullResponse;
                entry.status = signal.aborted || failed ? 'interrupted' : 'done';
            }
            // Once replaced, the window shows the newer request: leave it alone.
            if (!signal.aborted) {
                this.state.isLoading = false;
                this.state.isStreaming = false;
                this.state.currentResponse = fullResponse;
                this._broadcastState();
            }
            if (fullResponse) {
                try {
                    await askRepository.addAiMessage({ sessionId, role: 'assistant', content: fullResponse });
                } catch (dbError) {
                    console.error('[AskService] Failed to save the assistant response:', dbError);
                }
            }
        }
    }
}

const askService = new AskService();

module.exports = askService;
// Exported for tests.
module.exports.createSseParser = createSseParser;
