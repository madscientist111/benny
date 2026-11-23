import type { CronFiring, CronRecord } from './crons'

// A cron's firing limit (`docs/crons/plan.md`, requirements 19–21): a cron that fires once, or N
// times, then ends. `crons.ts` and `PiAgent` call these; they live apart from `crons.ts` because
// that file reaches the bot at import, and these are tested under plain Node.

/** The part of a cron record the limit reads and writes. */
type LimitedCron = Pick<CronRecord, 'firingLimit' | 'countedFirings' | 'status' | 'nextFiringAt' | 'scheduleId'>

/** The `firingLimit` the model passed, checked: undefined for no limit, else a whole number of 1 or more. */
export const checkFiringLimit = (firingLimit: unknown): number | undefined => {
    if (firingLimit === undefined || firingLimit === null) return undefined
    if (typeof firingLimit !== 'number' || !Number.isInteger(firingLimit) || firingLimit < 1) {
        throw new Error('firingLimit must be a whole number of 1 or more; leave it out for a cron with no end.')
    }
    return firingLimit
}

/** Whether the next counted firing is the cron's last one. */
export const isLastFiring = (cron: LimitedCron) =>
    cron.firingLimit !== undefined && cron.countedFirings + 1 >= cron.firingLimit

/**
 * Whether a firing uses up one of the cron's firings: one whose firing comment was posted
 * (`running`), and, for a cron with a limit, one skipped before its comment (closed issue, a run
 * going), so a skipped one-time cron ends instead of waiting a year for its next time. A skip with a
 * `requestId` came after its comment, which already counted.
 */
export const countsTowardLimit = (cron: LimitedCron, firing: Pick<CronFiring, 'outcome' | 'requestId'>) =>
    firing.outcome === 'running' ||
    (firing.outcome === 'skipped' && firing.requestId === undefined && cron.firingLimit !== undefined)

/**
 * Counts a firing (`countsTowardLimit`). The last one ends the cron: no next firing, and the
 * caller cancels the timer named by the old `scheduleId`.
 */
export const withCountedFiring = <Cron extends LimitedCron>(cron: Cron): Cron => {
    const counted = { ...cron, countedFirings: cron.countedFirings + 1 }
    if (!isLastFiring(cron)) return counted
    return { ...counted, status: 'ended', nextFiringAt: null, scheduleId: undefined }
}

/** The one line posted when a skipped firing ends the cron, so the cron does not vanish silently. `reason` is the skip's note. */
export const skippedLastFiringNote = (cron: Pick<CronRecord, 'title' | 'firingLimit'>, reason: string) => {
    const which = cron.firingLimit === 1 ? 'the only firing' : `the last of ${cron.firingLimit} firings`
    return `⏭ Skipped ${which} of "${cron.title}": ${reason}. The cron has ended.`
}

/** What the firing comment adds after the title: "(only firing)", "(last of 3)", or nothing. */
export const lastFiringNote = (cron: LimitedCron) => {
    if (!isLastFiring(cron)) return ''
    return cron.firingLimit === 1 ? ' (only firing)' : ` (last of ${cron.firingLimit})`
}

/**
 * The sentence `set_cron` returns about the limit, so the reply can say "fires once, at …" or
 * "fires 3 times, the last at …". `firingTimes` are the next times, formatted, at least as many as
 * the limit when the last one should be named.
 */
export const firingLimitSentence = (firingLimit: number | undefined, firingTimes: string[]) => {
    const nextTimes = `Next firings: ${firingTimes.slice(0, 3).join('; ')}.`
    if (firingLimit === undefined) return nextTimes
    if (firingLimit === 1) return `Fires once, at ${firingTimes[0]}, then ends, even if that firing is skipped because the issue is closed or a run is going.`
    const lastTime = firingTimes[firingLimit - 1]
    return `Fires ${firingLimit} times${lastTime ? `, the last at ${lastTime}` : ''}, then ends; ` +
        `a firing skipped because the issue is closed or a run is going still counts. ${nextTimes}`
}

/** The limit as the cron list shows it: "once", "2 of 3 firings", or null for no limit. */
export const firingLimitWords = (cron: Pick<CronRecord, 'firingLimit' | 'countedFirings'>) => {
    if (cron.firingLimit === undefined) return null
    if (cron.firingLimit === 1) return 'once'
    return `${cron.countedFirings} of ${cron.firingLimit} firings`
}
