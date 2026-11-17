const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const SummaryService = require('../src/features/listen/summary/summaryService');

const DEFAULT_ACTIONS = ['✨ What should I say next?', '💬 Suggest follow-up questions'];

function parse(text, previousResult = null) {
    return new SummaryService().parseResponseText(text, previousResult);
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
