const { createLLM } = require('../../common/ai/factory');
const sessionRepository = require('../../common/repositories/session');
const summaryRepository = require('./repositories');
const modelStateService = require('../../common/services/modelStateService');
const { isTextOnly, markTextOnly } = require('../../common/ai/textOnlyModels');
const { aboutMePromptSection } = require('../../common/prompts/aboutMe');
// Called through the module object so tests can stub the LLM call.
const questionDetector = require('./questionDetector');

// Analysis gets its own prompt: the shared 'pickle_glass_analysis' profile is
// written for Ask (it promises a screenshot and forbids summaries), which
// contradicted the summary format requested below.
const ANALYSIS_SYSTEM_PROMPT = `You are the user's live meeting and interview co-pilot. You receive a speech-to-text transcript of an ongoing conversation and, when available, a screenshot of the user's screen. Lines starting with "me:" are the user, lines starting with "them:" are the other participants.
{{ABOUT_ME}}

The transcript is machine-generated and may contain recognition errors: infer the intended meaning and ignore fragments that are clearly noise.

{{LANGUAGE_RULE}} Keep the section headers exactly as written in English (**Screen Task**, **Open Questions**, **Summary Overview**, **Key Topic: ...**, **Extended Explanation**), because they are parsed by software.

The first two sections matter most: each question there is answered in detail elsewhere, so do NOT answer anything in them.
- **Screen Task**: one line naming the task, problem or code visible on the screenshot (for example "LeetCode Two Sum, Python solution in the editor"). If the screen shows no task or code, write exactly: none
- **Open Questions**: every question or task raised in the conversation by anyone, including the user thinking aloud ("is there a bug in this code?", "how do I solve this?", "how would you solve X", "what is the complexity", "tell me about Y"), newest first. Write each one as a short, self-contained question that makes sense without the transcript. Keep earlier open questions unless they were clearly answered or dropped. If there are none, write exactly: none

<transcript>
{{CONVERSATION_HISTORY}}
</transcript>`;

const RESPONSE_FORMAT = `**Screen Task**
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
1-2 sentences on the context and implications.`;

const LANGUAGE_RULES = {
    ru: 'Write all content in Russian.',
    en: 'Write all content in English.',
};
const DEFAULT_LANGUAGE_RULE = 'Write all content in the language of the conversation.';

// New turns arriving within this window are analyzed together (the "me" and
// "them" streams often flush a turn each at the same moment).
const ANALYSIS_DEBOUNCE_MS = 1500;
// Each analysis sends a screenshot (~20 s on gemma4:e4b with whisper running)
// and competes with whisper and the call for the machine. Questions come from
// the question detector, so the summary can be rare; the first turn of a
// session is still analyzed right away, to find the task on screen.
const ANALYSIS_MIN_INTERVAL_MS = 45000;
// The "me" and "them" streams often flush a turn each at the same moment,
// and a long question can arrive as two turns.
const DETECTION_DEBOUNCE_MS = 700;
// What the question detector sees: the new turns, some turns before them for
// context, and the last questions already answered (so it recognizes repeats).
const DETECTION_MAX_NEW_TURNS = 6;
const DETECTION_CONTEXT_TURNS = 6;
const DETECTION_ANSWERED_CONTEXT = 8;
const MAX_DETECTED_QUESTIONS = 20;
const MAX_PROMPT_TURNS = 30;
// Extraction, not creative writing: a low temperature keeps the open
// questions worded the same between runs, so fewer look new to the auto answer.
const ANALYSIS_TEMPERATURE = 0.3;

// What the model writes in a section when it has nothing for it.
const NO_QUESTIONS = /^(none|нет|—|-|n\/a)\.?$/i;
const MAX_OPEN_QUESTIONS = 6;
const MAX_SUMMARY_POINTS = 5;
const MAX_TOPIC_BULLETS = 3;
const MAX_ACTIONS = 5;
// Stale-result bookkeeping is only needed for the last few sessions.
const MAX_TRACKED_SESSIONS = 8;

// The task on screen is always offered first, worded so Ask both solves it
// and checks the code that is already written.
const SCREEN_TASK_QUESTIONS = {
    ru: task => `Реши задачу на экране (${task}). Если на экране есть код, проверь его, найди и исправь ошибки.`,
    en: task => `Solve the task on screen (${task}). If there is code on screen, check it, find and fix any bugs.`,
};

// Fixed one-click requests, in the answer language.
const DEFAULT_ACTIONS = {
    ru: ['✨ Что мне сказать дальше?', '💬 Предложи уточняющие вопросы'],
    en: ['✨ What should I say next?', '💬 Suggest follow-up questions'],
};
const FOLLOW_UPS = {
    ru: ['✉️ Составь письмо по итогам', '✅ Составь список задач', '📝 Покажи итоги'],
    en: ['✉️ Draft a follow-up email', '✅ Generate action items', '📝 Show summary'],
};
const forLanguage = (table, language) => table[language] || table.en;

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

const emptyAnalysis = () => ({
    screenTask: '',
    screenTaskQuestion: '',
    questions: [],
    summary: [],
    topic: { header: '', bullets: [] },
    actions: [],
    followUps: [],
});

// Word prefixes stand in for stems: Russian inflects heavily ("задача",
// "задачу", "задачи"), and the model re-words its questions on every run.
const STEM_LENGTH = 5;
const stems = text => new Set((text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).map(w => w.slice(0, STEM_LENGTH)));

/**
 * Whether two questions are the same one, rephrased. The model rewrites the
 * open questions on every analysis, so exact comparison would re-trigger the
 * auto answer for a question that was already answered.
 */
function isSameQuestion(a, b) {
    const wa = stems(a);
    const wb = stems(b);
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

/** `questions` with `question` first, without a rephrased copy of it. */
const withQuestion = (questions, question) =>
    [question, ...(questions || []).filter(q => !isSameQuestion(q, question))].slice(0, MAX_OPEN_QUESTIONS);

const stripListMarker = line => line.replace(/^(\d+[.)]|[-•*])\s*/, '').trim();

// Lazy: askService pulls in the window manager.
const getAskService = () => require('../../ask/askService');

class SummaryService {
    constructor() {
        this.previousAnalysisResult = null;
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
        this.lastAnalysisStartedAt = -Infinity;

        // Question detection: one run at a time over the turns after
        // lastDetectedCount. Detected questions (with when they were found)
        // are kept on screen even if a summary started earlier lands later.
        this.detectionTimer = null;
        this.detectionRunning = false;
        this.detectionPending = false;
        this.lastDetectedCount = 0;
        this.detectedQuestions = [];

        // Questions already answered automatically in this session.
        this.autoAnsweredQuestions = [];
        this.autoAnsweredScreenTasks = [];
        // A detected question that waited for an answer to the user's own one.
        this.deferredQuestion = null;
        // Ask's answers from this id on belong to the current session.
        this.firstAnswerId = Infinity;
        // Auto answers only while listening: analyses still running after Stop
        // must not open Ask, since Stop clears the answered lists above and
        // every question would look new.
        this.autoAnswerEnabled = false;
    }

    setSessionId(sessionId) {
        this.currentSessionId = sessionId;
        this.autoAnswerEnabled = true;
        // Answers from here on belong to this session (see sessionAnswers).
        this.firstAnswerId = getAskService().peekNextAnswerId?.() ?? 0;
    }

    sendToRenderer(channel, data) {
        const { windowPool } = require('../../../window/windowManager');
        const listenWindow = windowPool?.get('listen');
        if (listenWindow && !listenWindow.isDestroyed()) {
            listenWindow.webContents.send(channel, data);
        }
    }

    addConversationTurn(speaker, text) {
        this.conversationHistory.push(`${speaker.toLowerCase()}: ${text.trim()}`);
        this.scheduleAnalysis();
        this.scheduleDetection();
    }

    getConversationHistory() {
        return this.conversationHistory;
    }

    resetConversationHistory() {
        this.conversationHistory = [];
        this.previousAnalysisResult = null;
        this.lastAnalyzedCount = 0;
        this.cancelScheduledAnalysis();
        this.analysisPending = false;
        this.autoAnsweredQuestions = [];
        this.autoAnsweredScreenTasks = [];
        this.deferredQuestion = null;
        this.lastAnalysisStartedAt = -Infinity;
        this.cancelScheduledDetection();
        this.detectionPending = false;
        this.lastDetectedCount = 0;
        this.detectedQuestions = [];
    }

    formatConversationForPrompt(conversationTexts, maxTurns = MAX_PROMPT_TURNS) {
        return conversationTexts.slice(-maxTurns).join('\n');
    }

    /**
     * Asks the LLM for an analysis. Throws on failure so the caller can show it.
     * @returns {Promise<{structuredData: object, responseText: string, model: string}>}
     */
    async makeOutlineAndRequests(conversationTexts, sessionId, previousResult, { screenshotBase64 = null, language = null, aboutMe = '' } = {}) {
        const modelInfo = await modelStateService.getCurrentModelInfo('llm');
        if (!modelInfo || !modelInfo.apiKey) {
            throw new Error('AI model or API key is not configured.');
        }
        if (sessionId) await sessionRepository.touch(sessionId);

        const profileSection = aboutMePromptSection(aboutMe);
        // Function replacers: the user's text and the transcript may contain "$&" etc.
        const systemPrompt = ANALYSIS_SYSTEM_PROMPT.replace('{{ABOUT_ME}}', () => (profileSection ? `\n${profileSection}\n` : ''))
            .replace('{{LANGUAGE_RULE}}', LANGUAGE_RULES[language] || DEFAULT_LANGUAGE_RULE)
            .replace('{{CONVERSATION_HISTORY}}', () => this.formatConversationForPrompt(conversationTexts));

        const previousContext = previousResult
            ? `Previous Analysis Context:
- Main Topic: ${previousResult.topic.header}
- Key Points: ${previousResult.summary.slice(0, 3).join(', ')}
- Open Questions so far:
${(previousResult.questions || []).map(q => `  - ${q}`).join('\n') || '  (none)'}

Please build upon this context while analyzing the new conversation segments.

`
            : '';
        const languageReminder = LANGUAGE_RULES[language]
            ? ` ${LANGUAGE_RULES[language]} This includes the screen task and every open question; the template above is in English only to show the format.`
            : '';
        const userText = `${previousContext}Analyze the conversation${screenshotBase64 ? ' and the screenshot of my screen' : ''}. Format your response as follows:

${RESPONSE_FORMAT}

Keep all points concise and build upon previous analysis if provided.${languageReminder}`;

        const textMessages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userText },
        ];
        const sendImage = screenshotBase64 && !isTextOnly(modelInfo.model);
        const imageMessages = sendImage && [
            textMessages[0],
            {
                role: 'user',
                content: [
                    { type: 'text', text: userText },
                    { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${screenshotBase64}` } },
                ],
            },
        ];

        const llm = createLLM(modelInfo.provider, {
            apiKey: modelInfo.apiKey,
            model: modelInfo.model,
            temperature: ANALYSIS_TEMPERATURE,
            maxTokens: 1024,
            // Yields to the question detector and Ask on a local model.
            background: true,
            // Never reason here: the hidden reasoning (~1000 tokens on gemma4)
            // would eat the 1024-token budget and leave an empty summary, and a
            // slow background summary also holds up Ask in the Ollama queue.
            think: false,
        });

        let completion;
        if (!sendImage) {
            completion = await llm.chat(textMessages);
        } else {
            try {
                completion = await llm.chat(imageMessages);
            } catch (error) {
                console.warn(`[SummaryService] ${modelInfo.model} rejected the screenshot, analyzing text-only:`, error.message);
                markTextOnly(modelInfo.model);
                completion = await llm.chat(textMessages);
            }
        }

        const responseText = completion.content;
        const structuredData = this.parseResponseText(responseText, previousResult, language);
        return { structuredData, responseText, model: modelInfo.model };
    }

    parseResponseText(responseText, previousResult, language = null) {
        const data = emptyAnalysis();
        data.followUps = [...forLanguage(FOLLOW_UPS, language)];
        if (previousResult) {
            data.topic.header = previousResult.topic.header;
            data.summary = [...previousResult.summary];
        }

        let sawQuestionsSection = false;
        let sawScreenTaskSection = false;
        let currentSection = '';

        for (const line of responseText.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            const header = detectSectionHeader(trimmed);
            if (header) {
                currentSection = header.section;
                if (currentSection === 'open-questions') sawQuestionsSection = true;
                if (currentSection === 'screen-task') sawScreenTaskSection = true;
                if (header.topicName) data.topic.header = `${header.topicName}:`;
                continue;
            }

            const bullet = trimmed.match(/^[-•*]\s+(.*)$/)?.[1].trim();
            switch (currentSection) {
                case 'screen-task': {
                    const task = trimmed.replace(/^[-•*]\s*/, '').trim();
                    if (!data.screenTask && !NO_QUESTIONS.test(task)) data.screenTask = task;
                    break;
                }
                case 'open-questions': {
                    const question = stripListMarker(trimmed);
                    if (question && !NO_QUESTIONS.test(question) && !data.questions.includes(question) && data.questions.length < MAX_OPEN_QUESTIONS) {
                        data.questions.push(question);
                    }
                    break;
                }
                case 'summary-overview':
                    // Newest point first; points carried over from the previous run drop off the end.
                    if (bullet && !data.summary.includes(bullet)) {
                        data.summary.unshift(bullet);
                        if (data.summary.length > MAX_SUMMARY_POINTS) data.summary.pop();
                    }
                    break;
                case 'topic':
                    if (bullet && data.topic.bullets.length < MAX_TOPIC_BULLETS) data.topic.bullets.push(bullet);
                    break;
                case 'explanation':
                    for (const part of trimmed.split(/\.\s+/)) {
                        const sentence = part.trim();
                        if (!sentence) continue;
                        const withDot = sentence.endsWith('.') ? sentence : `${sentence}.`;
                        if (data.topic.bullets.length < MAX_TOPIC_BULLETS && !data.topic.bullets.includes(withDot)) {
                            data.topic.bullets.push(withDot);
                        }
                    }
                    break;
                case 'questions':
                    if (/^\d+[.)]/.test(trimmed) || bullet) {
                        const question = stripListMarker(trimmed);
                        if (question.includes('?')) data.actions.push(`❓ ${question}`);
                    }
                    break;
            }
        }

        for (const action of forLanguage(DEFAULT_ACTIONS, language)) {
            if (!data.actions.includes(action)) data.actions.push(action);
        }
        data.actions = data.actions.slice(0, MAX_ACTIONS);

        // The model returns the full updated list each time; if it skipped
        // the section entirely, keep the previous one instead of wiping it.
        if (!sawQuestionsSection && previousResult?.questions) data.questions = [...previousResult.questions];
        if (!sawScreenTaskSection && previousResult?.screenTask) data.screenTask = previousResult.screenTask;
        if (data.screenTask) data.screenTaskQuestion = forLanguage(SCREEN_TASK_QUESTIONS, language)(data.screenTask);

        if (previousResult && data.topic.bullets.length === 0) data.topic.bullets = previousResult.topic.bullets;
        return data;
    }

    /**
     * Runs an analysis shortly after a new turn, so answers show up while the
     * conversation is still going, but no sooner than ANALYSIS_MIN_INTERVAL_MS
     * after the previous one started. Turns in between are covered together.
     */
    scheduleAnalysis() {
        this.cancelScheduledAnalysis();
        const sinceLast = Date.now() - this.lastAnalysisStartedAt;
        const delay = Math.max(ANALYSIS_DEBOUNCE_MS, ANALYSIS_MIN_INTERVAL_MS - sinceLast);
        this.analysisTimer = setTimeout(() => {
            this.analysisTimer = null;
            this.runLiveAnalysis();
        }, delay);
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
        this.lastAnalysisStartedAt = Date.now();
        try {
            await this.runAnalysis();
        } finally {
            this.analysisRunning = false;
        }
        if (this.analysisPending) {
            this.analysisPending = false;
            if (this.conversationHistory.length > this.lastAnalyzedCount) {
                this.scheduleAnalysis();
            }
        }
    }

    /**
     * Called when listening stops: analyzes the turns that arrived after the
     * last live analysis started (or were still in the debounce window).
     * Runs in the background so Stop isn't held up by the LLM.
     */
    finalizeSession() {
        this.autoAnswerEnabled = false;
        this.cancelScheduledAnalysis();
        this.analysisPending = false;
        if (this.conversationHistory.length > this.lastAnalyzedCount) {
            return this.runAnalysis();
        }
        return Promise.resolve();
    }

    async runAnalysis() {
        // Everything the analysis depends on is read now: Stop resets this
        // service's state while the final analysis is still in flight.
        const seq = ++this.analysisSeq;
        const startedAt = Date.now();
        const sessionId = this.currentSessionId;
        const conversationTexts = [...this.conversationHistory];
        const previousResult = this.previousAnalysisResult;
        this.lastAnalyzedCount = conversationTexts.length;

        let result;
        let error;
        try {
            const [screenshotBase64, language, aboutMe] = await Promise.all([this.captureScreen(), this.getAnswerLanguage(), this.getAboutMe()]);
            result = await this.makeOutlineAndRequests(conversationTexts, sessionId, previousResult, { screenshotBase64, language, aboutMe });
        } catch (err) {
            error = err;
        }

        // A newer analysis of the same session already landed: this one is stale.
        if (seq < (this.lastAppliedSeqBySession.get(sessionId) || 0)) return;
        // The user may have started a new session meanwhile; then this result
        // still belongs in its own session's record, but not on screen.
        const isCurrentSession = sessionId === this.currentSessionId;

        if (error) {
            console.error('[SummaryService] Analysis failed:', error.message);
            if (isCurrentSession) {
                this.sendToRenderer('summary-update', { ...(this.previousAnalysisResult || emptyAnalysis()), error: error.message });
            }
            return;
        }

        this.markApplied(sessionId, seq);
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
                console.error('[SummaryService] Failed to save summary:', err);
            }
        }

        if (!isCurrentSession) return;
        // Questions detected while this analysis ran are newer than its result.
        for (const { question, at } of this.detectedQuestions) {
            if (at >= startedAt) structuredData.questions = withQuestion(structuredData.questions, question);
        }
        this.previousAnalysisResult = structuredData;
        this.sendToRenderer('summary-update', structuredData);
        this.autoAnswerScreenTask(structuredData);
        this.retryDeferredQuestion();
    }

    markApplied(sessionId, seq) {
        this.lastAppliedSeqBySession.delete(sessionId);
        this.lastAppliedSeqBySession.set(sessionId, seq);
        if (this.lastAppliedSeqBySession.size > MAX_TRACKED_SESSIONS) {
            this.lastAppliedSeqBySession.delete(this.lastAppliedSeqBySession.keys().next().value);
        }
    }

    /**
     * Checks the newest turns for a question shortly after they arrive.
     * Unlike the summary this does not wait for the minimum interval.
     */
    scheduleDetection() {
        this.cancelScheduledDetection();
        this.detectionTimer = setTimeout(() => {
            this.detectionTimer = null;
            this.runDetection();
        }, DETECTION_DEBOUNCE_MS);
    }

    cancelScheduledDetection() {
        if (this.detectionTimer) {
            clearTimeout(this.detectionTimer);
            this.detectionTimer = null;
        }
    }

    async runDetection() {
        if (this.detectionRunning) {
            this.detectionPending = true;
            return;
        }
        this.detectionRunning = true;
        try {
            await this.detectNewQuestion();
        } catch (error) {
            console.error('[SummaryService] Question detection failed:', error.message);
        } finally {
            this.detectionRunning = false;
        }
        if (this.detectionPending) {
            this.detectionPending = false;
            if (this.conversationHistory.length > this.lastDetectedCount) await this.runDetection();
        }
    }

    /** Looks for a question in the turns since the last check and auto-answers it. */
    async detectNewQuestion() {
        this.retryDeferredQuestion();
        const history = this.conversationHistory;
        const start = this.lastDetectedCount;
        this.lastDetectedCount = history.length;
        const fresh = history.slice(start).slice(-DETECTION_MAX_NEW_TURNS);
        if (!this.autoAnswerEnabled || !fresh.some(questionDetector.looksLikeQuestion)) return;

        const sessionId = this.currentSessionId;
        const language = await this.getAnswerLanguage();
        const answered = this.answeredQuestions();
        const detected = await questionDetector.detectQuestion({
            earlier: history.slice(Math.max(0, start - DETECTION_CONTEXT_TURNS), start),
            fresh,
            answered: answered.map(a => a.text),
            language,
        });
        // Stop, or a new session, while the detector ran.
        if (!detected || sessionId !== this.currentSessionId || !this.autoAnswerEnabled) return;

        const repeated = detected.repeat ? answered[detected.repeat - 1] : null;
        if (repeated) {
            console.log(`[SummaryService] Repeated question: ${repeated.text}`);
            this.showDetectedQuestion(repeated.text, language);
            this.answerAgain(repeated.text, repeated.entry);
            return;
        }
        console.log(`[SummaryService] Detected question: ${detected.question}`);
        this.showDetectedQuestion(detected.question, language);
        this.autoAnswerQuestion(detected.question);
    }

    /** Answers given in this session, oldest first, including to questions the user asked. */
    sessionAnswers() {
        return getAskService().getAnswers?.(this.firstAnswerId) || [];
    }

    /**
     * The newest questions answered in this session, oldest first, for the
     * detector: [{text, entry}]. entry is the answer, if Ask still keeps it.
     */
    answeredQuestions() {
        const items = this.sessionAnswers()
            .filter(entry => entry.kind === 'question' && entry.subject)
            .map(entry => ({ text: entry.subject, entry }));
        for (const text of this.autoAnsweredQuestions) {
            if (!items.some(item => item.text === text)) items.push({ text, entry: null });
        }
        // A question answered twice (the first answer was cut off) is listed once, as its newest answer.
        const unique = items.filter((item, i) => !items.slice(i + 1).some(later => later.text === item.text));
        return unique.slice(-DETECTION_ANSWERED_CONTEXT);
    }

    /**
     * The answer to `question` (or a rewording of it) given in this session:
     * the newest finished or still running one, else the newest cut-off one.
     */
    findAnswer(question) {
        const matches = this.sessionAnswers()
            .filter(e => e.question === question || (e.kind === 'question' && e.subject && isSameQuestion(e.subject, question)))
            .reverse();
        return matches.find(e => e.status !== 'interrupted') || matches[0] || null;
    }

    /**
     * A question answered earlier in this session was asked again: shows the
     * answer given then. A new one would cost the model another run and could
     * differ from what the user already said. An answer cut off by a newer
     * question is generated again.
     */
    answerAgain(question, entry = this.findAnswer(question)) {
        if (!entry) {
            this.autoAnswerQuestion(question);
            return;
        }
        if (entry.status === 'pending') return;
        if (!this.canAutoAnswer({ interrupt: true })) {
            if (this.autoAnswerEnabled) this.deferredQuestion = question;
            return;
        }
        this.deferredQuestion = null;
        if (entry.status === 'interrupted') {
            this.autoAsk(entry.subject);
            return;
        }
        console.log(`[SummaryService] Showing the earlier answer again: ${entry.subject}`);
        getAskService().showAnswer(entry.id, { replay: true });
    }

    /** Puts a detected question at the top of the open questions on screen right away. */
    showDetectedQuestion(question, language) {
        this.detectedQuestions.push({ question, at: Date.now() });
        if (this.detectedQuestions.length > MAX_DETECTED_QUESTIONS) this.detectedQuestions.shift();
        const current = this.previousAnalysisResult || this.parseResponseText('', null, language);
        this.previousAnalysisResult = { ...current, questions: withQuestion(current.questions, question) };
        this.sendToRenderer('summary-update', this.previousAnalysisResult);
    }

    /**
     * Whether Ask may be opened without a click now. A question the user
     * asked themselves is never interrupted; with `interrupt: false` no
     * answer in progress is (the task on screen waits for a free moment).
     */
    canAutoAnswer({ interrupt }) {
        if (!this.autoAnswerEnabled) return false;
        const askService = getAskService();
        if (askService.isAnsweringUser?.()) return false;
        return interrupt || !askService.isAnswering?.();
    }

    /**
     * Answers a detected question in Ask, once: a question already answered
     * (even if rephrased) is not repeated. It replaces an auto answer to an
     * older question. While the user's own question is being answered it is
     * kept and tried again on the next detection or summary.
     */
    autoAnswerQuestion(question) {
        if (!question) return;
        // Answered already (also when the user asked it): show that answer.
        const earlier = this.findAnswer(question);
        if (earlier) {
            this.answerAgain(question, earlier);
            return;
        }
        // Asked before, but its answer is no longer kept.
        if (this.autoAnsweredQuestions.some(q => isSameQuestion(q, question))) return;
        if (!this.canAutoAnswer({ interrupt: true })) {
            if (this.autoAnswerEnabled) this.deferredQuestion = question;
            return;
        }
        this.deferredQuestion = null;
        this.autoAnsweredQuestions.push(question);
        this.autoAsk(question);
    }

    retryDeferredQuestion() {
        if (this.deferredQuestion) this.autoAnswerQuestion(this.deferredQuestion);
    }

    /** Solves the task the summary found on screen, once per task. */
    autoAnswerScreenTask({ screenTask, screenTaskQuestion } = {}) {
        if (!screenTask || this.autoAnsweredScreenTasks.some(t => isSameQuestion(t, screenTask))) return;
        // The user clicked it in the open questions, or it was solved before.
        const solved = this.sessionAnswers().some(
            e => e.question === screenTaskQuestion?.trim() || (e.kind === 'task' && isSameQuestion(e.subject, screenTask))
        );
        if (solved) {
            this.autoAnsweredScreenTasks.push(screenTask);
            return;
        }
        // Not marked as answered when skipped: the next summary tries again.
        if (!this.canAutoAnswer({ interrupt: false })) return;
        this.autoAnsweredScreenTasks.push(screenTask);
        this.autoAsk(screenTaskQuestion, { kind: 'task', subject: screenTask });
    }

    /** @param {{kind?: 'question'|'task', subject?: string}} [about] see askService.sendMessage */
    autoAsk(question, about = {}) {
        console.log(`[SummaryService] Auto-answering: ${question}`);
        getAskService().sendMessage(question, [...this.conversationHistory], { source: 'auto', ...about }).catch(error => {
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

    /** What the user wrote about themselves in Settings, so the analysis knows who "me" is. */
    async getAboutMe() {
        try {
            return await require('../../settings/settingsService').getAboutMeSetting();
        } catch {
            return '';
        }
    }
}

module.exports = SummaryService;
// Exported for tests.
module.exports.isSameQuestion = isSameQuestion;
module.exports.ANALYSIS_MIN_INTERVAL_MS = ANALYSIS_MIN_INTERVAL_MS;
