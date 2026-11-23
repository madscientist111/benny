import { Cron } from 'croner'
import { defineExtension, defineTool } from '@earendil-works/pi-durable'
import { bot, github } from './bot'
import { log } from './log'

// Crons (`docs/crons/plan.md`): a schedule, a timezone and a prompt kept for one issue. `PiAgent`
// owns the cron and its timer; this file checks a schedule, keeps the copy of every cron in
// ChatStateDO (the count of crons, later the cron list), and defines `set_cron` and `remove_cron`.

// `bot.ts` imports `pi-agent.ts`, which imports this file. Use `bot` and `github` only inside
// functions, never at module level.

/** The shortest time between two firings (plan, requirement 10). */
const MIN_INTERVAL_MS = 60 * 60 * 1000
/** At most this many crons exist at once, across every repo (requirement 10). */
export const MAX_CRONS = 20
/** Failed firings in a row that mark a cron Failing, and that pause it (requirement 11). */
export const FAILING_AFTER = 2
export const PAUSE_AFTER = 5
/** Firings kept on the record, for the cron list (requirement 12). */
const KEPT_FIRINGS = 7
/**
 * Firing times checked for a gap under `MIN_INTERVAL_MS`: two firings in one hour show up as a
 * neighbouring pair. Also the most times `set_cron` lists, to name a limited cron's last firing.
 */
export const CHECKED_FIRINGS = 25

/** How one firing ended. `stopped` is a member's stop, so it counts neither way; the 30-minute pause is `failed`. */
export type FiringOutcome = 'running' | 'replied' | 'failed' | 'stopped' | 'skipped'

export type CronFiring = { at: number; outcome: FiringOutcome; requestId?: string; note?: string }

/**
 * One issue's cron. `id` is new at every `set_cron`, and the timer carries it, so a timer left from
 * a cron that was replaced or removed finds a different id and does nothing.
 */
export type CronRecord = {
    id: string
    threadId: string
    title: string
    expression: string
    timezone: string
    prompt: string
    /** Who set the cron: a firing may write only while this login has write access (requirement 7). */
    creator: string
    /** `ended`: its last counted firing was made (`cron-limit.ts`); it stays for the cron list and counts toward no cap. */
    status: 'active' | 'failing' | 'paused' | 'ended'
    /** Null while paused or ended. */
    nextFiringAt: number | null
    failuresInARow: number
    /** How many firings the cron makes before it ends; absent for no end. */
    firingLimit?: number
    /** Firings whose firing comment was posted, plus, when there is a limit, firings skipped before it (`countsTowardLimit`). */
    countedFirings: number
    /** Newest last. */
    firings: CronFiring[]
    /** The `this.schedule` row of the next firing, so a replace or a pause can cancel it. */
    scheduleId?: string
    createdAt: number
}

export type CronInput = { expression: string; timezone: string; title: string; prompt: string; firingLimit?: number }

/**
 * The next `count` firing times after `from`, as numbers. Throws with a sentence the model can
 * repeat when the expression is not five fields, the timezone is unknown, or two firings come
 * closer than an hour.
 */
export const nextFirings = (expression: string, timezone: string, from: number, count = 1): number[] => {
    if (expression.trim().split(/\s+/).length !== 5) {
        throw new Error('the expression must have five fields: minute, hour, day of month, month, day of week.')
    }
    // croner checks the timezone only when it computes a time, so ask Intl first for a clear error.
    try {
        new Intl.DateTimeFormat('en', { timeZone: timezone })
    } catch {
        throw new Error(`"${timezone}" is not an IANA timezone, such as Asia/Kolkata.`)
    }
    const schedule = new Cron(expression.trim(), { timezone, paused: true })
    const times = schedule.nextRuns(Math.max(count, CHECKED_FIRINGS), new Date(from)).map((date) => date.getTime())
    if (times.length === 0) throw new Error('the expression never fires.')
    for (let index = 1; index < times.length; index++) {
        if (times[index] - times[index - 1] < MIN_INTERVAL_MS) throw new Error('two firings are less than one hour apart; the shortest interval is one hour.')
    }
    return times.slice(0, count)
}

/** A firing time as the reader of the issue says it, such as "Mon, 23 Nov 2026, 09:00 GMT+5:30". */
export const formatFiringTime = (at: number, timezone: string) =>
    new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
    }).format(new Date(at))

/**
 * Adds a firing to the record, or updates the one with the same request (it keeps its time), and
 * keeps the newest seven.
 */
export const withFiring = (firings: CronFiring[], firing: CronFiring): CronFiring[] => {
    const earlier = firing.requestId ? firings.find((kept) => kept.requestId === firing.requestId) : undefined
    const others = earlier ? firings.filter((kept) => kept !== earlier) : firings
    return [...others, { ...firing, at: earlier?.at ?? firing.at }].sort((first, second) => first.at - second.at).slice(-KEPT_FIRINGS)
}

// The ChatStateDO copy: one record per cron and the list of their threads. Neither is set with a
// TTL, so a cron never expires there (thread state does after 30 days).
const cronKey = (threadId: string) => `cron:${threadId}`
const CRON_THREADS_KEY = 'cronThreads'
/** The list of cron threads is changed under a ChatStateDO lock of this name; it is no thread id. */
const CRON_THREADS_LOCK_TTL_MS = 10_000
const CRON_THREADS_LOCK_ATTEMPTS = 5
const CRON_THREADS_LOCK_WAIT_MS = 200

/**
 * Changes the list of cron threads while holding its lock: every `PiAgent` writes the one list, and
 * two crons set at once must not drop each other's entry.
 */
const updateCronThreads = async (change: (threads: string[]) => string[]) => {
    const state = bot.getState()
    for (let attempt = 0; attempt < CRON_THREADS_LOCK_ATTEMPTS; attempt++) {
        const lock = await state.acquireLock(CRON_THREADS_KEY, CRON_THREADS_LOCK_TTL_MS)
        if (!lock) {
            await new Promise((resolve) => setTimeout(resolve, CRON_THREADS_LOCK_WAIT_MS))
            continue
        }
        try {
            await state.set(CRON_THREADS_KEY, change((await state.get<string[]>(CRON_THREADS_KEY)) ?? []))
        } finally {
            await state.releaseLock(lock)
        }
        return
    }
    throw new Error('the list of crons is busy; try again.')
}

/** Copies the record into ChatStateDO, so counting the crons, or listing them later, wakes no `PiAgent`. */
export const saveCronCopy = async (record: CronRecord) => {
    await bot.initialize()
    const state = bot.getState()
    await state.set(cronKey(record.threadId), record)
    // Read first: a firing saves the record each time, and only a new cron needs the lock.
    if (((await state.get<string[]>(CRON_THREADS_KEY)) ?? []).includes(record.threadId)) return
    await updateCronThreads((threads) => threads.includes(record.threadId) ? threads : [...threads, record.threadId])
}

export const deleteCronCopy = async (threadId: string) => {
    await bot.initialize()
    await bot.getState().delete(cronKey(threadId))
    await updateCronThreads((threads) => threads.filter((kept) => kept !== threadId))
}

/** Every cron's copy, from ChatStateDO only: what the cron list shows. */
export const readCronCopies = async (): Promise<CronRecord[]> => {
    await bot.initialize()
    const state = bot.getState()
    const threads = (await state.get<string[]>(CRON_THREADS_KEY)) ?? []
    const records = await Promise.all(threads.map((threadId) => state.get<CronRecord>(cronKey(threadId))))
    return records.filter((record): record is CronRecord => record !== null && record !== undefined)
}

/** How many crons count toward `MAX_CRONS`, from ChatStateDO only: an ended cron does not. */
export const countCrons = async () => (await readCronCopies()).filter((record) => record.status !== 'ended').length

/** Posts a comment in the cron's issue and returns its id: the firing's request, or the note that pauses it. */
export const postInIssue = async (threadId: string, text: string): Promise<string> => {
    await bot.initialize()
    const { id } = await github.postMessage(threadId, text)
    return id
}

/** What the cron tools ask `PiAgent`. Both are write tools: they run only when every pending request is a writer's mention. */
export type CronToolsAccess = {
    runMayWrite: () => Promise<boolean>
    /** Sets or replaces this issue's cron; returns what the model tells the reader. */
    setCron: (input: CronInput) => Promise<string>
    /** Removes this issue's cron; returns what the model tells the reader. */
    removeCron: () => Promise<string>
    currentRunId: () => Promise<string | undefined>
}

const WRITE_REFUSED = 'Crons need a request that mentions @bobby-sb, from a member with write access. Tell the requester; do not try again.'

const toolResult = (output: string, isError = false) => ({ output: [{ type: 'text' as const, text: output }], isError })

/** `set_cron` and `remove_cron`. `PiAgent` hides them with the other write tools. */
export const cronTools = (access: CronToolsAccess) => {
    // A refusal or a bad schedule goes back to the model as an error it can fix; nothing is thrown.
    const run = async (name: string, action: () => Promise<string>) => {
        const runId = await access.currentRunId()
        if (!(await access.runMayWrite())) {
            log('tool', { name, runId, refused: 'write access' })
            return toolResult(WRITE_REFUSED, true)
        }
        try {
            const output = await action()
            log('tool', { name, runId })
            return toolResult(output)
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error)
            log('tool', { name, runId, error: reason })
            return toolResult(`Not done: ${reason}`, true)
        }
    }
    return defineExtension({ name: 'crons', tools: [
        defineTool({
            name: 'set_cron',
            description: 'Run a request on a schedule in this issue: at each firing Benny posts a comment here and answers `prompt` as a new request. ' +
                'Call it only when the requester asks for something recurring or at a later time. One cron per issue; calling it again replaces the cron. ' +
                'For something that happens once or a set number of times ("once", "one time", "at 5pm today", "on 3 Dec at 10:00", "N times", "the next 3 days"), set `firingLimit`: ' +
                '1 for a one-time event, with an expression naming that minute, hour, day and month. ' +
                'Closing the issue skips firings until it is reopened; a skipped firing still uses up one of a limited cron\'s firings. Your reply must say the schedule in words, the timezone, and the firing times and limit this tool returns.',
            callers: ['model'],
            parameters: {
                type: 'object',
                properties: {
                    expression: { type: 'string', description: 'Five-field cron expression: minute hour day-of-month month day-of-week, such as "0 9 * * 1-5" for weekdays at 9:00. At most one firing per hour.' },
                    timezone: { type: 'string', description: 'IANA timezone the expression is read in, such as "Asia/Kolkata". Use the one the requester named; ask if they named none.' },
                    title: { type: 'string', description: 'A short name, such as "Daily work digest".' },
                    prompt: { type: 'string', description: 'The request each firing answers, written so it stands alone without this conversation.' },
                    firingLimit: { type: 'integer', minimum: 1, description: 'How many firings the cron makes, then it ends: 1 for a one-time event. Leave it out for a cron that recurs until removed.' },
                },
                required: ['expression', 'timezone', 'title', 'prompt'],
            },
            execute: (args) => run('set_cron', () => access.setCron(args as CronInput)),
        }),
        defineTool({
            name: 'remove_cron',
            description: 'Remove this issue\'s cron, so it fires no more.',
            callers: ['model'],
            parameters: { type: 'object', properties: {} },
            execute: () => run('remove_cron', () => access.removeCron()),
        }),
    ] })
}
