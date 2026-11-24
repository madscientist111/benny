import { test } from 'node:test'
import assert from 'node:assert/strict'
import { INPUT_REQUIRED_PREFIX, SCHEDULED_PREFIX, withoutTitleMark, withoutTitleMarks, withTitleMark } from '../src/github/title-marks.ts'

// Checks of the title marks (src/github/title-marks.ts): the waiting and scheduled prefixes go on and come
// off on their own, in a fixed order, never twice, whatever the title started with.

const BARE_TITLE = 'Daily work digest'
const BOTH_MARKS = `${INPUT_REQUIRED_PREFIX}${SCHEDULED_PREFIX}${BARE_TITLE}`

test('a title with no mark gets each prefix, and loses nothing it does not have', () => {
    assert.equal(withTitleMark(BARE_TITLE, INPUT_REQUIRED_PREFIX), `${INPUT_REQUIRED_PREFIX}${BARE_TITLE}`)
    assert.equal(withTitleMark(BARE_TITLE, SCHEDULED_PREFIX), `${SCHEDULED_PREFIX}${BARE_TITLE}`)
    assert.equal(withoutTitleMark(BARE_TITLE, INPUT_REQUIRED_PREFIX), BARE_TITLE)
    assert.equal(withoutTitleMark(BARE_TITLE, SCHEDULED_PREFIX), BARE_TITLE)
    assert.equal(withoutTitleMarks(BARE_TITLE), BARE_TITLE)
})

test('each prefix alone comes off, and clearing the other leaves it', () => {
    const waiting = `${INPUT_REQUIRED_PREFIX}${BARE_TITLE}`
    const scheduled = `${SCHEDULED_PREFIX}${BARE_TITLE}`
    assert.equal(withoutTitleMark(waiting, INPUT_REQUIRED_PREFIX), BARE_TITLE)
    assert.equal(withoutTitleMark(waiting, SCHEDULED_PREFIX), waiting)
    assert.equal(withoutTitleMark(scheduled, SCHEDULED_PREFIX), BARE_TITLE)
    assert.equal(withoutTitleMark(scheduled, INPUT_REQUIRED_PREFIX), scheduled)
    assert.equal(withoutTitleMarks(waiting), BARE_TITLE)
    assert.equal(withoutTitleMarks(scheduled), BARE_TITLE)
})

test('both prefixes sit in one fixed order, whichever went on first', () => {
    assert.equal(withTitleMark(withTitleMark(BARE_TITLE, INPUT_REQUIRED_PREFIX), SCHEDULED_PREFIX), BOTH_MARKS)
    assert.equal(withTitleMark(withTitleMark(BARE_TITLE, SCHEDULED_PREFIX), INPUT_REQUIRED_PREFIX), BOTH_MARKS)
})

test('with both prefixes in either order, each comes off alone and both come off together', () => {
    const reversed = `${SCHEDULED_PREFIX}${INPUT_REQUIRED_PREFIX}${BARE_TITLE}`
    for (const title of [BOTH_MARKS, reversed]) {
        assert.equal(withoutTitleMark(title, INPUT_REQUIRED_PREFIX), `${SCHEDULED_PREFIX}${BARE_TITLE}`)
        assert.equal(withoutTitleMark(title, SCHEDULED_PREFIX), `${INPUT_REQUIRED_PREFIX}${BARE_TITLE}`)
        assert.equal(withoutTitleMarks(title), BARE_TITLE)
    }
})

test('setting a prefix twice keeps one', () => {
    const waitingTwice = withTitleMark(withTitleMark(BARE_TITLE, INPUT_REQUIRED_PREFIX), INPUT_REQUIRED_PREFIX)
    assert.equal(waitingTwice, `${INPUT_REQUIRED_PREFIX}${BARE_TITLE}`)
    assert.equal(withTitleMark(BOTH_MARKS, SCHEDULED_PREFIX), BOTH_MARKS)
    assert.equal(withTitleMark(BOTH_MARKS, INPUT_REQUIRED_PREFIX), BOTH_MARKS)
})

test('a prefix inside the title, not at its start, is the title\'s own text', () => {
    const quoting = `Explain the ${SCHEDULED_PREFIX}mark`
    assert.equal(withoutTitleMarks(quoting), quoting)
    assert.equal(withTitleMark(quoting, SCHEDULED_PREFIX), `${SCHEDULED_PREFIX}${quoting}`)
})
