import type { AgentTask, AgentTaskReport, AgentTaskState, WorkspaceCopy } from './agent-do'
import type { Harness, RunResult, RunUsage } from './harness-contract'
import { log } from './log'
import type { McpTask } from './mcp-tools'
import type { PrChanges } from './pi-agent'
import { EFFORT_PARAGRAPH, EXPLANATION_PARAGRAPH, REVIEW_PARAGRAPH, VOICE_PARAGRAPH } from './reply-style'
import { wait } from './wait'

// The `Harness` contract over Claude Code: each task runs in the thread's container in the
// `bobby-agent-dev` Worker (`AgentDO`, reached through `AgentService`). `harness.ts` builds it when
// `HARNESS` is `claude-code`. A run is a chain of tasks in one Claude Code session, and everything
// a wait needs is in the `PiAgent`'s storage, so a wait after an eviction still settles.

/** The `AgentService` methods (`agent-worker.ts`) Benny calls; each takes the thread's agent name first. */
export type AgentServiceMethods = {
    /** Returns once the task is started; `taskReport` then says how it stands. */
    startTask(agentName: string, task: AgentTask): Promise<void>
    stopTask(agentName: string, taskId: string): Promise<boolean>
    taskReport(agentName: string, taskId: string): Promise<AgentTaskState>
    workspaceKey(agentName: string): Promise<string | undefined>
    copyWorkspace(agentName: string, copy: WorkspaceCopy): Promise<void>
}

/** The binding name of `AgentService` in `cloudflare.config.ts`. */
export const AGENT_SERVICE_BINDING = 'AGENT_SERVICE'

/** What a tool task may do, as `PiAgent.#configureToolAccess` decided for its run. */
export type ToolTaskAccess = Omit<McpTask, 'expiresAt'>

/**
 * The code a task starts from, as `PiAgent` sees it now. `key` names it without reading it
 * (`branch:<name>`, or `repo:<name>` plus the PR head); `copy` reads it only when the container
 * holds another key.
 */
export type AgentWorkspace = {
    key: string
    copy: () => Promise<{ archive: ReadableStream<Uint8Array>; prChanges: PrChanges | null }>
}

export type ClaudeCodeRunOptions = {
    /** The `PiAgent`'s synchronous storage: a join and a run's end each happen in one step. */
    store: SyncKvStorage
    agentService: AgentServiceMethods
    /** The thread's `AgentDO` name: the `PiAgent`'s id, 64 hex characters. */
    agentName: string
    /** Benny's `/mcp` at a URL the container can reach. */
    mcpUrl: string
    /** Mints a tool task token for the run working now (`PiAgent.#newTaskToken`). */
    newTaskToken: () => Promise<{ token: string; access: ToolTaskAccess }>
    workspace: () => Promise<AgentWorkspace>
    /** How a task is followed; tests shorten the times and pass a clock. */
    polling?: Partial<TaskPolling>
}

/** How Benny follows a task in `AgentDO`: it asks `taskReport` every `pollMs`, so no RPC lasts the task. */
export type TaskPolling = {
    pollMs: number
    /** How long `taskReport` may keep failing (a dropped connection) before the task counts as lost. */
    unreachableMs: number
    /** How long past its time limit a task may still be `running` before Benny stops it and ends it as `timedOut`. */
    overLimitMs: number
    now: () => number
}

export const TASK_POLLING: TaskPolling = { pollMs: 5 * 1000, unreachableMs: 3 * 60 * 1000, overLimitMs: 2 * 60 * 1000, now: () => Date.now() }

/** A task Benny follows. Stored with the run, so a new object follows it after an eviction. */
export type FollowedTask = { taskId: string; startedAt: number; timeoutSeconds: number }

/** A task gets 15 minutes (`AgentDO` allows no more); the runner caps it at 30 turns. */
export const TASK_LIMIT_SECONDS = 15 * 60
/** A task still "running" this long after it started is taken as lost. */
export const LOST_TASK_AFTER_MS = (TASK_LIMIT_SECONDS + 5 * 60) * 1000

/**
 * Why a request's task ended without an answer, as codes like pi's `turn_limit`. The reply's words
 * for each are `TASK_FAILURE_TEXTS`; the detail (an RPC error, a stack) goes
 * only to the log.
 */
export const TASK_FAILED_REASONS = {
    timeLimit: 'task_time_limit',
    lost: 'task_lost',
    unreachable: 'agent_unreachable',
    failed: 'task_failed',
} as const

/**
 * The reply for each reason a Claude Code task ends without an answer (`TASK_FAILED_REASONS`), as
 * `failureText` in `request-reporter.ts` shows them. Like
 * pi's, they never name the model or harness, and each says what happened and what to do next.
 */
export const TASK_FAILURE_TEXTS: Record<string, string> = {
    [TASK_FAILED_REASONS.timeLimit]: `I stopped because this request reached its ${TASK_LIMIT_SECONDS / 60}-minute time limit before I had an answer. Ask me to continue, or ask for a smaller part of the work.`,
    [TASK_FAILED_REASONS.lost]: 'I lost track of this request: the machine that ran it restarted, so it has no answer. Changes I did not write to the work branch are gone. Mention me to start it again.',
    [TASK_FAILED_REASONS.unreachable]: `I could not reach the machine that runs my work for ${TASK_POLLING.unreachableMs / 60_000} minutes, so this request has no answer. Mention me again in a few minutes.`,
    [TASK_FAILED_REASONS.failed]: 'My work on this request stopped with an error before I had an answer. Mention me to try again. If it fails again, the error is in Benny\'s logs.',
}

/** Settled operations are kept this long, for a follower that compares its leader's answer. */
const SETTLED_OPERATION_KEEP_MS = 24 * 60 * 60 * 1000
/** `stopTask` is sent again this often, up to 3 times, while the task has not reached `AgentDO` yet. */
const STOP_RETRY_MS = 2 * 1000
const STOP_ATTEMPTS = 3

const RUN_KEY = 'claudeCode:run'
const OPERATION_KEY_PREFIX = 'claudeCode:operation:'
/** Tasks started in this thread: `messageCount`, and the index of the next task's usage. */
const TASK_COUNT_KEY = 'claudeCode:taskCount'
const TASK_USAGE_KEY_PREFIX = 'claudeCode:taskUsage:'
/** The thread's Claude Code session: every task resumes it, so the thread is one conversation. */
const SESSION_KEY = 'claudeCode:sessionId'
/**
 * The session's running cost after its latest task. The SDK's `total_cost_usd` on a resumed session
 * already holds the earlier tasks (SDK 0.3.328 docs), so a task's own cost is the difference.
 */
const SESSION_COST_KEY = 'claudeCode:sessionCost'
type SessionCost = { sessionId: string; totalUsd: number }

/**
 * Appended to Claude Code's system prompt: Benny's voice and reply shapes, the same words pi gets
 * (`reply-style.ts`), around what is Claude Code's own here: its workspace, tools and how its work
 * reaches GitHub.
 */
export const CLAUDE_CODE_INSTRUCTIONS = [
    VOICE_PARAGRAPH,
    'You answer a comment in a GitHub issue or pull request. Your final message is posted there as your reply, so write it for the person who asked.',
    '`/workspace` holds the thread\'s code: the work branch once one is open, otherwise the default branch with the PR\'s changed files on top. It is a git repository with one baseline commit, so `git status` and `git diff` show your changes. Its local git branch is a copy, not a branch on GitHub: name the work branch `branch_start` gives you. There is no git token here: `git push` does not work.',
    'Benny\'s tools are the `mcp__bobby__` tools. The `github_` tools read and change issues and pull requests in this repository only.',
    'Benny\'s file tools (`mcp__bobby__read`, `ls`, `find`, `grep` and their `pr_` versions) see the repository at `/repo`, not `/workspace`: give them paths like `/repo/package.json`. Your own Read, Edit and Bash work in `/workspace`.',
    'Change things only when the requester asks for it. To change code: `branch_start`, edit the files in `/workspace` and run the tests with Bash, then `branch_write_files` with the whole content of every file you changed and the paths you deleted, then `branch_commit_push`, then `github_create_pr`, then `github_update_pr` with `draft: false` once the tests pass.',
    'Never merge, approve or close a PR, and never change files in `.github/workflows`. A PR has at most 20 files and 400 changed lines; for bigger work, say how you would split it and ask first.',
    'If a tool is refused for write access, say so, and do not try again. If the request says it does not mention you, change nothing on GitHub or in a branch.',
    EXPLANATION_PARAGRAPH,
    REVIEW_PARAGRAPH,
    EFFORT_PARAGRAPH,
].join('\n\n')

/** Starts the task that carries the requests that joined while the run worked. */
const JOINED_REQUESTS_INTRO =
    'More comments asked you while you worked; they follow. Your answer above was not posted: Benny posts only your answer to this message. ' +
    'Answer the earlier request and these together, in one reply.'

/** One run of the thread: a chain of tasks in its session. All its requests settle together. */
type ClaudeRun = {
    /** Every request of the run, leader first. */
    operationIds: string[]
    /** Prompts not yet sent: the leader's at the start, then those of requests that joined. */
    queuedPrompts: { operationId: string; prompt: string }[]
    /** The task working now. `index` is its place in the thread's tasks, for `usageSince`. */
    task?: FollowedTask & { index: number }
    tasksDone: number
    /** The answer of the run's latest task: the reply, when no request is left to send. */
    lastAnswer?: string
    /** Set by `abort`: the run ends with this reason once its task stops. */
    abortReason?: string
    /** For log lines, from the run's first task token. */
    runId?: string
}

/** One request's operation. `result` is set once it settled. */
type OperationRecord = { result?: RunResult; settledAt?: number }

/** What one task used, from its report. */
type TaskUsage = Pick<RunUsage, 'turns' | 'toolCalls' | 'webSearches' | 'webFetches' | 'tokensIn' | 'cachedTokensIn' | 'tokensOut' | 'peakContextTokens'> & { costUsd: number }

const operationKey = (operationId: string) => `${OPERATION_KEY_PREFIX}${operationId}`
/** Zero-padded, so a listing comes in task order. */
const taskUsageKey = (index: number) => `${TASK_USAGE_KEY_PREFIX}${String(index).padStart(10, '0')}`

/** A report for a task that never reached `AgentDO`, or whose report is gone. */
const failedReport = (taskId: string, error: string): AgentTaskReport => ({
    taskId, outcome: 'failed', answer: undefined, sessionId: undefined, turns: undefined, sessionCostUsd: undefined,
    resultSubtype: undefined, tokens: undefined, toolCalls: [], deniedToolCalls: undefined, toolCallsCut: 0, mcpServers: [],
    exitCode: -1, containerWaitMs: 0, taskMs: 0, error, stderr: '',
})

/**
 * Why a task ends its run unanswered, or `undefined` when it answered. The words are the ones
 * `PiAgent` reads: `aborted` for a stop, `turn_limit` asks for a summary answer; any other is one
 * of the plain `TASK_FAILED_REASONS`, never the report's raw error.
 */
const failureReason = (report: AgentTaskReport): string | undefined => {
    if (report.outcome === 'answered') return undefined
    if (report.outcome === 'stopped') return 'aborted'
    if (report.outcome === 'timedOut') return TASK_FAILED_REASONS.timeLimit
    if (report.resultSubtype === 'error_max_turns') return 'turn_limit'
    if (report.error === TASK_FAILED_REASONS.lost || report.error === TASK_FAILED_REASONS.unreachable) return report.error
    return TASK_FAILED_REASONS.failed
}

/**
 * Copies the thread's code into the container when it holds another copy (or none), and says
 * whether it did. `ClaudeCodeRun` and the `claude_code` tool both start a task with it.
 */
export const copyWorkspaceWhenStale = async (agentService: AgentServiceMethods, agentName: string, workspace: AgentWorkspace, runId: string): Promise<boolean> => {
    if ((await agentService.workspaceKey(agentName)) === workspace.key) return false
    const { archive, prChanges } = await workspace.copy()
    await agentService.copyWorkspace(agentName, { key: workspace.key, archive, prChanges, runId })
    return true
}

/**
 * Asks `AgentDO` how `task` stands every `pollMs` until it ends, and returns its report. A poll that
 * fails is retried (a dropped connection loses a poll, not the task) until polls have failed for
 * `unreachableMs`. A task `AgentDO` does not know is lost; one still running `overLimitMs` past its
 * time limit is stopped and ends `timedOut`. `ClaudeCodeRun` and the `claude_code` tool both follow
 * their tasks with it, also after an eviction.
 */
export const followTask = async (
    agentService: AgentServiceMethods, agentName: string, task: FollowedTask, runId: string | undefined, polling: TaskPolling,
): Promise<AgentTaskReport> => {
    const { taskId } = task
    let failingSince: number | undefined
    for (;;) {
        let state: AgentTaskState
        try {
            state = await agentService.taskReport(agentName, taskId)
            failingSince = undefined
        } catch (error) {
            failingSince ??= polling.now()
            log('agent task poll failed', { runId, taskId, failingMs: polling.now() - failingSince, error: String(error) })
            if (polling.now() - failingSince >= polling.unreachableMs) {
                log('agent task unreachable', { runId, taskId, failingMs: polling.now() - failingSince })
                // Best effort: the agent was unreachable, so the stop may not reach it either.
                agentService.stopTask(agentName, taskId).catch(() => {})
                return failedReport(taskId, TASK_FAILED_REASONS.unreachable)
            }
            await wait(polling.pollMs)
            continue
        }
        if (state.state === 'done') return state.report
        if (state.state === 'unknown') {
            log('agent task lost', { runId, taskId })
            // `AgentDO` stops an orphan runner itself when it answers `unknown`; this stop is a second try.
            agentService.stopTask(agentName, taskId).catch(() => {})
            return failedReport(taskId, TASK_FAILED_REASONS.lost)
        }
        if (polling.now() - task.startedAt > task.timeoutSeconds * 1000 + polling.overLimitMs) {
            log('agent task over its time limit', { runId, taskId, timeoutSeconds: task.timeoutSeconds, ms: polling.now() - task.startedAt })
            // Not awaited: a stop that hangs must not hold the reply.
            agentService.stopTask(agentName, taskId).catch((error) => log('agent task stop failed', { runId, taskId, error: String(error) }))
            return { ...failedReport(taskId, 'still running past its time limit, so Benny stopped it'), outcome: 'timedOut' }
        }
        await wait(polling.pollMs)
    }
}

/**
 * Starts `task` in `AgentDO` and follows it to its report. A start that throws is checked once:
 * when the connection dropped after `AgentDO` took the task, the task is followed; when `AgentDO`
 * never took it, the start's error is thrown.
 */
export const startAndFollowTask = async (
    agentService: AgentServiceMethods, agentName: string, task: AgentTask, polling: TaskPolling, onStarted: (startedAt: number) => void = () => {},
): Promise<AgentTaskReport> => {
    const startedAt = polling.now()
    try {
        await agentService.startTask(agentName, task)
    } catch (error) {
        const state = await agentService.taskReport(agentName, task.taskId).catch(() => ({ state: 'unknown' }) as const)
        if (state.state === 'unknown') throw error
        log('agent task start answered with an error, but the task started', { runId: task.runId, taskId: task.taskId, error: String(error) })
    }
    onStarted(startedAt)
    return followTask(agentService, agentName, { taskId: task.taskId, startedAt, timeoutSeconds: task.timeoutSeconds ?? TASK_LIMIT_SECONDS }, task.runId, polling)
}

/** A Benny tool's MCP name ends with its own name (`mcp__bobby__web_search`); Claude Code's own are `WebSearch` and `WebFetch`. */
const isToolNamed = (toolName: string, bennyName: string, claudeName: string) => toolName === claudeName || toolName.endsWith(`__${bennyName}`)

export class ClaudeCodeRun implements Harness {
    readonly #options: ClaudeCodeRunOptions
    readonly #store: SyncKvStorage
    /** Waits by operation id, resolved when the run settles. Lost on an eviction; `wait` adds them back. */
    readonly #waiters = new Map<string, ((result: RunResult) => void)[]>()
    /** The task this object started and still follows. After an eviction it is gone, and the stored task is followed. */
    #taskInFlight: { taskId: string; report: Promise<AgentTaskReport> } | undefined
    readonly #polling: TaskPolling
    /** A loop drives the run; set and cleared with no `await` between the check and the change. */
    #driving = false

    constructor(options: ClaudeCodeRunOptions) {
        this.#options = options
        this.#store = options.store
        this.#polling = { ...TASK_POLLING, ...options.polling }
    }

    async messageCount(): Promise<number> {
        return this.#store.get<number>(TASK_COUNT_KEY) ?? 0
    }

    /**
     * Joins the running run or starts one, decided with no `await` before the change, so it cannot
     * race the run's end. A joined prompt is sent as the next task of the same session once the
     * current task ends, and every request of the run settles with the answer to that last task.
     */
    async submit(prompt: string): Promise<{ operationId: string; joined: boolean }> {
        const operationId = crypto.randomUUID()
        const run = this.#store.get<ClaudeRun>(RUN_KEY)
        if (!run) {
            this.#startRun(operationId, prompt)
            return { operationId, joined: false }
        }
        run.operationIds.push(operationId)
        run.queuedPrompts.push({ operationId, prompt })
        this.#store.put<OperationRecord>(operationKey(operationId), {})
        this.#store.put<ClaudeRun>(RUN_KEY, run)
        // After an eviction nothing drives the run this request joined.
        this.#ensureDriving()
        return { operationId, joined: true }
    }

    async startRunWhenIdle(prompt: string): Promise<{ operationId: string }> {
        // Named as pi-durable names its refusal, so a caller tells "busy" from a failure for either harness.
        if (this.#store.get<ClaudeRun>(RUN_KEY)) throw Object.assign(new Error('A Claude Code run is working in this thread'), { name: 'ConversationBusy' })
        const operationId = crypto.randomUUID()
        this.#startRun(operationId, prompt)
        return { operationId }
    }

    async wait(operationId: string): Promise<RunResult> {
        const record = this.#store.get<OperationRecord>(operationKey(operationId))
        if (!record) {
            log('agent request unknown', { operationId })
            return { status: 'unanswered', reason: TASK_FAILED_REASONS.lost }
        }
        if (record.result) return record.result
        const settled = new Promise<RunResult>((resolve) => {
            this.#waiters.set(operationId, [...(this.#waiters.get(operationId) ?? []), resolve])
        })
        if (!this.#store.get<ClaudeRun>(RUN_KEY)) {
            // An operation with no result and no run: storage lost the run, so nothing will answer it.
            log('agent run gone', { operationId })
            this.#settle([operationId], { status: 'unanswered', reason: TASK_FAILED_REASONS.lost })
        } else {
            this.#ensureDriving()
        }
        return settled
    }

    /**
     * Withdraws a request whose prompt is still queued; any other id, or none, stops the run's task,
     * and the run's requests settle `aborted`.
     */
    async abort(operationId?: string): Promise<void> {
        const run = this.#store.get<ClaudeRun>(RUN_KEY)
        if (!run || (operationId !== undefined && !run.operationIds.includes(operationId))) return
        const queuedIndex = run.queuedPrompts.findIndex((queued) => queued.operationId === operationId)
        if (operationId !== undefined && queuedIndex !== -1) {
            run.queuedPrompts.splice(queuedIndex, 1)
            run.operationIds = run.operationIds.filter((id) => id !== operationId)
            this.#store.put<ClaudeRun>(RUN_KEY, run)
            this.#settle([operationId], { status: 'unanswered', reason: 'aborted' })
            return
        }
        run.abortReason = 'aborted'
        this.#store.put<ClaudeRun>(RUN_KEY, run)
        this.#ensureDriving()
        const task = run.task
        if (!task) return
        // A task still copying its workspace has not reached `AgentDO`; `#runTask` checks the mark
        // before it starts. One on its way there is stopped once it arrives.
        for (let attempt = 1; attempt <= STOP_ATTEMPTS; attempt++) {
            try {
                if (await this.#options.agentService.stopTask(this.#options.agentName, task.taskId)) break
            } catch (error) {
                log('agent task stop failed', { runId: run.runId, taskId: task.taskId, error: String(error) })
            }
            if (this.#store.get<ClaudeRun>(RUN_KEY)?.task?.taskId !== task.taskId) break
            await wait(STOP_RETRY_MS)
        }
    }

    /**
     * Nothing to hide: Claude Code gets Benny's tools from `/mcp`, where each task's token carries
     * the run's access and `PiAgent.serveMcp` narrows it again at every call, so a tool the run may
     * not use is neither listed nor run.
     */
    async hideTools(): Promise<void> {}

    /** Adds up the tasks from `messageCountBefore` on. Claude Code has no sandbox tools and no `claude_code` tool, so those stay 0. */
    async usageSince(messageCountBefore: number): Promise<RunUsage> {
        const usage: RunUsage = {
            tokensIn: 0, cachedTokensIn: 0, tokensOut: 0, toolCalls: 0, webSearches: 0, webFetches: 0,
            turns: 0, peakContextTokens: 0,
            sandboxCalls: 0, sandboxWallMs: 0, sandboxStarts: 0, sandboxInstallMs: 0,
            claudeCodeTasks: 0, claudeCodeCostUsd: 0,
            costUsd: 0,
        }
        for (const [key, task] of this.#store.list<TaskUsage>({ prefix: TASK_USAGE_KEY_PREFIX })) {
            if (Number(key.slice(TASK_USAGE_KEY_PREFIX.length)) < messageCountBefore) continue
            usage.turns += task.turns
            usage.toolCalls += task.toolCalls
            usage.webSearches += task.webSearches
            usage.webFetches += task.webFetches
            usage.tokensIn += task.tokensIn
            usage.cachedTokensIn += task.cachedTokensIn
            usage.tokensOut += task.tokensOut
            usage.peakContextTokens = Math.max(usage.peakContextTokens, task.peakContextTokens)
            usage.costUsd = (usage.costUsd ?? 0) + task.costUsd
        }
        return usage
    }

    #startRun(operationId: string, prompt: string): void {
        const now = Date.now()
        for (const [key, record] of this.#store.list<OperationRecord>({ prefix: OPERATION_KEY_PREFIX })) {
            if (record.settledAt !== undefined && now - record.settledAt > SETTLED_OPERATION_KEEP_MS) this.#store.delete(key)
        }
        this.#store.put<OperationRecord>(operationKey(operationId), {})
        this.#store.put<ClaudeRun>(RUN_KEY, { operationIds: [operationId], queuedPrompts: [{ operationId, prompt }], tasksDone: 0 })
        this.#ensureDriving()
    }

    /** Starts the loop that drives the stored run, unless one is already driving it. */
    #ensureDriving(): void {
        if (this.#driving) return
        this.#driving = true
        void this.#driveRun()
    }

    /**
     * Drives the run to its end: starts a task for the queued prompts, waits for its report (or, after
     * an eviction, asks `AgentDO` for it), and repeats while requests joined; then settles every
     * request of the run at once. Each check of the queue and the settle that follows it run with
     * no `await` between, so a request either joins in time or starts a new run.
     */
    async #driveRun(): Promise<void> {
        try {
            for (;;) {
                const run = this.#store.get<ClaudeRun>(RUN_KEY)
                if (!run) return
                if (run.task) {
                    const task = run.task
                    const inFlight = this.#taskInFlight?.taskId === task.taskId ? this.#taskInFlight : undefined
                    const report = inFlight
                        ? await inFlight.report
                        : await followTask(this.#options.agentService, this.#options.agentName, task, run.runId, this.#polling)
                    if (this.#taskInFlight?.taskId === task.taskId) this.#taskInFlight = undefined
                    this.#recordTask(task.index, report)
                    // Read again: requests may have joined, or `abort` marked the run, while the task ran.
                    const current = this.#store.get<ClaudeRun>(RUN_KEY)
                    if (!current) return
                    current.task = undefined
                    current.tasksDone += 1
                    if (report.answer) current.lastAnswer = report.answer
                    const reason = current.abortReason ?? failureReason(report)
                    if (reason) {
                        this.#endRun(current, { status: 'unanswered', reason })
                        return
                    }
                    this.#store.put<ClaudeRun>(RUN_KEY, current)
                    continue
                }
                if (run.abortReason) {
                    this.#endRun(run, { status: 'unanswered', reason: run.abortReason })
                    return
                }
                if (run.queuedPrompts.length === 0) {
                    this.#endRun(run, { status: 'done', text: run.lastAnswer })
                    return
                }
                this.#startTask(run)
            }
        } catch (error) {
            const run = this.#store.get<ClaudeRun>(RUN_KEY)
            log('agent run failed', { runId: run?.runId, error: String(error) })
            if (run) this.#endRun(run, { status: 'unanswered', reason: TASK_FAILED_REASONS.failed })
        } finally {
            // Cleared in the same step as the last check, so a request after it starts a new loop.
            this.#driving = false
        }
    }

    /** Sends every queued prompt as one task, and stores the task before anything can fail. */
    #startTask(run: ClaudeRun): void {
        const index = this.#store.get<number>(TASK_COUNT_KEY) ?? 0
        this.#store.put<number>(TASK_COUNT_KEY, index + 1)
        const prompts = run.queuedPrompts.map((queued) => queued.prompt)
        const prompt = run.tasksDone === 0 ? prompts.join('\n\n---\n\n') : [JOINED_REQUESTS_INTRO, ...prompts].join('\n\n---\n\n')
        const taskId = crypto.randomUUID()
        run.queuedPrompts = []
        run.task = { taskId, index, startedAt: this.#polling.now(), timeoutSeconds: TASK_LIMIT_SECONDS }
        this.#store.put<ClaudeRun>(RUN_KEY, run)
        this.#taskInFlight = { taskId, report: this.#runTask(taskId, prompt) }
    }

    /**
     * Runs one task: mints its tool token, copies the thread's code into the container when it holds
     * another copy, then runs it, resuming the thread's session. Never throws: a failure is a
     * `failed` report.
     */
    async #runTask(taskId: string, prompt: string): Promise<AgentTaskReport> {
        const { agentService, agentName, mcpUrl } = this.#options
        let runId: string | undefined
        try {
            // No token means no run is known to `PiAgent` (a summary answer after its run ended):
            // the task then gets no Benny tools, which a summary does not call.
            let tools: { access: ToolTaskAccess; token: string } | undefined
            try {
                tools = await this.#options.newTaskToken()
                runId = tools.access.runId
                const run = this.#store.get<ClaudeRun>(RUN_KEY)
                if (run && run.task?.taskId === taskId && !run.runId) this.#store.put<ClaudeRun>(RUN_KEY, { ...run, runId })
            } catch (error) {
                log('agent task without tools', { runId: this.#store.get<ClaudeRun>(RUN_KEY)?.runId, taskId, error: String(error) })
            }
            runId ??= this.#store.get<ClaudeRun>(RUN_KEY)?.runId

            const workspace = await this.#options.workspace()
            const workspaceCopied = await copyWorkspaceWhenStale(agentService, agentName, workspace, runId ?? taskId)
            let sessionId = this.#store.get<string>(SESSION_KEY)
            // The session remembers files that the new copy may not have.
            const notice = workspaceCopied && sessionId
                ? `Note: \`/workspace\` was replaced with a fresh copy of the thread's code (${workspace.key}) since your last message. Changes you did not write with \`branch_write_files\` are gone.\n\n`
                : ''
            const abortedReport = () => this.#store.get<ClaudeRun>(RUN_KEY)?.abortReason ? { ...failedReport(taskId, 'stopped before it started'), outcome: 'stopped' as const } : undefined
            const stoppedEarly = abortedReport()
            if (stoppedEarly) return stoppedEarly

            const task: AgentTask = {
                prompt: notice + prompt,
                instructions: CLAUDE_CODE_INSTRUCTIONS,
                resumeSessionId: sessionId,
                taskId,
                runId: runId ?? taskId,
                ...(tools ? { mcpUrl, mcpToken: tools.token } : {}),
                timeoutSeconds: TASK_LIMIT_SECONDS,
            }
            log('agent task started', {
                runId, taskId, resumed: sessionId !== undefined, workspaceKey: workspace.key, workspaceCopied,
                withTools: tools !== undefined, mayWrite: tools?.access.mayWrite ?? false, canRunCode: tools?.access.canRunCode ?? false,
            })
            // The task's clock starts when `AgentDO` takes it, not before the workspace copy. An abort
            // that came while the start was on its way found no task to stop (`abort` gives up after 3
            // tries), so the stop is sent once more now that `AgentDO` has it.
            const markStarted = (startedAt: number) => {
                const run = this.#store.get<ClaudeRun>(RUN_KEY)
                if (run?.task?.taskId === taskId) this.#store.put<ClaudeRun>(RUN_KEY, { ...run, task: { ...run.task, startedAt } })
                if (run?.abortReason) {
                    log('agent task stop requested', { runId, taskId, afterStart: true })
                    agentService.stopTask(agentName, taskId).catch((error) => log('agent task stop failed', { runId, taskId, error: String(error) }))
                }
            }
            let report = await startAndFollowTask(agentService, agentName, task, this.#polling, markStarted)
            // A resume that never reached a turn: the session is gone (a lost container with no saved
            // transcript). The request is still answerable, so it runs again as a new session.
            if (sessionId && report.outcome === 'failed' && report.turns === undefined) {
                log('agent session lost', { runId, taskId, error: report.error?.slice(0, 300) })
                this.#store.delete(SESSION_KEY)
                sessionId = undefined
                const stoppedMeanwhile = abortedReport()
                if (stoppedMeanwhile) return stoppedMeanwhile
                report = await startAndFollowTask(agentService, agentName, { ...task, prompt, resumeSessionId: undefined }, this.#polling, markStarted)
            }
            log(report.outcome === 'answered' ? 'agent task done' : report.outcome === 'stopped' ? 'agent task stopped' : 'agent task failed', {
                runId, taskId, outcome: report.outcome, turns: report.turns, costUsd: this.#taskCostUsd(report), sessionCostUsd: report.sessionCostUsd, taskMs: report.taskMs,
                containerWaitMs: report.containerWaitMs, toolCalls: report.toolCalls.length + report.toolCallsCut,
                deniedToolCalls: report.deniedToolCalls, error: report.error?.slice(0, 500),
            })
            return report
        } catch (error) {
            log('agent task failed', { runId, taskId, error: String(error) })
            return failedReport(taskId, String(error))
        }
    }

    /**
     * A task's own list-price cost: its session's total less the total after the session's task
     * before. A total below that (a session restored from an older transcript) counts whole.
     */
    #taskCostUsd(report: AgentTaskReport): number {
        const sessionCostUsd = report.sessionCostUsd ?? 0
        const before = this.#store.get<SessionCost>(SESSION_COST_KEY)
        const earlierUsd = before && before.sessionId === report.sessionId ? before.totalUsd : 0
        return sessionCostUsd >= earlierUsd ? sessionCostUsd - earlierUsd : sessionCostUsd
    }

    /** Keeps a task's usage for the footnote, and its session and the session's cost for the next task. */
    #recordTask(index: number, report: AgentTaskReport): void {
        const costUsd = this.#taskCostUsd(report)
        if (report.sessionId) this.#store.put<string>(SESSION_KEY, report.sessionId)
        if (report.sessionId && report.sessionCostUsd !== undefined) {
            this.#store.put<SessionCost>(SESSION_COST_KEY, { sessionId: report.sessionId, totalUsd: report.sessionCostUsd })
        }
        const toolNames = report.toolCalls.map((call) => call.name)
        this.#store.put<TaskUsage>(taskUsageKey(index), {
            turns: report.turns ?? 0,
            toolCalls: report.toolCalls.length + report.toolCallsCut,
            webSearches: toolNames.filter((name) => isToolNamed(name, 'web_search', 'WebSearch')).length,
            webFetches: toolNames.filter((name) => isToolNamed(name, 'web_fetch', 'WebFetch')).length,
            tokensIn: report.tokens?.input ?? 0,
            cachedTokensIn: report.tokens?.cachedInput ?? 0,
            tokensOut: report.tokens?.output ?? 0,
            peakContextTokens: report.tokens?.peakContext ?? 0,
            costUsd,
        })
    }

    /** Settles every request of the run with `result` and forgets the run, in one step. */
    #endRun(run: ClaudeRun, result: RunResult): void {
        this.#store.delete(RUN_KEY)
        this.#settle(run.operationIds, result)
    }

    #settle(operationIds: readonly string[], result: RunResult): void {
        const settledAt = Date.now()
        for (const operationId of operationIds) this.#store.put<OperationRecord>(operationKey(operationId), { result, settledAt })
        for (const operationId of operationIds) {
            for (const resolve of this.#waiters.get(operationId) ?? []) resolve(result)
            this.#waiters.delete(operationId)
        }
    }
}
