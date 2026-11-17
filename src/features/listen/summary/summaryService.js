const { BrowserWindow } = require('electron');
const { createLLM } = require('../../common/ai/factory');
const sessionRepository = require('../../common/repositories/session');
const summaryRepository = require('./repositories');
const modelStateService = require('../../common/services/modelStateService');

// Analysis gets its own prompt: the shared 'pickle_glass_analysis' profile is
// written for Ask (it promises a screenshot and forbids summaries), which
// contradicted the summary format requested below.
const ANALYSIS_SYSTEM_PROMPT = `You are the user's live meeting and interview co-pilot. You receive a speech-to-text transcript of an ongoing conversation and, when available, a screenshot of the user's screen. Lines starting with "me:" are the user, lines starting with "them:" are the other participants.

The transcript is machine-generated and may contain recognition errors: infer the intended meaning and ignore fragments that are clearly noise.

{{LANGUAGE_RULE}} Keep the section headers exactly as written in English (**Screen Task**, **Open Questions**, **Summary Overview**, **Key Topic: ...**, **Extended Explanation**), because they are parsed by software.

The first two sections matter most: each question there is answered in detail elsewhere, so do NOT answer anything in them.
- **Screen Task**: one line naming the task, problem or code visible on the screenshot (for example "LeetCode Two Sum, Python solution in the editor"). If the screen shows no task or code, write exactly: none
- **Open Questions**: every question or task raised in the conversation by anyone, including the user thinking aloud ("is there a bug in this code?", "how do I solve this?", "how would you solve X", "what is the complexity", "tell me about Y"), newest first. Write each one as a short, self-contained question that makes sense without the transcript. Keep earlier open questions unless they were clearly answered or dropped. If there are none, write exactly: none

<transcript>
{{CONVERSATION_HISTORY}}
</transcript>`;

const LANGUAGE_RULES = {
    ru: 'Write all content in Russian.',
    en: 'Write all content in English.',
};
const DEFAULT_LANGUAGE_RULE = 'Write all content in the language of the conversation.';

// New turns arriving within this window are analyzed together (the "me" and
// "them" streams often flush a turn each at the same moment).
const ANALYSIS_DEBOUNCE_MS = 1500;

// What the model writes in the Open Questions section when there are none.
const NO_QUESTIONS = /^(none|нет|—|-|n\/a)\.?$/i;
const MAX_OPEN_QUESTIONS = 6;

// The task on screen is always offered first, worded so Ask both solves it
// and checks the code that is already written.
const SCREEN_TASK_QUESTIONS = {
    ru: task => `Реши задачу на экране (${task}). Если на экране есть код, проверь его, найди и исправь ошибки.`,
    en: task => `Solve the task on screen (${task}). If there is code on screen, check it, find and fix any bugs.`,
};

// Fixed one-click requests under the insights, in the answer language.
const DEFAULT_ACTIONS = {
    ru: ['✨ Что мне сказать дальше?', '💬 Предложи уточняющие вопросы'],
    en: ['✨ What should I say next?', '💬 Suggest follow-up questions'],
};

// Section headers the parser accepts, including translated ones a model may
// produce despite the instruction above.
const SECTION_HEADERS = [
    { section: 'screen-task', pattern: /^(screen task|task on screen|задача на экране)/i },
    { section: 'open-questions', pattern: /^(open questions|asked questions|questions asked|открытые вопросы|заданные вопросы)/i },
    { section: 'summary-overview', pattern: /^(summary overview|summary|обзор|краткое содержание|краткий обзор|резюме)/i },
    { section: 'topic', pattern: /^(key topic|main topic|ключевая тема|основная тема|тема)/i },
    { section: 'explanation', pattern: /^(extended explanation|explanation|подробное объяснение|подробнее|пояснение|объяснение)/i },
    { section: 'questions', pattern: /^(suggested questions|follow-up questions|предлагаемые вопросы|рекомендуемые вопросы|вопросы)/i },
];

const EMPTY_ANALYSIS = {
    screenTask: '',
    screenTaskQuestion: '',
    questions: [],
    summary: [],
    topic: { header: '', bullets: [] },
    actions: [],
    followUps: [],
};

/**
 * Whether two questions are the same one, rephrased. The model rewrites the
 * open questions on every analysis, so exact comparison would re-trigger the
 * auto answer for a question that was already answered.
 */
function isSameQuestion(a, b) {
    const words = text => new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
    const wa = words(a);
    const wb = words(b);
    if (wa.size === 0 || wb.size === 0) return false;
    let common = 0;
    for (const w of wa) if (wb.has(w)) common++;
    return common / Math.min(wa.size, wb.size) >= 0.6;
}

/**
 * Recognizes "**Header**", "**Header:**", "## Header" and "**Key Topic: Name**".
 * @returns {{section: string, topicName: string} | null}
 */
function detectSectionHeader(line) {
    const match = line.match(/^#{0,6}\s*\*\*(.+?)\*\*:?\s*$/) || line.match(/^#{1,6}\s+(.+?)\s*$/);
    if (!match) return null;

    const headerText = match[1].trim().replace(/:$/, '');
    const header = SECTION_HEADERS.find(h => h.pattern.test(headerText));
    if (!header) return null;

    const colon = headerText.indexOf(':');
    const topicName = header.section === 'topic' && colon !== -1 ? headerText.slice(colon + 1).trim() : '';
    return { section: header.section, topicName };
}

class SummaryService {
    constructor() {
        this.previousAnalysisResult = null;
        this.analysisHistory = [];
        this.conversationHistory = [];
        this.currentSessionId = null;

        // Analyses run in the background and can overlap or outlive their
        // session; each one is numbered so an older answer never overwrites a newer one.
        this.analysisSeq = 0;
        this.lastAppliedSeqBySession = new Map();
        this.lastAnalyzedCount = 0;

        // Live analysis runs one at a time: turns that arrive while the model is
        // busy are picked up by the next run instead of starting a parallel one.
        this.analysisTimer = null;
        this.analysisRunning = false;
        this.analysisPending = false;

        // Questions already answered automatically in this session.
        this.autoAnsweredQuestions = [];
        this.autoAnsweredScreenTasks = [];

        // Models that rejected the screenshot; their analyses are text-only.
        this.textOnlyModels = new Set();

        // Callbacks
        this.onAnalysisComplete = null;
        this.onStatusUpdate = null;
    }

    setCallbacks({ onAnalysisComplete, onStatusUpdate }) {
        this.onAnalysisComplete = onAnalysisComplete;
        this.onStatusUpdate = onStatusUpdate;
    }

    setSessionId(sessionId) {
        this.currentSessionId = sessionId;
    }

    sendToRenderer(channel, data) {
        const { windowPool } = require('../../../window/windowManager');
        const listenWindow = windowPool?.get('listen');

        if (listenWindow && !listenWindow.isDestroyed()) {
            listenWindow.webContents.send(channel, data);
        }
    }

    addConversationTurn(speaker, text) {
        const conversationText = `${speaker.toLowerCase()}: ${text.trim()}`;
        this.conversationHistory.push(conversationText);
        console.log(`💬 Added conversation text: ${conversationText}`);
        console.log(`📈 Total conversation history: ${this.conversationHistory.length} texts`);

        this.scheduleAnalysis();
    }

    getConversationHistory() {
        return this.conversationHistory;
    }

    resetConversationHistory() {
        this.conversationHistory = [];
        this.previousAnalysisResult = null;
        this.analysisHistory = [];
        this.lastAnalyzedCount = 0;
        this.cancelScheduledAnalysis();
        this.analysisPending = false;
        this.autoAnsweredQuestions = [];
        this.autoAnsweredScreenTasks = [];
        console.log('🔄 Conversation history and analysis state reset');
    }

    /**
     * Converts conversation history into text to include in the prompt.
     * @param {Array<string>} conversationTexts - Array of conversation texts ["me: ~~~", "them: ~~~", ...]
     * @param {number} maxTurns - Maximum number of recent turns to include
     * @returns {string} - Formatted conversation string for the prompt
     */
    formatConversationForPrompt(conversationTexts, maxTurns = 30) {
        if (conversationTexts.length === 0) return '';
        return conversationTexts.slice(-maxTurns).join('\n');
    }

    /**
     * Asks the LLM for an analysis. Throws on failure so the caller can show it.
     * @returns {Promise<{structuredData: object, responseText: string, model: string}>}
     */
    async makeOutlineAndRequests(conversationTexts, sessionId, previousResult, { maxTurns = 30, screenshotBase64 = null, language = null } = {}) {
        console.log(`🔍 makeOutlineAndRequests called - conversationTexts: ${conversationTexts.length}`);

        const recentConversation = this.formatConversationForPrompt(conversationTexts, maxTurns);

        // 이전 분석 결과를 프롬프트에 포함
        let contextualPrompt = '';
        if (previousResult) {
            const previousQuestions = (previousResult.questions || []).map(q => `  - ${q}`).join('\n');
            contextualPrompt = `
Previous Analysis Context:
- Main Topic: ${previousResult.topic.header}
- Key Points: ${previousResult.summary.slice(0, 3).join(', ')}
- Open Questions so far:
${previousQuestions || '  (none)'}

Please build upon this context while analyzing the new conversation segments.
`;
        }

        const systemPrompt = ANALYSIS_SYSTEM_PROMPT
            .replace('{{LANGUAGE_RULE}}', LANGUAGE_RULES[language] || DEFAULT_LANGUAGE_RULE)
            .replace('{{CONVERSATION_HISTORY}}', recentConversation);

        if (sessionId) {
            await sessionRepository.touch(sessionId);
        }

        const modelInfo = await modelStateService.getCurrentModelInfo('llm');
        if (!modelInfo || !modelInfo.apiKey) {
            throw new Error('AI model or API key is not configured.');
        }
        console.log(`🤖 Sending analysis request to ${modelInfo.provider} using model ${modelInfo.model}`);

        const messages = [
            {
                role: 'system',
                content: systemPrompt,
            },
            {
                role: 'user',
                content: `${contextualPrompt}

Analyze the conversation${screenshotBase64 ? ' and the screenshot of my screen' : ''}. Format your response as follows:

**Screen Task**
The task or code on my screen, or: none

**Open Questions**
1. Newest question or task raised?
2. Earlier question still open?

**Summary Overview**
- Main discussion point with context

**Key Topic: [Topic Name]**
- First key insight
- Second key insight

**Extended Explanation**
1-2 sentences on the context and implications.

Keep all points concise and build upon previous analysis if provided.${
                    LANGUAGE_RULES[language]
                        ? ` ${LANGUAGE_RULES[language]} This includes the screen task and every open question; the template above is in English only to show the format.`
                        : ''
                }`,
            },
        ];

        const textOnly = !screenshotBase64 || this.textOnlyModels.has(modelInfo.model);
        const withScreenshot = textOnly
            ? messages
            : [
                  messages[0],
                  {
                      role: 'user',
                      content: [
                          { type: 'text', text: messages[1].content },
                          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${screenshotBase64}` } },
                      ],
                  },
              ];

        const llm = createLLM(modelInfo.provider, {
            apiKey: modelInfo.apiKey,
            model: modelInfo.model,
            temperature: 0.7,
            maxTokens: 1024,
            // Never reason here: the hidden reasoning (~1000 tokens on gemma4)
            // would eat the 1024-token budget and leave an empty summary, and a
            // slow background summary also holds up Ask in the Ollama queue.
            think: false,
            usePortkey: modelInfo.provider === 'openai-glass',
            portkeyVirtualKey: modelInfo.provider === 'openai-glass' ? modelInfo.apiKey : undefined,
        });

        let completion;
        try {
            completion = await llm.chat(withScreenshot);
        } catch (error) {
            if (textOnly) throw error;
            // The model may not accept images: remember that and go text-only.
            console.warn(`[SummaryService] Analysis with screenshot failed on ${modelInfo.model}, retrying text-only:`, error.message);
            this.textOnlyModels.add(modelInfo.model);
            completion = await llm.chat(messages);
        }

        const responseText = completion.content;
        console.log(`✅ Analysis response received: ${responseText}`);
        const structuredData = this.parseResponseText(responseText, previousResult, language);

        return { structuredData, responseText, model: modelInfo.model };
    }

    parseResponseText(responseText, previousResult, language = null) {
        const structuredData = {
            screenTask: '',
            screenTaskQuestion: '',
            questions: [],
            summary: [],
            topic: { header: '', bullets: [] },
            actions: [],
            followUps: ['✉️ Draft a follow-up email', '✅ Generate action items', '📝 Show summary'],
        };
        let sawQuestionsSection = false;
        let sawScreenTaskSection = false;

        // 이전 결과가 있으면 기본값으로 사용
        if (previousResult) {
            structuredData.topic.header = previousResult.topic.header;
            structuredData.summary = [...previousResult.summary];
        }

        try {
            const lines = responseText.split('\n');
            let currentSection = '';

            for (const line of lines) {
                const trimmedLine = line.trim();

                // 섹션 헤더 감지
                const header = detectSectionHeader(trimmedLine);
                if (header) {
                    currentSection = header.section;
                    if (currentSection === 'open-questions') sawQuestionsSection = true;
                    if (currentSection === 'screen-task') sawScreenTaskSection = true;
                    if (header.topicName) {
                        structuredData.topic.header = header.topicName + ':';
                    }
                    continue;
                }

                // 컨텐츠 파싱
                const bulletMatch = trimmedLine.match(/^[-•*]\s+(.*)$/);
                if (currentSection === 'screen-task' && trimmedLine) {
                    const task = trimmedLine.replace(/^[-•*]\s*/, '').trim();
                    if (!structuredData.screenTask && !NO_QUESTIONS.test(task)) {
                        structuredData.screenTask = task;
                    }
                } else if (currentSection === 'open-questions' && trimmedLine) {
                    const question = trimmedLine.replace(/^(\d+[.)]|[-•*])\s*/, '').trim();
                    if (
                        question &&
                        !NO_QUESTIONS.test(question) &&
                        !structuredData.questions.includes(question) &&
                        structuredData.questions.length < MAX_OPEN_QUESTIONS
                    ) {
                        structuredData.questions.push(question);
                    }
                } else if (bulletMatch && currentSection === 'summary-overview') {
                    const summaryPoint = bulletMatch[1].trim();
                    if (summaryPoint && !structuredData.summary.includes(summaryPoint)) {
                        // 기존 summary 업데이트 (최대 5개 유지)
                        structuredData.summary.unshift(summaryPoint);
                        if (structuredData.summary.length > 5) {
                            structuredData.summary.pop();
                        }
                    }
                } else if (bulletMatch && currentSection === 'topic') {
                    const bullet = bulletMatch[1].trim();
                    if (bullet && structuredData.topic.bullets.length < 3) {
                        structuredData.topic.bullets.push(bullet);
                    }
                } else if (currentSection === 'explanation' && trimmedLine) {
                    // explanation을 topic bullets에 추가 (문장 단위로)
                    const sentences = trimmedLine
                        .split(/\.\s+/)
                        .filter(s => s.trim().length > 0)
                        .map(s => s.trim() + (s.endsWith('.') ? '' : '.'));

                    sentences.forEach(sentence => {
                        if (structuredData.topic.bullets.length < 3 && !structuredData.topic.bullets.includes(sentence)) {
                            structuredData.topic.bullets.push(sentence);
                        }
                    });
                } else if (currentSection === 'questions' && (/^\d+[.)]/.test(trimmedLine) || bulletMatch)) {
                    const question = trimmedLine.replace(/^(\d+[.)]|[-•*])\s*/, '').trim();
                    if (question && question.includes('?')) {
                        structuredData.actions.push(`❓ ${question}`);
                    }
                }
            }

            // 기본 액션 추가
            const defaultActions = DEFAULT_ACTIONS[language] || DEFAULT_ACTIONS.en;
            defaultActions.forEach(action => {
                if (!structuredData.actions.includes(action)) {
                    structuredData.actions.push(action);
                }
            });

            // 액션 개수 제한
            structuredData.actions = structuredData.actions.slice(0, 5);

            // The model returns the full updated list each time; if it skipped
            // the section entirely, keep the previous list instead of wiping it.
            if (!sawQuestionsSection && previousResult?.questions) {
                structuredData.questions = [...previousResult.questions];
            }
            if (!sawScreenTaskSection && previousResult?.screenTask) {
                structuredData.screenTask = previousResult.screenTask;
            }
            if (structuredData.screenTask) {
                const template = SCREEN_TASK_QUESTIONS[language] || SCREEN_TASK_QUESTIONS.en;
                structuredData.screenTaskQuestion = template(structuredData.screenTask);
            }

            // 유효성 검증 및 이전 데이터 병합
            if (structuredData.summary.length === 0 && previousResult) {
                structuredData.summary = previousResult.summary;
            }
            if (structuredData.topic.bullets.length === 0 && previousResult) {
                structuredData.topic.bullets = previousResult.topic.bullets;
            }
        } catch (error) {
            console.error('❌ Error parsing response text:', error);
            // 에러 시 이전 결과 반환
            return (
                previousResult || {
                    summary: [],
                    topic: { header: 'Analysis in progress', bullets: [] },
                    actions: ['✨ What should I say next?', '💬 Suggest follow-up questions'],
                    followUps: ['✉️ Draft a follow-up email', '✅ Generate action items', '📝 Show summary'],
                }
            );
        }

        console.log('📊 Final structured data:', JSON.stringify(structuredData, null, 2));
        return structuredData;
    }

    /**
     * Runs an analysis shortly after every new turn, so answers show up while
     * the conversation is still going. Only one analysis runs at a time; turns
     * that arrive meanwhile are covered by one follow-up run.
     */
    scheduleAnalysis() {
        this.cancelScheduledAnalysis();
        this.analysisTimer = setTimeout(() => {
            this.analysisTimer = null;
            this.runLiveAnalysis();
        }, ANALYSIS_DEBOUNCE_MS);
    }

    cancelScheduledAnalysis() {
        if (this.analysisTimer) {
            clearTimeout(this.analysisTimer);
            this.analysisTimer = null;
        }
    }

    async runLiveAnalysis() {
        if (this.analysisRunning) {
            this.analysisPending = true;
            return;
        }
        this.analysisRunning = true;
        try {
            await this.runAnalysis();
        } finally {
            this.analysisRunning = false;
        }
        if (this.analysisPending) {
            this.analysisPending = false;
            if (this.conversationHistory.length > this.lastAnalyzedCount) {
                this.runLiveAnalysis();
            }
        }
    }

    /**
     * Called when listening stops: analyzes the turns added since the last
     * analysis, which the every-5-turns trigger would otherwise never see.
     * Runs in the background so Stop isn't held up by the LLM.
     */
    finalizeSession() {
        this.cancelScheduledAnalysis();
        this.analysisPending = false;
        if (this.conversationHistory.length > this.lastAnalyzedCount) {
            console.log(`Final analysis - ${this.conversationHistory.length - this.lastAnalyzedCount} unanalyzed conversation texts`);
            return this.runAnalysis();
        }
        return Promise.resolve();
    }

    async runAnalysis() {
        const seq = ++this.analysisSeq;
        const sessionId = this.currentSessionId;
        const conversationTexts = [...this.conversationHistory];
        this.lastAnalyzedCount = conversationTexts.length;

        let result;
        let error;
        try {
            const [screenshotBase64, language] = await Promise.all([this.captureScreen(), this.getAnswerLanguage()]);
            result = await this.makeOutlineAndRequests(conversationTexts, sessionId, this.previousAnalysisResult, {
                screenshotBase64,
                language,
            });
        } catch (err) {
            error = err;
        }

        // A newer analysis of the same session already landed: this one is stale.
        if (seq < (this.lastAppliedSeqBySession.get(sessionId) || 0)) {
            console.log(`Discarding stale analysis #${seq} for session ${sessionId}`);
            return;
        }
        // The user may have started a new session meanwhile; then this result
        // still belongs in its own session's record, but not on screen.
        const isCurrentSession = sessionId === this.currentSessionId;

        if (error) {
            console.error('❌ Error during analysis generation:', error.message);
            if (isCurrentSession) {
                this.sendToRenderer('summary-update', {
                    ...(this.previousAnalysisResult || EMPTY_ANALYSIS),
                    error: error.message,
                });
            }
            return;
        }

        this.lastAppliedSeqBySession.set(sessionId, seq);
        const { structuredData, responseText, model } = result;

        if (sessionId) {
            try {
                await summaryRepository.saveSummary({
                    sessionId,
                    text: responseText,
                    tldr: structuredData.summary.join('\n'),
                    bullet_json: JSON.stringify(structuredData.topic.bullets),
                    action_json: JSON.stringify(structuredData.actions),
                    model,
                });
            } catch (err) {
                console.error('[DB] Failed to save summary:', err);
            }
        }

        if (!isCurrentSession) return;

        // 분석 결과 저장
        this.previousAnalysisResult = structuredData;
        this.analysisHistory.push({
            timestamp: Date.now(),
            data: structuredData,
            conversationLength: conversationTexts.length,
        });

        if (this.analysisHistory.length > 10) {
            this.analysisHistory.shift();
        }

        console.log('Sending structured data to renderer');
        this.sendToRenderer('summary-update', structuredData);

        this.autoAnswerNewestQuestion(structuredData);

        // Notify callback
        if (this.onAnalysisComplete) {
            this.onAnalysisComplete(structuredData);
        }
    }

    /**
     * Answers in Ask without a click: first the task on screen (once per
     * task), then the newest question heard. A newer question interrupts the
     * answer to an older one; a question that was already answered (even if
     * rephrased) is not repeated.
     */
    autoAnswerNewestQuestion({ screenTask, screenTaskQuestion, questions } = {}) {
        let question = null;
        if (screenTask && !this.autoAnsweredScreenTasks.some(t => isSameQuestion(t, screenTask))) {
            this.autoAnsweredScreenTasks.push(screenTask);
            question = screenTaskQuestion;
        } else {
            const newest = questions?.[0];
            if (newest && !this.autoAnsweredQuestions.some(q => isSameQuestion(q, newest))) {
                this.autoAnsweredQuestions.push(newest);
                question = newest;
            }
        }
        if (!question) return;

        console.log(`[SummaryService] Auto-answering: ${question}`);
        const askService = require('../../ask/askService');
        askService.sendMessage(question, [...this.conversationHistory]).catch(error => {
            console.error('[SummaryService] Auto answer failed:', error.message);
        });
    }

    async captureScreen() {
        try {
            const { captureScreenshot } = require('../../common/utils/screenCapture');
            const result = await captureScreenshot();
            return result.success ? result.base64 : null;
        } catch (error) {
            console.warn('[SummaryService] Screenshot for analysis failed:', error.message);
            return null;
        }
    }

    /** The RU/EN switch picks the transcription language; insights follow it. */
    async getAnswerLanguage() {
        try {
            return await require('../../settings/settingsService').getSttLanguageSetting();
        } catch {
            return null;
        }
    }

    getCurrentAnalysisData() {
        return {
            previousResult: this.previousAnalysisResult,
            history: this.analysisHistory,
            conversationLength: this.conversationHistory.length,
        };
    }
}

module.exports = SummaryService;
// Exported for tests.
module.exports.isSameQuestion = isSameQuestion;
