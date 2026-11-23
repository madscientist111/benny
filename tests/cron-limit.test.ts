import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
    checkFiringLimit, countsTowardLimit, firingLimitSentence, firingLimitWords, isLastFiring, lastFiringNote, skippedLastFiringNote,
    withCountedFiring,
} from '../src/cron-limit.ts'
import type { CronRecord } from '../src/crons.ts'

// Checks of a cron's firing limit (src/cron-limit.ts): which firings count, which is the last, how
// counting one ends the cron, and the words the firing comment, a skip, `set_cron` and the cron list use.

type LimitedCron = Pick<CronRecord, 'firingLimit' | 'countedFirings' | 'status' | 'nextFiringAt' | 'scheduleId'>
const cronWith = (firingLimit: number | undefined, countedFirings: number): LimitedCron =>
    ({ firingLimit, countedFirings, status: 'active', nextFiringAt: 1_000, scheduleId: 'next-timer' })

test('a firing limit is a whole number of 1 or more, or absent', () => {
    assert.equal(checkFiringLimit(undefined), undefined)
    assert.equal(checkFiringLimit(null), undefined)
    assert.equal(checkFiringLimit(1), 1)
    assert.equal(checkFiringLimit(3), 3)
    for (const wrongLimit of [0, -1, 1.5, '3', Number.NaN]) assert.throws(() => checkFiringLimit(wrongLimit), /whole number/)
})

test('a one-time cron ends at its first counted firing', () => {
    const cron = cronWith(1, 0)
    assert.equal(isLastFiring(cron), true)
    assert.equal(lastFiringNote(cron), ' (only firing)')
    assert.deepEqual(withCountedFiring(cron), { firingLimit: 1, countedFirings: 1, status: 'ended', nextFiringAt: null, scheduleId: undefined })
})

test('a cron with a limit of 3 stays active for two firings and ends at the third', () => {
    let cron = cronWith(3, 0)
    for (const expectedCount of [1, 2]) {
        assert.equal(lastFiringNote(cron), '')
        cron = withCountedFiring(cron)
        assert.equal(cron.countedFirings, expectedCount)
        assert.equal(cron.status, 'active')
        assert.equal(cron.scheduleId, 'next-timer')
    }
    assert.equal(lastFiringNote(cron), ' (last of 3)')
    cron = withCountedFiring(cron)
    assert.equal(cron.status, 'ended')
    assert.equal(cron.nextFiringAt, null)
})

test('a cron with no limit never ends', () => {
    let cron = cronWith(undefined, 0)
    for (let firing = 0; firing < 50; firing++) cron = withCountedFiring(cron)
    assert.equal(cron.status, 'active')
    assert.equal(cron.countedFirings, 50)
    assert.equal(lastFiringNote(cron), '')
})

test('a skip counts only for a cron with a limit, and only before its firing comment', () => {
    const limited = cronWith(3, 0)
    const unlimited = cronWith(undefined, 0)
    assert.equal(countsTowardLimit(limited, { outcome: 'running', requestId: 'firing-comment' }), true)
    assert.equal(countsTowardLimit(unlimited, { outcome: 'running', requestId: 'firing-comment' }), true)
    assert.equal(countsTowardLimit(limited, { outcome: 'skipped' }), true)
    assert.equal(countsTowardLimit(unlimited, { outcome: 'skipped' }), false)
    // Skipped after its firing comment (a run started meanwhile): the comment already counted it.
    assert.equal(countsTowardLimit(limited, { outcome: 'skipped', requestId: 'firing-comment' }), false)
    for (const outcome of ['replied', 'failed', 'stopped'] as const) {
        assert.equal(countsTowardLimit(limited, { outcome, requestId: 'firing-comment' }), false)
    }
})

test('a skipped one-time cron ends, and its note says why', () => {
    const cron = cronWith(1, 0)
    assert.equal(countsTowardLimit(cron, { outcome: 'skipped' }), true)
    assert.equal(withCountedFiring(cron).status, 'ended')
    assert.equal(skippedLastFiringNote({ title: 'Ship it', firingLimit: 1 }, 'the issue is closed'),
        '⏭ Skipped the only firing of "Ship it": the issue is closed. The cron has ended.')
    assert.equal(skippedLastFiringNote({ title: 'Ship it', firingLimit: 3 }, 'the last run is still going'),
        '⏭ Skipped the last of 3 firings of "Ship it": the last run is still going. The cron has ended.')
})

test('set_cron says the limit and names the last firing when it knows it', () => {
    const times = ['Mon 09:00', 'Tue 09:00', 'Wed 09:00', 'Thu 09:00']
    assert.equal(firingLimitSentence(undefined, times), 'Next firings: Mon 09:00; Tue 09:00; Wed 09:00.')
    assert.match(firingLimitSentence(1, times), /^Fires once, at Mon 09:00, then ends, even if that firing is skipped/)
    assert.match(firingLimitSentence(4, times), /^Fires 4 times, the last at Thu 09:00, then ends;/)
    assert.match(firingLimitSentence(4, times), /skipped .* still counts/)
    // More firings than times listed: the last one is not named.
    assert.match(firingLimitSentence(40, times), /^Fires 40 times, then ends;/)
})

test('the cron list shows the limit as "once" or "N of M firings"', () => {
    assert.equal(firingLimitWords({ firingLimit: undefined, countedFirings: 4 }), null)
    assert.equal(firingLimitWords({ firingLimit: 1, countedFirings: 0 }), 'once')
    assert.equal(firingLimitWords({ firingLimit: 3, countedFirings: 2 }), '2 of 3 firings')
})
