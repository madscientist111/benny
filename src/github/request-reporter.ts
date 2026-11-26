import type { RequestUsage } from '../pi/agent'
import { BOT_USERNAME, bot, github } from '../bot'
import { TASK_FAILURE_TEXTS } from '../claude-code-run'
import { log } from '../log'
import { appendToWindow } from '../thread-window'

// Everything a request shows on GitHub: the status comment, the reply, and the reactions on the
// comment that asked. A run outlives the webhook that started it, so the agent reports itself.

// `bot.ts` imports this file and this file imports `bot.ts`. Use `bot` and `github` only inside
// functions, never at module level.

// The paused mark lives in ChatStateDO, so checking it wakes no PiAgent. The prefix keeps it
// clear of the SDK's own keys (subscriptions, locks, thread state).
const pausedKey = (threadId: string) => `paused:${threadId}`

// The texts a status comment can end with. A follower shows the same text its run's leader shows,
// word for word, so one run never tells two stories.
const stoppedText = '⏹ I stopped this request because a member asked me to.'
const joinedText = '➕ Benny added this to the request it is working on. One reply answers both.'
/** `marked`: the paused mark is in ChatStateDO, so a reply in the thread continues the work. */
const pausedText = (marked: boolean) => marked
    ? '⏸ I worked for 30 min and stopped. A member with write access can reply in this thread to let me continue; mention me in that reply if the work changes GitHub.'
    : '⏸ I worked for 30 min and stopped. Mention me to continue.'

/** A reason that is a raw JavaScript error (`Error: Peer closed WebSocket ...`, `TypeError: ...`) rather than words for people. */
const RAW_ERROR = /^(?:[A-Z]\w*)?Error\b/

const failureText = (reason: string) => {
    if (reason === 'turn_limit') return 'I stopped because I reached my limit of tool steps for one request. Ask a narrower question, or ask me to continue.'
    const taskFailureText = TASK_FAILURE_TEXTS[reason]
    if (taskFailureText) return taskFailureText
    // Only the first line, at most 200 characters: no tokens, headers or stack traces. A raw error is
    // not shown at all; `request finished` and `reply failed` log it in full.
    const reasonFirstLine = reason.split('\n')[0].trim().slice(0, 200)
    const shownReason = RAW_ERROR.test(reasonFirstLine) ? 'something went wrong inside Benny' : reasonFirstLine
    return `I could not finish this request because of an error: ${shownReason}. Please try again.`
}

// The reply footnote (requirements 22, 48), for example:
// "Benny worked 4.2 min · read de41bf6 + PR head 8407df8 · 42 turns, 88k context (2.3M sent, 96% cached), 34k out · 12 tool calls (3 web searches, 2 web fetches) · sandbox: 2 calls, 49 s (19 s install)".
const formatAgentTime = (ms: number) => {
    const seconds = Math.round(ms / 1000)
    return seconds < 60 ? `${seconds} s` : `${(ms / 60_000).toFixed(1)} min`
}

// A token count a reader can hold: 885, 4.7k, 88k, 2.3M, 1.2B. Below 10k one decimal keeps 4.7k
// apart from 4.8k; above it the decimal is noise next to a count that large. Rounding first keeps a
// count just under a boundary from reading 10.0k, 10.0M or 1000M.
const formatTokenCount = (count: number) => {
    if (count < 1000) return String(count)
    const thousands = Math.round(count / 100) / 10
    if (thousands < 10) return `${thousands.toFixed(1)}k`
    const wholeThousands = Math.round(thousands)
    if (wholeThousands < 1000) return `${wholeThousands}k`
    const millions = Math.round(count / 100_000) / 10
    if (millions < 10) return `${millions.toFixed(1)}M`
    const wholeMillions = Math.round(millions)
    if (wholeMillions < 1000) return `${wholeMillions}M`
    const billions = Math.round(count / 100_000_000) / 10
    if (billions < 10) return `${billions.toFixed(1)}B`
    return `${Math.round(billions)}B`
}

const SHORT_SHA_CHARS = 7

const formatFootnote = (usage: RequestUsage, commit: string | undefined, prHead: string | null) => {
    // The commits the answer read. GitHub turns a short sha into a link to the commit.
    const prPart = prHead ? ` + PR head ${prHead.slice(0, SHORT_SHA_CHARS)}` : ''
    const commitsRead = commit ? ` · read ${commit.slice(0, SHORT_SHA_CHARS)}${prPart}` : ''
    // What the request cost and how big its context got. The turns explain the sum: every turn sent
    // the whole context again, so `sent` is a running total while `context` is one turn's size. The
    // cached share is floored, so 100% means every token came from the cache; a request the provider
    // cached nothing of leaves it out.
    const cachedPercent = usage.tokensIn > 0 ? Math.floor((usage.cachedTokensIn / usage.tokensIn) * 100) : 0
    const tokenPart = `${usage.turns} turn${usage.turns === 1 ? '' : 's'}, ` +
        `${formatTokenCount(usage.peakContextTokens)} context ` +
        `(${formatTokenCount(usage.tokensIn)} sent${cachedPercent > 0 ? `, ${cachedPercent}% cached` : ''}), ` +
        `${formatTokenCount(usage.tokensOut)} out` +
        // Only a harness that reports a cost (Claude Code) shows one; a subscription pays none of it.
        (usage.costUsd !== undefined ? `, $${usage.costUsd.toFixed(2)} at list price` : '')
    // Which web tools the run used, in words. A count of 0 is left out, so a run that did no web
    // work says nothing about it.
    const webCallParts = [
        usage.webSearches > 0 ? `${usage.webSearches} web search${usage.webSearches === 1 ? '' : 'es'}` : undefined,
        usage.webFetches > 0 ? `${usage.webFetches} web fetch${usage.webFetches === 1 ? '' : 'es'}` : undefined,
    ].filter((part): part is string => part !== undefined)
    const webCallsPart = webCallParts.length > 0 ? ` (${webCallParts.join(', ')})` : ''
    // What the run did in the sandbox: how many calls reached it, the wall time it was in use
    // (overlapping calls merged), and the installs their starts ran. A run that never reached it
    // says nothing about it.
    const sandboxPart = usage.sandboxCalls > 0
        ? ` · sandbox: ${usage.sandboxCalls} call${usage.sandboxCalls === 1 ? '' : 's'}, ${formatAgentTime(usage.sandboxWallMs)}` +
          (usage.sandboxStarts > 0 ? ` (${formatAgentTime(usage.sandboxInstallMs)} install)` : '')
        : ''
    // The tasks pi handed to Claude Code (the `claude_code` tool), with their list-price cost.
    const claudeCodePart = usage.claudeCodeTasks > 0
        ? ` · Claude Code: ${usage.claudeCodeTasks} task${usage.claudeCodeTasks === 1 ? '' : 's'}, $${usage.claudeCodeCostUsd.toFixed(2)} at list price`
        : ''
    return `<sub>Benny worked ${formatAgentTime(usage.ms)}${commitsRead} · ` +
        `${tokenPart} · ` +
        `${usage.toolCalls} tool call${usage.toolCalls === 1 ? '' : 's'}${webCallsPart}${sandboxPart}${claudeCodePart}</sub>`
}

// One step after the comment that matters is already on GitHub (or a step of a failure report):
// a failing step is logged and must not stop the steps after it.
const bestEffort = async (threadId: string, requestId: string, step: string, action: () => Promise<unknown>) => {
    try {
        await action()
    } catch (error) {
        log('request report step failed', { threadId, requestId, step, error: String(error) })
    }
}

/** Puts `text` on a status comment; a failing edit must not stop the steps after it. */
const editStatus = (threadId: string, requestId: string, statusId: string, text: string, kind: string) =>
    bestEffort(threadId, requestId, 'edit status comment', async () => {
        await github.editMessage(threadId, statusId, text)
        log('request reported', { threadId, requestId, kind })
    })

/** Posts the status comment; returns its message id. `bot.ts` posts it before the slow steps. */
export const postStatus = async (threadId: string, requestId: string): Promise<string> => {
    await bot.initialize()
    // The id is how every later report finds this comment, so a failure here must reach the caller.
    const { id: statusId } = await github.postMessage(threadId, '⏳ Benny is working on this. Started just now.')
    log('request reported', { threadId, requestId, kind: 'status' })
    return statusId
}

/** Edits the status comment to show how long the request's run has worked. */
export const updateStatus = async (threadId: string, requestId: string, statusId: string, elapsedMs: number): Promise<void> => {
    await bot.initialize()
    await github.editMessage(threadId, statusId, `⏳ Benny is working on this. Time so far: ${formatAgentTime(elapsedMs)}.`)
    log('request reported', { threadId, requestId, kind: 'status' })
}

/** Edits a follower's status comment: its request joined the run that was already working. */
export const reportFollowerJoined = async (threadId: string, requestId: string, statusId: string): Promise<void> => {
    await bot.initialize()
    await editStatus(threadId, requestId, statusId, joinedText, 'joined')
}

/** Posts the reply with its usage footnote, deletes the status comment, records the reply for the decision model, and swaps 👀 for 👍. */
export const reportReply = async (input: {
    threadId: string; requestMessageId: string; statusId: string; text: string; usage: RequestUsage
    commit: string | undefined; prHead: string | null
}): Promise<void> => {
    await bot.initialize()
    const { threadId, requestMessageId, statusId, text, usage, commit, prHead } = input

    // The reply is the one thing the reader came for. If it cannot be posted, the caller must
    // report the failure, so this error is not caught here.
    const sent = await github.postMessage(threadId, `${text}\n\n${formatFootnote(usage, commit, prHead)}`)
    log('request reported', { threadId, requestId: requestMessageId, kind: 'reply' })

    // The reply is already on GitHub, so the remaining steps are best effort: one failing step
    // must not stop the others. The window holds the reply itself; the footnote is only for
    // GitHub readers.
    await bestEffort(threadId, requestMessageId, 'record reply', async () => {
        await appendToWindow(bot.getState(), threadId, {
            messageId: sent.id, author: BOT_USERNAME, isBenny: true, text, createdAt: Date.now(),
        })
    })
    await bestEffort(threadId, requestMessageId, 'delete status comment', () => github.deleteMessage(threadId, statusId))
    await bestEffort(threadId, requestMessageId, 'add thumbs up', () => github.addReaction(threadId, requestMessageId, 'thumbs_up'))
    await bestEffort(threadId, requestMessageId, 'remove eyes', () => github.removeReaction(threadId, requestMessageId, 'eyes'))
}

/**
 * How a follower's request ended. Its run's leader reports the same outcome for the run itself;
 * the two texts stay in one place so they cannot drift apart.
 */
export type FollowerEnd =
    /** The run's one reply answered this request too, so it posts no reply of its own. */
    | { kind: 'answered' }
    /** The run reached its turn limit and now writes a summary answer: the reply is still coming. */
    | { kind: 'joined' }
    | { kind: 'stopped' }
    | { kind: 'paused'; marked: boolean }
    | { kind: 'failed'; reason: string }

/**
 * Ends a follower's request: the text its run's leader ended with, and 👀 off. An answered run
 * deletes the status comment and swaps 👀 for 👍 instead. Never a reply: the leader's one reply
 * answers every request in the run.
 */
export const reportFollowerEnded = async (input: {
    threadId: string
    requestMessageId: string
    statusId: string
    end: FollowerEnd
}): Promise<void> => {
    await bot.initialize()
    const { threadId, requestMessageId, statusId, end } = input

    if (end.kind === 'answered') {
        await bestEffort(threadId, requestMessageId, 'delete status comment', () => github.deleteMessage(threadId, statusId))
        await bestEffort(threadId, requestMessageId, 'add thumbs up', () => github.addReaction(threadId, requestMessageId, 'thumbs_up'))
        await bestEffort(threadId, requestMessageId, 'remove eyes', () => github.removeReaction(threadId, requestMessageId, 'eyes'))
        return
    }

    const text =
        end.kind === 'joined' ? joinedText :
        end.kind === 'stopped' ? stoppedText :
        end.kind === 'paused' ? pausedText(end.marked) :
        failureText(end.reason)
    await editStatus(threadId, requestMessageId, statusId, text, end.kind)
    await bestEffort(threadId, requestMessageId, 'remove eyes', () => github.removeReaction(threadId, requestMessageId, 'eyes'))
}

/** Turns the status comment into an error message and swaps 👀 for 😕. */
export const reportFailure = async (input: { threadId: string; requestMessageId: string; statusId: string; reason: string }): Promise<void> => {
    await bot.initialize()
    const { threadId, requestMessageId, statusId, reason } = input

    // The status comment already exists, so every step here is best effort: one failing step
    // must not stop the others, and a thrown error would leave the remaining steps undone.
    await editStatus(threadId, requestMessageId, statusId, failureText(reason), 'failure')
    await bestEffort(threadId, requestMessageId, 'remove eyes', () => github.removeReaction(threadId, requestMessageId, 'eyes'))
    await bestEffort(threadId, requestMessageId, 'add confused', () => github.addReaction(threadId, requestMessageId, 'confused'))
}

/**
 * Turns the status comment into "stopped at 30 minutes" and marks the thread paused. Returns
 * whether the mark is set, which decides the text: without the mark the bot does not treat a plain
 * reply as a go-ahead, so the text must not promise one.
 */
export const reportPaused = async (input: { threadId: string; requestMessageId: string; statusId: string }): Promise<boolean> => {
    await bot.initialize()
    const { threadId, requestMessageId, statusId } = input

    // The mark is set first, not best effort: the text below depends on it.
    let marked = false
    try {
        await setPaused(threadId, true)
        marked = true
    } catch (error) {
        log('request report step failed', { threadId, requestId: requestMessageId, step: 'mark thread paused', error: String(error) })
    }

    // The text names the limit itself (30 min), not the elapsed time, so it reads the same every time.
    await editStatus(threadId, requestMessageId, statusId, pausedText(marked), 'paused')
    await bestEffort(threadId, requestMessageId, 'remove eyes', () => github.removeReaction(threadId, requestMessageId, 'eyes'))
    return marked
}

/** Turns the status comment into "stopped on request" and removes 👀. */
export const reportStopped = async (input: { threadId: string; requestMessageId: string; statusId: string }): Promise<void> => {
    await bot.initialize()
    const { threadId, requestMessageId, statusId } = input

    await editStatus(threadId, requestMessageId, statusId, stoppedText, 'stopped')
    await bestEffort(threadId, requestMessageId, 'remove eyes', () => github.removeReaction(threadId, requestMessageId, 'eyes'))
}

/** Whether the thread waits for a go-ahead. Kept in ChatStateDO, so checking it wakes no PiAgent. */
export const isPaused = async (threadId: string): Promise<boolean> => {
    await bot.initialize()
    return (await bot.getState().get<boolean>(pausedKey(threadId))) === true
}

/** Sets or clears the paused mark. */
export const setPaused = async (threadId: string, paused: boolean): Promise<void> => {
    await bot.initialize()
    if (paused) await bot.getState().set(pausedKey(threadId), true)
    else await bot.getState().delete(pausedKey(threadId))
}
