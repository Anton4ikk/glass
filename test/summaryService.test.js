const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const SummaryService = require('../src/features/listen/summary/summaryService');

const { ANALYSIS_MIN_INTERVAL_MS } = SummaryService;

const DEFAULT_ACTIONS = ['✨ What should I say next?', '💬 Suggest follow-up questions'];

function parse(text, previousResult = null, language = null) {
    return new SummaryService().parseResponseText(text, previousResult, language);
}

describe('SummaryService.parseResponseText', () => {
    test('parses the four English sections', () => {
        const result = parse(
            [
                '**Summary Overview**',
                '- Point A',
                '- Point B',
                '',
                '**Key Topic: Budget**',
                '- Bullet 1',
                '',
                '**Extended Explanation**',
                'First sentence. Second sentence.',
                '',
                '**Suggested Questions**',
                '1. What is the deadline?',
                '2. Not a question',
                '- How much does it cost?',
            ].join('\n')
        );

        // Newest point first.
        assert.deepEqual(result.summary, ['Point B', 'Point A']);
        assert.equal(result.topic.header, 'Budget:');
        assert.deepEqual(result.topic.bullets, ['Bullet 1', 'First sentence.', 'Second sentence.']);
        assert.deepEqual(result.actions, ['❓ What is the deadline?', '❓ How much does it cost?', ...DEFAULT_ACTIONS]);
    });

    test('accepts translated headers and "##" / trailing-colon forms', () => {
        const result = parse(
            [
                '## Краткое содержание',
                '- Обсудили сроки',
                '**Ключевая тема: Бюджет**',
                '- Нужно утвердить смету',
                '**Вопросы:**',
                '1) Когда дедлайн?',
            ].join('\n')
        );

        assert.deepEqual(result.summary, ['Обсудили сроки']);
        assert.equal(result.topic.header, 'Бюджет:');
        assert.deepEqual(result.topic.bullets, ['Нужно утвердить смету']);
        assert.deepEqual(result.actions, ['❓ Когда дедлайн?', ...DEFAULT_ACTIONS]);
    });

    test('caps actions at 5 and topic bullets at 3', () => {
        const result = parse(
            [
                '**Key Topic: X**',
                '- a',
                '- b',
                '- c',
                '- d',
                '**Suggested Questions**',
                ...[1, 2, 3, 4, 5, 6].map(n => `${n}. Question ${n}?`),
            ].join('\n')
        );

        assert.equal(result.topic.bullets.length, 3);
        assert.equal(result.actions.length, 5);
        assert.equal(result.actions[0], '❓ Question 1?');
    });

    test('falls back to the previous result when the response has no usable sections', () => {
        const previous = {
            summary: ['Earlier point'],
            topic: { header: 'Earlier topic:', bullets: ['Earlier bullet'] },
            actions: [],
            followUps: [],
        };
        const result = parse('Sorry, I could not analyze this.', previous);

        assert.deepEqual(result.summary, ['Earlier point']);
        assert.equal(result.topic.header, 'Earlier topic:');
        assert.deepEqual(result.topic.bullets, ['Earlier bullet']);
        assert.deepEqual(result.actions, DEFAULT_ACTIONS);
    });

    test('does not duplicate a summary point carried over from the previous result', () => {
        const previous = { summary: ['Same point'], topic: { header: '', bullets: [] }, actions: [], followUps: [] };
        const result = parse('**Summary Overview**\n- Same point\n- New point', previous);

        assert.deepEqual(result.summary, ['New point', 'Same point']);
    });
});

describe('SummaryService.formatConversationForPrompt', () => {
    test('keeps only the most recent turns', () => {
        const service = new SummaryService();
        const turns = ['me: one', 'them: two', 'me: three'];
        assert.equal(service.formatConversationForPrompt(turns, 2), 'them: two\nme: three');
        assert.equal(service.formatConversationForPrompt([], 2), '');
    });
});

describe('SummaryService open questions', () => {
    test('reads the screen task; "none" means no task, a missing section keeps the previous one', () => {
        assert.equal(parse('**Screen Task**\n- LeetCode Two Sum\n**Summary Overview**\n- x').screenTask, 'LeetCode Two Sum');
        const previous = { screenTask: 'Two Sum', summary: [], topic: { header: '', bullets: [] }, actions: [], followUps: [] };
        assert.equal(parse('**Screen Task**\nnone', previous).screenTask, '');
        assert.equal(parse('**Summary Overview**\n- x', previous).screenTask, 'Two Sum');
        assert.equal(parse('**Screen Task**\nnone').screenTaskQuestion, '');
    });

    test('collects the questions put to the user, newest first, without answering them', () => {
        const result = parse(
            [
                '**Open Questions**',
                '1. Как развернуть связный список?',
                '2) Какая сложность у решения Two Sum?',
                '- Как развернуть связный список?',
                '',
                '**Summary Overview**',
                '- Live coding interview',
            ].join('\n'),
            null,
            'ru'
        );

        assert.deepEqual(result.questions, ['Как развернуть связный список?', 'Какая сложность у решения Two Sum?']);
        assert.deepEqual(result.summary, ['Live coding interview']);
        // Fixed one-click requests follow the selected language.
        assert.deepEqual(result.actions, ['✨ Что мне сказать дальше?', '💬 Предложи уточняющие вопросы']);
    });

    test('"none" clears the list; a missing section keeps the previous one', () => {
        const previous = { questions: ['Earlier?'], summary: [], topic: { header: '', bullets: [] }, actions: [], followUps: [] };
        assert.deepEqual(parse('**Open Questions**\nnone\n**Summary Overview**\n- x', previous).questions, []);
        assert.deepEqual(parse('**Summary Overview**\n- x', previous).questions, ['Earlier?']);
    });
});

describe('SummaryService live analysis scheduling', () => {
    function makeService() {
        const service = new SummaryService();
        const runs = [];
        service.runAnalysis = async () => {
            runs.push(service.conversationHistory.length);
            service.lastAnalyzedCount = service.conversationHistory.length;
            await new Promise(resolve => setTimeout(resolve, 20));
        };
        return { service, runs };
    }

    test('analyzes after a single turn instead of waiting for five', async t => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const { service, runs } = makeService();
        service.addConversationTurn('Them', 'Как развернуть связный список?');
        t.mock.timers.tick(1500);
        assert.deepEqual(runs, [1]);
    });

    test('turns arriving during a run are covered by exactly one follow-up run', async t => {
        t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
        const { service, runs } = makeService();
        const first = service.runLiveAnalysis();
        service.conversationHistory.push('them: a', 'them: b');
        await service.runLiveAnalysis();
        await service.runLiveAnalysis();
        t.mock.timers.tick(20);
        await first;
        // The follow-up waits for the minimum interval instead of starting right away.
        t.mock.timers.tick(ANALYSIS_MIN_INTERVAL_MS - 1000);
        assert.deepEqual(runs, [0]);
        t.mock.timers.tick(1000);
        t.mock.timers.tick(20);
        assert.deepEqual(runs, [0, 2]);
    });

    test('a steady stream of turns is analyzed about once per interval, not per turn', async t => {
        t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
        const service = new SummaryService();
        const runs = [];
        service.runAnalysis = async () => {
            runs.push(Date.now());
            service.lastAnalyzedCount = service.conversationHistory.length;
        };
        // A turn every 2 s for 2.5 intervals.
        const turns = Math.round((2.5 * ANALYSIS_MIN_INTERVAL_MS) / 2000);
        for (let i = 0; i < turns; i++) {
            service.addConversationTurn('Them', `turn ${i}`);
            t.mock.timers.tick(2000);
            await Promise.resolve();
        }
        t.mock.timers.tick(ANALYSIS_MIN_INTERVAL_MS);
        await Promise.resolve();
        // Mocked Date reads the end of the tick in which the timer fired (1.5 s timer, 2 s ticks).
        assert.ok(runs[0] <= 2000, `the first turn is analyzed right away: ${JSON.stringify(runs)}`);
        assert.ok(runs.length <= 4, `expected about one run per interval, got ${runs.length}`);
        for (let i = 1; i < runs.length; i++) assert.ok(runs[i] - runs[i - 1] >= ANALYSIS_MIN_INTERVAL_MS);
    });
});

describe('SummaryService auto answer', () => {
    const { isSameQuestion } = SummaryService;

    test('treats a rephrased question as the same one', () => {
        assert.equal(isSameQuestion('Как развернуть связный список?', 'Как развернуть односвязный связный список?'), true);
        assert.equal(isSameQuestion('Как развернуть связный список?', 'Какая сложность у Two Sum?'), false);
    });

    function recordAsks(run) {
        const asked = [];
        const askService = require('../src/features/ask/askService');
        const original = askService.sendMessage;
        askService.sendMessage = async question => asked.push(question);
        try {
            run();
        } finally {
            askService.sendMessage = original;
        }
        return asked;
    }

    test('answers each detected question once, even rephrased', () => {
        const service = new SummaryService();
        service.setSessionId('session-1');
        const asked = recordAsks(() => {
            service.autoAnswerQuestion('Как развернуть связный список?');
            service.autoAnswerQuestion('Как развернуть односвязный связный список?');
            service.autoAnswerQuestion('Какая сложность у Two Sum?');
            service.autoAnswerQuestion(null);
        });
        assert.deepEqual(asked, ['Как развернуть связный список?', 'Какая сложность у Two Sum?']);
    });

    test('the summary auto-answers only the task on screen, once; its open questions are left to the detector', () => {
        const service = new SummaryService();
        service.setSessionId('session-1');
        const withTask = service.parseResponseText('**Screen Task**\nLeetCode Two Sum, Python\n**Open Questions**\n1. Есть ли ошибка в коде?', null, 'ru');
        const asked = recordAsks(() => {
            service.autoAnswerScreenTask(withTask);
            service.autoAnswerScreenTask(withTask);
        });
        assert.deepEqual(asked, ['Реши задачу на экране (LeetCode Two Sum, Python). Если на экране есть код, проверь его, найди и исправь ошибки.']);
    });

    test('the task on screen does not cut off an answer in progress and is tried again later', () => {
        const askService = require('../src/features/ask/askService');
        const original = askService.isAnswering;
        const service = new SummaryService();
        service.setSessionId('session-1');
        const task = service.parseResponseText('**Screen Task**\nTwo Sum', null, 'en');
        try {
            askService.isAnswering = () => true;
            assert.deepEqual(recordAsks(() => service.autoAnswerScreenTask(task)), []);
            askService.isAnswering = () => false;
            assert.equal(recordAsks(() => service.autoAnswerScreenTask(task)).length, 1);
        } finally {
            askService.isAnswering = original;
        }
    });


    test('no auto answers after Stop, even though the answered lists were reset', () => {
        const service = new SummaryService();
        service.setSessionId('session-1');
        service.runAnalysis = async () => {};
        const asked = recordAsks(() => {
            service.autoAnswerQuestion('Как решить задачу?');
            service.finalizeSession();
            service.resetConversationHistory();
            // A detection that was still running when Stop was pressed lands now.
            service.autoAnswerQuestion('Как решить задачу?');
        });
        assert.deepEqual(asked, ['Как решить задачу?']);
    });
});

describe('SummaryService auto answer vs the user', () => {
    test('Russian inflections of the same question count as one', () => {
        const { isSameQuestion } = SummaryService;
        assert.equal(isSameQuestion('Как решить задачу Two Sum?', 'Как решить эту задачу Two Sum?'), true);
        // Only the stems match here: every word is inflected differently.
        assert.equal(isSameQuestion('Объясни решение задачи', 'Объяснить решения задач'), true);
    });

    test('does not replace an answer to a question the user asked, and retries later', () => {
        const askService = require('../src/features/ask/askService');
        const original = { send: askService.sendMessage, busy: askService.isAnsweringUser };
        const asked = [];
        askService.sendMessage = async (question, _history, options) => asked.push([question, options?.source]);
        try {
            const service = new SummaryService();
            service.setSessionId('session-1');
            askService.isAnsweringUser = () => true;
            service.autoAnswerQuestion('Какая сложность?');
            assert.deepEqual(asked, []);

            // Kept, and asked once the user's answer is done.
            askService.isAnsweringUser = () => false;
            service.retryDeferredQuestion();
            service.retryDeferredQuestion();
            assert.deepEqual(asked, [['Какая сложность?', 'auto']]);
        } finally {
            askService.sendMessage = original.send;
            askService.isAnsweringUser = original.busy;
        }
    });

    test('the final analysis after Stop still builds on the previous result', async () => {
        const service = new SummaryService();
        service.setSessionId('session-1');
        service.previousAnalysisResult = { questions: ['Earlier?'], summary: ['p'], topic: { header: 'T:', bullets: [] } };
        service.conversationHistory.push('them: new turn');
        service.captureScreen = async () => null;
        service.getAnswerLanguage = async () => null;
        let seenPrevious;
        service.makeOutlineAndRequests = async (_texts, _id, previous) => {
            seenPrevious = previous;
            throw new Error('stop here');
        };
        service.sendToRenderer = () => {};

        const final = service.finalizeSession();
        service.resetConversationHistory(); // what closeSession() does right after
        await final;
        assert.deepEqual(seenPrevious?.questions, ['Earlier?']);
    });
});

