import { defineExtension, defineTool, type ToolRegistration } from '@earendil-works/pi-durable'
import {
    MAX_KEEP_PATHS,
    MAX_LOCKFILE_BYTES,
    PR_SIZE_LIMITS,
    RUN_WRITE_LIMITS,
    type BranchCopy,
    type RunWriteKind,
    type ThreadWork,
} from './github-contract'
import { BENNY_LOGIN, prSize, WRITE_REFUSED_TEXT, type Octokit } from './github-tools'
import { log } from './log'
import type { SandboxClient } from './sandbox-contract'

// The branch tools (batch 5 plan, 3.3): open the thread's work branch, see what changed, commit and
// push, and keep files a sandbox command changed. The file tools for the branch (`branch_read` ...
// `branch_delete`) are `workspaceTools` over the branch copy; `PiAgent` installs both. Every tool
// here changes something or exists for a change, so all of them are the model's only and need every
// pending request to be a writer's mention. `branch_write_files` is for a harness with files of its
// own (Claude Code over MCP), so it is returned apart and pi is not offered it.

/** What the branch tools ask `PiAgent` about the thread and the run. */
export type BranchToolsAccess = {
    octokit: () => Promise<Octokit>
    /** The thread: its repo, whether it is an issue or a PR, and its number. */
    thread: () => Promise<{ owner: string; repo: string; type: 'issue' | 'pr'; number: number }>
    threadWork: () => Promise<ThreadWork | null>
    saveThreadWork: (work: ThreadWork) => Promise<void>
    clearThreadWork: () => Promise<void>
    /** The `BranchDO` that holds a work branch of this thread's repo. */
    branchCopy: (branch: string) => Promise<BranchCopy>
    runMayWrite: () => Promise<boolean>
    countRunWrite: (kind: RunWriteKind) => number
    sandbox: () => SandboxClient
    /** Stops the thread's sandbox and drops its PR overlay, so the next command copies the branch. */
    switchSandboxToBranch: () => Promise<void>
    currentRunId: () => Promise<string | undefined>
}

type ToolOutput = { output: { type: 'text'; text: string }[]; isError: boolean }

/**
 * Most bytes one `branch_write_files` call sends to the branch copy: room for a 10 MiB lockfile and
 * a few source files, and half the 32 MiB a Durable Object RPC call may carry.
 */
const MAX_WRITE_FILES_BYTES = 16 * 1024 * 1024

class Refusal extends Error {}

export const branchTools = (access: BranchToolsAccess) => {
    const { octokit, thread, threadWork, saveThreadWork, clearThreadWork, branchCopy, runMayWrite, countRunWrite, sandbox, switchSandboxToBranch, currentRunId } = access

    // A fresh installation token for a `BranchDO` call; it goes into request headers only.
    const installationToken = async () => ((await (await octokit()).auth({ type: 'installation' })) as { token: string }).token

    const run = async (name: string, args: unknown, callId: string, body: (logIds: { runId?: string }) => Promise<string>): Promise<ToolOutput> => {
        const startedAt = Date.now()
        const runId = await currentRunId()
        let text: string
        let isError = false
        try {
            if (!(await runMayWrite())) throw new Refusal(WRITE_REFUSED_TEXT)
            text = await body({ runId })
        } catch (error) {
            isError = true
            text = error instanceof Refusal ? `${name} refused: ${error.message}` : `${name} failed: ${error instanceof Error ? error.message : String(error)}`
        }
        log('tool', { name, args: JSON.stringify(args).slice(0, 200), ms: Date.now() - startedAt, isError, callId, runId })
        return { output: [{ type: 'text', text }], isError }
    }

    // The thread's work, refused once its PR was merged or closed: nothing more may be pushed there.
    // An issue thread's work is cleared, so the next branch_start opens a fresh branch and a new PR.
    const requireWork = async () => {
        const work = await threadWork()
        if (!work) throw new Refusal('no work branch is open: call branch_start first.')
        if (work.prNumber !== null) {
            const { owner, repo, type, number } = await thread()
            const { data: pr } = await (await octokit()).pulls.get({ owner, repo, pull_number: work.prNumber })
            if (pr.state === 'closed') {
                const ended = pr.merged ? 'merged' : 'closed'
                if (type === 'pr' && number === work.prNumber) throw new Refusal(`PR #${number} is ${ended}: nothing more can be pushed to it. Ask on an issue for new work.`)
                await clearThreadWork()
                throw new Refusal(`PR #${work.prNumber} for ${work.branch} is ${ended}. Call branch_start to open a fresh branch, then make the change again.`)
            }
        }
        return work
    }

    const tools: ToolRegistration[] = [
        defineTool({
            name: 'branch_start',
            description: 'Open the thread\'s work branch: bobby/issue-N on an issue, or the PR\'s branch (bobby/pr-N for a person\'s PR). Its files appear at the same /repo paths in the branch_ tools, and commands run on it. A second call returns the branch already open.',
            callers: ['model'],
            parameters: { type: 'object', properties: { from: { type: 'string', description: 'The branch a new work branch starts from. Default: the default branch, or the PR\'s head.' } } },
            execute: (args, api) => run('branch_start', args, api.callId, async (logIds) => {
                const { from: fromArg } = args as { from?: string }
                const { owner, repo, type, number } = await thread()
                const client = await octokit()
                let work = await threadWork()
                if (work) {
                    try {
                        work = await requireWork()
                    } catch (error) {
                        // `requireWork` cleared an issue thread's work whose PR ended: start a fresh
                        // branch. Any other refusal (a closed PR's own thread) stands.
                        if (await threadWork()) throw error
                        work = null
                    }
                }
                let from: string
                if (work) {
                    from = work.baseBranch
                } else if (type === 'issue') {
                    const { data: repository } = await client.repos.get({ owner, repo })
                    from = fromArg ?? repository.default_branch
                    work = { branch: `bobby/issue-${number}`, baseBranch: from, prNumber: null }
                } else {
                    const { data: pr } = await client.pulls.get({ owner, repo, pull_number: number })
                    if (pr.head.repo?.full_name !== pr.base.repo.full_name) {
                        throw new Refusal('this PR comes from a fork, and Benny cannot push to a fork. Post your change as a line comment with a ```suggestion block (github_review_comment).')
                    }
                    // Benny's own PR gets more commits; a person's PR gets a branch of its own, and a
                    // PR into theirs, so the author decides what to take (plan 2.3).
                    from = pr.head.ref
                    if (pr.state === 'closed') throw new Refusal(`PR #${number} is ${pr.merged ? 'merged' : 'closed'}. Ask on an issue for new work.`)
                    // Benny's own PR gets more commits only on a branch named bobby/... (plan 4.1): a
                    // head someone renamed is a person's branch now.
                    const ownPr = pr.user?.login === BENNY_LOGIN && pr.head.ref.startsWith('bobby/')
                    work = ownPr
                        ? { branch: pr.head.ref, baseBranch: pr.base.ref, prNumber: number }
                        : { branch: `bobby/pr-${number}`, baseBranch: pr.head.ref, prNumber: null }
                    // `from` is never committed to; for Benny's own PR the branch exists, so `from`
                    // only names what it started from: the PR's base.
                    if (ownPr) from = pr.base.ref
                }
                const copy = await branchCopy(work.branch)
                const started = await copy.start({ owner, repo, token: await installationToken(), branch: work.branch, from, logIds })
                await saveThreadWork(work)
                await switchSandboxToBranch()
                return `Work branch ${work.branch} is open at ${started.commit.slice(0, 7)}${started.created ? `, starting from ${from}; the first branch_commit_push creates it on GitHub` : ''}. ` +
                    'Read and change it with the branch_ tools; commands now run on it.'
            }),
        }),
        defineTool({
            name: 'branch_status',
            description: 'The work branch: files changed and not committed yet, whether the branch is on GitHub, and its PR.',
            callers: ['model'],
            parameters: { type: 'object', properties: {} },
            execute: (args, api) => run('branch_status', args, api.callId, async () => {
                const work = await requireWork()
                const status = await (await branchCopy(work.branch)).status()
                const changes = status.uncommitted.map((change) => `${change.change} ${change.path}`)
                return [
                    `Branch ${status.branch} at ${status.commit.slice(0, 7)}, ${status.onGitHub ? 'on GitHub' : 'not on GitHub yet'}${work.prNumber !== null ? `, PR #${work.prNumber}` : ''}.`,
                    changes.length > 0 ? `Not committed yet (${changes.length}):\n${changes.join('\n')}` : 'Nothing to commit.',
                ].join('\n')
            }),
        }),
        defineTool({
            name: 'branch_commit_push',
            description: 'Commit every change on the work branch and push it to GitHub. Run the tests first. Workflow files, secret files, binary files and files over 1 MiB are refused.',
            callers: ['model'],
            parameters: { type: 'object', properties: { message: { type: 'string', description: 'The commit message: one line on what changes and why.' } }, required: ['message'] },
            execute: (args, api) => run('branch_commit_push', args, api.callId, async (logIds) => {
                const { message } = args as { message: string }
                const work = await requireWork()
                if (countRunWrite('pushes') > RUN_WRITE_LIMITS.pushes) throw new Refusal(`this run already pushed ${RUN_WRITE_LIMITS.pushes} times, the most one run may. Say so in your reply.`)
                const result = await (await branchCopy(work.branch)).commitAndPush({ message, token: await installationToken(), logIds })
                if (result.kind === 'nothing-to-commit') return 'Nothing to commit: the branch has no changes since its last commit.'
                if (result.kind === 'refused') throw new Refusal(result.reason)
                if (result.kind === 'branch-changed') {
                    throw new Refusal(`someone pushed to ${work.branch} and changed files you changed too. Nothing was committed. Tell the requester; do not try again.`)
                }
                const pushed = `Committed ${result.files} files as ${result.commit.slice(0, 7)} and pushed ${work.branch}${result.createdBranch ? ' (new on GitHub)' : ''}.`
                const { owner, repo } = await thread()
                // The push landed; a size check that fails (the base branch was deleted) must not
                // make it look failed, or the model retries and finds nothing to commit.
                const size = await prSize(await octokit(), owner, repo, work.baseBranch, work.branch).catch(() => null)
                if (!size) return `${pushed} The PR size could not be counted against ${work.baseBranch}.`
                const overLimit = size.files > PR_SIZE_LIMITS.files || size.changedLines > PR_SIZE_LIMITS.changedLines
                return `${pushed} The branch now changes ${size.files} files and ${size.changedLines} lines against ${work.baseBranch}` +
                    (overLimit ? `: over the PR limit of ${PR_SIZE_LIMITS.files} files and ${PR_SIZE_LIMITS.changedLines} lines. Stop, describe how you would split the work, and ask before you go on.` : '.')
            }),
        }),
        defineTool({
            name: 'sandbox_keep_changes',
            description: `Copy files a sandbox command changed (a lockfile, formatter output) from the sandbox into the work branch, so the next commit has them. Name each file; at most ${MAX_KEEP_PATHS} per call. node_modules and build output stay in the sandbox.`,
            callers: ['model'],
            parameters: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' }, description: 'Paths from the repo root, such as package.json.' } }, required: ['paths'] },
            execute: (args, api) => run('sandbox_keep_changes', args, api.callId, async (logIds) => {
                const pathsArg = (args as { paths?: unknown }).paths
                // Paths are repo-relative; a sandbox path (`/workspace/repo/...`) or `/repo/...` is accepted too.
                const paths = (Array.isArray(pathsArg) ? pathsArg : [pathsArg]).filter((path) => path !== undefined).map(String).map((path) => path.replace(/^\/(workspace\/)?repo\//, ''))
                if (paths.length === 0) throw new Refusal('name at least one file.')
                if (paths.length > MAX_KEEP_PATHS) throw new Refusal(`at most ${MAX_KEEP_PATHS} paths per call.`)
                const work = await requireWork()
                const reply = await sandbox().readFiles({ paths, maxBytes: MAX_LOCKFILE_BYTES })
                if (reply.kind === 'needs-start') throw new Refusal('no sandbox is running: run the command with exec first.')
                const { files, missing, tooLarge } = reply.result
                const kept = await (await branchCopy(work.branch)).keepFiles({ files, removedPaths: [], logIds })
                return [
                    `Kept ${kept.kept} of ${paths.length} files in ${work.branch}. Commit them with branch_commit_push.`,
                    kept.refused.length > 0 ? `Refused: ${kept.refused.map((file) => `${file.path} (${file.reason})`).join(', ')}.` : '',
                    missing.length > 0 ? `Not in the sandbox (or a secret file): ${missing.join(', ')}.` : '',
                    tooLarge.length > 0 ? `Over ${MAX_LOCKFILE_BYTES / (1024 * 1024)} MiB, left in the sandbox: ${tooLarge.join(', ')}.` : '',
                ].filter(Boolean).join('\n')
            }),
        }),
    ]

    // How code a harness wrote in its own container reaches the work branch (Claude Code, over MCP;
    // `mcp-tools.ts`). pi writes into the branch copy directly with `branch_write`, so pi is not
    // offered this tool. The copy's own checks (`BranchDO.keepFiles`) refuse workflow, secret,
    // binary and oversized files; nothing reaches GitHub until `branch_commit_push`.
    const writeFilesTool = defineTool({
        name: 'branch_write_files',
        description: `Write whole files into the work branch (after branch_start), and delete files from it, so the next branch_commit_push has them. ` +
            `Send each changed file's full UTF-8 text; at most ${MAX_KEEP_PATHS} paths and ${MAX_WRITE_FILES_BYTES / (1024 * 1024)} MiB per call. Workflow, secret and binary files are refused.`,
        callers: ['model'],
        parameters: {
            type: 'object',
            properties: {
                files: {
                    type: 'array',
                    description: 'Files to write, each replacing the branch\'s file at that path.',
                    items: {
                        type: 'object',
                        properties: { path: { type: 'string', description: 'Path from the repo root, such as src/index.ts. /workspace/src/index.ts and /repo/src/index.ts mean the same file.' }, content: { type: 'string', description: 'The whole file, as UTF-8 text.' } },
                        required: ['path', 'content'],
                    },
                },
                deletedPaths: { type: 'array', items: { type: 'string' }, description: 'Paths from the repo root to delete from the branch.' },
            },
        },
        execute: (args, api) => {
            const { files = [], deletedPaths = [] } = args as { files?: { path: string; content: string }[]; deletedPaths?: string[] }
            // The contents are whole files, so the tool's log line names only the paths.
            return run('branch_write_files', { paths: files.map((file) => file.path), deletedPaths }, api.callId, async (logIds) => {
                // Paths are repo-relative; `/workspace/...` (the container's copy, where Claude Code's own
                // tools see the repo root) and `/repo/...` (Benny's read tools) are accepted too, so
                // `/workspace/repo/x` is the repo's `repo/x`. A `..` segment or another absolute path could
                // leave the repo, so it is refused.
                const repoPath = (path: string) => {
                    const relative = path.replace(/^\/(?:workspace|repo)\//, '').replace(/^\.\//, '')
                    if (relative === '' || relative.startsWith('/') || relative.split('/').some((segment) => segment === '..' || segment === '')) {
                        throw new Refusal(`"${path}" is not a path inside the repo.`)
                    }
                    return relative
                }
                const pathCount = files.length + deletedPaths.length
                if (pathCount === 0) throw new Refusal('name at least one file to write or delete.')
                if (pathCount > MAX_KEEP_PATHS) throw new Refusal(`at most ${MAX_KEEP_PATHS} paths per call; split the files over several calls.`)
                const encoder = new TextEncoder()
                const encoded = files.map((file) => ({ path: repoPath(file.path), content: encoder.encode(file.content) }))
                const removedPaths = deletedPaths.map(repoPath)
                const totalBytes = encoded.reduce((sum, file) => sum + file.content.byteLength, 0)
                if (totalBytes > MAX_WRITE_FILES_BYTES) throw new Refusal(`these files hold ${totalBytes} bytes; at most ${MAX_WRITE_FILES_BYTES} per call. Split them over several calls.`)
                const work = await requireWork()
                const kept = await (await branchCopy(work.branch)).keepFiles({ files: encoded, removedPaths, logIds })
                return [
                    `Wrote ${kept.kept} of ${pathCount} paths in ${work.branch}. Commit them with branch_commit_push.`,
                    kept.refused.length > 0 ? `Refused: ${kept.refused.map((file) => `${file.path} (${file.reason})`).join(', ')}.` : '',
                ].filter(Boolean).join('\n')
            })
        },
    })

    return {
        extension: defineExtension({ name: 'branch', tools }),
        tools,
        /** `branch_write_files`, served over MCP only: a harness with its own files sends them to the branch copy with it. */
        writeFilesTool,
    }
}
