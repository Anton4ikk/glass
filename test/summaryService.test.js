const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const SummaryService = require('../src/features/listen/summary/summaryService');

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

    test('turns arriving during a run are covered by exactly one follow-up run', async () => {
        const { service, runs } = makeService();
        const first = service.runLiveAnalysis();
        service.conversationHistory.push('them: a', 'them: b');
        await service.runLiveAnalysis();
        await service.runLiveAnalysis();
        await first;
        await new Promise(resolve => setTimeout(resolve, 60));
        assert.deepEqual(runs, [0, 2]);
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

    test('answers each new question once, newest first', () => {
        const service = new SummaryService();
        const asked = recordAsks(() => {
            service.autoAnswerNewestQuestion({ questions: ['Как развернуть связный список?'] });
            service.autoAnswerNewestQuestion({ questions: ['Как развернуть связный список?'] });
            service.autoAnswerNewestQuestion({ questions: ['Какая сложность у Two Sum?', 'Как развернуть связный список?'] });
            service.autoAnswerNewestQuestion({ questions: [] });
        });
        assert.deepEqual(asked, ['Как развернуть связный список?', 'Какая сложность у Two Sum?']);
    });

    test('the task on screen is answered first, once, then spoken questions', () => {
        const service = new SummaryService();
        const data = text => service.parseResponseText(text, null, 'ru');
        const withTask = data('**Screen Task**\nLeetCode Two Sum, Python\n**Open Questions**\n1. Есть ли ошибка в коде?');
        const asked = recordAsks(() => {
            service.autoAnswerNewestQuestion(withTask);
            service.autoAnswerNewestQuestion(withTask);
            service.autoAnswerNewestQuestion(withTask);
        });
        assert.deepEqual(asked, [
            'Реши задачу на экране (LeetCode Two Sum, Python). Если на экране есть код, проверь его, найди и исправь ошибки.',
            'Есть ли ошибка в коде?',
        ]);
    });

});
