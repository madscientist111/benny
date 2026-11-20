import { defineExtension, defineTool } from '@earendil-works/pi-durable'
import { bot } from './bot'
import { httpStatus, lowerRepoName } from './github-contract'
import type { Octokit } from './github-tools'
import { log, type LogIds } from './log'

// The waiting mark (`docs/input-required/plan.md`): a `[INPUT_REQUIRED] ` title prefix plus an
// `input-required` label on an issue or PR that waits for a writer. `PiAgent` sets it after a reply
// that asks, a pause, or a PR made ready; `bot.ts` clears it when a writer comments.

// `bot.ts` imports this file and this file imports `bot.ts`. Use `bot` only inside functions, never
// at module level. `PiAgent` has no webhook that connected the state store, so each function here
// calls `bot.initialize()` before it reads or writes the mark.

export const INPUT_REQUIRED_PREFIX = '[INPUT_REQUIRED] '
const INPUT_REQUIRED_LABEL = 'input-required'
const LABEL_COLOR = 'd93f0b'

/** The issue or PR that carries the mark. */
export type MarkTarget = { owner: string; repo: string; number: number }

// Whether the target has the mark, in ChatStateDO, so a comment on an unmarked thread costs no GitHub
// call. Repo names are case-insensitive on GitHub, so the key is lowercased.
const markKey = ({ owner, repo, number }: MarkTarget) => `inputRequired:${lowerRepoName(owner, repo)}#${number}`

/** The title without the mark's prefix: what the decision model and the replies talk about. */
export const withoutPrefix = (title: string) =>
    title.startsWith(INPUT_REQUIRED_PREFIX) ? title.slice(INPUT_REQUIRED_PREFIX.length) : title

/**
 * Puts the prefix and the label on the target. ChatStateDO learns of the mark first, so a mark that
 * reaches GitHub is always one a writer's comment clears. A failure is logged, never thrown (plan
 * rule 14), and `octokit` is called inside, so a missing installation cannot throw either.
 */
export const setInputRequired = async (octokit: () => Promise<Octokit>, target: MarkTarget, logIds: LogIds & { reason: string }) => {
    const { owner, repo, number } = target
    try {
        await bot.initialize()
        await bot.getState().set(markKey(target), true)
        const client = await octokit()
        const { data: issue } = await client.issues.get({ owner, repo, issue_number: number })
        if (!issue.title.startsWith(INPUT_REQUIRED_PREFIX)) {
            await client.issues.update({ owner, repo, issue_number: number, title: `${INPUT_REQUIRED_PREFIX}${issue.title}` })
        }
        try {
            await client.issues.createLabel({ owner, repo, name: INPUT_REQUIRED_LABEL, color: LABEL_COLOR, description: 'Benny waits for a maintainer' })
        } catch (error) {
            // 422: the label is already in the repo.
            if (httpStatus(error) !== 422) throw error
        }
        await client.issues.addLabels({ owner, repo, issue_number: number, labels: [INPUT_REQUIRED_LABEL] })
        log('input required set', { ...logIds, repo: `${owner}/${repo}`, number })
    } catch (error) {
        log('input required set failed', { ...logIds, repo: `${owner}/${repo}`, number, error: String(error) })
    }
}

/** Whether the target has the mark, from ChatStateDO only. */
export const hasInputRequired = async (target: MarkTarget) => {
    await bot.initialize()
    return (await bot.getState().get<boolean>(markKey(target))) === true
}

/** Takes the prefix and the label off the target. A failure is logged, never thrown (plan rule 14). */
export const clearInputRequired = async (octokit: Octokit, target: MarkTarget, logIds: LogIds) => {
    const { owner, repo, number } = target
    try {
        await bot.initialize()
        const { data: issue } = await octokit.issues.get({ owner, repo, issue_number: number })
        if (issue.title.startsWith(INPUT_REQUIRED_PREFIX)) {
            await octokit.issues.update({ owner, repo, issue_number: number, title: withoutPrefix(issue.title) })
        }
        try {
            await octokit.issues.removeLabel({ owner, repo, issue_number: number, name: INPUT_REQUIRED_LABEL })
        } catch (error) {
            // 404: someone already took the label off.
            if (httpStatus(error) !== 404) throw error
        }
        await bot.getState().delete(markKey(target))
        log('input required cleared', { ...logIds, repo: `${owner}/${repo}`, number })
    } catch (error) {
        log('input required clear failed', { ...logIds, repo: `${owner}/${repo}`, number, error: String(error) })
    }
}

/**
 * The tool the model calls when its reply asks a writer for something (plan rule 1). It only notes
 * the ask: `PiAgent` puts the mark on once the reply is posted. `noteAsk` returns false when the run
 * is not all writers' requests (rule 4).
 */
export const inputRequiredTool = (noteAsk: () => Promise<boolean>) => defineExtension({
    name: 'input-required',
    tools: [
        defineTool({
            name: 'mark_input_required',
            description: 'Call this when your reply asks the requester to answer, decide or do something before the work can go on. The issue or PR then shows [INPUT_REQUIRED] until a maintainer replies. Do not call it for a plain answer.',
            callers: ['model'],
            parameters: { type: 'object', properties: {} },
            execute: async () => {
                const noted = await noteAsk()
                const text = noted
                    ? 'Noted. The thread gets the [INPUT_REQUIRED] mark when your reply is posted. Ask your question in the reply.'
                    : 'Not marked: the mark is only for requests from members with write access. Ask your question in the reply.'
                return { output: [{ type: 'text' as const, text }], isError: false }
            },
        }),
    ],
})
