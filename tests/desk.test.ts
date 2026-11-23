import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { ageText, clip, deskCards, laneOf, plain, titleOf, type DeskItem } from '../src/desk.ts'

// Checks of the Desk's card rules (src/desk.ts): which lane a thread goes in, how a title and a
// body are cut from Markdown, and how an age reads.

const NOW = Date.UTC(2026, 10, 20, 12, 0, 0)
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

const item = (fields: Partial<DeskItem> = {}): DeskItem => ({
    url: 'https://github.com/acme/app/pull/7',
    repo: 'acme/app',
    number: 7,
    isPullRequest: true,
    isOpen: true,
    isDraft: false,
    byBenny: true,
    hasWaitingMark: false,
    title: 'Add retries to the uploader',
    body: '',
    updatedAt: NOW - HOUR_MS,
    mergedAt: null,
    ...fields,
})

describe('laneOf', () => {
    test('puts an open PR of Benny that is ready for review in Needs you', () => {
        assert.deepEqual(laneOf(item(), NOW), { lane: 'needs_you', why: 'Waits for your review' })
    })

    test('puts a thread with the waiting mark in Needs you, whoever opened it', () => {
        const issue = item({ isPullRequest: false, byBenny: false, hasWaitingMark: true, updatedAt: NOW - 30 * DAY_MS })
        assert.deepEqual(laneOf(issue, NOW), { lane: 'needs_you', why: 'Waits for your reply' })
    })

    test('says a marked draft, or a marked PR of someone else, waits for a reply', () => {
        assert.equal(laneOf(item({ hasWaitingMark: true, isDraft: true }), NOW)?.why, 'Waits for your reply')
        assert.equal(laneOf(item({ hasWaitingMark: true, byBenny: false }), NOW)?.why, 'Waits for your reply')
        assert.equal(laneOf(item({ hasWaitingMark: true }), NOW)?.why, 'Waits for your review')
    })

    test('cuts FYI at exactly three days and Done at exactly seven', () => {
        const answered = item({ isPullRequest: false, byBenny: false })
        assert.equal(laneOf({ ...answered, updatedAt: NOW - 3 * DAY_MS + 1 }, NOW)?.lane, 'fyi')
        assert.equal(laneOf({ ...answered, updatedAt: NOW - 3 * DAY_MS }, NOW), null)
        assert.equal(laneOf({ ...answered, isOpen: false }, NOW), null)
        assert.equal(laneOf(item({ isOpen: false, mergedAt: NOW - 7 * DAY_MS + 1 }), NOW)?.lane, 'done')
        assert.equal(laneOf(item({ isOpen: false, mergedAt: NOW - 7 * DAY_MS }), NOW), null)
    })

    test('leaves a closed thread with the waiting mark out', () => {
        assert.equal(laneOf(item({ isPullRequest: false, byBenny: false, hasWaitingMark: true, isOpen: false }), NOW), null)
    })

    test('puts every open draft of Benny in FYI, however old', () => {
        assert.deepEqual(laneOf(item({ isDraft: true }), NOW), { lane: 'fyi', why: 'Draft in progress' })
        assert.deepEqual(laneOf(item({ isDraft: true, updatedAt: NOW - 40 * DAY_MS }), NOW), { lane: 'fyi', why: 'Draft in progress' })
    })

    test('puts a PR merged in the last seven days in Done', () => {
        assert.deepEqual(laneOf(item({ isOpen: false, mergedAt: NOW - 6 * DAY_MS }), NOW), { lane: 'done', why: 'Merged' })
        assert.equal(laneOf(item({ isOpen: false, mergedAt: NOW - 8 * DAY_MS }), NOW), null)
    })

    test('leaves a PR closed without a merge out', () => {
        assert.equal(laneOf(item({ isOpen: false }), NOW), null)
    })

    test('puts a thread Benny answered in the last three days in FYI', () => {
        const answered = item({ isPullRequest: false, byBenny: false, updatedAt: NOW - 2 * DAY_MS })
        assert.deepEqual(laneOf(answered, NOW), { lane: 'fyi', why: 'Benny replied' })
        assert.equal(laneOf({ ...answered, updatedAt: NOW - 4 * DAY_MS }, NOW), null)
    })
})

describe('plain and clip', () => {
    test('strips Markdown, HTML comments and tags down to one line', () => {
        const markdown = '<!-- note -->\n## What\n**Adds** a [retry](https://x.y) to `upload()`:\n- one\n- two <br/>'
        assert.equal(plain(markdown), 'What Adds a retry to upload(): one two')
    })

    test('keeps issue numbers and identifiers inside a line', () => {
        assert.equal(plain('Closes #50. Adds `public_read` and __bold__.'), 'Closes #50. Adds public_read and bold.')
    })

    test('strips __ only when it wraps a word', () => {
        assert.equal(plain('Rename __init__ to init and __this__'), 'Rename init to init and this')
        assert.equal(plain('__init__.py and a __ b'), 'init.py and a __ b')
    })

    test('turns a tag into a space and strips <details open>', () => {
        assert.equal(plain('one<br>two'), 'one two')
        assert.equal(plain('<details open><summary>Logs</summary>x</details>'), 'Logs x')
    })

    test('strips real HTML tags but not a < b and c > d', () => {
        assert.equal(plain('<p class="x">a</p> <br/>'), 'a')
        assert.equal(plain('when a<b and c>d'), 'when a<b and c>d')
    })

    test('clips with an ellipsis inside the limit', () => {
        assert.equal(clip('abcdef', 4), 'abc…')
        assert.equal(clip('abc', 4), 'abc')
    })
})

describe('titleOf', () => {
    test('takes the first sentence of the first non-empty line', () => {
        assert.equal(titleOf('\n**Fixes the uploader.** It retried forever.\nMore'), 'Fixes the uploader')
    })

    test('ends the title after a short word, and at ! or ?', () => {
        assert.equal(titleOf('Fix it. Then more'), 'Fix it')
        assert.equal(titleOf('Is it ok? Next'), 'Is it ok?')
    })

    test('does not end the title at e.g. or i.e.', () => {
        assert.equal(titleOf('Use a cache, e.g. KV, for lookups. Then more'), 'Use a cache, e.g. KV, for lookups')
        assert.equal(titleOf('e.g. this one. Next'), 'e.g. this one')
    })

    test('clips at 110 characters', () => {
        const title = titleOf('word '.repeat(40))
        assert.equal(title.length, 110)
        assert.ok(title.endsWith('…'))
    })
})

describe('ageText', () => {
    test('says the age in the largest whole unit', () => {
        assert.equal(ageText(NOW - 20_000, NOW), 'just now')
        assert.equal(ageText(NOW - 12 * 60_000, NOW), '12 min ago')
        assert.equal(ageText(NOW - 3 * HOUR_MS - 59 * 60_000, NOW), '3 h ago')
        assert.equal(ageText(NOW - 2 * DAY_MS, NOW), '2 d ago')
        assert.equal(ageText(NOW - 20 * DAY_MS, NOW), '31 Oct')
    })

    test('switches unit at the exact limits', () => {
        assert.equal(ageText(NOW - 59_999, NOW), 'just now')
        assert.equal(ageText(NOW - 60_000, NOW), '1 min ago')
        assert.equal(ageText(NOW - HOUR_MS, NOW), '1 h ago')
        assert.equal(ageText(NOW - DAY_MS, NOW), '1 d ago')
        assert.equal(ageText(NOW - 14 * DAY_MS, NOW), '6 Nov')
    })

    test('adds the year to a date from an earlier year', () => {
        assert.equal(ageText(Date.UTC(2025, 10, 1), NOW), '1 Nov 2025')
    })
})

describe('deskCards', () => {
    test('keeps one card per thread, newest first, with clipped text', () => {
        const merged = item({ url: 'https://github.com/acme/app/pull/5', number: 5, isOpen: false, mergedAt: NOW - DAY_MS, updatedAt: NOW - 10 * 60_000 })
        const waiting = item({ hasWaitingMark: true, body: 'x'.repeat(900), updatedAt: NOW - 3 * HOUR_MS })
        const cards = deskCards([waiting, merged, waiting], NOW)
        assert.deepEqual(
            cards.map((card) => [card.lane, card.number, card.age]),
            [
                ['needs_you', 7, '3 h ago'],
                // Done is dated by the merge, not the last update.
                ['done', 5, '1 d ago'],
            ],
        )
        assert.equal(cards[0].body.length, 700)
        assert.equal(cards[0].title, 'Add retries to the uploader')
    })

    test('keeps the first of two different items with the same URL', () => {
        const first = item({ title: 'First one' })
        const second = item({ title: 'Second one' })
        assert.deepEqual(deskCards([first, second], NOW).map((card) => card.title), ['First one'])
    })
})
