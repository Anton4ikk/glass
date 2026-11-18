const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const questionDetector = require('../src/features/listen/summary/questionDetector');
const SummaryService = require('../src/features/listen/summary/summaryService');

const { looksLikeQuestion, buildDetectorMessages, parseDetectorResponse } = questionDetector;

describe('looksLikeQuestion', () => {
    test('passes questions, requests and tasks, with or without a question mark', () => {
        for (const line of [
            'them: Чем отличается горутина от потока?',
            'them: А вот скажите, чем отличается горутина от потока',
            'them: Как бы вы ускорили этот запрос',
            'them: Объясните, пожалуйста, принцип работы b-tree',
            'them: Есть ли у вас опыт с кафкой',
            'me: Так, а как здесь найти дубликаты за линейное время',
            'them: So how would you scale this service',
            'them: Walk me through your last project',
            'them: Почему?',
            'them: Хорошо, понятно. Ок, как бы вы это протестировали',
        ]) {
            assert.equal(looksLikeQuestion(line), true, line);
        }
    });

    test('skips plain statements, so they never reach the LLM', () => {
        for (const line of [
            'them: Отлично, у нас как раз команда на го, в основном микросервисы и кафка.',
            'me: Да, с кафкой я работал, у нас было около двадцати топиков.',
            'me: Я думаю, что это хорошая идея.',
            'them: We mostly use Postgres here.',
            'me: Хм, сейчас подумаю',
        ]) {
            assert.equal(looksLikeQuestion(line), false, line);
        }
    });
});

describe('buildDetectorMessages', () => {
    test('separates the new lines from context and lists the answered questions', () => {
        const [system, user] = buildDetectorMessages({
            earlier: ['them: Расскажите о себе.'],
            fresh: ['them: Чем горутина отличается от потока?'],
            answered: ['Какой у вас опыт?'],
            language: 'ru',
        });
        assert.match(system.content, /in Russian/);
        assert.equal(
            user.content,
            'ALREADY ANSWERED:\n1. Какой у вас опыт?\n\nEARLIER (context only):\nthem: Расскажите о себе.\n\nNEW:\nthem: Чем горутина отличается от потока?'
        );
    });

    test('without context only the new lines are sent', () => {
        const [, user] = buildDetectorMessages({ earlier: [], fresh: ['them: Why?'] });
        assert.equal(user.content, 'NEW:\nthem: Why?');
    });
});

describe('parseDetectorResponse', () => {
    test('reads the question, also from fenced or chatty output', () => {
        assert.deepEqual(parseDetectorResponse('{"question": "Что такое b-tree?"}'), { question: 'Что такое b-tree?', repeat: null });
        assert.deepEqual(parseDetectorResponse('```json\n{"question": " Why? ", "repeat": null}\n```'), { question: 'Why?', repeat: null });
    });

    test('reads the number of the answered question it repeats', () => {
        assert.equal(parseDetectorResponse('{"question": "Что такое b-tree?", "repeat": 2}').repeat, 2);
        assert.equal(parseDetectorResponse('{"question": "Что такое b-tree?", "repeat": "3"}').repeat, 3);
        for (const repeat of ['0', '-1', '1.5', '"no"', 'true']) {
            assert.equal(parseDetectorResponse(`{"question": "Q?", "repeat": ${repeat}}`).repeat, null, repeat);
        }
    });

    test('null, empty and unreadable output mean "no question"', () => {
        for (const text of ['{"question": null}', '{"question": ""}', '{"question": 42}', 'not json', '{broken', '', undefined]) {
            assert.equal(parseDetectorResponse(text), null, String(text));
        }
    });
});

describe('SummaryService question detection', () => {
    function setup(t, detected) {
        const askService = require('../src/features/ask/askService');
        const calls = [];
        const asked = [];
        const updates = [];
        t.mock.method(questionDetector, 'detectQuestion', async input => {
            calls.push(input);
            const result = await (typeof detected === 'function' ? detected(input) : detected);
            return typeof result === 'string' ? { question: result, repeat: null } : result;
        });
        t.mock.method(askService, 'sendMessage', async (question, _history, options) => asked.push([question, options?.source]));
        t.mock.method(askService, 'isAnsweringUser', () => false);
        const shown = [];
        t.mock.method(askService, 'showAnswer', (id, options) => shown.push([id, options?.replay]));

        const service = new SummaryService();
        service.setSessionId('session-1');
        service.getAnswerLanguage = async () => 'ru';
        service.sendToRenderer = (channel, data) => updates.push([channel, data]);
        return { service, calls, asked, updates, shown };
    }

    /** An answer Ask gave in the current session (sendMessage is mocked, so none are recorded by it). */
    function givenAnswer(question, { status = 'done', source = 'auto' } = {}) {
        const askService = require('../src/features/ask/askService');
        const entry = askService._addAnswer({ question, subject: question, kind: 'question', source });
        entry.status = status;
        if (status !== 'pending') entry.response = `Ответ: ${question}`;
        return entry;
    }

    test('a question the detector marks as a repeat shows the earlier answer, without asking the model', async t => {
        const { service, calls, asked, shown, updates } = setup(t, { question: 'Чем горутина отличается от потока?', repeat: 1 });
        const earlier = givenAnswer('Чем горутина отличается от потока?');
        service.conversationHistory.push('them: Так, ещё раз: чем горутина отличается от потока?');

        await service.runDetection();

        assert.deepEqual(calls[0].answered, ['Чем горутина отличается от потока?']);
        assert.deepEqual(asked, []);
        assert.deepEqual(shown, [[earlier.id, true]]);
        assert.deepEqual(updates.at(-1)[1].questions, ['Чем горутина отличается от потока?']);
    });

    test('a question the user asked counts as answered: a reworded repeat shows that answer', async t => {
        const { service, calls, asked, shown } = setup(t, 'Как развернуть односвязный связный список?');
        const earlier = givenAnswer('Как развернуть связный список?', { source: 'user' });
        service.conversationHistory.push('them: А как развернуть односвязный список?');

        await service.runDetection();

        assert.deepEqual(calls[0].answered, ['Как развернуть связный список?']);
        assert.deepEqual(asked, []);
        assert.deepEqual(shown, [[earlier.id, true]]);
    });

    test('an answer cut off by a newer question is generated again when the question is repeated', async t => {
        const { service, asked, shown } = setup(t, { question: 'Что такое b-tree?', repeat: 1 });
        givenAnswer('Что такое b-tree?', { status: 'interrupted' });
        service.conversationHistory.push('them: Так что такое b-tree?');

        await service.runDetection();

        assert.deepEqual(asked, [['Что такое b-tree?', 'auto']]);
        assert.deepEqual(shown, []);
    });

    test('a repeat of the question being answered right now is left alone', async t => {
        const { service, asked, shown } = setup(t, { question: 'Что такое b-tree?', repeat: 1 });
        givenAnswer('Что такое b-tree?', { status: 'pending' });
        service.conversationHistory.push('them: Ну, что такое b-tree?');

        await service.runDetection();

        assert.deepEqual(asked, []);
        assert.deepEqual(shown, []);
    });

    test('answers from an earlier session do not count', async t => {
        givenAnswer('Что такое b-tree?');
        const { service, asked, shown } = setup(t, 'Что такое b-tree?');
        service.conversationHistory.push('them: Что такое b-tree?');

        await service.runDetection();

        assert.deepEqual(asked, [['Что такое b-tree?', 'auto']]);
        assert.deepEqual(shown, []);
    });

    test('the task on screen is not solved again after the user clicked it', t => {
        const askService = require('../src/features/ask/askService');
        const { service, asked } = setup(t, null);
        t.mock.method(askService, 'isAnswering', () => false);
        const analysis = service.parseResponseText('**Screen Task**\nLeetCode Two Sum, Python', null, 'ru');
        givenAnswer(analysis.screenTaskQuestion, { source: 'user' });

        service.autoAnswerScreenTask(analysis);

        assert.deepEqual(asked, []);
    });

    test('sends only the new turns, with earlier ones as context, and answers right away', async t => {
        const { service, calls, asked, updates } = setup(t, 'Чем горутина отличается от потока?');
        service.conversationHistory.push('them: Расскажите о себе.', 'me: Я пишу на го.');
        service.lastDetectedCount = 2;
        service.conversationHistory.push('them: Чем горутина отличается от потока?');

        await service.runDetection();

        assert.deepEqual(calls[0].earlier, ['them: Расскажите о себе.', 'me: Я пишу на го.']);
        assert.deepEqual(calls[0].fresh, ['them: Чем горутина отличается от потока?']);
        assert.equal(calls[0].language, 'ru');
        assert.deepEqual(asked, [['Чем горутина отличается от потока?', 'auto']]);
        // Shown in the open questions before any summary has run.
        const [channel, data] = updates.at(-1);
        assert.equal(channel, 'summary-update');
        assert.deepEqual(data.questions, ['Чем горутина отличается от потока?']);

        // The same turns are not checked twice.
        await service.runDetection();
        assert.equal(calls.length, 1);
    });

    test('turns without any question signal never reach the LLM', async t => {
        const { service, calls } = setup(t, 'Расскажите о вашем опыте с Kafka?');
        service.conversationHistory.push('them: У нас микросервисы и кафка.', 'me: Да, я работал с кафкой.');
        await service.runDetection();
        assert.equal(calls.length, 0);
    });

    test('answered questions are passed on, so the detector can skip repeats', async t => {
        const { service, calls } = setup(t, null);
        service.autoAnsweredQuestions.push('Что такое горутина?');
        service.conversationHistory.push('them: А что такое горутина?');
        await service.runDetection();
        assert.deepEqual(calls[0].answered, ['Что такое горутина?']);
    });

    test('a detection that lands after Stop does not open Ask', async t => {
        let release;
        const { service, asked } = setup(t, () => new Promise(resolve => (release = resolve)));
        service.conversationHistory.push('them: Как решить задачу?');
        const run = service.runDetection();
        await new Promise(resolve => setImmediate(resolve));
        service.finalizeSession = () => {};
        service.autoAnswerEnabled = false;
        service.resetConversationHistory();
        release('Как решить задачу?');
        await run;
        assert.deepEqual(asked, []);
    });

    test('a summary that started before a detection keeps the detected question on screen', async t => {
        const { service, updates } = setup(t, 'Как ускорить запрос?');
        t.mock.method(require('../src/features/listen/summary/repositories'), 'saveSummary', async () => {});
        let finishSummary;
        service.captureScreen = async () => null;
        service.getAboutMe = async () => '';
        service.makeOutlineAndRequests = () =>
            new Promise(resolve => {
                finishSummary = () =>
                    resolve({ structuredData: service.parseResponseText('**Open Questions**\n1. Какой у вас опыт?', null, 'ru'), responseText: '', model: 'm' });
            });
        service.conversationHistory.push('them: Расскажите о себе.');
        const summary = service.runAnalysis();
        await new Promise(resolve => setImmediate(resolve));

        service.conversationHistory.push('them: Как бы вы ускорили запрос?');
        await service.runDetection();
        finishSummary();
        await summary;

        assert.deepEqual(updates.at(-1)[1].questions, ['Как ускорить запрос?', 'Какой у вас опыт?']);
    });
});
