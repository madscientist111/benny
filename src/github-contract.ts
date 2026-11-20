import type { LogIds } from './log'

// Shared names for batch 5 (`scratchpad/batch-5-github-tools-plan.md`): the GitHub tools, the
// thread's work branch, and the branch copy that holds it. `BranchDO` (G2) implements `BranchCopy`;
// the GitHub tools (G3) and the branch tools (G4) are the only callers.
//
// A *branch copy* is the files of one work branch, held by one `BranchDO`; GitHub holds the
// history. A *work branch* is the branch Benny commits to for a thread, such as `bobby/issue-12`.

/** Days a branch copy may go unused before it deletes itself (plan section 2.2). */
export const BRANCH_COPY_IDLE_DAYS = 5

/** A PR Benny opens has at most this many files and changed lines, lockfiles and snapshots not counted (plan 4.3). */
export const PR_SIZE_LIMITS = { files: 20, changedLines: 400 } as const

// Every path in this contract is relative to the repo root, such as `src/bot.ts`: no `/repo/` and no
// leading `/`. The checks below also accept `/repo/src/bot.ts`, `./src/bot.ts` and `..` segments,
// as `isSecretPath` does, so no spelling of a path can make them fail open.
const repoRelative = (path: string) => {
    const segments: string[] = []
    for (const segment of path.replace(/^\/repo\//, '').split('/')) {
        if (segment === '' || segment === '.') continue
        if (segment === '..') segments.pop()
        else segments.push(segment)
    }
    return segments.join('/')
}

/** Lockfile names: left out of the PR size count, and allowed up to 10 MiB in a commit (plan 2.4, 4.3). */
export const LOCKFILE_NAMES: readonly string[] = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lockb']

export const isLockfile = (path: string) => LOCKFILE_NAMES.includes(repoRelative(path).split('/').pop() ?? '')

/** Files left out of the PR size count besides lockfiles: snapshots (plan 4.3). */
export const isSnapshotFile = (path: string) => path.endsWith('.snap')

/** Largest file Benny commits, reads with `github_read_file` or brings back from the sandbox, and the larger cap for a lockfile (plan 2.4, 3.1, 4.2). */
export const MAX_FILE_BYTES = 1024 * 1024
export const MAX_LOCKFILE_BYTES = 10 * 1024 * 1024

/** Paths Benny never commits: a workflow runs with the repo's secrets (plan 4.2). Secret files are refused by `isSecretPath`. */
const FORBIDDEN_PATH_PREFIXES: readonly string[] = ['.github/workflows/', '.github/actions/']

export const isForbiddenPath = (path: string) => FORBIDDEN_PATH_PREFIXES.some((prefix) => repoRelative(path).startsWith(prefix))

/** At most this many paths per `sandbox_keep_changes` call (plan 2.4). */
export const MAX_KEEP_PATHS = 20

/** `owner/repo` in lower case: GitHub repo names are case-insensitive, so two spellings compare equal. */
export const lowerRepoName = (owner: string, repo: string) => `${owner}/${repo}`.toLowerCase()

/** The HTTP status Octokit puts on a failed request, such as 404; undefined for any other error. */
export const httpStatus = (error: unknown): number | undefined => (error as { status?: number } | null)?.status

/**
 * Name of the one `BranchDO` for a work branch. Repo names are case-insensitive on GitHub, branch
 * names are not, so only the repo part is lowercased.
 */
export const branchObjectName = (owner: string, repo: string, branch: string) =>
    `${lowerRepoName(owner, repo)}@${branch}`

/** The thread's work, kept in `PiAgent` storage so a later request continues on the same branch and PR (plan 2.3). */
export type ThreadWork = {
    /** The work branch, such as `bobby/issue-12`. */
    branch: string
    /** The branch the work started from and the PR targets. */
    baseBranch: string
    /** The PR Benny opened from the branch, once there is one. */
    prNumber: number | null
}

/** One changed file of a branch copy, from the workspace's revision log (plan 2.1). `path` is repo-relative. */
export type BranchChange =
    | { path: string; change: 'added' | 'modified'; content: Uint8Array }
    | { path: string; change: 'deleted' }

export type BranchStartRequest = {
    owner: string
    repo: string
    /** An installation token; it goes into request headers only. */
    token: string
    /** The work branch. When it does not exist on GitHub yet, the copy starts from `from`. */
    branch: string
    /** The branch a new work branch starts from: the default branch, or a PR's head branch. */
    from: string
    logIds: LogIds
}

export type BranchStartResult = {
    /** The commit the copy holds. */
    commit: string
    /** True when the work branch does not exist on GitHub yet: the first commit creates it. */
    created: boolean
    /** The workspace revision after the import: `changedSince(rev)` counts from here. */
    rev: number
}

export type BranchStatus = {
    branch: string
    /** The commit the copy is based on: the last commit Benny made, or the imported one. */
    commit: string
    /** Files changed since that commit and not committed yet. */
    uncommitted: { path: string; change: BranchChange['change'] }[]
    /** True once the work branch exists on GitHub. */
    onGitHub: boolean
}

export type BranchCommitRequest = { message: string; token: string; logIds: LogIds }

/**
 * What a commit did. `branch-changed`: someone pushed to the work branch, so GitHub refused to move
 * it (a 422 on the ref update); nothing was committed.
 */
export type BranchCommitResult =
    | { kind: 'committed'; commit: string; files: number; createdBranch: boolean }
    | { kind: 'nothing-to-commit' }
    | { kind: 'branch-changed' }
    | { kind: 'refused'; reason: string }

/** Files a sandbox command changed, brought back by `sandbox_keep_changes` (plan 2.4). Paths are repo-relative. */
export type KeepFilesRequest = {
    files: { path: string; content: Uint8Array }[]
    removedPaths: string[]
    logIds: LogIds
}

/** `BranchDO`'s RPC methods, as the branch and sandbox tools call them. */
export interface BranchCopy {
    start(request: BranchStartRequest): Promise<BranchStartResult>
    status(): Promise<BranchStatus>
    /** Files written or deleted since workspace revision `rev`, and the revision now. */
    changedSince(request: { rev: number }): Promise<{ rev: number; changes: BranchChange[] }>
    /** Marks the copy as used, so its 5-day alarm counts from now. */
    touch(): Promise<void>
    commitAndPush(request: BranchCommitRequest): Promise<BranchCommitResult>
    keepFiles(request: KeepFilesRequest): Promise<{ kept: number; refused: { path: string; reason: string }[] }>
    /** The copy as one ustar stream for the sandbox, and the revision it holds. */
    archive(logIds: LogIds): Promise<{ archive: ReadableStream<Uint8Array>; rev: number }>
}

/** The GitHub read tools, offered to every member (plan 3.1). With code mode on, scripts call them. */
export const GITHUB_READ_TOOL_NAMES = [
    'github_get_issue',
    'github_list_issues',
    'github_get_pr',
    'github_list_review_comments',
    'github_get_checks',
    'github_read_file',
    'github_compare',
] as const

/** The GitHub write tools, offered only when every pending request is a writer's mention (plan 3.2, 4.1). */
export const GITHUB_WRITE_TOOL_NAMES = [
    'github_create_issue',
    'github_update_issue',
    'github_comment',
    'github_edit_comment',
    'github_create_pr',
    'github_update_pr',
    'github_review_comment',
] as const

/** The branch tools, offered under the same rule as the write tools (plan 3.3). */
export const BRANCH_TOOL_NAMES = [
    'branch_start',
    'branch_read',
    'branch_ls',
    'branch_find',
    'branch_grep',
    'branch_write',
    'branch_edit',
    'branch_delete',
    'branch_status',
    'branch_commit_push',
    'sandbox_keep_changes',
] as const

/** GitHub writes one run may make (plan 4.4). Over the limit, the tool refuses. */
export const RUN_WRITE_LIMITS = {
    issuesCreated: 5,
    comments: 20,
    prsCreated: 3,
    pushes: 20,
    edits: 20,
} as const

export type RunWriteKind = keyof typeof RUN_WRITE_LIMITS
export type RunWriteCounts = Record<RunWriteKind, number>
