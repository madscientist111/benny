import { Chat } from 'chat'
import { GitHubAdapter } from '@chat-adapter/github'
import { createCloudflareState, type ChatStateDO } from 'chat-state-cloudflare-do'
import { env } from 'cloudflare:workers'
import { getAgentByName } from 'agents'
import type { PiAgent } from './pi-agent'
import { repoObjectName, type RepoDO } from './repo-do'
import { checkRepoSize } from './repo-size'
import { buildFirstContext, githubContextBlock, type ContextInput } from './context'
import { loadPrChanges } from './pr-changes'
import { log } from './log'
import { recordMessage } from './thread-window'
import { httpStatus } from './github-contract'
import { isPaused, postStatus, reportFailure, setPaused } from './request-reporter'
import { clearInputRequired, hasInputRequired, withoutPrefix } from './input-required'
import { asksToStop, classify } from './jev/classify'

// The webhook side of Benny: the Chat SDK bot with its GitHub adapter, and the two handlers that
// decide what a comment starts. A mention starts a request, or stops one; an unmentioned message
// in a subscribed thread goes to the decision model. The run itself belongs to `PiAgent`
// (`pi-agent.ts`).

// Must be the GitHub App *slug* (github.com/apps/<slug>), not the app name,
// the repo name, or the `…[bot]` login. This is what `@`-mention detection matches.
export const BOT_USERNAME = 'bobby-sb'
// Numeric id of the `bobby-sb[bot]` account (public: api.github.com/users/bobby-sb%5Bbot%5D).
// Without it the adapter detects the id asynchronously per isolate, and webhooks that arrive
// first see Benny's own comments with `isMe: false`, so subscribed threads would classify them.
const BOT_USER_ID = 356604674

// `github.octokit` only knows the installation inside a webhook the Chat SDK handles. Push
// events never reach the SDK, so this subclass opens up the adapter's own per-installation
// client and its signature check instead of a second GitHub client.
class BennyGitHubAdapter extends GitHubAdapter {
    octokitFor(installationId: number) {
        return this.getOctokit(installationId)
    }

    isSignedByGitHub(body: string, signature: string | null) {
        return this.verifySignature(body, signature)
    }
}

export const github = new BennyGitHubAdapter({
    appId: env.GITHUB_APP_ID!,
    privateKey: env.GITHUB_PRIVATE_KEY!,
    // Workers bindings are not exposed on `process.env`, so pass the
    // secret explicitly instead of relying on auto-detection.
    webhookSecret: env.GITHUB_WEBHOOK_SECRET!,
    userName: BOT_USERNAME,
    botUserId: BOT_USER_ID,
})

// Per-thread state kept by the SDK (30-day TTL from the last write).
type ThreadState = { title: string }

export const bot = new Chat<{ github: typeof github }, ThreadState>({
    userName: BOT_USERNAME,
    adapters: {
        github
    },
    // Persistent across isolates, so subscriptions, locks and dedupe actually hold.
    state: createCloudflareState({ namespace: env.CHAT_STATE as unknown as DurableObjectNamespace<ChatStateDO> })
})



type BotThread = Parameters<Parameters<typeof bot.onNewMention>[0]>[0]
type BotMessage = Parameters<Parameters<typeof bot.onNewMention>[0]>[1]

const fetchIssue = (threadId: string) => {
    const { owner, repo, prNumber } = github.decodeThreadId(threadId)
    return github.octokit.issues.get({ owner, repo, issue_number: prNumber }).then((r) => r.data)
}
type Issue = Awaited<ReturnType<typeof fetchIssue>>

// Only repo members get a reply, a reaction or a subscription (requirement 46). GitHub answers
// 204 for a collaborator and 404 for anyone else (a repo the App cannot see also gives 404).
// Any other error is real, so it must not read as "not a member". The skip is logged, so a
// thread that goes quiet has a reason in the logs.
const isRepoMember = async (threadId: string, message: BotMessage) => {
    const { owner, repo } = github.decodeThreadId(threadId)
    const user = message.author.userName
    try {
        await github.octokit.repos.checkCollaborator({ owner, repo, username: user })
        return true
    } catch (error) {
        // Octokit puts the HTTP status on its request errors.
        if (httpStatus(error) !== 404) throw error
        log('ignored non-member', { threadId, requestId: message.id, user })
        return false
    }
}

// The title is cached in thread state; it's refetched when missing (first mention, or after
// the state expired). Returns the issue when it fetched one, so handleReply can reuse it. The
// cached title leaves out the waiting mark's prefix, so the decision model's input stays the same.
const getTitle = async (thread: BotThread): Promise<{ title: string; issue?: Issue }> => {
    const cached = await thread.state
    if (cached?.title) return { title: cached.title }
    const issue = await fetchIssue(thread.id)
    await thread.setState({ title: withoutPrefix(issue.title) })
    return { title: withoutPrefix(issue.title), issue }
}

// Requirement 35: only someone who may push to the repo can stop a run or send a go-ahead.
const hasWriteAccess = async (threadId: string, username: string) => {
    const { owner, repo } = github.decodeThreadId(threadId)
    const { data } = await github.octokit.repos.getCollaboratorPermissionLevel({ owner, repo, username })
    // `maintain` shows as `write`; `triage`, `read` and `none` may not stop or continue a run.
    return data.permission === 'admin' || data.permission === 'write'
}

// A writer's comment answers whatever Benny waited for, so the waiting mark goes, before the comment
// does anything else (`docs/input-required/plan.md`, rule 6). Only a marked thread costs a GitHub call.
const clearInputRequiredIfWriter = async (threadId: string, message: BotMessage) => {
    const { owner, repo, prNumber } = github.decodeThreadId(threadId)
    const target = { owner, repo, number: prNumber }
    try {
        if (!(await hasInputRequired(target))) return
        if (!(await hasWriteAccess(threadId, message.author.userName))) return
        await clearInputRequired(github.octokit, target, { requestId: message.id })
    } catch (error) {
        log('input required clear failed', { threadId, requestId: message.id, error: String(error) })
    }
}

// This thread's own PiAgent: one Durable Object per GitHub thread.
const threadAgent = (threadId: string) =>
    getAgentByName(env.PI_AGENT as unknown as DurableObjectNamespace<PiAgent>, threadId)

// Said in a request that does not mention Benny (a follow-up the decision model answers): the GitHub
// write and branch tools are off for it (batch 5 plan, 4.1), and the prompt tells the model what to say.
const NO_MENTION_NOTE = `This message does not mention @${BOT_USERNAME}, so the GitHub write and branch tools are off for it.`

const handleReply = async (thread: BotThread, message: BotMessage, knownIssue?: Issue) => {
    await thread.adapter.addReaction(thread.id, message.id, 'eyes')

    const threadId = thread.id
    // The comment that asked: every line about this request carries its id, so one grep finds
    // the whole story of the request.
    const requestId = message.id
    // The status comment goes first: the steps below (the clone, the PR fetch, the first-message
    // fetch) may outlive the webhook's ~30 s, so the user hears something now, and a failure at any
    // of them has a comment to turn into the error.
    let statusId: string | undefined
    try {
        statusId = await postStatus(threadId, requestId)
        const agent = await threadAgent(threadId)

        const isNewChat = await agent.isNew()
        // The first request's GitHub text, built now while the thread's data is fetched; the PR's
        // file list joins it below, once the PR changes are loaded.
        let firstContext: Omit<ContextInput, 'prSummary'> | undefined
        if (isNewChat) {
            const { octokit } = github
            const { owner, repo, prNumber, type } = github.decodeThreadId(thread.id)
            const kind = type === 'issue' ? 'issue' : 'pr'

            const [repoInfo, issue, pr, all] = await Promise.all([
                octokit.repos.get({ owner, repo }).then((r) => r.data),
                knownIssue ?? fetchIssue(thread.id),
                kind === 'pr'
                    ? octokit.pulls.get({ owner, repo, pull_number: prNumber }).then((r) => r.data)
                    : undefined,
                // collect(thread.allMessages),
                (await thread.adapter.fetchMessages(thread.id)).messages
            ])

            const recent = all.slice(-30)
            firstContext = {
                owner, repo, type: kind, number: prNumber,
                repoInfo, issue, pr,
                comments: recent.map((m: any) => ({ author: m.author.userName, text: m.text })),
                totalComments: all.length,
                requester: message.author.userName,
            }
        }
        log('reply start', { threadId, requestId, isNewChat })

        const { owner, repo, prNumber, type } = github.decodeThreadId(threadId)
        // The adapter stores the installation on every webhook, before a handler runs.
        const installationId = await github.getInstallationId(threadId)
        if (installationId === undefined) throw new Error(`No GitHub App installation is known for ${owner}/${repo}`)
        // A fresh installation token (1 hour); the RepoDO uses it only for git requests.
        const { token } = (await github.octokit.auth({ type: 'installation' })) as { token: string }
        const repoStub = (env.REPO as unknown as DurableObjectNamespace<RepoDO>).getByName(repoObjectName(owner, repo))
        await checkRepoSize(github.octokit, owner, repo, requestId)
        const { commit } = await repoStub.sync({ owner, repo, token, logIds: { requestId } })
        await agent.useRepo({ owner, repo })

        // A PR thread reads the PR's own version of its changed files; every other file stays the
        // default branch in /repo. The fetch is skipped when the thread already holds this head.
        let prSummary: string | undefined
        let prHead: string | null = null
        if (type === 'pr') {
            const { headSha, prChanges, summary } = await loadPrChanges(github.octokit, {
                owner, repo, prNumber, requestId, knownHead: await agent.prChangesHead(),
            })
            if (prChanges) await agent.replacePrChanges({ ...prChanges, requestId })
            prSummary = summary
            prHead = headSha
        }

        // All GitHub text goes inside the data block, and the request comes after it, then what Benny
        // itself knows: the commit, and whether the request mentions Benny (batch 5 plan, 4.1).
        const context = firstContext ? buildFirstContext({ ...firstContext, prSummary }) : prSummary ? githubContextBlock(prSummary) : undefined
        const prompt = [
            ...(context ? [context] : []),
            `Request from @${message.author.userName}:\n${message.text}`,
            `Repository: ${owner}/${repo} at commit ${commit}`,
            ...(message.isMention ? [] : [NO_MENTION_NOTE]),
        ].join('\n\n')

        // Only a member with write access may make Benny run code (requirement 37). A failing check
        // must not stop the reply, so it counts as no write access.
        let requesterHasWriteAccess = false
        try {
            requesterHasWriteAccess = await hasWriteAccess(threadId, message.author.userName)
        } catch (error) {
            log('write access check failed', { threadId, requestId, user: message.author.userName, error: String(error) })
        }

        // A request may run for 30 minutes, longer than this webhook lives, so start the run and
        // return: the thread's PiAgent reports the reply, the footnote and the reactions itself.
        await agent.start({
            threadId,
            requestMessageId: message.id,
            statusId,
            // The requester's own comment only: its links are the ones `web_fetch` may read.
            requestText: message.text,
            prompt,
            commit,
            prHead,
            hasWriteAccess: requesterHasWriteAccess,
            mentionsBenny: message.isMention === true,
            installationId,
            // Whose access a read of another repo checks (issue #53): the person who asked, never the model.
            requester: message.author.userName,
        })
    } catch (error) {
        log('reply failed', { threadId, requestId, error: String(error) })
        // The status comment is already on GitHub: it becomes the error, and the reactions change.
        if (statusId) {
            try {
                // The message only: `String(error)` would show "Error: " in the comment.
                const reason = error instanceof Error ? error.message : String(error)
                await reportFailure({ threadId, requestMessageId: message.id, statusId, reason })
            } catch (reportError) {
                log('reply failed to report the error', { threadId, requestId, error: String(reportError) })
            }
            return
        }

        // Posting the status comment itself failed, so there is no comment to edit. Only the first
        // line, at most 200 characters: no tokens, headers or stack traces.
        const errorText = error instanceof Error ? error.message : String(error)
        const errorFirstLine = errorText.split('\n')[0].trim().slice(0, 200)

        // Each step has its own catch: the user must see the reactions change even when
        // posting the explanation fails, and vice versa.
        try {
            await thread.post(`I could not finish this request because of an error: ${errorFirstLine}. Please try again. If it fails again, tell the maintainers.`)
        } catch (postError) {
            log('reply failed to report the error', { threadId, requestId, error: String(postError) })
        }
        try {
            await thread.adapter.removeReaction(thread.id, message.id, 'eyes')
        } catch (removeError) {
            log('reply failed to remove the eyes reaction', { threadId, requestId, error: String(removeError) })
        }
        try {
            await thread.adapter.addReaction(thread.id, message.id, 'confused')
        } catch (addError) {
            log('reply failed to add the confused reaction', { threadId, requestId, error: String(addError) })
        }
    }
}

const handleMention = async (thread: BotThread, message: BotMessage) => {
    const { issue } = await getTitle(thread)
    await recordMessage(bot.getState(), thread.adapter, thread.id, message)
    await handleReply(thread, message, issue)
}

// Requirement 35: "stop" is a mention, so it reaches the handlers like any other mention. The
// handle comes from BOT_USERNAME, never a second copy of it.
const STOP_COMMAND = new RegExp(`@${BOT_USERNAME}\\s+stop\\b`, 'i')

// "New" means a mention in an *unsubscribed* thread, not the first mention: the SDK keeps no
// record of earlier mentions, only the subscription flag. Without subscribe() here, every later
// mention would land here again and unmentioned follow-ups would go to onNewMessage, which fires
// for every comment in every installed repo. Once subscribed, the SDK sends every message in the
// thread (mentions included) to onSubscribedMessage instead, never to both.
bot.onNewMention(async (thread, message) => {
    if (!(await isRepoMember(thread.id, message))) return
    // A writer's comment answers the mark even when it is a "stop" (a PR Benny made ready has a mark
    // and no subscription yet), so this runs before the stop check.
    await clearInputRequiredIfWriter(thread.id, message)
    // Nothing can be running before the thread's first mention, so a "stop" here only gets logged.
    if (STOP_COMMAND.test(message.text)) {
        log('stop ignored', { threadId: thread.id, requestId: message.id, user: message.author.userName })
        return
    }
    await thread.subscribe()
    await handleMention(thread, message)
})

// Subscriptions live in ChatStateDO, so threads Benny was never mentioned in never get here
// and never wake a PiAgent.
bot.onSubscribedMessage(async (thread, message) => {
    if (message.isMention) {
        if (!(await isRepoMember(thread.id, message))) return
        await clearInputRequiredIfWriter(thread.id, message)
        const username = message.author.userName
        if (STOP_COMMAND.test(message.text) || (await asksToStop(message))) {
            // Only someone who may push to the repo can stop a request (requirement 35).
            try {
                if (!(await hasWriteAccess(thread.id, username))) {
                    log('stop refused', { threadId: thread.id, requestId: message.id, user: username })
                    return
                }
                const agent = await threadAgent(thread.id)
                const stopped = await agent.stop()
                log('stop', { threadId: thread.id, requestId: message.id, user: username, stopped })
                // Say what happened instead of reacting, so a stop never looks ignored.
                if (stopped) await thread.adapter.addReaction(thread.id, message.id, 'thumbs_up')
                else if (await isPaused(thread.id)) {
                    // Nothing runs, but the thread waits for a go-ahead: stopping cancels that wait.
                    await setPaused(thread.id, false)
                    await thread.post('I cancelled the paused request.')
                } else await thread.post('Nothing is running in this thread.')
            } catch (error) {
                log('stop failed', { threadId: thread.id, requestId: message.id, error: String(error) })
                await thread.post('I could not stop the request because of an error. Please try again.')
            }
            return
        }
        // A mention while paused is a go-ahead too (requirement 33): only a writer continues.
        if (await isPaused(thread.id)) {
            if (!(await hasWriteAccess(thread.id, username))) {
                log('go-ahead refused', { threadId: thread.id, requestId: message.id, user: username })
                return
            }
        }
        return handleMention(thread, message)
    }

    const { title } = await getTitle(thread)
    // Record before checking membership: the decision model needs the full thread context.
    const messagesBefore = await recordMessage(bot.getState(), thread.adapter, thread.id, message)
    if (!(await isRepoMember(thread.id, message))) return
    await clearInputRequiredIfWriter(thread.id, message)

    // Reply after a pause (requirement 33): the next request starts instead of being classified.
    let isGoAhead = false
    try {
        if (await isPaused(thread.id)) {
            if (!(await hasWriteAccess(thread.id, message.author.userName))) {
                log('go-ahead refused', { threadId: thread.id, requestId: message.id, user: message.author.userName })
                return
            }
            isGoAhead = true
        }
    } catch (error) {
        // Without the check, the message is classified like any other.
        log('go-ahead check failed', { threadId: thread.id, requestId: message.id, error: String(error) })
    }
    if (isGoAhead) return handleReply(thread, message)

    const { type } = github.decodeThreadId(thread.id)

    const decision = await classify({ threadId: thread.id, kind: type === 'issue' ? 'issue' : 'pr', title }, messagesBefore, message)
    if (decision.action === 'reply') await handleReply(thread, message)
    else if (decision.action === 'ack') await thread.adapter.addReaction(thread.id, message.id, decision.reaction)
})
