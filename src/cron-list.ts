import { Hono } from 'hono'
import cronstrue from 'cronstrue'
import { github } from './bot'
import { readCronCopies, type CronRecord } from './crons'
import { firingLimitWords } from './cron-limit'
import { requireAccess, withDesignSystem } from './owner-page'
import cronListPage from './cron-list-page.html?raw'

// The cron list (`docs/crons/plan.md`, requirements 12–18): the page at `/crons` and the
// `GET /api/crons` it reads. `index.ts` mounts it. Both read ChatStateDO only, so loading the page
// wakes no `PiAgent`, and both sit behind Cloudflare Access, which the Worker checks again itself.

/** One row of the page: what it shows, worked out here so the page does no cron parsing. */
type CronRow = {
    threadId: string
    title: string
    prompt: string
    expression: string
    /** The expression in words, such as "At 09:00, Monday through Friday". */
    scheduleWords: string
    timezone: string
    /** "once", "2 of 3 firings", or null for a cron with no end. */
    firingLimitWords: string | null
    repo: string
    issueNumber: number
    issueUrl: string
    status: 'active' | 'running' | 'paused' | 'failing' | 'ended'
    nextFiringAt: number | null
    firings: CronRecord['firings']
}

const toCronRow = (record: CronRecord): CronRow => {
    const { owner, repo, prNumber } = github.decodeThreadId(record.threadId)
    let scheduleWords = record.expression
    try {
        scheduleWords = cronstrue.toString(record.expression, { use24HourTimeFormat: true })
    } catch {
        // `set_cron` checked the expression with croner; cronstrue may still read one differently.
    }
    // A firing still going shows as Running; the record's own status says Active or Failing.
    const lastFiring = record.firings.at(-1)
    const status = record.status !== 'paused' && lastFiring?.outcome === 'running' ? 'running' : record.status
    return {
        threadId: record.threadId,
        title: record.title,
        prompt: record.prompt,
        expression: record.expression,
        scheduleWords,
        timezone: record.timezone,
        firingLimitWords: firingLimitWords(record),
        repo: `${owner}/${repo}`,
        issueNumber: prNumber,
        issueUrl: `https://github.com/${owner}/${repo}/issues/${prNumber}`,
        status,
        nextFiringAt: record.nextFiringAt,
        firings: record.firings,
    }
}

export const cronList = new Hono()

// Named paths only, not `*`: `index.ts` mounts this at the root, and the GitHub webhook must stay public.
for (const path of ['/crons', '/api/crons']) {
    cronList.use(path, requireAccess)
}

cronList.get('/crons', (c) => c.html(withDesignSystem(cronListPage)))

cronList.get('/api/crons', async (c) => {
    const records = await readCronCopies()
    return c.json({ crons: records.map(toCronRow) })
})
