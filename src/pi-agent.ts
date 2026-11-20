import { Agent } from "agents";
import { Workspace, getWorkspace, type WorkspaceStub } from "@cloudflare/computer";
import { WorkerShellBackend } from "@cloudflare/computer/backends/worker-shell";
import { createGitClient } from "@cloudflare/computer/git";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ConversationIdle, defineExtension, hook, ToolTask, type ToolRegistration } from "@earendil-works/pi-durable";
import { codemodeExtension } from './codemode'
import { codemodeLimitHooks, type CodemodeCallKind } from './codemode-limits'
import { createAssistantHarness } from './harness'
import { log, type LogIds } from './log'
import { Benny } from "./pi-prompts";
import { REPO_DIR } from './checkout'
import { BENNY_GIT_IDENTITY, repoObjectName, type RepoDO } from "./repo-do";
import { sandboxClient } from "./sandbox-client";
import type { SandboxClient } from "./sandbox-contract";
import { mergedIntervalsMs, sandboxTools, type SandboxDetails, type SandboxInterval } from "./sandbox-tools";
import {
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
import { branchObjectName, lowerRepoName, RUN_WRITE_LIMITS, type BranchCopy, type RunWriteCounts, type RunWriteKind, type ThreadWork } from './github-contract'
import { githubTools, WRITE_REFUSED_TEXT, type Octokit } from './github-tools'
import { inputRequiredTool, setInputRequired } from './input-required'
import { createWebTools } from "./web-tools";
import { publicRepoTools, type PublicRepo } from './public-repo'
import { workspaceTools } from "./workspace-tools";

// The thread's agent: one `PiAgent` Durable Object per GitHub thread. `bot.ts` hands it a request
// and returns; the agent runs the model with its tools, keeps every unreported request in storage,
// and reports each one to GitHub itself (`request-reporter.ts`), also after a restart. It also
// holds the thread's PR changes.

/** What one request used, for the footnote on each reply (requirement 48). */
// `tokensIn` counts every input token, `cachedTokensIn` the part the provider served from its
// prompt cache: pi-ai's `usage.input` alone leaves cached tokens out. `turns` counts the request's
// assistant messages, and each turn sends the whole context again, so `tokensIn` says what the
// request cost while `peakContextTokens`, the largest `input + cacheRead + cacheWrite` of one turn,
// says how big its context got (the size `COMPACT_ABOVE_TOKENS` watches in `harness.ts`). Both count
// only the messages after `transcriptCountBefore`, which inherits the compaction index issue (#21):
// after a compaction that count points into a shorter list. `webSearches` and
// `webFetches` count the model's calls to those two tools, refused ones included. `sandboxCalls`
// counts the calls that reached the sandbox, a failed one too; `sandboxWallMs` the wall time the
// sandbox was in use, `sandboxStarts` the starts those calls ran, and `sandboxInstallMs` the
// installs of those starts. A call refused for missing write access never reached the sandbox, so
// it is not counted.
export type RequestUsage = {
    ms: number; tokensIn: number; cachedTokensIn: number; tokensOut: number; toolCalls: number
    turns: number; peakContextTokens: number
    webSearches: number; webFetches: number
    sandboxCalls: number; sandboxWallMs: number; sandboxStarts: number; sandboxInstallMs: number
}

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
/** The run's reply asks a writer for something: the reply puts the waiting mark on (`docs/input-required/plan.md`, rule 1). */
const RUN_ASKS_INPUT_KEY = 'asksInputThisRun'
const NO_RUN_WRITES = Object.fromEntries(Object.keys(RUN_WRITE_LIMITS).map((kind) => [kind, 0])) as RunWriteCounts
/**
 * The run's code mode counts, kept in `ctx.storage.kv` so an eviction keeps them: `codemode-limits.ts`
 * caps how many scripts, and how many nested calls from scripts, one run may make.
 */
type CodemodeRunCalls = { scripts: number; nestedCalls: number }
const CODEMODE_RUN_CALLS_KEY = 'codemodeCallsThisRun'
const NO_CODEMODE_CALLS: CodemodeRunCalls = { scripts: 0, nestedCalls: 0 }
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
    private harness;
    private registry;
    // The sandbox tools: a run that may not run code is not offered them (requirement 37).
    #sandboxTools: readonly ToolRegistration[]
    // The GitHub write tools and the branch tools the model may call, which `modelTools` hides unless
    // every pending request is a writer's mention.
    #githubWriteTools: readonly ToolRegistration[]
    // The names of `#sandboxTools`, for the usage loop: only their results carry the details the
    // footnote counts, so the tool name, never the shape of `details`, decides which count.
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

        const created = createAssistantHarness(this.env);
        this.harness = created.harness;
        this.registry = created.registry;
        this.lifecycle.use(this.harness);

        // A missing binding or any value but `'true'` means off: exactly today's behaviour without a code deploy.
        // The cast: the generated type is the config's own literal (`'false'`), and a deployment may set `'true'`.
        this.#codeModeEnabled = (this.env.CODEMODE_ENABLED as string) === 'true'

        // install benny agent
        this.registry.install(Benny(this.#codeModeEnabled))
        // The tools read the shared repo copy in RepoDO; `#repoName()` runs on the first call.
        const repoNamespace = this.env.REPO as unknown as DurableObjectNamespace<RepoDO>
        // Every tool line names the run it worked for, so two threads', or two runs', lines differ.
        const currentRunId = () => this.#currentRunId()
        // With code mode on, the 8 read tools are offered to scripts only (`callers: ['tools']`): the
        // model reads through `codemode`, and `#configureToolAccess` cannot offer them again.
        const readToolCallers = this.#codeModeEnabled ? (['tools'] as const) : undefined
        this.registry.install(workspaceTools(getWorkspace(async () => repoNamespace.getByName(await this.#repoName())), { currentRunId, callers: readToolCallers }))
        // Two tool sets, same /repo/... paths, two different stores:
        //   read, ls, find, grep          → the shared RepoDO: the whole default branch.
        //   pr_read, pr_ls, pr_find, pr_grep → this thread's own workspace: only the files the PR
        //                                    changes, written there by `replacePrChanges` (req. 29, 30).
        this.registry.install(workspaceTools(this.prChanges, {
            name: 'pr-changes',
            toolPrefix: 'pr_',
            describe: (description) => 'PR version: reads the PR\'s changed files at the same /repo/... paths. ' +
                'Only files the PR changed are here; use the tool without pr_ for every other file. ' + description,
            currentRunId,
            callers: readToolCallers,
        }))
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
            canRunCode: async () => {
                const pendingRequests = Object.values(await this.#pendingRequests())
                return pendingRequests.length > 0 && pendingRequests.every((request) => request.hasWriteAccess === true)
            },
            currentRunId,
        })
        this.registry.install(sandboxExtension)
        // `modelTools` removes tools by their registration, so keep the ones it hides.
        this.#sandboxTools = sandboxExtension.tools ?? []
        this.#sandboxToolNames = new Set(this.#sandboxTools.map((tool) => tool.name))
        // The web tools keep the links this run may read (requirement 52). Exa runs the lookups in
        // the Worker, so the model sees results and never the API key.
        this.#webTools = createWebTools({
            apiKey: this.env.EXA_API_KEY,
            secrets: [this.env.EXA_API_KEY, this.env.OPENCODE_API_KEY, this.env.GITHUB_PRIVATE_KEY, this.env.GITHUB_WEBHOOK_SECRET]
                .filter((secret): secret is string => Boolean(secret)),
            currentRunId,
        })
        this.registry.install(this.#webTools.extension)
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
        this.registry.install(publicRepo.list)
        this.registry.install(publicRepo.files)
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
        this.registry.install(github_.read)
        // Notes that the reply asks a writer for something; the mark goes on with the reply.
        this.registry.install(inputRequiredTool(async () => {
            const allWriters = await this.#everyPendingRequest((request) => request.hasWriteAccess === true)
            if (allWriters) this.ctx.storage.kv.put<boolean>(RUN_ASKS_INPUT_KEY, true)
            log('tool', { name: 'mark_input_required', noted: allWriters, runId: await currentRunId() })
            return allWriters
        }))
        this.registry.install(github_.write)
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
        this.registry.install(branch_.extension)
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
        this.registry.install(branchFiles)
        const offeredToModel = (tool: ToolRegistration) => !tool.callers || tool.callers.includes('model')
        this.#githubWriteTools = [...github_.writeTools, ...branch_.tools, ...(branchFiles.tools ?? []).filter(offeredToModel)]
        // Code mode (requirement 16): the `codemode` tool next to the direct ones, and the caps on the
        // scripts one run may make and the nested calls they make. Nothing here runs when the flag is off.
        if (this.#codeModeEnabled) {
            this.registry.install(codemodeExtension(this.env))
            this.registry.install(defineExtension({
                name: 'codemode-limits',
                hooks: [hook(ToolTask, codemodeLimitHooks({
                    countCodemodeCall: (kind: CodemodeCallKind) => this.#countCodemodeCall(kind),
                    // `#runId` holds for the length of a run. The hook is synchronous, so it cannot fall
                    // back to the pending requests the way `#currentRunId()` does after an eviction.
                    logIds: () => ({ runId: this.#runId }),
                }))],
            }))
        }
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
    async start({ threadId, requestMessageId, statusId, prompt, commit, prHead, hasWriteAccess, mentionsBenny, installationId, requester, requestText }: BennyRequest): Promise<void> {
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
        if (startsRun) this.ctx.storage.kv.delete(RUN_ASKS_INPUT_KEY)
        // And for the token of each other repo a read names: a new run finds it again.
        if (startsRun) this.#repoOctokits.clear()
        // The GitHub tools get a fresh installation token at each call from this id; it is not a
        // secret, and a token would expire mid-thread (batch 5 spike).
        this.ctx.storage.kv.put<number>(INSTALLATION_ID_KEY, installationId)
        this.ctx.storage.kv.put<string>(THREAD_ID_KEY, threadId)
        const session = this.harness.session()
        const transcriptCountBefore = (await session.messages()).length
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
            submitted = await this.#submitRequest(prompt)
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
     * Offers the model the sandbox tools only when the run this request joins may run code: every
     * request working on the thread is from a writer, and so is this one (requirement 37). A call
     * still refuses on its own, so a failure here costs a step, not the request.
     */
    async #configureToolAccess({ threadId, hasWriteAccess, mentionsBenny, runId }: {
        threadId: string; hasWriteAccess: boolean; mentionsBenny: boolean; runId: string
    }): Promise<void> {
        const pendingRequests = Object.values(await this.#pendingRequests())
        // A request that joins counts with the run it joins. On an idle thread the map is empty, so
        // it is this request alone.
        const canRunCode = hasWriteAccess && pendingRequests.every((request) => request.hasWriteAccess === true)
        // GitHub writes also need a mention on every request (plan 4.1): a follow-up the decision
        // model answers gets the read tools only.
        const mayWrite = canRunCode && mentionsBenny && pendingRequests.every((request) => request.mentionsBenny === true)
        const hidden = [...(canRunCode ? [] : this.#sandboxTools), ...(mayWrite ? [] : this.#githubWriteTools)]
        try {
            const root = await (await this.harness.pi()).root(BACKGROUND_CONTEXT)
            // `null` offers every tool the model may call again; tools with `callers: ['tools']` stay hidden (code mode).
            await root.configure({ modelTools: hidden.length === 0 ? null : { remove: hidden } }, BACKGROUND_CONTEXT)
        } catch (error) {
            log('tool access update failed', { threadId, runId, error: String(error) })
        }
        log('tool access', { threadId, runId, canRunCode, mayWrite })
    }

    /**
     * Submits one request to the model: it joins the work of a running request, or leads a run of its
     * own. `joined` says which happened.
     */
    async #submitRequest(prompt: string): Promise<{ operationId: string; joined: boolean }> {
        const session = this.harness.session()
        try {
            // One step joins the running work or is refused, so it cannot race the run's end.
            const { operationId } = await session.submit(prompt, { whenBusy: 'steer', whenIdle: 'reject' })
            return { operationId, joined: true }
        } catch (error) {
            // A second copy of pi-durable in the bundle would break `instanceof`, so the name counts too.
            const idle = error instanceof ConversationIdle || (error instanceof Error && error.name === 'ConversationIdle')
            if (!idle) throw error
            // Nothing was running, so this request leads a run of its own.
            const { operationId } = await session.submit(prompt)
            return { operationId, joined: false }
        }
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
        await this.harness.session().abort()
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
            await this.harness.session().abort()
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
        const session = this.harness.session()
        const result = await session.wait(operationId).catch(async (error) => {
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

        if (result.status === 'done') {
            // A follower that joined in time gets the leader's answer, which the leader posts. One
            // that came as the run was answering got a run of its own, and its answer differs.
            const leaderAnswer = request.joined && request.leaderOperationId
                ? (await session.wait(request.leaderOperationId).catch(() => undefined))?.text
                : undefined
            if (request.joined && leaderAnswer === result.text) {
                await reportSafely(operationId, request, () => reportFollowerEnded({ ...requestIds, end: { kind: 'answered' } }))
            } else {
                const usage: RequestUsage = {
                    ms: Date.now() - request.startedAt,
                    tokensIn: 0, cachedTokensIn: 0, tokensOut: 0, toolCalls: 0, webSearches: 0, webFetches: 0,
                    turns: 0, peakContextTokens: 0,
                    sandboxCalls: 0, sandboxWallMs: 0, sandboxStarts: 0, sandboxInstallMs: 0,
                }
                // A sandbox call's span on the clock, so parallel calls that waited on the same start
                // count that wait once.
                const sandboxIntervals: SandboxInterval[] = []
                // A result from before `sandboxStartedAt` was stored has no place on the clock, so its
                // own time is added alone: whether it overlapped the others is unknown.
                let sandboxMsWithoutStart = 0
                for (const entry of (await session.messages()).slice(request.transcriptCountBefore)) {
                    for (const message of entry.model ?? []) {
                        if (message.role === 'toolResult') {
                            // A sandbox tool's result says what its call did there, a failed call too; a
                            // refused call, and a result from before the footnote counted this, has none.
                            const sandboxCall = this.#sandboxToolNames.has(message.toolName)
                                ? message.details as Partial<SandboxDetails> | undefined
                                : undefined
                            if (typeof sandboxCall?.sandboxMs === 'number') {
                                usage.sandboxCalls += 1
                                usage.sandboxInstallMs += sandboxCall.installMs ?? 0
                                if (typeof sandboxCall.sandboxStartedAt === 'number') {
                                    sandboxIntervals.push({ start: sandboxCall.sandboxStartedAt, end: sandboxCall.sandboxStartedAt + sandboxCall.sandboxMs })
                                } else {
                                    sandboxMsWithoutStart += sandboxCall.sandboxMs
                                }
                                if (sandboxCall.started === true) usage.sandboxStarts += 1
                            }
                        }
                        if (message.role !== 'assistant') continue
                        // One assistant message is one turn, and every turn sent the whole context
                        // again: the largest of those sends is the context the request reached.
                        const contextTokens = message.usage.input + message.usage.cacheRead + message.usage.cacheWrite
                        usage.turns += 1
                        usage.tokensIn += contextTokens
                        usage.cachedTokensIn += message.usage.cacheRead
                        usage.tokensOut += message.usage.output
                        usage.peakContextTokens = Math.max(usage.peakContextTokens, contextTokens)
                        for (const block of message.content) {
                            if (block.type !== 'toolCall') continue
                            // Every call the model made, refused ones too: a refusal happens before Exa,
                            // so the footnote shows the attempts.
                            usage.toolCalls += 1
                            if (block.name === 'web_search') usage.webSearches += 1
                            if (block.name === 'web_fetch') usage.webFetches += 1
                        }
                    }
                }
                usage.sandboxWallMs = mergedIntervalsMs(sandboxIntervals) + sandboxMsWithoutStart
                await reportSafely(operationId, request, async () => {
                    try {
                        await reportReply({
                            ...requestIds,
                            text: result.text ?? 'I could not produce an answer. Please try again.',
                            usage,
                            commit: request.commit,
                            prHead: request.prHead ?? null,
                        })
                        // The reply that asks is on GitHub now, so the thread can show it waits.
                        if (this.ctx.storage.kv.get<boolean>(RUN_ASKS_INPUT_KEY)) {
                            this.ctx.storage.kv.delete(RUN_ASKS_INPUT_KEY)
                            await this.#markWaiting(this.#thread().number, pendingRunId(request), 'reply asks')
                        }
                    } catch (error) {
                        // The status comment still says "working", so the reader must hear that the
                        // reply did not make it.
                        await reportFailure({ ...requestIds, reason: `could not post the reply: ${String(error)}` })
                    }
                })
            }
        } else if (request.endReason === 'paused') {
            // `checkPendingRequests` reports a pause, the run's leader and its followers together.
        } else if (request.endReason === 'stopped') {
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
                await reportSafely(operationId, request, () => reportFailure({ ...requestIds, reason: 'turn_limit' }))
            }
        } else {
            const reason = result.reason ?? 'unknown error'
            if (request.joined) {
                await reportSafely(operationId, request, () => reportFollowerEnded({ ...requestIds, end: { kind: 'failed', reason } }))
            } else {
                // A failed run leaves the requests that joined it but were not placed yet still
                // queued: end them before the leader, while nothing else can place them.
                await this.#endUnsettledFollowers(reason)
                await reportSafely(operationId, request, () => reportFailure({ ...requestIds, reason }))
            }
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
            await this.harness.session().abort(operationId).catch((error) => {
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
            const { operationId } = await this.harness.session().submit(SUMMARY_PROMPT, { whenBusy: 'reject' })
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
                    isSummary: true,
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
        return (await this.harness.messages()).length === 0
    }
}
