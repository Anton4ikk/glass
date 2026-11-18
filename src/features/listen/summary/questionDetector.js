// Finds the question to auto-answer in the newest transcript lines.
// A separate tiny text-only request (~1 s on gemma4:e4b, 16 GB M1 Pro) instead
// of waiting for the ~20 s live summary; a rule-based filter skips it for
// lines that cannot hold a question.
const { createLLM } = require('../../common/ai/factory');
const modelStateService = require('../../common/services/modelStateService');

const words = text => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];

// Words that open a question when they start a sentence. Not after a comma:
// there "что", "как", "когда" are conjunctions ("Я думаю, что ...").
const QUESTION_OPENERS = new Set([
    // Russian
    'как', 'какой', 'какая', 'какое', 'какие', 'каким', 'какую', 'каких', 'какого', 'каков', 'какова',
    'что', 'чем', 'чего', 'чему', 'почему', 'зачем', 'когда', 'где', 'куда', 'откуда', 'кто', 'кого',
    'кому', 'сколько', 'разве', 'неужели', 'можете', 'можешь', 'могли', 'знаете', 'знаешь',
    'приходилось', 'доводилось', 'есть',
    // English
    'what', 'how', 'why', 'when', 'where', 'who', 'whom', 'whose', 'which', 'can', 'could', 'would',
    'will', 'do', 'does', 'did', 'is', 'are', 'was', 'were', 'have', 'has', 'should', 'shall',
]);
// Skipped before the opener, commas included: "А вот как ...",
// "Хорошо, понятно, а как ...", "Okay, so how ...".
const FILLERS = new Set([
    'а', 'и', 'ну', 'вот', 'так', 'хорошо', 'ладно', 'окей', 'ок', 'тогда', 'теперь', 'понятно', 'ясно', 'отлично', 'супер', 'спасибо', 'да', 'хм',
    'and', 'so', 'ok', 'okay', 'well', 'now', 'then', 'right', 'great', 'good', 'thanks', 'yeah', 'yes',
]);
// Requests and tasks, in any position ("Объясните, пожалуйста, ...", "Please explain ...").
const REQUEST_WORDS = new Set(
    ['расскажи', 'объясни', 'опиши', 'назови', 'приведи', 'покажи', 'напиши', 'реши', 'сравни', 'докажи', 'предложи', 'перечисли', 'оцени', 'представь', 'подумай', 'скажи', 'реализуй', 'посчитай']
        .flatMap(w => [w, `${w}те`])
        .concat(['explain', 'describe', 'tell', 'show', 'write', 'implement', 'solve', 'compare', 'design', 'walk', 'name', 'list'])
);

/**
 * Cheap pre-check: can this transcript line contain a question or a request?
 * Errs on the side of yes; the detector makes the real decision.
 */
function looksLikeQuestion(line) {
    const text = line.replace(/^(me|them):\s*/i, '');
    if (text.includes('?')) return true;
    const all = words(text);
    if (all.some(w => REQUEST_WORDS.has(w) || w === 'ли')) return true;
    return text.split(/[.!;:—–\n]+/).some(sentence => {
        const first = words(sentence).find(w => !FILLERS.has(w));
        return !!first && QUESTION_OPENERS.has(first);
    });
}

const DETECTOR_PROMPT = `You find questions in a live conversation transcript (speech-to-text, may contain recognition errors). "me:" lines are the user, "them:" lines are the other participants.

Answer with JSON only: {"question": "...", "repeat": null}, or {"question": null}.

Rules:
- Look only at the lines under NEW. Lines under EARLIER are context for understanding them, never a source of questions.
- A question is something the user is asked or asks themselves and may need help answering: a direct question, a request ("tell me about...", "explain...", "how would you...") or a task. It may be split across several NEW lines.
- Return null when the NEW lines are statements, answers, comments, small talk, greetings or agreement. Never turn a mentioned topic into a question: "we use Kafka" is not a question.
- Return null for courtesy and logistics that need no help: "can you hear me?", "how are you?", "shall we start?", rhetorical questions.
- Write the newest such question {{LANGUAGE}} as one short self-contained question: replace "it", "this", "that" with what they refer to.
- If the NEW lines ask one of the ALREADY ANSWERED questions again (reworded, or in another language), copy its wording and put its number in "repeat": {"question": "<as worded there>", "repeat": 2}. Only when it is asked again, not when it is mentioned or being answered. A follow-up on the same topic, or the same question with a new condition, is a new question: "repeat": null.`;

const LANGUAGES = { ru: 'in Russian', en: 'in English' };

/**
 * @param {{earlier: string[], fresh: string[], answered?: string[], language?: string}} input
 */
function buildDetectorMessages({ earlier, fresh, answered = [], language = null }) {
    const parts = [];
    if (answered.length) parts.push(`ALREADY ANSWERED:\n${answered.map((q, i) => `${i + 1}. ${q}`).join('\n')}`);
    if (earlier.length) parts.push(`EARLIER (context only):\n${earlier.join('\n')}`);
    parts.push(`NEW:\n${fresh.join('\n')}`);
    return [
        { role: 'system', content: DETECTOR_PROMPT.replace('{{LANGUAGE}}', LANGUAGES[language] || 'in the language of the conversation') },
        { role: 'user', content: parts.join('\n\n') },
    ];
}

/**
 * @returns {{question: string, repeat: number|null}|null} the question, and the
 *   1-based number of the ALREADY ANSWERED one it repeats; null for "no
 *   question" and unreadable output
 */
function parseDetectorResponse(text) {
    const json = (text || '').match(/\{[\s\S]*\}/)?.[0];
    if (!json) return null;
    try {
        const { question, repeat } = JSON.parse(json);
        if (typeof question !== 'string' || !question.trim()) return null;
        // Small models write the number as a string now and then.
        const number = typeof repeat === 'number' || typeof repeat === 'string' ? Number(repeat) : NaN;
        return { question: question.trim(), repeat: Number.isInteger(number) && number > 0 ? number : null };
    } catch {
        return null;
    }
}

/**
 * Asks the current LLM for the newest question in `fresh`. Throws on failure.
 * @returns {Promise<{question: string, repeat: number|null}|null>} see parseDetectorResponse
 */
async function detectQuestion(input) {
    const modelInfo = await modelStateService.getCurrentModelInfo('llm');
    if (!modelInfo || !modelInfo.apiKey) throw new Error('AI model or API key is not configured.');

    const llm = createLLM(modelInfo.provider, {
        apiKey: modelInfo.apiKey,
        model: modelInfo.model,
        temperature: 0,
        maxTokens: 150,
        // Hidden reasoning would cost tens of seconds; the task is simple.
        think: false,
        format: 'json',
    });
    const completion = await llm.chat(buildDetectorMessages(input));
    return parseDetectorResponse(completion.content);
}

module.exports = { detectQuestion, looksLikeQuestion, buildDetectorMessages, parseDetectorResponse };
