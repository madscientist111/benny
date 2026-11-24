import { DurableObject } from "cloudflare:workers";
import { Workspace, type WorkspaceStub } from "@cloudflare/computer";
import { applyCompare, archiveCheckout, fetchCompare, importTarball, importTarStream, REPO_DIR, type ImportCounts } from './checkout'
import { lowerRepoName } from './github/contract'
import { githubJson } from './github/rest'
import { log, type LogIds } from './log'
import { fetchPublicTarball, PUBLIC_REPO_LIMITS } from './public-repo'

/** Benny's git author: the `bobby-sb[bot]` account, so its commits link to the bot on GitHub. */
export const BENNY_GIT_IDENTITY = { name: 'bobby-sb[bot]', email: '356604674+bobby-sb[bot]@users.noreply.github.com' }

/** Name of the one RepoDO for a repo. GitHub names are case-insensitive. */
export const repoObjectName = lowerRepoName

/** `clone`: a full tarball import. `pull`: only the files GitHub's compare lists. */
export type SyncResult = { action: 'clone' | 'pull' | 'unchanged'; commit: string }

// The checked-out commit. A copy made before batch 5 (a git clone) has none, so its first sync
// imports the tarball over it.
const COMMIT_KEY = 'commit'

// A public repo's copy (issue #51) and when it was imported. A copy younger than a day is reused, so
// one thread's `public_import` does not empty the copy another thread is reading: an import deletes
// the directory before it writes the new files.
const PUBLIC_IMPORT_KEY = 'publicImport'
const PUBLIC_COPY_FRESH_MS = 24 * 60 * 60 * 1000
type PublicImport = ImportCounts & { importedAt: number }

// One object per GitHub repo. It holds the only copy of its default branch, as files without git
// history; thread agents read it over RPC and never write to it (requirements 1-3, 23).
//
// Internal methods use `#` (JavaScript private), not TypeScript's `private`. `private` is only a
// compile-time check: at runtime the method is public, so any holder of a stub could call
// `stub.syncOnce()` over RPC and skip the one-sync-at-a-time guard in `sync`. `#` methods are not
// properties, so RPC cannot reach them. Every public method here is an RPC endpoint.
export class RepoDO extends DurableObject<Env> {
    workspace = new Workspace({ storage: this.ctx.storage })

    // The sync that is running right now, if any. A push webhook and a mention for the same
    // repo can arrive together, and the second caller must await this one instead of starting
    // a second import on the same checkout.
    #syncing: Promise<SyncResult> | undefined
    // The public import that is running right now, if any, for the same reason: a second caller
    // awaits it instead of emptying the copy the first one is writing.
    #importingPublic: Promise<ImportCounts> | undefined

    // Lets another object read this workspace through `getWorkspace(stub)`.
    async __getWorkspaceStub(): Promise<WorkspaceStub> {
        await this.workspace.ready();
        return this.workspace.stub();
    }

    /** The checkout as one ustar stream, secret files and the root `.git` left out, for a sandbox copy. */
    async archive(logIds: LogIds): Promise<ReadableStream<Uint8Array>> {
        const startedAt = Date.now()
        return archiveCheckout(this.workspace.fs, (counts) => {
            log('repo archived', { ...logIds, ...counts, ms: Date.now() - startedAt })
        }, logIds)
    }

    /** Imports the default branch on the first call, then applies what changed. Returns the checked-out commit. */
    async sync({ owner, repo, token, logIds }: { owner: string; repo: string; token: string; logIds: LogIds }): Promise<SyncResult> {
        const alreadySyncing = this.#syncing
        if (alreadySyncing) {
            // The sync below runs under the first caller's ids, so this line is the only trace of
            // the caller that waited for it.
            log('repo sync joined', { ...logIds, owner, repo })
            return alreadySyncing
        }
        const syncing = this.#syncOnce({ owner, repo, token, logIds }).finally(() => {
            // Cleared on success and on error, so the next call starts a fresh sync.
            this.#syncing = undefined
        })
        this.#syncing = syncing
        return syncing
    }

    // The token goes into the request headers only, so it never reaches the model and never shows
    // up in the logs below.
    async #syncOnce({ owner, repo, token, logIds }: { owner: string; repo: string; token: string; logIds: LogIds }): Promise<SyncResult> {
        const startedAt = Date.now()
        await this.workspace.ready()
        const { default_branch: defaultBranch } = await githubJson<{ default_branch: string }>(token, 'GET', `/repos/${owner}/${repo}`)
        const { sha: commit } = await githubJson<{ sha: string }>(token, 'GET', `/repos/${owner}/${repo}/commits/${encodeURIComponent(defaultBranch)}`)
        const commitBefore = this.ctx.storage.kv.get<string>(COMMIT_KEY)
        let action: SyncResult['action']
        // The files a push changed, when GitHub's compare can list them all.
        let compareFiles: Awaited<ReturnType<typeof fetchCompare>> = null
        if (commitBefore === commit) {
            action = 'unchanged'
        } else if (commitBefore && (compareFiles = await fetchCompare({ owner, repo, token, from: commitBefore, to: commit }))) {
            await applyCompare({ workspace: this.workspace, owner, repo, token, files: compareFiles })
            action = 'pull'
        } else {
            // The commit key goes first: an import cut off half way must not look like a finished copy.
            this.ctx.storage.kv.delete(COMMIT_KEY)
            await importTarball({ workspace: this.workspace, owner, repo, sha: commit, token, logIds })
            action = 'clone'
        }
        this.ctx.storage.kv.put(COMMIT_KEY, commit)
        log('repo synced', { ...logIds, owner, repo, action, commit, ms: Date.now() - startedAt })
        return { action, commit }
    }

    /**
     * Replaces the copy with the default branch of a public repo another thread linked, at the caps
     * of a secondary repo (issue #51). No token goes in: a private repo answers 404 at codeload.
     * Past a cap this throws and keeps no copy, so `PiAgent` records only a repo that is on disk.
     */
    async importPublic({ owner, repo, logIds }: { owner: string; repo: string; logIds: LogIds }): Promise<ImportCounts> {
        const stored = this.ctx.storage.kv.get<PublicImport>(PUBLIC_IMPORT_KEY)
        if (stored && Date.now() - stored.importedAt < PUBLIC_COPY_FRESH_MS) {
            log('public repo reused', { ...logIds, owner, repo, files: stored.files, ageMs: Date.now() - stored.importedAt })
            return { files: stored.files, bytes: stored.bytes, skipped: stored.skipped }
        }
        if (this.#importingPublic) {
            log('public repo import joined', { ...logIds, owner, repo })
            return this.#importingPublic
        }
        const importing = (async () => {
            const startedAt = Date.now()
            await this.workspace.ready()
            // A failed import deletes the copy, so the stored date goes first: no reader is told it is fresh.
            this.ctx.storage.kv.delete(PUBLIC_IMPORT_KEY)
            const tarball = await fetchPublicTarball(owner, repo)
            const counts = await importTarStream({
                fs: this.workspace.fs, directory: REPO_DIR, tarball,
                maxBytes: PUBLIC_REPO_LIMITS.bytes, maxFiles: PUBLIC_REPO_LIMITS.files,
            })
            this.ctx.storage.kv.put<PublicImport>(PUBLIC_IMPORT_KEY, { ...counts, importedAt: Date.now() })
            log('public repo imported', { ...logIds, owner, repo, ...counts, ms: Date.now() - startedAt })
            return counts
        })().finally(() => {
            // Cleared on success and on error, so the next call starts a fresh import.
            this.#importingPublic = undefined
        })
        this.#importingPublic = importing
        return importing
    }

    /** The checked-out commit, or null before the first sync. */
    async commit(): Promise<string | null> {
        return this.ctx.storage.kv.get<string>(COMMIT_KEY) ?? null
    }

    /** Deletes the copy, for when the App is removed from the repo (requirement 26). */
    async destroy(logIds: LogIds): Promise<void> {
        await this.ctx.storage.deleteAll()
        log('repo destroyed', { ...logIds })
        // `deleteAll` wipes the files the in-memory workspace caches, so this object must not
        // answer another request with it. `ctx.abort` throws and rejects this RPC, which is how
        // the caller knows the object is gone: a rejected `destroy` means success here, and the
        // next request gets a fresh object.
        this.ctx.abort('repo destroyed')
    }
}
