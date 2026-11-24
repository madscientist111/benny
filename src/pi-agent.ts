import { Agent } from "agents";
import { Workspace, getWorkspace, type WorkspaceStub } from "@cloudflare/computer";
import { WorkerShellBackend } from "@cloudflare/computer/backends/worker-shell";
import { createGitClient } from "@cloudflare/computer/git";
import { ConversationBusy, defineExtension, hook, ToolTask, type ToolRegistration } from "@earendil-works/pi-durable";
import { codemodeExtension, scriptSandbox } from './codemode'
import { codemodeLimitHooks, type CodemodeCallKind } from './codemode-limits'
import { createHarness } from './harness'
import type { Harness, RunUsage } from './harness-contract'
import { log, type LogIds } from './log'
import type { AgentWorkspace, ToolTaskAccess } from './claude-code-run'
import { claudeCodeTool, claudeCodeToolBindings } from './claude-code-tool'
import { answerMcpRequest, mcpTools, newTaskToken, servedTools, taskTokenKey, toolAccessFor, TASK_TOKEN_KEY_PREFIX, unknownTaskReply, type McpReply, type McpRequest, type McpTools, type McpTask } from './mcp-tools'
import { Benny } from "./pi-prompts";
import { REPO_DIR } from './checkout'
import { BENNY_GIT_IDENTITY, repoObjectName, type RepoDO } from "./repo-do";
import { sandboxClient } from "./sandbox-client";
import type { SandboxClient } from "./sandbox-contract";
import { sandboxTools } from "./sandbox-tools";
import {
    postStatus,
    reportFailure,
    reportFollowerEnded,
    reportFollowerJoined,
    reportPaused,
    reportReply,
    reportStopped,
    setPaused,
    updateStatus,
} from "./request-reporter";
import { github } from './bot'
import type { BranchDO } from './branch-do'
import { branchTools } from './branch-tools'
import { branchObjectName, lowerRepoName, RUN_WRITE_LIMITS, type BranchCopy, type RunWriteCounts, type RunWriteKind, type ThreadWork } from './github/github-contract'
import { githubTools, WRITE_REFUSED_TEXT, type Octokit } from './github/github-tools'
import { setInputRequired } from './input-required'
import { askReplyWaits } from './jev/classify'
import { createWebTools } from "./web-tools";
import { checkRepoSize } from './repo-size'
import {
    CHECKED_FIRINGS, countCrons, cronTools, deleteCronCopy, FAILING_AFTER, formatFiringTime, MAX_CRONS, nextFirings, PAUSE_AFTER, postInIssue,
    saveCronCopy, withFiring, type CronFiring, type CronInput, type CronRecord, type FiringOutcome,
} from './crons'
import { checkFiringLimit, countsTowardLimit, firingLimitSentence, lastFiringNote, skippedLastFiringNote, withCountedFiring } from './cron-limit'
import { updateScheduledMark } from './github/scheduled-mark'
import { publicRepoTools, type PublicRepo } from './public-repo'
import { workspaceTools } from "./workspace-tools";

// The thread's agent: one `PiAgent` Durable Object per GitHub thread. `bot.ts` hands it a request
// and returns; the agent runs the model with its tools, keeps every unreported request in storage,
// and reports each one to GitHub itself (`request-reporter.ts`), also after a restart. It also
// holds the thread's PR changes.

/**
 * What one request used, for the footnote on each reply (requirement 48): the run's time, and what
 * the harness counted in the messages after the request's `transcriptCountBefore` (`RunUsage`,
 * whose `peakContextTokens` is the size `COMPACT_ABOVE_TOKENS` watches in `harness.ts`).
 * `sandboxStarts` counts the starts the sandbox calls ran, `sandboxInstallMs` the installs of those
 * starts. A call refused for missing write access never reached the sandbox, so it is not counted.
 */
export type RequestUsage = { ms: number } & RunUsage

/**
 * A PR's version of its changed files (requirements 29, 30). `path` is repo-relative
 * (`src/bot.ts`); removed, binary, secret and oversized files are not in `files`. `removedPaths`
 * names the files the PR deletes and the old path of every file it renames, so the sandbox's copy
 * can drop them from the branch it copies first.
 */
export type PrChanges = { headSha: string; files: { path: string; content: string }[]; removedPaths: string[] }

/**
 * A request's PR changes: the files `replacePrChanges` writes, plus the id of the comment that
 * asked, so `pr changes applied` names a request.
 */
type RequestPrChanges = PrChanges & { requestId: string }

/**
 * One request to Benny: where to report, which comment asked (gets the reactions), the prompt, and
 * the code it reads: the default branch commit, plus the PR head on a PR thread (requirement 22).
 */
export type BennyRequest = {
    threadId: string
    requestMessageId: string
    statusId: string
    prompt: string
    commit: string
    prHead: string | null
    /** The asking comment's text: its links are the ones `web_fetch` may read (requirement 52). */
    requestText: string
    /** The asker may push to the repo, so Benny may run their code (requirement 37). */
    hasWriteAccess: boolean
    /** The asking comment mentions Benny. GitHub writes need it on every pending request (batch 5 plan, 4.1). */
    mentionsBenny: boolean
    /** The GitHub App installation the thread's repo is in; `PiAgent` gets its GitHub tokens from it. */
    installationId: number
    /** The asker's login: a read of a repo other than the thread's needs every requester of the run to be a member of it (issue #53). */
    requester: string
    /** Set when a cron's firing is the request: its end is noted on the cron (`docs/crons/plan.md`). */
    cronId?: string
}

/**
 * One request that has no final report yet, kept in storage until it finishes, so a restarted
 * object still reports it. Several requests can share one run.
 */
type PendingRequest = {
    threadId: string
    requestMessageId: string
    statusId: string
    /**
     * The run that answers this request: the `requestId` of the request that started it. Missing on
     * records written before runs had ids, which `pendingRunId` reads as a run of their own.
     */
    runId?: string
    /** The code the request read, for the reply's footnote. Missing on records written before it existed. */
    commit?: string
    prHead?: string | null
    /** When the request's run started; a follower copies its run leader's. */
    startedAt: number
    /** Messages already in the conversation. The reply's footnote (turns, context, tokens sent and out, tool calls) counts only the messages after this number. */
    transcriptCountBefore: number
    /** This request joined a run that was already working: only the run's leader posts the reply. */
    joined?: boolean
    /** A follower's leader, to compare answers: pi may start a new run for a follower that came too late to join. */
    leaderOperationId?: string
    /** The run that answers from what a run that reached its turn limit found. */
    isSummary?: boolean
    /** Why the operation ended unanswered; set just before it is aborted (requirement 33, 35). */
    endReason?: 'paused' | 'stopped'
    /**
     * The asker may push to the repo, so Benny may run their code. Missing on records written before
     * it existed or before it was renamed from `canRunCode`; both count as false, which can only refuse.
     */
    hasWriteAccess?: boolean
    /** The asking comment mentions Benny. Missing on records written before it existed, which count as false. */
    mentionsBenny?: boolean
    /** The asker's login, for the read of another repo. Missing on records written before it existed, which refuse one. */
    requester?: string
    /** The cron whose firing this request is. */
    cronId?: string
    /**
     * The asking comment's text, which the decision model reads beside the reply to tell whether the
     * reply waits for the requester (plan rule 1). Missing on records written before it existed.
     */
    requestText?: string
}

const PENDING_REQUESTS_KEY = 'pendingRequests'
/** The thread repo's GitHub App installation, from the latest request. */
const INSTALLATION_ID_KEY = 'installationId'
/** This object's thread id, from the latest request: the GitHub tools need its repo and number. */
const THREAD_ID_KEY = 'threadId'
/** The thread's work branch and PR (batch 5 plan, 2.3). */
const THREAD_WORK_KEY = 'threadWork'
/** The public repos this thread imported (issue #51), so an eviction keeps the list `public_repos` reads. */
const PUBLIC_REPOS_KEY = 'publicRepos'
/**
 * The work branch's workspace revision the sandbox holds (plan 2.4): set when a start copies the
 * branch, moved on when its edits are written in. Missing while the sandbox holds the default branch.
 */
const SANDBOX_BRANCH_REV_KEY = 'sandboxBranchRev'
/** The run's GitHub writes, by kind (plan 4.4), in `ctx.storage.kv` so an eviction keeps them. */
const RUN_WRITES_KEY = 'githubWritesThisRun'
/** The issue's cron (`crons.ts`); ChatStateDO keeps a copy of it. */
const CRON_KEY = 'cron'
const NO_RUN_WRITES = Object.fromEntries(Object.keys(RUN_WRITE_LIMITS).map((kind) => [kind, 0])) as RunWriteCounts
/**
 * The run's code mode counts, kept in `ctx.storage.kv` so an eviction keeps them: `codemode-limits.ts`
 * caps how many scripts, and how many nested calls from scripts, one run may make.
 */
type CodemodeRunCalls = { scripts: number; nestedCalls: number }
const CODEMODE_RUN_CALLS_KEY = 'codemodeCallsThisRun'
const NO_CODEMODE_CALLS: CodemodeRunCalls = { scripts: 0, nestedCalls: 0 }
/**
 * What the run's tools may do, as `#configureToolAccess` decided for its latest request: a harness
 * outside the Worker reads it when it starts a tool task, and each MCP call checks it again, so a
 * non-writer who joins the run turns writes off for a task already running.
 */
type RunToolAccess = { runId: string; mayWrite: boolean; canRunCode: boolean }
const RUN_TOOL_ACCESS_KEY = 'runToolAccess'
/** How often `checkPendingRequests` edits the status comments and checks the 30-minute limit (requirement 31). */
const CHECK_INTERVAL_SECONDS = 60
/** A run this long pauses and waits for a go-ahead (requirement 33). */
const RUN_LIMIT_MS = 30 * 60 * 1000
/** Asked of a run that used every tool step of its limit, so the reader still gets what it found. */
const SUMMARY_PROMPT = 'You reached the limit of tool steps for this request. Do not call any tools. ' +
    'Reply now with what you found so far, and say what is still left to check.'

/** A pending request's run id; a record written before runs had ids belongs to a run of its own. */
const pendingRunId = (request: PendingRequest): string => request.runId ?? request.requestMessageId

/**
 * The ids a line about this request carries. An `undefined` record adds no keys, so a line about
 * a request that is already reported keeps only its own `operationId`.
 */
const requestLogIds = (request: PendingRequest | undefined): LogIds => ({
    requestId: request?.requestMessageId,
    runId: request && pendingRunId(request),
})

/** Runs one GitHub report. A report that throws is logged and must not stop the request's bookkeeping. */
const reportSafely = async (operationId: string, request: PendingRequest, report: () => Promise<void>) => {
    try {
        await report()
    } catch (error) {
        log('request report failed', { ...requestLogIds(request), operationId, error: String(error) })
    }
}

export class PiAgent extends Agent<Env> {
    // The harness that runs the model for this thread (`harness-contract.ts`), chosen by `HARNESS`.
    #harness: Harness;
    // The sandbox tools: a run that may not run code is not offered them (requirement 37).
    #sandboxTools: readonly ToolRegistration[]
    // The GitHub write tools and the branch tools the model may call, which `#configureToolAccess` hides unless
    // every pending request is a writer's mention.
    #githubWriteTools: readonly ToolRegistration[]
    // The `claude_code` tool when it is on (`claudeCodeToolBindings`): hidden like the sandbox tools.
    #claudeCodeTools: readonly ToolRegistration[] = []
    // The names of `#sandboxTools`, for the footnote's sandbox counts (`Harness.usageSince`).
    #sandboxToolNames: ReadonlySet<string>
    // The RepoDO name from `useRepo`, kept here and in storage for after a restart.
    #repoNameValue: string | undefined
    // Operation ids that have a wait running. Lost on an eviction; `checkPendingRequests` adds them
    // back, because a pending request without an entry here is a request nobody waits for.
    #requestsBeingWaitedOn = new Set<string>()
    // The web tools, and the links this run may read; `start` records the requester's links.
    #webTools: ReturnType<typeof createWebTools>
    // One Octokit per other repo the run named, so the run finds its installation and mints its token
    // once, not once per call. `start` clears it when it starts a run.
    #repoOctokits = new Map<string, Promise<Octokit>>()
    // Whether code mode is on for this object: only the exact `'true'` in `CODEMODE_ENABLED` turns it
    // on. Read here, before the prompt and the extensions take their shape from it.
    #codeModeEnabled = false
    // Benny's tools as an MCP server, for a harness that runs outside the Worker (`mcp-tools.ts`).
    #mcpTools: McpTools
    // The id of the run this object is working on, which every line about the run's work carries;
    // `undefined` means no run is active here. `start` sets it, and while it is set the run holds
    // the web tools' allowed links and web budget: `start` reads and sets it with no `await`
    // between, so of two starts on an idle object only the first one clears the links. After an
    // eviction it is empty, when the pending requests still hold it, so the next request may clear
    // the links of a run still working: that can only refuse a link, never allow one. The same
    // request also resets the run's code mode counts, which can only allow more scripts, up to one
    // more set of caps.
    #runId: string | undefined

    // This thread's own store. It holds ONLY the files a PR changes (at /repo/...), never the whole
    // repo: the whole default branch lives in the shared RepoDO. Empty on issue threads.
    prChanges = new Workspace({
        storage: this.ctx.storage,
        git: createGitClient(),
        defaultGitIdentity: BENNY_GIT_IDENTITY,
        backends: [
            new WorkerShellBackend({
                id: 'shell',
                loader: this.env.LOADER,
                workspace: { binding: 'PI_AGENT', id: this.ctx.id.toString() },
                ctx: this.ctx
            })
        ]
    })

    // The shell's Dynamic Worker calls back through this to reach the files.
    // Think provides this for you; a plain Agent has to add it.
    async __getWorkspaceStub(): Promise<WorkspaceStub> {
        await this.prChanges.ready();
        return this.prChanges.stub();
    }


    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env);

        const created = createHarness(this.env, {
            lifecycle: this.lifecycle,
            isSandboxTool: (toolName) => this.#sandboxToolNames.has(toolName),
            newTaskToken: () => this.#newTaskToken(),
            agentName: this.ctx.id.toString(),
            store: this.ctx.storage.kv,
            workspace: () => this.#agentWorkspace(),
        });
        this.#harness = created.harness;
        const registry = created.registry;

        // A missing binding or any value but `'true'` means off: exactly today's behaviour without a code deploy.
        // The cast: the generated type is the config's own literal (`'false'`), and a deployment may set `'true'`.
        this.#codeModeEnabled = (this.env.CODEMODE_ENABLED as string) === 'true'

        // install benny agent
        registry.install(Benny(this.#codeModeEnabled))
        // The tools read the shared repo copy in RepoDO; `#repoName()` runs on the first call.
        const repoNamespace = this.env.REPO as unknown as DurableObjectNamespace<RepoDO>
        // Every tool line names the run it worked for, so two threads', or two runs', lines differ.
        const currentRunId = () => this.#currentRunId()
        // With code mode on, the 8 read tools are offered to scripts only (`callers: ['tools']`): the
        // model reads through `codemode`, and `#configureToolAccess` cannot offer them again.
        const readToolCallers = this.#codeModeEnabled ? (['tools'] as const) : undefined
        const repoFiles = workspaceTools(getWorkspace(async () => repoNamespace.getByName(await this.#repoName())), { currentRunId, callers: readToolCallers })
        registry.install(repoFiles)
        // Two tool sets, same /repo/... paths, two different stores:
        //   read, ls, find, grep          → the shared RepoDO: the whole default branch.
        //   pr_read, pr_ls, pr_find, pr_grep → this thread's own workspace: only the files the PR
        //                                    changes, written there by `replacePrChanges` (req. 29, 30).
        const prFiles = workspaceTools(this.prChanges, {
            name: 'pr-changes',
            toolPrefix: 'pr_',
            describe: (description) => 'PR version: reads the PR\'s changed files at the same /repo/... paths. ' +
                'Only files the PR changed are here; use the tool without pr_ for every other file. ' + description,
            currentRunId,
            callers: readToolCallers,
        })
        registry.install(prFiles)
        // Commands run in this thread's own sandbox, one per thread. The container starts on the
        // first command of a run and stops when the run's last request is reported.
        const sandboxExtension = sandboxTools({
            sandbox: () => this.#sandbox(),
            // The start copies the repo the run reads: this thread's RepoDO archive, its line named
            // by the run `#currentRunId()` reports. No request id is in scope here, so there is no
            // fallback: an id it cannot find leaves the line without one.
            // With a work branch the sandbox runs the branch (batch 5 plan, 2.4), and remembers which
            // revision it copied, so later edits can be written in without a new copy.
            archive: async () => {
                const runId = await this.#currentRunId()
                const work = this.ctx.storage.kv.get<ThreadWork>(THREAD_WORK_KEY)
                if (!work) {
                    this.ctx.storage.kv.delete(SANDBOX_BRANCH_REV_KEY)
                    return repoNamespace.getByName(await this.#repoName()).archive({ runId })
                }
                const { archive, rev } = await (await this.#branchCopy(work.branch)).archive({ runId })
                this.ctx.storage.kv.put<number>(SANDBOX_BRANCH_REV_KEY, rev)
                return archive
            },
            beforeCommand: (client) => this.#writeBranchEditsToSandbox(client),
            // Every pending request of the run must come from a writer: a non-writer whose comment
            // joins a writer's run turns command running off for that run (requirement 37).
            canRunCode: () => this.#everyRequestFromWriter(),
            currentRunId,
        })
        registry.install(sandboxExtension)
        // Keep the tools `#configureToolAccess` may hide.
        this.#sandboxTools = sandboxExtension.tools ?? []
        this.#sandboxToolNames = new Set(this.#sandboxTools.map((tool) => tool.name))
        // Claude Code as a tool of pi (issue #61, T7), in the thread's agent container: off unless
        // `CLAUDE_CODE_TOOL_ENABLED` is `'true'` and `AGENT_SERVICE` is bound. Same gate as the sandbox.
        const claudeCodeBindings = claudeCodeToolBindings(this.env)
        if (claudeCodeBindings) {
            const claudeCodeExtension = claudeCodeTool({
                ...claudeCodeBindings,
                agentName: this.ctx.id.toString(),
                store: this.ctx.storage.kv,
                newTaskToken: (writeTools) => this.#newTaskToken(writeTools),
                workspace: () => this.#agentWorkspace(),
                canRunCode: () => this.#everyRequestFromWriter(),
                currentRunId,
            })
            registry.install(claudeCodeExtension)
            this.#claudeCodeTools = claudeCodeExtension.tools ?? []
        }
        // The web tools keep the links this run may read (requirement 52). Exa runs the lookups in
        // the Worker, so the model sees results and never the API key.
        this.#webTools = createWebTools({
            apiKey: this.env.EXA_API_KEY,
            secrets: [this.env.EXA_API_KEY, this.env.OPENCODE_API_KEY, this.env.GITHUB_PRIVATE_KEY, this.env.GITHUB_WEBHOOK_SECRET, this.env.OPENROUTER_KEY]
                .filter((secret): secret is string => Boolean(secret)),
            currentRunId,
        })
        registry.install(this.#webTools.extension)
        // Reading a public repo the requester linked (issue #51): one read-only copy in its own
        // RepoDO, fetched with no token, and only for a link the run saw.
        const publicRepo = publicRepoTools({
            repoObjects: () => this.env.REPO as unknown as DurableObjectNamespace<RepoDO>,
            linkSource: this.#webTools.linkSource,
            openRepos: () => this.ctx.storage.kv.get<PublicRepo[]>(PUBLIC_REPOS_KEY) ?? [],
            saveOpenRepos: (repos) => this.ctx.storage.kv.put<PublicRepo[]>(PUBLIC_REPOS_KEY, repos),
            currentRunId,
            callers: readToolCallers,
        })
        registry.install(publicRepo.list)
        registry.install(publicRepo.files)
        // The GitHub tools (batch 5): reads for every member, writes only for a writer's mention.
        const github_ = githubTools({
            octokit: () => this.#octokit(),
            octokitForRepo: (owner, repo) => this.#octokitForRepo(owner, repo),
            requesters: () => this.#requesters(),
            thread: async () => this.#thread(),
            runMayWrite: () => this.#runMayWrite(),
            countRunWrite: (kind) => this.#countRunWrite(kind),
            threadWork: async () => this.ctx.storage.kv.get<ThreadWork>(THREAD_WORK_KEY) ?? null,
            saveThreadWork: async (work) => this.ctx.storage.kv.put<ThreadWork>(THREAD_WORK_KEY, work),
            callStore: this.ctx.storage.kv,
            codeModeEnabled: this.#codeModeEnabled,
            currentRunId,
            markPrReady: async (number) => this.#markWaiting(number, (await currentRunId()) ?? 'unknown', 'pr ready'),
        })
        registry.install(github_.read)
        registry.install(github_.write)
        // The branch tools, and file tools over the work branch's copy at the same /repo paths.
        const branch_ = branchTools({
            octokit: () => this.#octokit(),
            thread: async () => this.#thread(),
            threadWork: async () => this.ctx.storage.kv.get<ThreadWork>(THREAD_WORK_KEY) ?? null,
            saveThreadWork: async (work) => this.ctx.storage.kv.put<ThreadWork>(THREAD_WORK_KEY, work),
            clearThreadWork: async () => {
                this.ctx.storage.kv.delete(THREAD_WORK_KEY)
                this.ctx.storage.kv.delete(SANDBOX_BRANCH_REV_KEY)
            },
            branchCopy: (branch) => this.#branchCopy(branch),
            runMayWrite: () => this.#runMayWrite(),
            countRunWrite: (kind) => this.#countRunWrite(kind),
            sandbox: () => this.#sandbox(),
            switchSandboxToBranch: async () => {
                const runId = (await this.#currentRunId()) ?? 'unknown'
                // The running container holds the default branch; the next command copies the work
                // branch, without the PR overlay, which the branch already contains.
                await this.#shutdownSandbox('branch started', runId)
                await this.#sandbox().setSources({ prChanges: null, runId })
            },
            currentRunId,
        })
        registry.install(branch_.extension)
        const branchFiles = workspaceTools(getWorkspace(async () => {
            const work = this.ctx.storage.kv.get<ThreadWork>(THREAD_WORK_KEY)
            if (!work) throw new Error('No work branch is open: call branch_start first')
            return this.#branchStub(work.branch)
        }), {
            name: 'branch-files',
            toolPrefix: 'branch_',
            describe: (description) => 'Work branch version: reads and changes the work branch at the same /repo/... paths, after branch_start. ' + description,
            currentRunId,
            callers: readToolCallers,
            writeAccess: { mayWrite: () => this.#runMayWrite(), refusedText: WRITE_REFUSED_TEXT },
        })
        registry.install(branchFiles)
        // `set_cron` and `remove_cron`: write tools, gated like the GitHub writes.
        const crons = cronTools({
            runMayWrite: () => this.#runMayWrite(),
            setCron: (input) => this.#setCron(input),
            removeCron: () => this.#removeCron(),
            currentRunId,
        })
        registry.install(crons)
        const offeredToModel = (tool: ToolRegistration) => !tool.callers || tool.callers.includes('model')
        this.#githubWriteTools = [...github_.writeTools, ...branch_.tools, ...(branchFiles.tools ?? []).filter(offeredToModel), ...(crons.tools ?? [])]
        // Code mode (requirement 16): the `codemode` tool next to the direct ones, and the caps on the
        // scripts one run may make and the nested calls they make. Nothing here runs when the flag is off.
        if (this.#codeModeEnabled) {
            registry.install(codemodeExtension(this.env))
            registry.install(defineExtension({
                name: 'codemode-limits',
                hooks: [hook(ToolTask, codemodeLimitHooks({
                    countCodemodeCall: (kind: CodemodeCallKind) => this.#countCodemodeCall(kind),
                    // `#runId` holds for the length of a run. The hook is synchronous, so it cannot fall
                    // back to the pending requests the way `#currentRunId()` does after an eviction.
                    logIds: () => ({ runId: this.#runId }),
                }))],
            }))
        }
        // The same tool registrations over MCP: the reads, and the writes pi offers a writer plus
        // `branch_write_files`, which `mcp-tools.ts` refuses for a task that may not write.
        this.#mcpTools = mcpTools({
            tools: servedTools({
                read: [repoFiles, prFiles, github_.read, this.#webTools.extension].flatMap((extension) => extension.tools ?? []),
                write: [...this.#githubWriteTools, branch_.writeFilesTool],
            }),
            codemode: this.#codeModeEnabled
                ? { sandbox: (tools) => scriptSandbox(this.env, tools), countCodemodeCall: (kind) => this.#countCodemodeCall(kind) }
                : undefined,
        })
    }

    /**
     * Starts a tool task for the run working now and returns its token: the only thing a harness
     * outside the Worker (Claude Code's container) gets to call Benny's tools with. Its record holds
     * what `#configureToolAccess` decided for the run, and is stored under the token's hash; the
     * access comes back too, for the harness's log. `writeTools` narrows the write tools the task may
     * call below the run's (`McpTask.writeTools`). Clears the records that expired, so storage holds
     * only live ones.
     */
    async #newTaskToken(writeTools?: readonly string[]): Promise<{ token: string; access: ToolTaskAccess }> {
        const runId = await this.#currentRunId()
        const access = this.ctx.storage.kv.get<RunToolAccess>(RUN_TOOL_ACCESS_KEY)
        if (!runId || !access || access.runId !== runId) throw new Error('No run is working: a tool task belongs to a run')
        const now = Date.now()
        for (const [key, record] of this.ctx.storage.kv.list<McpTask>({ prefix: TASK_TOKEN_KEY_PREFIX })) {
            if (record.expiresAt <= now) this.ctx.storage.kv.delete(key)
        }
        const threadId = this.ctx.storage.kv.get<string>(THREAD_ID_KEY)
        if (!threadId) throw new Error('This thread has no request yet')
        const token = await newTaskToken(threadId, this.env.GITHUB_WEBHOOK_SECRET!)
        // A run pauses at `RUN_LIMIT_MS`, so no task of it needs its token for longer.
        const taskAccess: ToolTaskAccess = { runId, mayWrite: access.mayWrite, canRunCode: access.canRunCode, ...(writeTools ? { writeTools } : {}) }
        this.ctx.storage.kv.put<McpTask>(await taskTokenKey(token), { ...taskAccess, expiresAt: now + RUN_LIMIT_MS })
        log('tool task started', { runId, mayWrite: access.mayWrite, canRunCode: access.canRunCode, writeTools })
        return { token, access: taskAccess }
    }

    /**
     * The code a Claude Code task starts from: the work branch copy when one is open, so a whole-file
     * `branch_write_files` cannot undo an earlier commit; otherwise the repo copy with the PR's
     * files on top, as the sandbox gets. The key is read without reading the code.
     */
    async #agentWorkspace(): Promise<AgentWorkspace> {
        const runId = await this.#currentRunId()
        const work = this.ctx.storage.kv.get<ThreadWork>(THREAD_WORK_KEY)
        if (work) {
            return {
                key: `branch:${work.branch}`,
                copy: async () => ({ archive: (await (await this.#branchCopy(work.branch)).archive({ runId })).archive, prChanges: null }),
            }
        }
        const repoName = await this.#repoName()
        const prHead = await this.prChangesHead()
        return {
            key: `repo:${repoName}${prHead ? `+pr:${prHead}` : ''}`,
            copy: async () => ({
                archive: await (this.env.REPO as unknown as DurableObjectNamespace<RepoDO>).getByName(repoName).archive({ runId }),
                prChanges: await this.#sandboxPrChanges(),
            }),
        }
    }

    /**
     * One MCP request from a harness outside the Worker (`/mcp` in `index.ts`). The token is the only
     * credential: it must name a task of the run working now, and the run's current access narrows
     * the task's, so a task never does more than pi would for the same run.
     */
    async serveMcp(token: string, request: McpRequest): Promise<McpReply> {
        const record = this.ctx.storage.kv.get<McpTask>(await taskTokenKey(token))
        const runId = await this.#currentRunId()
        const access = this.ctx.storage.kv.get<RunToolAccess>(RUN_TOOL_ACCESS_KEY)
        if (!record || !access || record.expiresAt <= Date.now() || record.runId !== runId || access.runId !== runId) {
            log('mcp token rejected', { method: request.method, runId, known: record !== undefined })
            return unknownTaskReply(request)
        }
        const task: McpTask = { ...record, mayWrite: record.mayWrite && access.mayWrite, canRunCode: record.canRunCode && access.canRunCode }
        return answerMcpRequest(this.#mcpTools, task, request, `mcp-${crypto.randomUUID()}`)
    }

    /** Every pending request of the run comes from a writer: the gate for running code (requirement 37). */
    async #everyRequestFromWriter(): Promise<boolean> {
        const pendingRequests = Object.values(await this.#pendingRequests())
        return pendingRequests.length > 0 && pendingRequests.every((request) => request.hasWriteAccess === true)
    }

    /**
     * Adds one to the run's count for `kind` and returns the new total, so `codemode-limits.ts`
     * decides from one number. `ctx.storage.kv` keeps the counts across an eviction.
     */
    #countCodemodeCall(kind: CodemodeCallKind): number {
        const counts = this.ctx.storage.kv.get<CodemodeRunCalls>(CODEMODE_RUN_CALLS_KEY) ?? NO_CODEMODE_CALLS
        const scripts = counts.scripts + (kind === 'script' ? 1 : 0)
        const nestedCalls = counts.nestedCalls + (kind === 'nested' ? 1 : 0)
        this.ctx.storage.kv.put<CodemodeRunCalls>(CODEMODE_RUN_CALLS_KEY, { scripts, nestedCalls })
        return kind === 'script' ? scripts : nestedCalls
    }

    /** An Octokit for the thread repo's installation; each call gets a fresh token (batch 5 spike). */
    async #octokit() {
        const installationId = this.ctx.storage.kv.get<number>(INSTALLATION_ID_KEY)
        if (installationId === undefined) throw new Error('No GitHub App installation is known for this thread yet')
        return github.octokitFor(installationId)
    }

    /**
     * An Octokit for the installation the App has on another repo than the thread's (issue #53).
     * `apps.getRepoInstallation` names it, and `@octokit/auth-app` signs that route with the App's JWT
     * on the thread's client (the adapter's own `octokit` getter has no installation outside a
     * webhook). Cached for the run, and `start` clears the cache.
     */
    async #octokitForRepo(owner: string, repo: string): Promise<Octokit> {
        const name = lowerRepoName(owner, repo)
        const cached = this.#repoOctokits.get(name)
        if (cached) return cached
        const client = (await this.#octokit()).apps.getRepoInstallation({ owner, repo }).then(({ data }) => github.octokitFor(data.id))
        this.#repoOctokits.set(name, client)
        // A failed lookup leaves no client behind, so the next call tries again.
        client.catch(() => this.#repoOctokits.delete(name))
        return client
    }

    /** This thread's repo, kind and number, from the thread id the latest request stored. */
    #thread(): { owner: string; repo: string; type: 'issue' | 'pr'; number: number } {
        const threadId = this.ctx.storage.kv.get<string>(THREAD_ID_KEY)
        if (!threadId) throw new Error('This thread has no request yet')
        const { owner, repo, prNumber, type } = github.decodeThreadId(threadId)
        return { owner, repo, type: type === 'pr' ? 'pr' : 'issue', number: prNumber }
    }

    /** The `BranchDO` of one of this thread repo's work branches. */
    #branchStub(branch: string): DurableObjectStub<BranchDO> {
        const { owner, repo } = this.#thread()
        return (this.env.BRANCH as unknown as DurableObjectNamespace<BranchDO>).getByName(branchObjectName(owner, repo, branch))
    }

    async #branchCopy(branch: string): Promise<BranchCopy> {
        return this.#branchStub(branch) as unknown as BranchCopy
    }

    /**
     * Writes the work branch's edits since the sandbox's copy into the running container, before a
     * command, so it runs the code just written (plan 2.4). Nothing to do without a work branch, or
     * while the sandbox holds the default branch; a stopped sandbox copies the whole branch at its
     * next start, so `needs-start` is not an error here.
     */
    async #writeBranchEditsToSandbox(client: SandboxClient): Promise<void> {
        const work = this.ctx.storage.kv.get<ThreadWork>(THREAD_WORK_KEY)
        const rev = this.ctx.storage.kv.get<number>(SANDBOX_BRANCH_REV_KEY)
        if (!work) return
        if (rev === undefined) {
            // A work branch is open, but no start has copied it: a container still running holds
            // the default branch (a shutdown that failed at branch_start, or sources a request set
            // just before it). Stop it and drop the PR overlay; the command's start copies the branch.
            const runId = (await this.#currentRunId()) ?? 'unknown'
            await client.shutdown({ reason: 'switch to work branch' })
            await client.setSources({ prChanges: null, runId })
            return
        }
        const { rev: currentRev, changes } = await (await this.#branchCopy(work.branch)).changedSince({ rev })
        if (changes.length === 0) return
        const files = changes.flatMap((change) => change.change === 'deleted' ? [] : [{ path: change.path, content: change.content }])
        const removedPaths = changes.flatMap((change) => change.change === 'deleted' ? [change.path] : [])
        const reply = await client.writeFiles({ files, removedPaths })
        if (reply.kind === 'done') this.ctx.storage.kv.put<number>(SANDBOX_BRANCH_REV_KEY, currentRev)
        log('sandbox branch edits written', { runId: await this.#currentRunId(), files: files.length, removed: removedPaths.length, written: reply.kind === 'done' })
    }

    /** The run has pending requests and every one passes `test`. */
    async #everyPendingRequest(test: (request: PendingRequest) => boolean): Promise<boolean> {
        const pendingRequests = Object.values(await this.#pendingRequests())
        return pendingRequests.length > 0 && pendingRequests.every(test)
    }

    /** Every pending request of the run mentions Benny and comes from a writer: the gate for GitHub writes (plan 4.1). */
    async #runMayWrite(): Promise<boolean> {
        return this.#everyPendingRequest((request) => request.hasWriteAccess === true && request.mentionsBenny === true)
    }

    /** Puts the waiting mark on issue or PR `number` of the thread's repo; it never throws. */
    async #markWaiting(number: number, runId: string, reason: string): Promise<void> {
        const { owner, repo } = this.#thread()
        await setInputRequired(() => this.#octokit(), { owner, repo, number }, { runId, reason })
    }

    /** Adds one GitHub write of `kind` to the run's count and returns the new total (plan 4.4). */
    #countRunWrite(kind: RunWriteKind): number {
        const counts = { ...NO_RUN_WRITES, ...this.ctx.storage.kv.get<RunWriteCounts>(RUN_WRITES_KEY) }
        counts[kind] += 1
        this.ctx.storage.kv.put<RunWriteCounts>(RUN_WRITES_KEY, counts)
        return counts[kind]
    }

    /** The issue's cron, or undefined when it has none. */
    #cron(): CronRecord | undefined {
        return this.ctx.storage.kv.get<CronRecord>(CRON_KEY)
    }

    /** Saves the cron, and its copy in ChatStateDO. A failed copy is only logged: the cron here is the one that fires. */
    async #saveCron(record: CronRecord): Promise<void> {
        this.ctx.storage.kv.put<CronRecord>(CRON_KEY, record)
        await saveCronCopy(record).catch((error) => log('cron copy failed', { threadId: record.threadId, cronId: record.id, error: String(error) }))
    }

    /**
     * Puts the scheduled mark on the cron's issue while the cron will fire again (status active or
     * failing), else takes it off (requirement 22). It never throws.
     */
    async #updateScheduledMark(cron: CronRecord, logIds: LogIds, scheduled = cron.status === 'active' || cron.status === 'failing'): Promise<void> {
        const { owner, repo, prNumber } = github.decodeThreadId(cron.threadId)
        await updateScheduledMark(() => this.#octokit(), { owner, repo, number: prNumber }, scheduled, { ...logIds, cronId: cron.id })
    }

    /** Sets the timer for the cron's first firing after `from`, and returns the record that names it. */
    async #scheduleNextFiring(record: CronRecord, from: number): Promise<CronRecord> {
        const [nextFiringAt] = nextFirings(record.expression, record.timezone, from)
        const { id: scheduleId } = await this.schedule(new Date(nextFiringAt), 'fireCron', { cronId: record.id })
        return { ...record, nextFiringAt, scheduleId }
    }

    /** `set_cron`: sets or replaces the issue's cron. A throw goes back to the model as the reason. */
    async #setCron(input: CronInput): Promise<string> {
        const thread = this.#thread()
        if (thread.type !== 'issue') throw new Error('a cron lives in an issue, not a PR. Ask the requester to open an issue for it.')
        const expression = input.expression.trim()
        const title = input.title.trim()
        const prompt = input.prompt.trim()
        if (!title || !prompt) throw new Error('the title and the prompt must not be empty.')
        const firingLimit = checkFiringLimit(input.firingLimit)
        const now = Date.now()
        // At least three times, so the reply shows the reader whether the schedule is the one they
        // meant, and up to the limit, so it can name the last firing.
        const upcoming = nextFirings(expression, input.timezone, now, Math.min(Math.max(3, firingLimit ?? 0), CHECKED_FIRINGS))
        const previous = this.#cron()
        // An ended cron counts toward no cap, so replacing one adds a cron.
        if ((!previous || previous.status === 'ended') && (await countCrons()) >= MAX_CRONS) throw new Error(`${MAX_CRONS} crons exist already, the most Benny keeps. Remove one first.`)
        // The run's first request asked for the cron; a request that joined it did not.
        const creator = Object.values(await this.#pendingRequests()).find((request) => !request.joined)?.requester
        if (!creator) throw new Error('the request that asked has no requester on record.')
        // `#thread()` above found it, so it is there.
        const threadId = this.ctx.storage.kv.get<string>(THREAD_ID_KEY)!
        if (previous?.scheduleId) await this.cancelSchedule(previous.scheduleId)
        const record = await this.#scheduleNextFiring({
            id: crypto.randomUUID(),
            threadId,
            title, expression, timezone: input.timezone, prompt, creator,
            status: 'active', nextFiringAt: null, failuresInARow: 0, firings: [], createdAt: now,
            ...(firingLimit === undefined ? {} : { firingLimit }), countedFirings: 0,
        }, now)
        // The copy counts toward the cap, so here a failed copy fails the tool instead of being logged.
        try {
            await saveCronCopy(record)
        } catch (error) {
            if (record.scheduleId) await this.cancelSchedule(record.scheduleId)
            throw error
        }
        this.ctx.storage.kv.put<CronRecord>(CRON_KEY, record)
        const runId = await this.#currentRunId()
        log('cron set', { threadId: record.threadId, runId, cronId: record.id, expression, timezone: input.timezone, firingLimit, replacedCronId: previous?.id })
        await this.#updateScheduledMark(record, { runId })
        const times = upcoming.map((at) => formatFiringTime(at, input.timezone))
        return `Cron set: "${title}", \`${expression}\` in ${input.timezone}${previous ? ', replacing the cron this issue had' : ''}. ${firingLimitSentence(firingLimit, times)}`
    }

    /** `remove_cron`: the issue's cron fires no more. */
    async #removeCron(): Promise<string> {
        const record = this.#cron()
        if (!record) return 'This issue has no cron.'
        if (record.scheduleId) await this.cancelSchedule(record.scheduleId)
        this.ctx.storage.kv.delete(CRON_KEY)
        const runId = await this.#currentRunId()
        await deleteCronCopy(record.threadId).catch((error) => log('cron copy failed', { threadId: record.threadId, runId, cronId: record.id, error: String(error) }))
        log('cron removed', { threadId: record.threadId, runId, cronId: record.id })
        await this.#updateScheduledMark(record, { runId }, false)
        return `Cron "${record.title}" removed.`
    }

    /**
     * The cron's timer; public because `schedule` calls it by name. Firings missed while Benny was
     * down arrive as this one late call, and the next is counted from now, so they merge into one
     * (requirement 9). It never throws: the scheduler retries a callback that throws, and each retry
     * would set another timer.
     */
    async fireCron({ cronId }: { cronId: string }): Promise<void> {
        const cron = this.#cron()
        const firedAt = Date.now()
        // A timer from a cron that was replaced, removed, paused or ended since, or a second timer for a
        // time this cron already fired at: each firing moves `nextFiringAt` past now.
        if (!cron || cron.id !== cronId || cron.status === 'paused' || cron.status === 'ended' || (cron.nextFiringAt !== null && cron.nextFiringAt > firedAt)) {
            log('cron firing dropped', { threadId: cron?.threadId, cronId, currentCronId: cron?.id, nextFiringAt: cron?.nextFiringAt })
            return
        }
        await this.#makeFiring(cron, firedAt)
    }

    /**
     * Dev only (`src/dev-routes.ts`): fires the cron now, whatever its `nextFiringAt`, and returns
     * the record after. Public because the route reaches it over RPC, so it checks
     * `DEV_ROUTES_ENABLED` itself: any stub can call it, and in production it refuses. With `fail`
     * no run starts; the firing is noted as failed, so the failure counting runs for real.
     */
    async fireCronNow({ fail = false }: { fail?: boolean }): Promise<CronRecord | null> {
        if ((this.env.DEV_ROUTES_ENABLED as string) !== 'true') throw new Error('fireCronNow is a dev route and dev routes are off')
        const cron = this.#cron()
        if (!cron) return null
        log('cron fired by the dev route', { threadId: cron.threadId, cronId: cron.id, status: cron.status, fail })
        // A paused or ended cron fires no more, as at its timer.
        if (cron.status === 'paused' || cron.status === 'ended') return cron
        if (fail) {
            await this.#recordFiring(cron.id, { at: Date.now(), outcome: 'failed', note: 'forced by the dev route' })
        } else {
            // The firing books the next timer; the one booked now would make a second for that time.
            if (cron.scheduleId) await this.cancelSchedule(cron.scheduleId)
            await this.#makeFiring(cron, Date.now())
        }
        return this.#cron() ?? null
    }

    /**
     * One firing of the cron: `fireCron` at its timer, `fireCronNow` from the dev route. It sets the
     * next firing first, so a failure below costs one firing, not the cron. It never throws.
     */
    async #makeFiring(cron: CronRecord, firedAt: number): Promise<void> {
        const { threadId, id: cronId } = cron
        try {
            await this.#saveCron(await this.#scheduleNextFiring(cron, firedAt))
        } catch (error) {
            log('cron next firing not set', { threadId, cronId, error: String(error) })
        }
        // The note is a phrase the reader can see: the cron list shows it, and so does the line a
        // skip posts when it ends a limited cron (`#recordFiring`).
        const skip = async (note: string) => {
            log('cron firing skipped', { threadId, cronId, note })
            await this.#recordFiring(cronId, { at: firedAt, outcome: 'skipped', note })
        }
        // The firing comment is the request (requirement 6); the status comment follows it, as for a person's request.
        let requestId: string | undefined
        let statusId: string | undefined
        try {
            const { owner, repo, number } = this.#thread()
            const octokit = await this.#octokit()
            // A closed issue skips its firings, and reopening it resumes them, with none made up (requirement 4).
            const { data: issue } = await octokit.issues.get({ owner, repo, issue_number: number })
            if (issue.state === 'closed') return await skip('the issue is closed')
            if (Object.keys(await this.#pendingRequests()).length > 0) return await skip('the last run is still going')
            // Checked at each firing: a creator who lost write access gets the read tools only
            // (requirement 7). As in `bot.ts`, a failing check counts as no write access.
            let creatorMayWrite = false
            try {
                const { data: access } = await octokit.repos.getCollaboratorPermissionLevel({ owner, repo, username: cron.creator })
                creatorMayWrite = access.permission === 'admin' || access.permission === 'write'
            } catch (error) {
                log('write access check failed', { threadId, cronId, user: cron.creator, error: String(error) })
            }

            // This post is what counts toward a firing limit (`#recordFiring`); the last one says so.
            requestId = await postInIssue(threadId, `⏰ Firing: ${cron.title}${lastFiringNote(cron)}`)
            await this.#recordFiring(cronId, { at: firedAt, outcome: 'running', requestId })
            statusId = await postStatus(threadId, requestId)
            const { token } = (await octokit.auth({ type: 'installation' })) as { token: string }
            await checkRepoSize(octokit, owner, repo, requestId)
            const repoStub = (this.env.REPO as unknown as DurableObjectNamespace<RepoDO>).getByName(repoObjectName(owner, repo))
            const { commit } = await repoStub.sync({ owner, repo, token, logIds: { requestId } })
            await this.useRepo({ owner, repo })
            const prompt = [
                `Cron firing: "${cron.title}", set up by @${cron.creator}, fired at ${formatFiringTime(firedAt, cron.timezone)}. ` +
                    'Nobody is waiting for a live answer, so put everything in the reply.',
                `Request from @${cron.creator}:\n${cron.prompt}`,
                `Repository: ${owner}/${repo} at commit ${commit}`,
            ].join('\n\n')
            await this.start({
                threadId, requestMessageId: requestId, statusId, prompt, commit, prHead: null,
                requestText: cron.prompt, hasWriteAccess: creatorMayWrite, mentionsBenny: true,
                installationId: this.ctx.storage.kv.get<number>(INSTALLATION_ID_KEY) ?? 0,
                requester: cron.creator, cronId,
            })
            log('cron fired', { threadId, cronId, requestId, creatorMayWrite })
        } catch (error) {
            // `start` refuses a firing while a run is going (requirement 8): a request that came in
            // during the steps above. That firing is skipped, not failed.
            const busy = error instanceof ConversationBusy || (error instanceof Error && error.name === 'ConversationBusy')
            const reason = busy ? 'a run was already going in this issue' : error instanceof Error ? error.message : String(error)
            log('cron firing failed', { threadId, cronId, requestId, error: reason })
            if (requestId && statusId) {
                await reportFailure({ threadId, requestMessageId: requestId, statusId, reason })
                    .catch((reportError) => log('request report failed', { requestId, error: String(reportError) }))
            }
            await this.#recordFiring(cronId, { at: firedAt, outcome: busy ? 'skipped' : 'failed', requestId, note: reason.slice(0, 200) })
                .catch((recordError) => log('cron firing not noted', { threadId, cronId, requestId, error: String(recordError) }))
        }
    }

    /**
     * Notes how a firing went on its cron and counts the failures in a row: two mark the cron
     * Failing, five pause it with a comment in the issue (requirement 11). A firing of a cron that
     * was replaced since changes nothing. A `running` firing (its comment was posted) counts toward
     * the firing limit, and so does a skip of a limited cron; the last one ends the cron
     * (requirement 20), and a skip that ends it posts one line saying so.
     */
    async #recordFiring(cronId: string, firing: CronFiring): Promise<void> {
        const cron = this.#cron()
        if (!cron || cron.id !== cronId) return
        const failuresInARow = firing.outcome === 'failed' ? cron.failuresInARow + 1
            : firing.outcome === 'replied' ? 0
            : cron.failuresInARow
        // A paused or ended cron keeps its status; failures neither revive nor pause it.
        const stopped = cron.status === 'paused' || cron.status === 'ended'
        let record: CronRecord = {
            ...cron,
            firings: withFiring(cron.firings, firing),
            failuresInARow,
            status: stopped ? cron.status : failuresInARow >= FAILING_AFTER ? 'failing' : 'active',
        }
        if (countsTowardLimit(cron, firing)) {
            record = withCountedFiring(record)
            if (record.status === 'ended') {
                // A timer left behind is harmless (`fireCron` drops an ended cron's), so a failed cancel is only logged.
                if (cron.scheduleId) await this.cancelSchedule(cron.scheduleId).catch((error) => log('cron timer not cancelled', { threadId: cron.threadId, cronId, error: String(error) }))
                log('cron ended', { threadId: cron.threadId, cronId, requestId: firing.requestId, firingLimit: cron.firingLimit, outcome: firing.outcome })
                if (firing.outcome === 'skipped') {
                    await postInIssue(cron.threadId, skippedLastFiringNote(cron, firing.note ?? 'it was skipped'))
                        .catch((error) => log('cron skip note failed', { threadId: cron.threadId, cronId, error: String(error) }))
                }
            }
        }
        if (failuresInARow >= PAUSE_AFTER && !stopped) {
            if (cron.scheduleId) await this.cancelSchedule(cron.scheduleId)
            record = { ...record, status: 'paused', nextFiringAt: null, scheduleId: undefined }
            await postInIssue(cron.threadId, `⏸ I paused the cron "${cron.title}" after ${PAUSE_AFTER} failed firings in a row. Mention me to set it again.`)
                .catch((error) => log('cron pause note failed', { threadId: cron.threadId, cronId, error: String(error) }))
        }
        await this.#saveCron(record)
        log('cron firing noted', { threadId: cron.threadId, cronId, requestId: firing.requestId, outcome: firing.outcome, failuresInARow, status: record.status })
        // Ended or paused just now: the cron fires no more until it is set again.
        if (!stopped && (record.status === 'ended' || record.status === 'paused')) await this.#updateScheduledMark(record, { requestId: firing.requestId })
    }

    /** This thread's sandbox: one per thread, named by this agent's id (requirement 39). */
    #sandbox(): SandboxClient {
        return sandboxClient(this.env, this.ctx.id.toString())
    }

    /** The RepoDO name saved by `useRepo`, also after the object restarts. */
    async #repoName(): Promise<string> {
        if (this.#repoNameValue) return this.#repoNameValue
        const stored = await this.ctx.storage.get<string>('repoName')
        if (!stored) throw new Error('PiAgent has no repo: call useRepo({ owner, repo }) before asking')
        this.#repoNameValue = stored
        return stored
    }

    /** Points this thread's tools at the repo's RepoDO. Called before every request. */
    async useRepo({ owner, repo }: { owner: string; repo: string }): Promise<void> {
        const name = repoObjectName(owner, repo)
        await this.ctx.storage.put('repoName', name)
        this.#repoNameValue = name
    }

    /**
     * Replaces the PR changes held in `prChanges` with this PR head's changed files. `requestId` is
     * the comment that asked: `bot.ts` applies the changes before it starts the run, so the line
     * names a request and has no run yet.
     */
    async replacePrChanges({ headSha, files, removedPaths, requestId }: RequestPrChanges): Promise<void> {
        const startedAt = Date.now()
        // `this.prChanges` is this thread's own store, not the shared RepoDO. Its /repo holds only
        // the previous PR version's changed files; delete them all, so a file the new head no
        // longer changes cannot stay behind. The RepoDO's full copy is never touched here.
        await this.prChanges.fs.rm(REPO_DIR, { recursive: true, force: true })
        // Write each changed file at its repo path, e.g. `src/bot.ts` → `/repo/src/bot.ts`.
        // `mkdir` first creates the folders on the way (`/repo/src`), which `writeFile` needs.
        for (const { path, content } of files) {
            const parentDir = `${REPO_DIR}/${path}`.split('/').slice(0, -1).join('/')
            await this.prChanges.fs.mkdir(parentDir, { recursive: true })
            await this.prChanges.fs.writeFile(`${REPO_DIR}/${path}`, content)
        }
        // Both in one write, so the head and the paths it removes can never disagree.
        await this.ctx.storage.put({ prChangesHead: headSha, prRemovedPaths: removedPaths })
        log('pr changes applied', { requestId, headSha, files: files.length, removedPaths: removedPaths.length, ms: Date.now() - startedAt })
    }

    /** The PR head commit `prChanges` holds, or null when there is none. */
    async prChangesHead(): Promise<string | null> {
        return (await this.ctx.storage.get<string>('prChangesHead')) ?? null
    }

    /**
     * The thread's code for the sandbox's `setSources`: its PR head, the files `prChanges` holds
     * at their repo-relative paths and the paths the PR removed; null when the thread has no PR
     * head. `prChanges` holds only the PR's changed files, so one walk reads them all.
     */
    async #sandboxPrChanges(): Promise<PrChanges | null> {
        const headSha = await this.prChangesHead()
        if (!headSha) return null
        const removedPaths = (await this.ctx.storage.get<string[]>('prRemovedPaths')) ?? []
        const files: PrChanges['files'] = []
        for (const entry of await this.prChanges.fs.find(REPO_DIR)) {
            if (entry.type !== 'file') continue
            files.push({
                path: entry.path.slice(REPO_DIR.length + 1),
                content: await this.prChanges.fs.readFile(entry.path, 'utf8'),
            })
        }
        return { headSha, files, removedPaths }
    }

    /**
     * Starts a request durably and returns before the model runs; the agent reports to GitHub
     * itself. A request that arrives while a run is working joins that run, so its one reply
     * answers every request in it; an idle thread starts a new run for this request.
     */
    async start({ threadId, requestMessageId, statusId, prompt, commit, prHead, hasWriteAccess, mentionsBenny, installationId, requester, requestText, cronId }: BennyRequest): Promise<void> {
        // The links this request may read come from the requester's own comment only, and a new run
        // forgets the links and the web budget of the run before it (requirement 52). The id is
        // read and set with no `await` between, so of two starts on an idle object only the first
        // clears the links; the second adds its comment's links to the run already working.
        const startsRun = this.#runId === undefined
        // A request that starts a run names it: its own comment id. One that joins a working run
        // keeps that run's id, which after an eviction only the pending requests still hold.
        if (startsRun) this.#runId = requestMessageId
        this.#webTools.noteRequest(requestText, startsRun)
        // A new run counts its own scripts and nested calls, so a request that joins a run must not
        // reset them: the same flag that clears the web tools' links and budget. Written only when
        // code mode is on, so a deployment with the flag off stores nothing new.
        if (startsRun && this.#codeModeEnabled) {
            this.ctx.storage.kv.put<CodemodeRunCalls>(CODEMODE_RUN_CALLS_KEY, NO_CODEMODE_CALLS)
        }
        // Same rule for the run's GitHub writes: a request that joins keeps the run's count.
        if (startsRun) this.ctx.storage.kv.put<RunWriteCounts>(RUN_WRITES_KEY, NO_RUN_WRITES)
        // And for the token of each other repo a read names: a new run finds it again.
        if (startsRun) this.#repoOctokits.clear()
        // The GitHub tools get a fresh installation token at each call from this id; it is not a
        // secret, and a token would expire mid-thread (batch 5 spike).
        this.ctx.storage.kv.put<number>(INSTALLATION_ID_KEY, installationId)
        this.ctx.storage.kv.put<string>(THREAD_ID_KEY, threadId)
        const transcriptCountBefore = await this.#harness.messageCount()
        // The lines before the submit need the run too, and only the submit tells a joiner from the
        // run's first request. A request that starts a run has just named it, and one that joins
        // finds it in that run's pending requests; its own comment id is the fallback that keeps
        // the id required.
        const runId = (await this.#currentRunId()) ?? requestMessageId
        let submitted: { operationId: string; joined: boolean }
        try {
            // The sandbox follows the thread: every request hands it this thread's code, also one that
            // joins a run, because the model can call a command before a later request lands. Nothing
            // is submitted yet, so a throw here reaches `bot.ts`, which reports the failure.
            // A work branch already holds the PR's files and Benny's commits, so it gets no PR overlay.
            // Read after the PR files are fetched: a branch_start in between must win.
            const prChanges = await this.#sandboxPrChanges()
            const hasWorkBranch = this.ctx.storage.kv.get<ThreadWork>(THREAD_WORK_KEY) !== undefined
            await this.#sandbox().setSources({ prChanges: hasWorkBranch ? null : prChanges, runId })
            await this.#configureToolAccess({ threadId, hasWriteAccess, mentionsBenny, runId })
            // A person's request joins the running run, or leads a run of its own; `joined` says which.
            // A cron's firing never joins: the harness throws `ConversationBusy` while a run works, and `fireCron` skips it.
            submitted = cronId ? { ...(await this.#harness.startRunWhenIdle(prompt)), joined: false } : await this.#harness.submit(prompt)
        } catch (error) {
            // Nothing was submitted, so the run this request would have started is not active.
            if (startsRun) this.#runId = undefined
            throw error
        }
        const { operationId, joined } = submitted

        const pendingRequests = await this.#updatePendingRequests((pendingRequests) => {
            // A follower copies its run leader's clock and transcript base, so the one reply's
            // footnote and the 30-minute limit count the whole run. Known gap: a follower that
            // came as the run was answering gets a run of its own, and its footnote then also
            // counts the leader's tokens and time.
            const leaderEntry = joined ? Object.entries(pendingRequests).find(([, request]) => !request.joined) : undefined
            const leader = leaderEntry?.[1]
            pendingRequests[operationId] = {
                threadId,
                requestMessageId,
                statusId,
                // The run a follower joins is its leader's; a request that starts one is its first.
                runId: leader ? pendingRunId(leader) : requestMessageId,
                commit,
                prHead,
                hasWriteAccess,
                mentionsBenny,
                requester,
                requestText,
                ...(cronId ? { cronId } : {}),
                startedAt: leader?.startedAt ?? Date.now(),
                transcriptCountBefore: leader?.transcriptCountBefore ?? transcriptCountBefore,
                ...(joined ? { joined: true, leaderOperationId: leaderEntry?.[0] } : {}),
            }
            return true
        })
        const request = pendingRequests[operationId]
        // The record is the truth: a request can join a run this object had forgotten (after an
        // eviction, or a summary run), and it belongs to that run, not to one with its own id.
        this.#runId = pendingRunId(request)

        this.#waitForAnswerInBackground(operationId)
        // The request is submitted and will report itself, so nothing below may throw: the caller
        // would turn the status comment into an error while the answer is still coming.
        try {
            // This request is the go-ahead after a pause, so the paused mark goes away.
            await setPaused(threadId, false)
            await this.schedule(CHECK_INTERVAL_SECONDS, 'checkPendingRequests', undefined, { idempotent: true })
            if (joined) await reportFollowerJoined(threadId, requestMessageId, statusId)
        } catch (error) {
            log('request start step failed', { threadId, ...requestLogIds(request), operationId, error: String(error) })
        }
        log('request started', { threadId, ...requestLogIds(request), operationId, joined })
    }

    /**
     * Offers the model the sandbox tools (and `claude_code`) only when the run this request joins may run code: every
     * request working on the thread is from a writer, and so is this one (requirement 37). A call
     * still refuses on its own, so a failure here costs a step, not the request.
     */
    async #configureToolAccess({ threadId, hasWriteAccess, mentionsBenny, runId }: {
        threadId: string; hasWriteAccess: boolean; mentionsBenny: boolean; runId: string
    }): Promise<void> {
        // A request that joins counts with the run it joins. On an idle thread the map is empty, so
        // it is this request alone. GitHub writes also need a mention on every request (plan 4.1): a
        // follow-up the decision model answers gets the read tools only.
        const { canRunCode, mayWrite } = toolAccessFor(Object.values(await this.#pendingRequests()), { hasWriteAccess, mentionsBenny })
        this.ctx.storage.kv.put<RunToolAccess>(RUN_TOOL_ACCESS_KEY, { runId, mayWrite, canRunCode })
        const hidden = [...(canRunCode ? [] : [...this.#sandboxTools, ...this.#claudeCodeTools]), ...(mayWrite ? [] : this.#githubWriteTools)]
        try {
            await this.#harness.hideTools(hidden.map((tool) => tool.name))
        } catch (error) {
            log('tool access update failed', { threadId, runId, error: String(error) })
        }
        log('tool access', { threadId, runId, canRunCode, mayWrite })
    }

    /** Aborts every running and queued request in this thread. True when something was running. */
    async stop(): Promise<boolean> {
        const pendingRequests = await this.#updatePendingRequests((current) => {
            const operationIds = Object.keys(current)
            // Mark before the abort: each wait then reports "stopped", not a failure.
            for (const operationId of operationIds) {
                current[operationId] = { ...current[operationId], endReason: 'stopped' }
            }
            return operationIds.length > 0
        })
        await this.#harness.abort()
        return Object.keys(pendingRequests).length > 0
    }

    /**
     * The run's timer: every 60 s it shows the elapsed time on each status comment, pauses a run
     * that reached the 30-minute limit (requirement 33), and waits again for the requests this
     * object lost on an eviction. Public because `schedule` calls it by name.
     */
    async checkPendingRequests(): Promise<void> {
        for (const operationId of Object.keys(await this.#pendingRequests())) {
            // The snapshot above may be old: a wait may have reported this request since.
            const request = (await this.#pendingRequests())[operationId]
            if (!request) continue
            // An eviction lost the wait; waiting again answers at once when the run already finished.
            if (!this.#requestsBeingWaitedOn.has(operationId)) this.#waitForAnswerInBackground(operationId)

            const elapsedMs = Date.now() - request.startedAt
            // A follower copied the leader's start time, so only the leader pauses the run: the
            // pause below marks every follower too.
            // A follower's comment keeps saying it joined; only the leader's shows the time.
            if (request.joined) continue
            if (elapsedMs < RUN_LIMIT_MS) {
                await reportSafely(operationId, request, () =>
                    updateStatus(request.threadId, request.requestMessageId, request.statusId, elapsedMs))
                continue
            }

            // Mark the reason in a transaction: when the request finished meanwhile, leave it alone.
            const marked = await this.#updatePendingRequests((pendingRequests) => {
                if (!pendingRequests[operationId]) return false
                for (const id of Object.keys(pendingRequests)) {
                    pendingRequests[id] = { ...pendingRequests[id], endReason: 'paused' }
                }
                return true
            })
            if (!marked[operationId]) continue
            // No id: abort the whole run, so its followers stop with their leader.
            await this.#harness.abort()
            // The paused mark decides the text, and a follower shows the same text.
            const pausedMarkSet = await reportPaused({
                threadId: request.threadId,
                requestMessageId: request.requestMessageId,
                statusId: request.statusId,
            }).catch((error) => {
                log('request report failed', { ...requestLogIds(request), operationId, error: String(error) })
                return false
            })
            // Without the paused mark no reply continues the work, so nothing waits for a writer.
            if (pausedMarkSet) await this.#markWaiting(this.#thread().number, pendingRunId(request), 'paused')
            for (const [id, follower] of Object.entries(marked)) {
                if (id === operationId) continue
                await reportSafely(id, follower, () => reportFollowerEnded({
                    threadId: follower.threadId,
                    requestMessageId: follower.requestMessageId,
                    statusId: follower.statusId,
                    end: { kind: 'paused', marked: pausedMarkSet },
                }))
            }
            // Reported above, so the waits and the next check leave them alone.
            await this.#updatePendingRequests((pendingRequests) => {
                for (const id of Object.keys(marked)) delete pendingRequests[id]
                return true
            })
            // Every request of the run is reported, so nothing needs the container again. The
            // sandbox's own 30-minute alarm is the backstop if this call never arrives. `request`
            // is this check's own copy, read before those records went, so it still names the run.
            await this.#shutdownSandbox('paused', pendingRunId(request))
        }

        // Keep the timer going only while a request is unfinished. Not idempotent: this check's own
        // row stays in the schedule table until it returns, so an idempotent schedule would match
        // that row and add nothing, and the timer would stop when the row is deleted.
        if (Object.keys(await this.#pendingRequests()).length > 0) {
            await this.schedule(CHECK_INTERVAL_SECONDS, 'checkPendingRequests', undefined, { idempotent: false })
        }
    }

    /** Waits for one submitted request, so its result is reported even after an eviction. */
    #waitForAnswerInBackground(operationId: string): void {
        // One wait per operation: a second wait would report the same result twice.
        if (this.#requestsBeingWaitedOn.has(operationId)) return
        this.#requestsBeingWaitedOn.add(operationId)
        this.ctx.waitUntil(
            this.#waitForAnswerAndReport(operationId)
                .catch(async (error) => {
                    const request = (await this.#pendingRequests())[operationId]
                    log('request wait and report failed', { ...requestLogIds(request), operationId, error: String(error) })
                })
                .finally(() => this.#requestsBeingWaitedOn.delete(operationId)),
        )
    }

    /** Waits for one submitted request and reports how it ended. The pending request makes this run once. */
    async #waitForAnswerAndReport(operationId: string): Promise<void> {
        const result = await this.#harness.wait(operationId).catch(async (error) => {
            // The pending request stays, so the next check waits for the operation again.
            const pendingRequest = (await this.#pendingRequests())[operationId]
            log('request wait failed', { ...requestLogIds(pendingRequest), operationId, error: String(error) })
            return undefined
        })
        if (!result) return

        const removed = await this.#removePendingRequest(operationId)
        if (!removed) return
        const { request, wasLast } = removed
        // The sandbox follows the run: with its last request reported, no tool of it is left. The
        // summary turn a turn limit asks for has no tools, so it can run after this.
        if (wasLast) {
            const endWord = result.status === 'done' ? 'replied'
                : request.endReason === 'stopped' ? 'stopped'
                : request.endReason === 'paused' ? 'paused'
                : 'failed'
            await this.#shutdownSandbox(endWord, pendingRunId(request))
        }

        // The three ids every report of this request needs.
        const requestIds = {
            threadId: request.threadId,
            requestMessageId: request.requestMessageId,
            statusId: request.statusId,
        }

        // How a cron's firing ended, noted on the cron below; undefined while its answer is still coming.
        let firingOutcome: FiringOutcome | undefined
        if (result.status === 'done') {
            firingOutcome = 'replied'
            // A follower that joined in time gets the leader's answer, which the leader posts. One
            // that came as the run was answering got a run of its own, and its answer differs.
            const leaderAnswer = request.joined && request.leaderOperationId
                ? (await this.#harness.wait(request.leaderOperationId).catch(() => undefined))?.text
                : undefined
            if (request.joined && leaderAnswer === result.text) {
                await reportSafely(operationId, request, () => reportFollowerEnded({ ...requestIds, end: { kind: 'answered' } }))
            } else {
                const usage: RequestUsage = {
                    ms: Date.now() - request.startedAt,
                    ...await this.#harness.usageSince(request.transcriptCountBefore),
                }
                // Only a run whose requests all come from writers may get the waiting mark (plan rule 4):
                // `canRunCode` says so for the run, as decided when its latest request came. Read before
                // the reply goes out, while no new run can have replaced it.
                const runAccess = this.ctx.storage.kv.get<RunToolAccess>(RUN_TOOL_ACCESS_KEY)
                const mayMarkWaiting = runAccess?.runId === pendingRunId(request) && runAccess.canRunCode
                await reportSafely(operationId, request, async () => {
                    try {
                        await reportReply({
                            ...requestIds,
                            text: result.text ?? 'I could not produce an answer. Please try again.',
                            usage,
                            commit: request.commit,
                            prHead: request.prHead ?? null,
                        })
                        // The reply is on GitHub now, so a slow or failed decision model never delays it.
                        // It, not the writing model, says whether the reply waits (plan rule 1).
                        if (mayMarkWaiting && result.text) {
                            const waits = await askReplyWaits({
                                requestText: request.requestText ?? '',
                                replyText: result.text,
                                logIds: requestLogIds(request),
                            })
                            if (waits) await this.#markWaiting(this.#thread().number, pendingRunId(request), 'reply asks')
                        }
                    } catch (error) {
                        firingOutcome = 'failed'
                        // The status comment still says "working", so the reader must hear that the
                        // reply did not make it.
                        await reportFailure({ ...requestIds, reason: `could not post the reply: ${String(error)}` })
                    }
                })
            }
        } else if (request.endReason === 'paused') {
            // A firing that hits the 30-minute limit fails, so a cron that always times out pauses.
            firingOutcome = 'failed'
            // `checkPendingRequests` reports a pause, the run's leader and its followers together.
        } else if (request.endReason === 'stopped') {
            firingOutcome = 'stopped'
            if (request.joined) {
                await reportSafely(operationId, request, () => reportFollowerEnded({ ...requestIds, end: { kind: 'stopped' } }))
            } else {
                await reportSafely(operationId, request, () => reportStopped(requestIds))
            }
        } else if (result.reason === 'turn_limit' && request.joined) {
            // The run's leader asked for a summary answer, so this request's reply is still coming.
            await reportSafely(operationId, request, () => reportFollowerEnded({ ...requestIds, end: { kind: 'joined' } }))
        } else if (result.reason === 'turn_limit' && !request.isSummary) {
            // A run that used every tool step still owes an answer: ask for one from what it found.
            // Only a summary that runs out of steps too reports the limit as a failure.
            if (!(await this.#summarise(request))) {
                firingOutcome = 'failed'
                await reportSafely(operationId, request, () => reportFailure({ ...requestIds, reason: 'turn_limit' }))
            }
        } else {
            const reason = result.reason ?? 'unknown error'
            firingOutcome = 'failed'
            if (request.joined) {
                await reportSafely(operationId, request, () => reportFollowerEnded({ ...requestIds, end: { kind: 'failed', reason } }))
            } else {
                // A failed run leaves the requests that joined it but were not placed yet still
                // queued: end them before the leader, while nothing else can place them.
                await this.#endUnsettledFollowers(reason)
                await reportSafely(operationId, request, () => reportFailure({ ...requestIds, reason }))
            }
        }
        if (request.cronId && firingOutcome) {
            await this.#recordFiring(request.cronId, { at: request.startedAt, outcome: firingOutcome, requestId: request.requestMessageId })
        }
        log('request finished', { ...requestLogIds(request), operationId, status: result.status, reason: result.reason })
    }

    /**
     * Ends the followers that a run that failed left queued: pi keeps the inputs queued behind a
     * failed run (`afterFailedRun: 'keep'`), so no run would ever settle them and their status
     * comments would say "working" forever. Each reports the leader's outcome, and its queued
     * input is withdrawn, so the thread's next request is not queued behind it.
     */
    async #endUnsettledFollowers(reason: string): Promise<void> {
        const followers = Object.entries(await this.#pendingRequests()).filter(([, request]) => request.joined)
        if (followers.length === 0) return
        const remaining = await this.#updatePendingRequests((pendingRequests) => {
            for (const [operationId] of followers) delete pendingRequests[operationId]
            return true
        })
        // The leader is already reported, so these were the run's last requests: the sandbox goes.
        // Every follower holds the run id its leader started, so any of them names the run.
        if (Object.keys(remaining).length === 0) await this.#shutdownSandbox('failed', pendingRunId(followers[0][1]))
        for (const [operationId, follower] of followers) {
            await reportSafely(operationId, follower, () => reportFollowerEnded({
                threadId: follower.threadId,
                requestMessageId: follower.requestMessageId,
                statusId: follower.statusId,
                end: { kind: 'failed', reason },
            }))
            await this.#harness.abort(operationId).catch((error) => {
                log('request follower withdraw failed', { ...requestLogIds(follower), operationId, error: String(error) })
            })
        }
    }

    /**
     * Asks the model for an answer from what it found, as a new run on the same request, after a run
     * reached its turn limit. False when that run cannot start, so the caller reports the limit
     * itself.
     */
    async #summarise(request: PendingRequest): Promise<boolean> {
        try {
            // `reject`: if a new request started a run in the meantime, the summary must not join
            // it and answer under the wrong request; the caller then reports the limit instead.
            const { operationId } = await this.#harness.startRunWhenIdle(SUMMARY_PROMPT)
            await this.#updatePendingRequests((pendingRequests) => {
                // The same request keeps its comment, its reply's footnote and the run's clock;
                // only its operation is new. No `hasWriteAccess`: the sandbox stopped with the run's
                // last request, and a summary turn calls no tools.
                pendingRequests[operationId] = {
                    threadId: request.threadId,
                    requestMessageId: request.requestMessageId,
                    statusId: request.statusId,
                    // The summary answers the same request, so it is still that request's run.
                    runId: pendingRunId(request),
                    startedAt: request.startedAt,
                    transcriptCountBefore: request.transcriptCountBefore,
                    ...(request.requestText !== undefined ? { requestText: request.requestText } : {}),
                    isSummary: true,
                    ...(request.cronId ? { cronId: request.cronId } : {}),
                }
                return true
            })
            this.#waitForAnswerInBackground(operationId)
            log('request summarising', { threadId: request.threadId, ...requestLogIds(request), operationId })
            return true
        } catch (error) {
            log('request summary failed to start', { threadId: request.threadId, ...requestLogIds(request), error: String(error) })
            return false
        }
    }

    /** The logins of the run's pending requests, for the read of another repo. A record that does not name one says `[]`: no other repo passes. */
    async #requesters(): Promise<string[]> {
        const pendingRequests = Object.values(await this.#pendingRequests())
        const requesters = pendingRequests.map((request) => request.requester)
        return requesters.every((requester): requester is string => requester !== undefined) ? requesters : []
    }

    /** Every request that has not reported yet, by operation id. */
    async #pendingRequests(): Promise<Record<string, PendingRequest>> {
        return (await this.ctx.storage.get<Record<string, PendingRequest>>(PENDING_REQUESTS_KEY)) ?? {}
    }

    /**
     * The run this object is working on: the id `start` set, or, after an eviction, the id every
     * pending request of the run holds.
     */
    async #currentRunId(): Promise<string | undefined> {
        if (this.#runId) return this.#runId
        const [firstPendingRequest] = Object.values(await this.#pendingRequests())
        return firstPendingRequest ? pendingRunId(firstPendingRequest) : undefined
    }

    /**
     * Reads, changes and saves the pending requests in one storage transaction, so two requests
     * cannot overwrite each other's record. `change` says whether it changed the map. Ends the run
     * (clears `#runId`) when the last pending request goes, so the next request starts a new one.
     */
    #updatePendingRequests(change: (pendingRequests: Record<string, PendingRequest>) => boolean): Promise<Record<string, PendingRequest>> {
        return this.ctx.storage.transaction(async (transaction) => {
            const pendingRequests = (await transaction.get<Record<string, PendingRequest>>(PENDING_REQUESTS_KEY)) ?? {}
            if (!change(pendingRequests)) return pendingRequests
            await transaction.put(PENDING_REQUESTS_KEY, pendingRequests)
            if (Object.keys(pendingRequests).length === 0) this.#runId = undefined
            return pendingRequests
        })
    }

    /**
     * Removes one pending request and returns it, with whether it was the run's last one; only the
     * first caller gets it, so only one place reports the request. Ends the run (clears `#runId`)
     * when it was the last one, so the next request starts a new one.
     */
    #removePendingRequest(operationId: string): Promise<{ request: PendingRequest; wasLast: boolean } | undefined> {
        return this.ctx.storage.transaction(async (transaction) => {
            const pendingRequests = (await transaction.get<Record<string, PendingRequest>>(PENDING_REQUESTS_KEY)) ?? {}
            const request = pendingRequests[operationId]
            if (!request) return undefined
            delete pendingRequests[operationId]
            await transaction.put(PENDING_REQUESTS_KEY, pendingRequests)
            const wasLast = Object.keys(pendingRequests).length === 0
            if (wasLast) this.#runId = undefined
            return { request, wasLast }
        })
    }

    /**
     * Stops the run's sandbox; a failure is logged, because the request's report must still go out.
     * `runId` comes from the caller: every caller removes the run's last pending request first,
     * and that clears `#runId`, so `#currentRunId()` would no longer know the run.
     */
    async #shutdownSandbox(reason: string, runId: string): Promise<void> {
        try {
            await this.#sandbox().shutdown({ reason })
        } catch (error) {
            log('sandbox shutdown failed', { runId, reason, error: String(error) })
        }
    }

    async isNew() {
        return (await this.#harness.messageCount()) === 0
    }
}
