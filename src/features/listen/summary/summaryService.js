const { BrowserWindow } = require('electron');
const { createLLM } = require('../../common/ai/factory');
const sessionRepository = require('../../common/repositories/session');
const summaryRepository = require('./repositories');
const modelStateService = require('../../common/services/modelStateService');

// Analysis gets its own prompt: the shared 'pickle_glass_analysis' profile is
// written for Ask (it promises a screenshot and forbids summaries), which
// contradicted the summary format requested below.
const ANALYSIS_SYSTEM_PROMPT = `You are the user's live meeting co-pilot. You receive a speech-to-text transcript of an ongoing conversation. Lines starting with "me:" are the user, lines starting with "them:" are the other participants.

The transcript is machine-generated and may contain recognition errors: infer the intended meaning and ignore fragments that are clearly noise.

Write all content in the language of the conversation, but keep the four section headers exactly as written in English (**Summary Overview**, **Key Topic: ...**, **Extended Explanation**, **Suggested Questions**), because they are parsed by software.

If someone asked the user a question near the end of the transcript, start the Extended Explanation with a direct answer to it.

<transcript>
{{CONVERSATION_HISTORY}}
</transcript>`;

// Section headers the parser accepts, including translated ones a model may
// produce despite the instruction above.
const SECTION_HEADERS = [
    { section: 'summary-overview', pattern: /^(summary overview|summary|обзор|краткое содержание|краткий обзор|резюме)/i },
    { section: 'topic', pattern: /^(key topic|main topic|ключевая тема|основная тема|тема)/i },
    { section: 'explanation', pattern: /^(extended explanation|explanation|подробное объяснение|подробнее|пояснение|объяснение)/i },
    { section: 'questions', pattern: /^(suggested questions|follow-up questions|предлагаемые вопросы|рекомендуемые вопросы|вопросы)/i },
];

const EMPTY_ANALYSIS = {
    summary: [],
    topic: { header: '', bullets: [] },
    actions: [],
    followUps: [],
};

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

        // Trigger analysis if needed
        this.triggerAnalysisIfNeeded();
    }

    getConversationHistory() {
        return this.conversationHistory;
    }

    resetConversationHistory() {
        this.conversationHistory = [];
        this.previousAnalysisResult = null;
        this.analysisHistory = [];
        this.lastAnalyzedCount = 0;
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
    async makeOutlineAndRequests(conversationTexts, sessionId, previousResult, maxTurns = 30) {
        console.log(`🔍 makeOutlineAndRequests called - conversationTexts: ${conversationTexts.length}`);

        const recentConversation = this.formatConversationForPrompt(conversationTexts, maxTurns);

        // 이전 분석 결과를 프롬프트에 포함
        let contextualPrompt = '';
        if (previousResult) {
            contextualPrompt = `
Previous Analysis Context:
- Main Topic: ${previousResult.topic.header}
- Key Points: ${previousResult.summary.slice(0, 3).join(', ')}
- Last Actions: ${previousResult.actions.slice(0, 2).join(', ')}

Please build upon this context while analyzing the new conversation segments.
`;
        }

        const systemPrompt = ANALYSIS_SYSTEM_PROMPT.replace('{{CONVERSATION_HISTORY}}', recentConversation);

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

Analyze the conversation and provide a structured summary. Respond in the same language as the conversation (e.g., if the conversation is in French, respond in French; if in English, respond in English), keeping the section headers in English. Format your response as follows:

**Summary Overview**
- Main discussion point with context

**Key Topic: [Topic Name]**
- First key insight
- Second key insight
- Third key insight

**Extended Explanation**
Provide 2-3 sentences explaining the context and implications.

**Suggested Questions**
1. First follow-up question?
2. Second follow-up question?
3. Third follow-up question?

Keep all points concise and build upon previous analysis if provided.`,
            },
        ];

        const llm = createLLM(modelInfo.provider, {
            apiKey: modelInfo.apiKey,
            model: modelInfo.model,
            temperature: 0.7,
            maxTokens: 1024,
            usePortkey: modelInfo.provider === 'openai-glass',
            portkeyVirtualKey: modelInfo.provider === 'openai-glass' ? modelInfo.apiKey : undefined,
        });

        const completion = await llm.chat(messages);

        const responseText = completion.content;
        console.log(`✅ Analysis response received: ${responseText}`);
        const structuredData = this.parseResponseText(responseText, previousResult);

        return { structuredData, responseText, model: modelInfo.model };
    }

    parseResponseText(responseText, previousResult) {
        const structuredData = {
            summary: [],
            topic: { header: '', bullets: [] },
            actions: [],
            followUps: ['✉️ Draft a follow-up email', '✅ Generate action items', '📝 Show summary'],
        };

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
                    if (header.topicName) {
                        structuredData.topic.header = header.topicName + ':';
                    }
                    continue;
                }

                // 컨텐츠 파싱
                const bulletMatch = trimmedLine.match(/^[-•*]\s+(.*)$/);
                if (bulletMatch && currentSection === 'summary-overview') {
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
            const defaultActions = ['✨ What should I say next?', '💬 Suggest follow-up questions'];
            defaultActions.forEach(action => {
                if (!structuredData.actions.includes(action)) {
                    structuredData.actions.push(action);
                }
            });

            // 액션 개수 제한
            structuredData.actions = structuredData.actions.slice(0, 5);

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
     * Triggers analysis when conversation history reaches 5 texts.
     */
    triggerAnalysisIfNeeded() {
        if (this.conversationHistory.length >= 5 && this.conversationHistory.length % 5 === 0) {
            console.log(`Triggering analysis - ${this.conversationHistory.length} conversation texts accumulated`);
            this.runAnalysis();
        }
    }

    /**
     * Called when listening stops: analyzes the turns added since the last
     * analysis, which the every-5-turns trigger would otherwise never see.
     * Runs in the background so Stop isn't held up by the LLM.
     */
    finalizeSession() {
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
            result = await this.makeOutlineAndRequests(conversationTexts, sessionId, this.previousAnalysisResult);
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

        // Notify callback
        if (this.onAnalysisComplete) {
            this.onAnalysisComplete(structuredData);
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
