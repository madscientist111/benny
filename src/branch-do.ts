import { DurableObject } from "cloudflare:workers";
import { Workspace, type WorkspaceStub } from "@cloudflare/computer";
import { applyCompare, archiveCheckout, fetchCompare, gitBlobSha, importTarball, REPO_DIR } from './checkout'
import {
    BRANCH_COPY_IDLE_DAYS,
    isForbiddenPath,
    isLockfile,
    MAX_FILE_BYTES,
    MAX_LOCKFILE_BYTES,
    type BranchChange,
    type BranchCommitRequest,
    type BranchCommitResult,
    type BranchCopy,
    type BranchStartRequest,
    type BranchStartResult,
    type BranchStatus,
    type KeepFilesRequest,
} from './github/github-contract'
import { GitHubRequestError, githubJson } from './github/github-rest'
import { log, type LogIds } from './log'
import { isSecretPath } from './secret-files'

// One object per work branch (`branchObjectName`): the branch's files, and the commit they started
// from. GitHub holds the history. A commit goes through the Git Data API (a tree on the base tree,
// a commit, a ref update), so no git objects live here (batch 5 plan, 2.1; spike part 2).
//
// The `branch_*` file tools write through `__getWorkspaceStub()`, so no method here runs on such a
// write. What changed is read from the workspace's own revision log instead (`#changedSince`).

const DAY_MS = 24 * 60 * 60 * 1000
const IDLE_MS = BRANCH_COPY_IDLE_DAYS * DAY_MS
const NEW_FILE_MODE = '100644'

/** What the copy holds, kept in `ctx.storage.kv`; timestamps are numbers (AGENTS.md). */
type BranchState = {
    owner: string
    repo: string
    branch: string
    /** The branch the work started from. Never committed to. */
    from: string
    /** The commit the files are based on: the imported one, then each commit Benny makes. */
    commit: string
    /** That commit's tree, the `base_tree` of the next commit. */
    tree: string
    /** The workspace revision right after that commit or import: later revisions are uncommitted work. */
    rev: number
    /** The branch exists on GitHub: the next commit updates it instead of creating it. */
    onGitHub: boolean
}

const STATE_KEY = 'branchState'
/** The `vfs_meta` schema version of `@cloudflare/computer` 0.11.2, whose tables `#changedSince` reads. */
const KNOWN_WORKSPACE_SCHEMA = 10
const LAST_USED_KEY = 'lastUsedAt'

// `ignoreBOM` keeps a byte order mark in the text, so a committed file keeps its bytes.
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

// Why a path may not be committed, or undefined when it may. Plan 4.2: a workflow runs with the
// repo's secrets, secret files never leave, and big or binary files do not go through the tree API.
const refusalReason = (path: string, content?: Uint8Array): string | undefined => {
    if (isForbiddenPath(path)) return 'Benny never changes workflow files'
    if (isSecretPath(`${REPO_DIR}/${path}`)) return 'a secret file'
    if (!content) return undefined
    const limit = isLockfile(path) ? MAX_LOCKFILE_BYTES : MAX_FILE_BYTES
    if (content.byteLength > limit) return `over ${limit / (1024 * 1024)} MiB`
    if (content.includes(0)) return 'a binary file'
    // The tree call takes the content as a string, so the bytes must be UTF-8 text.
    try {
        decoder.decode(content)
    } catch {
        return 'not UTF-8 text'
    }
    return undefined
}

// A branch name in a URL: each segment encoded, the `/` between them kept (`#` and `%` are legal in refs).
const encodeRef = (branch: string) => branch.split('/').map(encodeURIComponent).join('/')

const readBytes = async (stream: ReadableStream<Uint8Array>) => new Uint8Array(await new Response(stream).arrayBuffer())

export class BranchDO extends DurableObject<Env> implements BranchCopy {
    workspace = new Workspace({ storage: this.ctx.storage })

    // The start that is running right now, if any: two branch tools in one run must not import twice.
    #starting: Promise<BranchStartResult> | undefined
    // The last commit queued: two commits in one turn run one after the other, or the second would
    // build on the same base and be refused as a false "branch changed".
    #committing: Promise<unknown> = Promise.resolve()

    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env)
        // Each base file's git blob hash and mode: a file whose hash still matches is not a change.
        ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS branch_base_files (path TEXT PRIMARY KEY, sha TEXT NOT NULL, mode TEXT NOT NULL)`)
    }

    async __getWorkspaceStub(): Promise<WorkspaceStub> {
        this.#requireState()
        await this.workspace.ready()
        return this.workspace.stub()
    }

    async start(request: BranchStartRequest): Promise<BranchStartResult> {
        const alreadyStarting = this.#starting
        if (alreadyStarting) return alreadyStarting
        const starting = this.#startOnce(request).finally(() => {
            this.#starting = undefined
        })
        this.#starting = starting
        return starting
    }

    async #startOnce({ owner, repo, token, branch, from, logIds }: BranchStartRequest): Promise<BranchStartResult> {
        const startedAt = Date.now()
        await this.workspace.ready()
        await this.touch()
        const remoteCommit = await this.#remoteBranchCommit(token, owner, repo, branch)
        const state = this.#state()
        // The branch was on GitHub and is gone: usually its PR was merged and the branch deleted. A copy
        // with work not committed yet keeps it, and the next commit creates the branch again; a clean
        // copy is stale, so it starts again from `from` below.
        const branchGone = Boolean(state && state.branch === branch && state.onGitHub && remoteCommit === null)
        if (state && branchGone && (await this.#uncommitted(state)).length > 0) {
            this.ctx.storage.kv.put<BranchState>(STATE_KEY, { ...state, onGitHub: false })
        }
        if (state && state.branch === branch && !(branchGone && (await this.#uncommitted(state)).length === 0)) {
            const unchanged = remoteCommit === null || remoteCommit === state.commit
            // Someone pushed: catch up when their files and Benny's uncommitted work do not overlap.
            // Otherwise the copy keeps its work, and the next commit reports the branch changed.
            const caughtUp = !unchanged && await this.#catchUp(state, token, remoteCommit, logIds)
            if (unchanged || caughtUp || (await this.#uncommitted(state)).length > 0) {
                const current = this.#requireState()
                log('branch reused', { ...logIds, branch, commit: current.commit, remoteMoved: !unchanged, caughtUp })
                return { commit: current.commit, created: !current.onGitHub, rev: this.#currentRev() }
            }
        }
        const created = remoteCommit === null
        const startCommit = remoteCommit ?? await this.#remoteBranchCommit(token, owner, repo, from)
        if (!startCommit) throw new Error(`The branch ${from} does not exist on GitHub`)
        const { tree } = await githubJson<{ tree: { sha: string } }>(token, 'GET', `/repos/${owner}/${repo}/git/commits/${startCommit}`)
        // The state goes first: an import cut off half way must not look like a finished copy.
        this.ctx.storage.kv.delete(STATE_KEY)
        this.ctx.storage.sql.exec(`DELETE FROM branch_base_files`)
        const sql = this.ctx.storage.sql
        await importTarball({
            workspace: this.workspace, owner, repo, sha: startCommit, token, logIds,
            onFile: async ({ path, content, mode }) => {
                sql.exec(`INSERT OR REPLACE INTO branch_base_files (path, sha, mode) VALUES (?, ?, ?)`,
                    path, await gitBlobSha(content), (mode & 0o111) ? '100755' : NEW_FILE_MODE)
            },
        })
        const rev = this.#currentRev()
        this.ctx.storage.kv.put<BranchState>(STATE_KEY, { owner, repo, branch, from, commit: startCommit, tree: tree.sha, rev, onGitHub: !created })
        log('branch started', { ...logIds, branch, from, commit: startCommit, created, ms: Date.now() - startedAt })
        return { commit: startCommit, created, rev }
    }

    async status(): Promise<BranchStatus> {
        const state = this.#requireState()
        const uncommitted = (await this.#uncommitted(state)).map(({ path, change }) => ({ path, change }))
        return { branch: state.branch, commit: state.commit, uncommitted, onGitHub: state.onGitHub }
    }

    async changedSince({ rev }: { rev: number }): Promise<{ rev: number; changes: BranchChange[] }> {
        return { rev: this.#currentRev(), changes: await this.#changedSince(rev) }
    }

    async touch(): Promise<void> {
        this.ctx.storage.kv.put<number>(LAST_USED_KEY, Date.now())
        // One alarm at a time: each `setAlarm` is a billed row write, so a used copy does not move it.
        if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + IDLE_MS)
    }

    async alarm(): Promise<void> {
        const lastUsedAt = this.ctx.storage.kv.get<number>(LAST_USED_KEY) ?? 0
        if (Date.now() - lastUsedAt < IDLE_MS) {
            await this.ctx.storage.setAlarm(lastUsedAt + IDLE_MS)
            return
        }
        const branch = this.#state()?.branch
        // `deleteAll` clears the alarm too (spike G0). Nothing committed is lost: GitHub has it, and
        // the next `start` imports the branch again.
        await this.ctx.storage.deleteAll()
        log('branch copy deleted', { branch, idleDays: Math.floor((Date.now() - lastUsedAt) / DAY_MS) })
        // As in `RepoDO.destroy`: the in-memory workspace still caches the deleted files.
        this.ctx.abort('branch copy deleted')
    }

    async commitAndPush(request: BranchCommitRequest): Promise<BranchCommitResult> {
        const committed = this.#committing.then(() => this.#commitWithCatchUp(request))
        this.#committing = committed.catch(() => {})
        return committed
    }

    async #commitWithCatchUp(request: BranchCommitRequest): Promise<BranchCommitResult> {
        const result = await this.#commitOnce(request)
        if (result.kind !== 'branch-changed') return result
        // Someone pushed to the branch: catch up when their files and this commit's do not overlap,
        // then try once more. A second refusal goes back to the model as "the branch changed".
        const state = this.#requireState()
        const remoteCommit = await this.#remoteBranchCommit(request.token, state.owner, state.repo, state.branch)
        if (!remoteCommit || !(await this.#catchUp(state, request.token, remoteCommit, request.logIds))) return result
        return this.#commitOnce(request)
    }

    async #commitOnce({ message, token, logIds }: BranchCommitRequest): Promise<BranchCommitResult> {
        const startedAt = Date.now()
        await this.touch()
        const state = this.#requireState()
        if (state.branch === state.from) return { kind: 'refused', reason: `Benny never commits to ${state.from}, the branch the work started from` }
        // Every push goes through here, so this is the last guard of plan 4.1: Benny pushes only to its own branches.
        if (!state.branch.startsWith('bobby/')) return { kind: 'refused', reason: `Benny pushes only to branches named bobby/..., not to ${state.branch}` }
        // Read before the changes: a write that lands while this commit runs is then after the new
        // base revision, so it still counts as uncommitted (the hash compare drops it if it matches).
        const revBeforeCommit = this.#currentRev()
        const changes = await this.#uncommitted(state)
        if (changes.length === 0) return { kind: 'nothing-to-commit' }
        const refused = changes.flatMap((change) => {
            const reason = refusalReason(change.path, change.change === 'deleted' ? undefined : change.content)
            return reason ? [`${change.path} (${reason})`] : []
        })
        if (refused.length > 0) {
            log('branch push refused', { ...logIds, branch: state.branch, reason: 'paths', paths: refused.length })
            return { kind: 'refused', reason: `These files cannot be committed: ${refused.join(', ')}. Undo them with branch_delete or branch_write.` }
        }
        const { owner, repo, branch } = state
        const modeOf = (path: string) =>
            (this.ctx.storage.sql.exec(`SELECT mode FROM branch_base_files WHERE path = ?`, path).toArray()[0]?.mode as string | undefined) ?? NEW_FILE_MODE
        // Every committed file is text (refusalReason rejects binary files), so its content goes
        // inline in the tree call: one call for any number of files, no blob calls (spike part 2).
        const tree = changes.map((change) => change.change === 'deleted'
            ? { path: change.path, mode: modeOf(change.path), type: 'blob', sha: null }
            : { path: change.path, mode: modeOf(change.path), type: 'blob', content: decoder.decode(change.content) })
        const newTree = await githubJson<{ sha: string }>(token, 'POST', `/repos/${owner}/${repo}/git/trees`, { base_tree: state.tree, tree })
        // No author: GitHub then signs the commit as the App, and it shows as Verified.
        const commit = await githubJson<{ sha: string }>(token, 'POST', `/repos/${owner}/${repo}/git/commits`, { message, tree: newTree.sha, parents: [state.commit] })
        // True when this commit creates the branch on GitHub: the first commit, or one after a deletion.
        let createdBranch = false
        const createRef = async () => {
            await githubJson(token, 'POST', `/repos/${owner}/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha })
            createdBranch = true
        }
        try {
            if (!state.onGitHub) {
                await createRef()
            } else {
                try {
                    await githubJson(token, 'PATCH', `/repos/${owner}/${repo}/git/refs/heads/${encodeRef(branch)}`, { sha: commit.sha, force: false })
                } catch (error) {
                    // The branch was deleted on GitHub since the last commit: GitHub answers 422
                    // ("Reference does not exist") or 404. Create it again; a branch that still exists
                    // means someone pushed, which the outer catch reports.
                    const refused = error instanceof GitHubRequestError && (error.status === 404 || error.status === 422)
                    if (!refused || (await this.#remoteBranchCommit(token, owner, repo, branch)) !== null) throw error
                    await createRef()
                }
            }
        } catch (error) {
            // 422: not a fast-forward, or the branch appeared meanwhile. Someone else pushed.
            if (error instanceof GitHubRequestError && error.status === 422) {
                log('branch push refused', { ...logIds, branch, reason: 'branch changed' })
                return { kind: 'branch-changed' }
            }
            throw error
        }
        const sql = this.ctx.storage.sql
        for (const change of changes) {
            if (change.change === 'deleted') sql.exec(`DELETE FROM branch_base_files WHERE path = ?`, change.path)
            else sql.exec(`INSERT OR REPLACE INTO branch_base_files (path, sha, mode) VALUES (?, ?, ?)`, change.path, await gitBlobSha(change.content), modeOf(change.path))
        }
        this.ctx.storage.kv.put<BranchState>(STATE_KEY, { ...state, commit: commit.sha, tree: newTree.sha, rev: revBeforeCommit, onGitHub: true })
        log('branch pushed', { ...logIds, branch, commit: commit.sha, files: changes.length, createdBranch, ms: Date.now() - startedAt })
        return { kind: 'committed', commit: commit.sha, files: changes.length, createdBranch }
    }

    async keepFiles({ files, removedPaths, logIds }: KeepFilesRequest): Promise<{ kept: number; refused: { path: string; reason: string }[] }> {
        await this.touch()
        this.#requireState()
        const fs = this.workspace.fs
        const refused: { path: string; reason: string }[] = []
        let kept = 0
        for (const file of files) {
            const reason = refusalReason(file.path, file.content)
            if (reason) {
                refused.push({ path: file.path, reason })
                continue
            }
            if (file.path.includes('/')) await fs.mkdir(`${REPO_DIR}/${file.path.slice(0, file.path.lastIndexOf('/'))}`, { recursive: true })
            await fs.writeFile(`${REPO_DIR}/${file.path}`, file.content)
            kept += 1
        }
        for (const path of removedPaths) {
            const reason = refusalReason(path)
            if (reason) {
                refused.push({ path, reason })
                continue
            }
            await fs.rm(`${REPO_DIR}/${path}`, { force: true })
            kept += 1
        }
        log('branch files kept', { ...logIds, kept, refused: refused.length })
        return { kept, refused }
    }

    async archive(logIds: LogIds): Promise<{ archive: ReadableStream<Uint8Array>; rev: number }> {
        // A copy the 5-day alarm deleted has no files: say what to do, not "no such directory".
        this.#requireState()
        await this.touch()
        const startedAt = Date.now()
        // The revision is read before the walk: a write during the walk then shows up in the next
        // `changedSince`, never goes missing.
        const rev = this.#currentRev()
        const archive = archiveCheckout(this.workspace.fs, (counts) => {
            log('branch archived', { ...logIds, ...counts, ms: Date.now() - startedAt })
        }, logIds)
        return { archive, rev }
    }

    // Moves the copy's base to `remoteCommit` when someone else pushed to the branch: their files
    // come in through GitHub's compare, and the base records their hashes, so they are not Benny's
    // changes. False, with nothing changed, when a file they changed is one Benny has not committed
    // yet, or the compare cannot list the change (a force push).
    async #catchUp(state: BranchState, token: string, remoteCommit: string, logIds: LogIds): Promise<boolean> {
        try {
            return await this.#catchUpOnce(state, token, remoteCommit, logIds)
        } catch (error) {
            // A GitHub error here (a compare after a force push, a blob over 100 MB, a submodule) must
            // not fail the start or the commit: `start` imports again, and a commit reports the change.
            log('branch catch-up failed', { ...logIds, branch: state.branch, error: String(error) })
            return false
        }
    }

    async #catchUpOnce(state: BranchState, token: string, remoteCommit: string, logIds: LogIds): Promise<boolean> {
        const files = await fetchCompare({ owner: state.owner, repo: state.repo, token, from: state.commit, to: remoteCommit })
        if (!files) return false
        const ownPaths = new Set((await this.#uncommitted(state)).map((change) => change.path))
        const overlapping = files.filter((file) => ownPaths.has(file.filename) || (file.previous_filename !== undefined && ownPaths.has(file.previous_filename)))
        if (overlapping.length > 0) {
            log('branch catch-up refused', { ...logIds, branch: state.branch, overlapping: overlapping.length })
            return false
        }
        const sql = this.ctx.storage.sql
        await applyCompare({
            workspace: this.workspace, owner: state.owner, repo: state.repo, token, files,
            // GitHub's compare gives no file mode; a file already known keeps its own.
            onWrite: (path, sha) => sql.exec(
                `INSERT INTO branch_base_files (path, sha, mode) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET sha = excluded.sha`,
                path, sha, NEW_FILE_MODE),
            onRemove: (path) => sql.exec(`DELETE FROM branch_base_files WHERE path = ?`, path),
        })
        const { tree } = await githubJson<{ tree: { sha: string } }>(token, 'GET', `/repos/${state.owner}/${state.repo}/git/commits/${remoteCommit}`)
        // `rev` stays: the files just written match the base now, so they do not count as Benny's
        // changes, and Benny's own writes after `rev` still do.
        this.ctx.storage.kv.put<BranchState>(STATE_KEY, { ...state, commit: remoteCommit, tree: tree.sha, onGitHub: true })
        log('branch caught up', { ...logIds, branch: state.branch, commit: remoteCommit, files: files.length })
        return true
    }

    #state(): BranchState | undefined {
        return this.ctx.storage.kv.get<BranchState>(STATE_KEY)
    }

    #requireState(): BranchState {
        const state = this.#state()
        if (!state) throw new Error('No work branch is open: call branch_start first')
        return state
    }

    // The branch's head commit on GitHub, or null when the branch does not exist there.
    async #remoteBranchCommit(token: string, owner: string, repo: string, branch: string): Promise<string | null> {
        try {
            const { object } = await githubJson<{ object: { sha: string } }>(token, 'GET', `/repos/${owner}/${repo}/git/ref/heads/${encodeRef(branch)}`)
            return object.sha
        } catch (error) {
            if (error instanceof GitHubRequestError && error.status === 404) return null
            throw error
        }
    }

    // The workspace revision counter, which every write bumps (Computer's `vfs_meta`; spike part 2).
    #currentRev(): number {
        return (this.ctx.storage.sql.exec(`SELECT v FROM vfs_meta WHERE k = 'rev'`).toArray()[0]?.v as number | undefined) ?? 0
    }

    // Files written or deleted under /repo after revision `rev`, from Computer's revision log: two
    // indexed queries instead of a walk (0.5 s against 10.8 s on next.js). These tables are
    // Computer internals; `@cloudflare/computer` is pinned in package.json for this reason.
    async #changedSince(rev: number): Promise<BranchChange[]> {
        const sql = this.ctx.storage.sql
        // A Computer upgrade that changes these tables must fail loudly, not report "no changes".
        const schemaVersion = sql.exec(`SELECT v FROM vfs_meta WHERE k = 'schema_version'`).toArray()[0]?.v
        if (schemaVersion !== KNOWN_WORKSPACE_SCHEMA) {
            throw new Error(`Computer's workspace schema is version ${String(schemaVersion)}, not ${KNOWN_WORKSPACE_SCHEMA}: update BranchDO's revision-log queries`)
        }
        const pathOf = (inode: number) => {
            const names: string[] = []
            for (let node = inode; ;) {
                const row = sql.exec(`SELECT parent_inode, name FROM vfs_dirents WHERE child_inode = ?`, node).toArray()[0]
                if (!row) break
                names.unshift(row.name as string)
                node = row.parent_inode as number
            }
            return `/${names.join('/')}`
        }
        const prefix = `${REPO_DIR}/`
        const written = sql.exec(`SELECT inode FROM vfs_nodes WHERE rev > ? AND type = 'file'`, rev).toArray()
            .map((row) => pathOf(row.inode as number))
            .filter((path) => path.startsWith(prefix))
        const writtenSet = new Set(written)
        const changes: BranchChange[] = []
        for (const fullPath of written) {
            // A file deleted since the list was read is a delete in the next call, not an error now.
            const content = await this.workspace.fs.readFile(fullPath).then(readBytes, () => undefined)
            if (content) changes.push({ path: fullPath.slice(prefix.length), change: 'modified', content })
        }
        const deleted = sql.exec(`SELECT DISTINCT path FROM vfs_changes WHERE rev > ? AND op = 'delete'`, rev).toArray()
            .map((row) => row.path as string)
            .filter((path) => path.startsWith(prefix) && !writtenSet.has(path))
        for (const fullPath of deleted) {
            // A path deleted and then written again is in `written`; one still missing is a delete.
            const exists = await this.workspace.fs.stat(fullPath).then(() => true, () => false)
            if (!exists) changes.push({ path: fullPath.slice(prefix.length), change: 'deleted' })
        }
        return changes
    }

    // Changes since the base commit, compared with the base: a file written back with its old
    // content is no change, and a file the base lacks is added.
    async #uncommitted(state: BranchState): Promise<BranchChange[]> {
        const sql = this.ctx.storage.sql
        const baseSha = (path: string) => sql.exec(`SELECT sha FROM branch_base_files WHERE path = ?`, path).toArray()[0]?.sha as string | undefined
        const changes: BranchChange[] = []
        for (const change of await this.#changedSince(state.rev)) {
            const base = baseSha(change.path)
            if (change.change === 'deleted') {
                if (base) changes.push(change)
                continue
            }
            if (!base) changes.push({ path: change.path, change: 'added', content: change.content })
            else if (base !== await gitBlobSha(change.content)) changes.push(change)
        }
        return changes
    }
}
