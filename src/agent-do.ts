import { DurableObject } from 'cloudflare:workers'
import { log } from './log'
import type { PrChanges } from './pi/agent'
import { readCappedText } from './sandbox-shell'
import { tarStream, type TarEntry } from './sandbox-tar'
import { isSecretPath } from './secret-files'
import { wait } from './wait'

// The thread's Claude Code container (issue #61). `AgentDO` starts it, runs one task at a time as
// one `exec` of the runner (`agent/run.mjs`), and turns the runner's JSON lines into a report.
// It also copies the thread's code into `/workspace`, keeps each task's report, and saves the
// session transcript so a lost container can resume. The subscription token is the env of one
// exec only: never in the image, never logged.

/** A task gets 15 minutes unless the caller asks for less, and never more. */
const DEFAULT_TASK_SECONDS = 15 * 60
const MAX_TASK_SECONDS = 15 * 60
/** Longer than a task, so an idle clock that does not see a running exec still cannot end one. */
const CONTAINER_IDLE_MS = 20 * 60 * 1000
/**
 * A just-started container refuses `exec` for a moment (the spike's first exec after a deploy
 * failed), so the start polls with `true` until one passes, up to this long.
 */
const CONTAINER_READY_WAIT_MS = 90 * 1000
const CONTAINER_READY_POLL_MS = 1000
const READY_CHECK_TIMEOUT_MS = 10 * 1000
/** `timeout` sends TERM at the limit and KILL this much later. */
const KILL_AFTER_SECONDS = 10
/** The exec's abort is the last resort, this long after `timeout`'s KILL. */
const ABORT_GRACE_SECONDS = 20
/** `stopTask` sends TERM; a runner still there after this has its exec aborted. */
const STOP_GRACE_MS = 15 * 1000
/**
 * The task goes to the runner on stdin, not its command line, where Linux takes at most 128 KiB per
 * argument (two long joined comments failed with E2BIG). The cap only bounds a runaway prompt.
 */
const MAX_PROMPT_CHARS = 1000 * 1000
/** Output caps: a longer runner line is dropped whole; the rest are cut to these. */
const MAX_LINE_BYTES = 256 * 1024
const MAX_ANSWER_CHARS = 64 * 1024
const MAX_TOOL_CALLS_KEPT = 200
const STDERR_BYTES = 4 * 1024

const RUNNER_PATH = '/opt/runner/run.mjs'
/** The image's non-root user: Claude Code refuses `bypassPermissions` as root. */
const AGENT_HOME = '/home/agent'
/** The runner's working directory: the thread's code, copied in by `copyWorkspace`. */
const WORKSPACE_DIR = '/workspace'
/**
 * Names the code `/workspace` holds, inside the container, so a new container (which has no file)
 * never passes for one that holds the thread's code.
 */
const WORKSPACE_KEY_FILE = `${AGENT_HOME}/.bobby-workspace-key`
const COPY_TIMEOUT_SECONDS = 5 * 60
/** A workspace key of a work branch copy is this prefix and the branch (`WorkspaceCopy.key`). */
const WORK_BRANCH_KEY_PREFIX = 'branch:'
/** The local git branch of a repo copy, which has no work branch yet. */
const REPO_COPY_BRANCH = 'workspace'
/** The newest reports are kept, so a caller that lost its wait can still read how a task ended. */
const REPORTS_KEPT = 20
const REPORT_KEY_PREFIX = 'report:'
const REPORT_TASK_IDS_KEY = 'reportTaskIds'
/**
 * The running task's id, in storage as well as in `#running`: a restarted object has lost
 * `#running`, but its container may still run that task's runner, which must be stopped.
 */
const RUNNING_TASK_KEY = 'runningTaskId'
/** How long an orphan runner gets to exit after TERM before it is sent KILL. */
const ORPHAN_STOP_WAIT_MS = 10 * 1000
const ORPHAN_POLL_MS = 500
/** The session the saved transcript belongs to. */
const TRANSCRIPT_SESSION_KEY = 'transcriptSessionId'
/** A saved transcript is cut into rows this big; a row may hold 2 MB. */
const TRANSCRIPT_CHUNK_BYTES = 1024 * 1024
/**
 * The saved transcript's limit, gzipped. Saving holds it in this object's memory up to three times
 * (the chunks read, one joined copy, the rows), so 8 MiB keeps the peak near 24 MiB of the 128 MiB
 * a Durable Object has.
 * A bigger one is not saved and the older copy is deleted: the session goes on in this container,
 * and a lost container starts a new session.
 */
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024
const TRANSCRIPT_TIMEOUT_SECONDS = 2 * 60
/** A session id goes into a `find -name`, so it may hold only these characters. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9-]{1,100}$/

/** One Claude Code task. `taskId` names this task; `runId` is the Benny run it serves. */
export type AgentTask = {
    prompt: string
    /** Appended to Claude Code's system prompt after the runner's own rules. */
    instructions?: string
    /** The `sessionId` of an earlier task in this container, to continue its conversation. */
    resumeSessionId?: string
    taskId: string
    runId: string
    /** Benny's MCP route; the runner sends `mcpToken` as its bearer. Both absent: a task with no Benny tools. */
    mcpUrl?: string
    mcpToken?: string
    /** Default and maximum 15 minutes. */
    timeoutSeconds?: number
}

/**
 * A task's tokens. `input` counts every turn's whole context (cached included); `cachedInput` is
 * the part read from the cache; `peakContext` is the largest one turn sent.
 */
export type AgentTaskTokens = { input: number; cachedInput: number; output: number; peakContext: number }

/** One tool call the model made; `input` is cut to 300 characters by the runner. */
export type AgentToolCall = { name: string; input: string }

/** `timedOut`: the time limit ended it. `stopped`: `stopTask` or `destroyContainer` did. */
export type AgentTaskOutcome = 'answered' | 'failed' | 'stopped' | 'timedOut'

export type AgentTaskReport = {
    taskId: string
    outcome: AgentTaskOutcome
    answer: string | undefined
    /** Pass as `resumeSessionId` to continue; set from the first event, so a stopped task has one. */
    sessionId: string | undefined
    turns: number | undefined
    /**
     * List-price cost of the whole session so far, from the SDK's result event (`total_cost_usd`): a
     * resumed session continues from the total its transcript saved, so one task's cost is the
     * difference from the task before (`ClaudeCodeRun`). The subscription is not charged by it.
     */
    sessionCostUsd: number | undefined
    /** The SDK's result subtype: `success`, `error_max_turns`, `error_during_execution`, ... */
    resultSubtype: string | undefined
    /** Tokens of this task's model calls, added up by the runner; `undefined` when it sent none. */
    tokens: AgentTaskTokens | undefined
    toolCalls: AgentToolCall[]
    /** Tool calls the runner's deny rules refused, from the result event. */
    deniedToolCalls: number | undefined
    /** Tool calls past the first 200, counted and not kept. */
    toolCallsCut: number
    /** Each MCP server and whether it connected, from the session's first event. */
    mcpServers: { name: string; status: string }[]
    /** The runner's exit code under `timeout`: 124 or 137 means the limit; -1 means no exit code. */
    exitCode: number
    /** Time spent starting the container; 0 when it was already up. */
    containerWaitMs: number
    /** Time from the runner's start to its end. */
    taskMs: number
    /** The runner's or the exec's error, when there is one. */
    error: string | undefined
    /** The runner's stderr, capped at 4 KiB. */
    stderr: string
}

/** One line the runner prints. */
type RunnerEvent =
    | { type: 'session'; sessionId: string; mcpServers: { name: string; status: string }[] }
    | { type: 'tool'; name: string; input: string }
    | {
        type: 'result'; answer?: string; isError: boolean; subtype: string; turns: number; sessionCostUsd: number; sessionId: string; deniedToolCalls: number
        tokens?: AgentTaskTokens
    }
    | { type: 'error' | 'stopped'; error: string }

type RunningTask = { taskId: string; runId: string; stopRequested: boolean; execAbort: AbortController }

/** How a task stands, for a caller that lost its wait: still running, ended with a report, or unknown here. */
export type AgentTaskState = { state: 'running' } | { state: 'done'; report: AgentTaskReport } | { state: 'unknown' }

/**
 * The code a task works on. `key` names it (`branch:<name>`, or `repo:<name>` plus the PR head);
 * `archive` is the work branch copy or the repo copy as ustar (`BranchDO.archive()`,
 * `RepoDO.archive()`); `prChanges` goes on top of a repo copy, as in the sandbox.
 */
export type WorkspaceCopy = { key: string; archive: ReadableStream<Uint8Array>; prChanges: PrChanges | null; runId: string }

/** What `runInContainer` read. */
type ContainerCommandResult = { exitCode: number; stdout: Uint8Array; stdoutCut: boolean; stderr: string }

/** A repo-relative path with no way out of `/workspace`. */
const isRepoRelativePath = (path: string) => path !== '' && !path.startsWith('/') && !path.split('/').includes('..')

/**
 * Runs one command (no shell unless it names one) under `timeout`, with `stdin` as its input.
 * Keeps up to `stdoutCap` bytes of stdout (more is read and dropped, and `stdoutCut` says so) and
 * 4 KiB of stderr.
 */
const runInContainer = async (
    container: Container,
    command: string[],
    { stdin, timeoutSeconds, stdoutCap = 0, cwd = AGENT_HOME }: { stdin?: ReadableStream; timeoutSeconds: number; stdoutCap?: number; cwd?: string },
): Promise<ContainerCommandResult> => {
    const abort = new AbortController()
    const execProcess = await container.exec(['timeout', `--kill-after=${KILL_AFTER_SECONDS}`, String(timeoutSeconds), ...command], {
        cwd, stdin, stdout: 'pipe', stderr: 'pipe', signal: abort.signal,
    })
    let exited = false
    const exitCode = execProcess.exitCode.finally(() => {
        exited = true
    })
    // The last resort after `timeout`; it must not fire after the exit, which logs a runtime error.
    const abortTimer = setTimeout(() => {
        if (!exited) abort.abort()
    }, (timeoutSeconds + KILL_AFTER_SECONDS + ABORT_GRACE_SECONDS) * 1000)
    const readStdout = async () => {
        const chunks: Uint8Array[] = []
        let keptBytes = 0
        let cut = false
        if (execProcess.stdout) {
            for await (const chunk of execProcess.stdout as ReadableStream<Uint8Array>) {
                if (keptBytes + chunk.length > stdoutCap) cut = true
                else {
                    chunks.push(chunk)
                    keptBytes += chunk.length
                }
            }
        }
        const bytes = new Uint8Array(keptBytes)
        let offset = 0
        for (const chunk of chunks) {
            bytes.set(chunk, offset)
            offset += chunk.length
        }
        return { bytes, cut }
    }
    try {
        const [code, stdout, stderr] = await Promise.all([exitCode, readStdout(), readCappedText(execProcess.stderr, STDERR_BYTES)])
        return { exitCode: code, stdout: stdout.bytes, stdoutCut: stdout.cut, stderr: stderr.text }
    } finally {
        clearTimeout(abortTimer)
    }
}

/** Throws with the command's stderr when it did not exit 0. */
const requireSuccess = (result: ContainerCommandResult, what: string) => {
    if (result.exitCode !== 0) throw new Error(`${what} failed (exit ${result.exitCode}): ${result.stderr.trim().slice(0, 500)}`)
}

/** One byte stream from stored chunks, for `tar` to read. */
const streamOf = (chunks: Uint8Array[]): ReadableStream<Uint8Array> => new ReadableStream({
    start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk)
        controller.close()
    },
})

/** What `AgentDO` reads from its Worker's env. */
export type AgentEnv = { CLAUDE_CODE_OAUTH_TOKEN: string }

/**
 * Reads `stream` line by line and hands each JSON line to `onEvent`. A line over `MAX_LINE_BYTES`
 * or one that is not JSON is skipped and counted, so a runner that prints too much costs nothing.
 */
const readRunnerEvents = async (stream: ReadableStream<Uint8Array> | null, onEvent: (event: RunnerEvent) => void): Promise<number> => {
    if (!stream) return 0
    const decoder = new TextDecoder()
    let pending = ''
    let skippingLongLine = false
    let skippedLines = 0
    const takeLine = (line: string) => {
        if (!line.trim()) return
        try {
            onEvent(JSON.parse(line) as RunnerEvent)
        } catch {
            skippedLines++
        }
    }
    for await (const chunk of stream) {
        pending += decoder.decode(chunk, { stream: true })
        let newline = pending.indexOf('\n')
        while (newline !== -1) {
            if (skippingLongLine) skippingLongLine = false
            else takeLine(pending.slice(0, newline))
            pending = pending.slice(newline + 1)
            newline = pending.indexOf('\n')
        }
        if (pending.length > MAX_LINE_BYTES) {
            if (!skippingLongLine) skippedLines++
            skippingLongLine = true
            pending = ''
        }
    }
    if (!skippingLongLine) takeLine(pending + decoder.decode())
    return skippedLines
}

// One object per thread, named by a 64-hex id like `SandboxDO`. Every public method is an RPC
// endpoint; internals use `#`. It reads only `CLAUDE_CODE_OAUTH_TOKEN` from its Worker's env.
export class AgentDO extends DurableObject<AgentEnv> {
    /** The task in flight; one at a time. */
    #running: RunningTask | undefined
    /** The container start in flight, so a second caller waits on it instead of starting again. */
    #starting: Promise<number> | undefined

    /**
     * Starts one task and returns at once; the caller asks `taskReport` until it is `done`. No RPC
     * lasts the task: a call held open for minutes dropped (issue #73, `Peer closed WebSocket: 1006`
     * after about 2 minutes on a dev service binding). Throws only when a task is already running or
     * the input is bad; everything that goes wrong inside the task ends in a `failed` report.
     */
    async startTask(task: AgentTask): Promise<void> {
        if (this.#running) throw new Error(`Task ${this.#running.taskId} is still running: one task at a time`)
        if (task.prompt.length > MAX_PROMPT_CHARS) throw new Error(`The prompt is over ${MAX_PROMPT_CHARS} characters`)
        // A task this object did not start (it restarted since): its runner may still be going, and
        // two runners would write one session file.
        await this.#stopOrphanTask(task.runId)
        if (this.#running) throw new Error(`Task ${(this.#running as RunningTask).taskId} is still running: one task at a time`)
        const running: RunningTask = { taskId: task.taskId, runId: task.runId, stopRequested: false, execAbort: new AbortController() }
        // Set before returning, so the caller's first `taskReport` already finds the task running.
        this.#running = running
        this.ctx.storage.kv.put(RUNNING_TASK_KEY, task.taskId)
        // Not awaited. The caller's polls are requests to this object, which also keep it from being
        // evicted while the task runs.
        void this.#runTask(task, running).catch((taskError) => {
            log('agent task report lost', { runId: task.runId, taskId: task.taskId, error: String(taskError) })
        })
    }

    /**
     * Runs one task to its end and keeps its report. Starts the container first if it is down, and
     * waits until it takes commands.
     */
    async #runTask(task: AgentTask, running: RunningTask): Promise<void> {
        const timeoutSeconds = Math.min(Math.max(1, Math.floor(task.timeoutSeconds ?? DEFAULT_TASK_SECONDS)), MAX_TASK_SECONDS)
        const { taskId, runId } = task

        let sessionId: string | undefined
        let mcpServers: { name: string; status: string }[] = []
        const toolCalls: AgentToolCall[] = []
        let toolCallsCut = 0
        let result: Extract<RunnerEvent, { type: 'result' }> | undefined
        let error: string | undefined
        let exitCode = -1
        let stderr = ''
        let containerWaitMs = 0
        let execStartedAt = Date.now()
        try {
            containerWaitMs = await this.#startContainer(runId)
            const container = this.ctx.container!
            log('agent task started', { runId, taskId, timeoutSeconds, resumed: task.resumeSessionId !== undefined, containerWaitMs })
            if (running.stopRequested) throw new Error('Stopped before the runner started')
            if (task.resumeSessionId) {
                // A failed restore only costs the resume: the runner then reports it, and the caller starts a new session.
                await this.#restoreTranscript(container, task.resumeSessionId, runId).catch((restoreError) => {
                    log('agent transcript restore failed', { runId, taskId, error: String(restoreError) })
                })
            }

            execStartedAt = Date.now()
            const runnerInput = JSON.stringify({
                prompt: task.prompt, instructions: task.instructions, resumeSessionId: task.resumeSessionId, mcpUrl: task.mcpUrl,
            })
            const execProcess = await container.exec(
                ['timeout', `--kill-after=${KILL_AFTER_SECONDS}`, String(timeoutSeconds), 'node', RUNNER_PATH],
                {
                    cwd: '/opt/runner',
                    stdin: streamOf([new TextEncoder().encode(runnerInput)]),
                    // The only place the subscription token goes: this one process's env.
                    env: { HOME: AGENT_HOME, CLAUDE_CODE_OAUTH_TOKEN: this.env.CLAUDE_CODE_OAUTH_TOKEN, ...(task.mcpToken ? { MCP_TOKEN: task.mcpToken } : {}) },
                    stdout: 'pipe',
                    stderr: 'pipe',
                    signal: running.execAbort.signal,
                },
            )
            let exited = false
            const exitCodePromise = execProcess.exitCode.finally(() => {
                exited = true
            })
            // `timeout` ends the runner; this abort is the last resort, and must not fire after the
            // exit, which logs a runtime error.
            const abortTimer = setTimeout(() => {
                if (!exited) running.execAbort.abort()
            }, (timeoutSeconds + KILL_AFTER_SECONDS + ABORT_GRACE_SECONDS) * 1000)
            try {
                const [code, skippedLines, cappedStderr] = await Promise.all([
                    exitCodePromise.catch((exitError: unknown) => {
                        error ??= `The runner's exec ended without an exit code: ${String(exitError)}`
                        return -1
                    }),
                    readRunnerEvents(execProcess.stdout, (event) => {
                        if (event.type === 'session') {
                            sessionId = event.sessionId
                            mcpServers = event.mcpServers ?? []
                        } else if (event.type === 'tool') {
                            log('agent tool call', { runId, taskId, tool: event.name })
                            if (toolCalls.length < MAX_TOOL_CALLS_KEPT) toolCalls.push({ name: event.name, input: event.input })
                            else toolCallsCut++
                        } else if (event.type === 'result') {
                            result = event
                            sessionId = event.sessionId
                        } else {
                            error = event.error
                        }
                    }).catch(() => 0),
                    readCappedText(execProcess.stderr, STDERR_BYTES).catch(() => ({ text: '', truncated: false })),
                ])
                exitCode = code
                stderr = cappedStderr.text
                if (skippedLines > 0) log('agent runner lines skipped', { runId, taskId, skippedLines })
            } finally {
                clearTimeout(abortTimer)
            }
            // Saved whatever the outcome: a stopped task's session is still the thread's conversation.
            if (sessionId && container.running) {
                await this.#saveTranscript(container, sessionId, runId).catch((saveError) => {
                    log('agent transcript save failed', { runId, taskId, error: String(saveError) })
                })
            }
        } catch (taskError) {
            error = String(taskError)
        } finally {
            this.#running = undefined
            if (this.ctx.storage.kv.get<string>(RUNNING_TASK_KEY) === taskId) this.ctx.storage.kv.delete(RUNNING_TASK_KEY)
        }

        const timedOut = !running.stopRequested && (exitCode === 124 || exitCode === 137 || running.execAbort.signal.aborted)
        const outcome: AgentTaskOutcome = running.stopRequested
            ? 'stopped'
            : timedOut
              ? 'timedOut'
              : result && !result.isError && exitCode === 0
                ? 'answered'
                : 'failed'
        const report: AgentTaskReport = {
            taskId,
            outcome,
            answer: result?.answer?.slice(0, MAX_ANSWER_CHARS),
            sessionId,
            turns: result?.turns,
            sessionCostUsd: result?.sessionCostUsd,
            resultSubtype: result?.subtype,
            tokens: result?.tokens,
            toolCalls,
            deniedToolCalls: result?.deniedToolCalls,
            toolCallsCut,
            mcpServers,
            exitCode,
            containerWaitMs,
            taskMs: Date.now() - execStartedAt,
            error: error ?? (result?.isError ? `The SDK ended with ${result.subtype}` : undefined),
            stderr,
        }
        log('agent task finished', {
            runId,
            taskId,
            outcome,
            exitCode,
            turns: report.turns,
            sessionCostUsd: report.sessionCostUsd,
            toolCalls: toolCalls.length + toolCallsCut,
            taskMs: report.taskMs,
            containerWaitMs,
            error: report.error?.slice(0, 500),
        })
        this.#keepReport(report)
    }

    /** How the task `taskId` stands: what a caller polls after `startTask`, or after it lost its wait (an evicted `PiAgent`). */
    async taskReport(taskId: string): Promise<AgentTaskState> {
        if (this.#running?.taskId === taskId) return { state: 'running' }
        const report = this.ctx.storage.kv.get<AgentTaskReport>(`${REPORT_KEY_PREFIX}${taskId}`)
        if (report) return { state: 'done', report }
        // Unknown here, so nobody reads its runner: stop it before the caller gives the task up.
        await this.#stopOrphanTask(undefined)
        return { state: 'unknown' }
    }

    /**
     * Stops the task storage says is running when this object did not start it (`#running` is
     * empty): the object restarted, so nothing reads its runner and no report will come. TERM to the
     * runner, KILL after `ORPHAN_STOP_WAIT_MS`, then the mark goes. Answers the orphan's id, if any.
     */
    async #stopOrphanTask(runId: string | undefined): Promise<string | undefined> {
        const orphanTaskId = this.ctx.storage.kv.get<string>(RUNNING_TASK_KEY)
        if (!orphanTaskId || this.#running) return undefined
        const container = this.ctx.container
        if (container?.running && !this.#starting) {
            const signal = (name: string) => runInContainer(container, ['pkill', `-${name}`, '-f', RUNNER_PATH], { timeoutSeconds: 10 }).catch(() => undefined)
            await signal('TERM')
            const stopBy = Date.now() + ORPHAN_STOP_WAIT_MS
            for (;;) {
                const left = await runInContainer(container, ['pgrep', '-f', RUNNER_PATH], { timeoutSeconds: 10 }).catch(() => undefined)
                // `pgrep` exits 1 when no process matches.
                if (left?.exitCode === 1) break
                if (Date.now() > stopBy) {
                    await signal('KILL')
                    break
                }
                await wait(ORPHAN_POLL_MS)
            }
        }
        // Read again: a `startTask` may have begun while this one waited.
        if (this.ctx.storage.kv.get<string>(RUNNING_TASK_KEY) === orphanTaskId && !this.#running) this.ctx.storage.kv.delete(RUNNING_TASK_KEY)
        log('agent orphan task stopped', { runId, taskId: orphanTaskId, containerRunning: container?.running ?? false })
        return orphanTaskId
    }

    /** Stores a report and drops the oldest past `REPORTS_KEPT`. */
    #keepReport(report: AgentTaskReport): void {
        const taskIds = [...(this.ctx.storage.kv.get<string[]>(REPORT_TASK_IDS_KEY) ?? []), report.taskId]
        for (const oldTaskId of taskIds.splice(0, Math.max(0, taskIds.length - REPORTS_KEPT))) {
            this.ctx.storage.kv.delete(`${REPORT_KEY_PREFIX}${oldTaskId}`)
        }
        this.ctx.storage.kv.put(`${REPORT_KEY_PREFIX}${report.taskId}`, report)
        this.ctx.storage.kv.put(REPORT_TASK_IDS_KEY, taskIds)
    }

    /** The key of the code `/workspace` holds, or `undefined` when the container is down or holds none. */
    async workspaceKey(): Promise<string | undefined> {
        const container = this.ctx.container
        if (!container?.running || this.#starting) return undefined
        const result = await runInContainer(container, ['cat', WORKSPACE_KEY_FILE], { timeoutSeconds: 10, stdoutCap: 4096 })
        return result.exitCode === 0 ? new TextDecoder().decode(result.stdout) : undefined
    }

    /**
     * Replaces `/workspace` with `copy`: the archive, then on a repo copy the PR's removals and
     * files, then a baseline git commit so the model's `git status` shows only its own changes.
     * Starts the container if it is down. Refused while a task runs, which the copy would wipe.
     */
    async copyWorkspace({ key, archive, prChanges, runId }: WorkspaceCopy): Promise<void> {
        if (this.#running) {
            await archive.cancel().catch(() => {})
            throw new Error(`Task ${this.#running.taskId} is running: the workspace is copied between tasks`)
        }
        const startedAt = Date.now()
        await this.#startContainer(runId)
        const container = this.ctx.container!
        // The key goes first, so a copy that fails halfway never passes for a whole one.
        requireSuccess(await runInContainer(container, ['sh', '-c', `rm -f ${WORKSPACE_KEY_FILE} && find ${WORKSPACE_DIR} -mindepth 1 -delete`], {
            timeoutSeconds: COPY_TIMEOUT_SECONDS,
        }), 'Clearing /workspace')
        requireSuccess(await runInContainer(container, ['tar', '-xf', '-', '-C', WORKSPACE_DIR], {
            stdin: archive, timeoutSeconds: COPY_TIMEOUT_SECONDS,
        }), 'Copying the code')
        const removedPaths = (prChanges?.removedPaths ?? []).filter(isRepoRelativePath)
        if (removedPaths.length > 0) {
            requireSuccess(await runInContainer(container, ['rm', '-rf', '--', ...removedPaths], {
                cwd: WORKSPACE_DIR, timeoutSeconds: COPY_TIMEOUT_SECONDS,
            }), "Removing the PR's deleted files")
        }
        const prFiles = (prChanges?.files ?? []).filter((file) => isRepoRelativePath(file.path) && !isSecretPath(`/repo/${file.path}`))
        if (prFiles.length > 0) {
            const mtime = Math.floor(Date.now() / 1000)
            const entries = async function* (): AsyncGenerator<TarEntry> {
                for (const file of prFiles) {
                    const bytes = new TextEncoder().encode(file.content)
                    yield { path: file.path, type: 'file', mtime, size: bytes.length, read: async () => streamOf([bytes]) }
                }
            }
            requireSuccess(await runInContainer(container, ['tar', '-xf', '-', '-C', WORKSPACE_DIR], {
                stdin: tarStream(entries(), () => {}, { runId }), timeoutSeconds: COPY_TIMEOUT_SECONDS,
            }), "Copying the PR's files")
        }
        // The local branch is named after the work branch, or `workspace` for a repo copy: git's
        // default (`master`) showed up in a reply as if it were a branch on GitHub.
        const localBranch = key.startsWith(WORK_BRANCH_KEY_PREFIX) ? key.slice(WORK_BRANCH_KEY_PREFIX.length) : REPO_COPY_BRANCH
        requireSuccess(await runInContainer(container, ['sh', '-c',
            'git init -q -b "$1" && git add -A && git -c user.name=bobby -c user.email=bobby@localhost commit -q --allow-empty -m "Benny: the copy this task started from"',
            'sh', localBranch,
        ], { cwd: WORKSPACE_DIR, timeoutSeconds: COPY_TIMEOUT_SECONDS }), 'The baseline commit')
        requireSuccess(await runInContainer(container, ['sh', '-c', 'printf %s "$1" > "$2"', 'sh', key, WORKSPACE_KEY_FILE], {
            timeoutSeconds: 10,
        }), 'Writing the workspace key')
        log('agent workspace copied', { runId, key, prFiles: prFiles.length, removedPaths: removedPaths.length, ms: Date.now() - startedAt })
    }

    /**
     * Saves the session's transcript (Claude Code's `~/.claude/projects/.../<session>.jsonl` and its
     * folder) as one gzip tar in rows, replacing the one before: a thread has one conversation.
     */
    async #saveTranscript(container: Container, sessionId: string, runId: string): Promise<void> {
        if (!SESSION_ID_PATTERN.test(sessionId)) return
        const result = await runInContainer(container, ['sh', '-c',
            'cd "$2" && find .claude/projects -name "$1*" -print0 2>/dev/null | tar -czf - --null -T -', 'sh', sessionId, AGENT_HOME,
        ], { timeoutSeconds: TRANSCRIPT_TIMEOUT_SECONDS, stdoutCap: MAX_TRANSCRIPT_BYTES })
        const { sql } = this.ctx.storage
        if (result.exitCode !== 0 || result.stdoutCut || result.stdout.length === 0) {
            log('agent transcript not saved', { runId, exitCode: result.exitCode, tooBig: result.stdoutCut, maxBytes: MAX_TRANSCRIPT_BYTES, stderr: result.stderr.slice(0, 300) })
            if (result.stdoutCut) {
                // An older copy of a session that has grown would resume it from the past.
                this.ctx.storage.transactionSync(() => {
                    sql.exec('CREATE TABLE IF NOT EXISTS transcript_chunks (chunk INTEGER PRIMARY KEY, data BLOB NOT NULL)')
                    sql.exec('DELETE FROM transcript_chunks')
                    this.ctx.storage.kv.delete(TRANSCRIPT_SESSION_KEY)
                })
            }
            return
        }
        this.ctx.storage.transactionSync(() => {
            sql.exec('CREATE TABLE IF NOT EXISTS transcript_chunks (chunk INTEGER PRIMARY KEY, data BLOB NOT NULL)')
            sql.exec('DELETE FROM transcript_chunks')
            for (let offset = 0, chunk = 0; offset < result.stdout.length; offset += TRANSCRIPT_CHUNK_BYTES, chunk++) {
                sql.exec('INSERT INTO transcript_chunks (chunk, data) VALUES (?, ?)', chunk, result.stdout.slice(offset, offset + TRANSCRIPT_CHUNK_BYTES).buffer)
            }
            this.ctx.storage.kv.put(TRANSCRIPT_SESSION_KEY, sessionId)
        })
        log('agent transcript saved', { runId, bytes: result.stdout.length })
    }

    /**
     * Puts the saved transcript back when the container lost it (a new container), so `resume`
     * finds the session. Without a saved copy of that session it does nothing: the runner then fails
     * to resume, and the caller starts a new session.
     */
    async #restoreTranscript(container: Container, sessionId: string, runId: string): Promise<void> {
        if (!SESSION_ID_PATTERN.test(sessionId)) return
        const present = await runInContainer(container, ['sh', '-c',
            'find "$2/.claude/projects" -name "$1.jsonl" 2>/dev/null | grep -q .', 'sh', sessionId, AGENT_HOME,
        ], { timeoutSeconds: 30 })
        if (present.exitCode === 0) return
        if (this.ctx.storage.kv.get<string>(TRANSCRIPT_SESSION_KEY) !== sessionId) {
            log('agent transcript missing', { runId })
            return
        }
        const rows = this.ctx.storage.sql.exec<{ data: ArrayBuffer }>('SELECT data FROM transcript_chunks ORDER BY chunk').toArray()
        const chunks = rows.map((row) => new Uint8Array(row.data))
        requireSuccess(await runInContainer(container, ['tar', '-xzf', '-', '-C', AGENT_HOME], {
            stdin: streamOf(chunks), timeoutSeconds: TRANSCRIPT_TIMEOUT_SECONDS,
        }), 'Restoring the transcript')
        log('agent transcript restored', { runId, bytes: chunks.reduce((total, chunk) => total + chunk.length, 0) })
    }

    /**
     * Stops the task `taskId` if it is the one running: TERM to the runner, which aborts the SDK,
     * then the exec's abort if the runner is still there 15 s later. Answers whether it ran.
     */
    async stopTask(taskId: string): Promise<boolean> {
        const running = this.#running
        if (!running) return (await this.#stopOrphanTask(undefined)) === taskId
        if (running.taskId !== taskId) return false
        running.stopRequested = true
        log('agent task stop requested', { runId: running.runId, taskId })
        setTimeout(() => {
            if (this.#running === running) running.execAbort.abort()
        }, STOP_GRACE_MS)
        // Still starting: `runTask` sees the mark once the container is up and never runs the runner.
        if (this.#starting || !this.ctx.container?.running) return true
        try {
            // `pkill` skips itself; both `timeout` and the runner match, and `timeout` passes TERM on.
            const kill = await this.ctx.container.exec(['pkill', '-TERM', '-f', RUNNER_PATH], {
                signal: AbortSignal.timeout(READY_CHECK_TIMEOUT_MS),
            })
            await kill.exitCode
        } catch (stopError) {
            log('agent task stop failed', { runId: running.runId, taskId, error: String(stopError) })
            running.execAbort.abort()
        }
        return true
    }

    /** Destroys the container, ending any task in it as `stopped`. Answers whether one was running. */
    async destroyContainer(reason: string): Promise<boolean> {
        const container = this.ctx.container
        if (!container?.running) return false
        if (this.#running) this.#running.stopRequested = true
        await container.destroy()
        log('agent container destroyed', { runId: this.#running?.runId, reason })
        return true
    }

    /** Starts the container when it is down and waits until it takes commands. Answers the ms waited. */
    async #startContainer(runId: string): Promise<number> {
        if (this.#starting) return this.#starting
        const container = this.ctx.container
        if (!container) throw new Error('AgentDO has no container: check its export in the Worker config')
        if (container.running) return 0
        this.#starting = (async () => {
            const startedAt = Date.now()
            container.start({ image: container.images.agent, instance: 'standard-2', enableInternet: true })
            // `start()` does not report a failed start; only `monitor()` does. Never awaited: it
            // settles when the container exits.
            container
                .monitor()
                .then(() => log('agent container exited', { runId }))
                .catch((exitError) => log('agent container exited', { runId, error: String(exitError) }))
            await container.setInactivityTimeout(CONTAINER_IDLE_MS)
            let attempts = 0
            let lastError = ''
            for (;;) {
                attempts++
                try {
                    const readyCheck = await container.exec(['true'], { signal: AbortSignal.timeout(READY_CHECK_TIMEOUT_MS) })
                    if ((await readyCheck.exitCode) === 0) break
                    lastError = 'exit code not 0'
                } catch (checkError) {
                    lastError = String(checkError)
                }
                if (Date.now() - startedAt > CONTAINER_READY_WAIT_MS) {
                    log('agent container start failed', { runId, attempts, lastError })
                    await container.destroy().catch(() => {})
                    throw new Error(`The agent container did not take commands within ${CONTAINER_READY_WAIT_MS / 1000} s: ${lastError}`)
                }
                await wait(CONTAINER_READY_POLL_MS)
            }
            const waitMs = Date.now() - startedAt
            log('agent container ready', { runId, waitMs, attempts, lastError: lastError || undefined })
            return waitMs
        })().finally(() => {
            this.#starting = undefined
        })
        return this.#starting
    }
}
