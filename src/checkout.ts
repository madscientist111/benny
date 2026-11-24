import type { Workspace } from '@cloudflare/computer'
import { githubJson, githubStream } from './github/github-rest'
import { log, type LogIds } from './log'
import { tarStream, type TarEntry } from './sandbox-tar'
import { isSecretPath } from './secret-files'

// A repo checkout at `/repo` in a workspace, as `RepoDO` and `BranchDO` keep one: brought in from
// GitHub's tarball, and archived for a sandbox. Both stream one file at a time, so memory holds one
// file, never the repo. A git clone holds the whole pack in memory and failed for next.js in a
// deployed Durable Object, while the tarball import took 25 s (batch 5 spike,
// `docs/learnings/git-and-github.md`).

/** Where the repo is checked out, relative to the workspace root. */
export const REPO_DIR = '/repo'

const BLOCK_BYTES = 512
const textDecoder = new TextDecoder()

/** One imported file, for a caller that records what the copy started from. */
export type ImportedFile = { path: string; content: Uint8Array; mode: number }

/** What one import put in, and what it left out. */
export type ImportCounts = { files: number; bytes: number; skipped: number }

export type ImportResult = ImportCounts & { ms: number }

// Hands out exact byte counts from a stream, keeping only what was read and not handed out yet.
class ByteReader {
    #reader: ReadableStreamDefaultReader<Uint8Array>
    #buffered: Uint8Array[] = []
    #bufferedBytes = 0

    constructor(stream: ReadableStream<Uint8Array>) {
        this.#reader = stream.getReader()
    }

    /** The next `byteCount` bytes, or null at the end of the stream. */
    async read(byteCount: number): Promise<Uint8Array | null> {
        while (this.#bufferedBytes < byteCount) {
            const { value, done } = await this.#reader.read()
            if (done) return null
            this.#buffered.push(value)
            this.#bufferedBytes += value.byteLength
        }
        const out = new Uint8Array(byteCount)
        let filled = 0
        while (filled < byteCount) {
            const head = this.#buffered[0]
            const taken = Math.min(head.byteLength, byteCount - filled)
            out.set(head.subarray(0, taken), filled)
            filled += taken
            if (taken === head.byteLength) this.#buffered.shift()
            else this.#buffered[0] = head.subarray(taken)
        }
        this.#bufferedBytes -= byteCount
        return out
    }
}

const headerText = (header: Uint8Array, offset: number, length: number) =>
    textDecoder.decode(header.subarray(offset, offset + length)).replace(/\0.*$/s, '')
const headerOctal = (header: Uint8Array, offset: number, length: number) =>
    parseInt(headerText(header, offset, length).trim() || '0', 8)

// The `path` record of a pax extended header ("<length> path=<value>\n" records), for long paths.
const paxPath = (body: Uint8Array) => {
    for (const record of textDecoder.decode(body).split('\n')) {
        const match = record.match(/^\d+ path=(.*)$/s)
        if (match) return match[1]
    }
    return undefined
}

/** Git's id for a file's content: `sha1("blob <size>\0" + bytes)`, as GitHub's trees list it. */
export const gitBlobSha = async (content: Uint8Array): Promise<string> => {
    const prefix = new TextEncoder().encode(`blob ${content.byteLength}\0`)
    const whole = new Uint8Array(prefix.byteLength + content.byteLength)
    whole.set(prefix)
    whole.set(content, prefix.byteLength)
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', whole))
    return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Replaces `directory` with the files of one gzipped tar stream, such as GitHub's tarball.
 * `onFile` sees every file written, for a caller that keeps hashes. Symlinks and secret files are
 * skipped, as `archive` skips them: a link can point outside the checkout, and a secret file never
 * lands in a copy Benny reads. Past `maxFiles` or `maxBytes` the import throws and keeps no partial
 * copy. While it runs, `directory` holds only the files written so far.
 */
export const importTarStream = async ({ fs, directory, tarball, maxBytes = Number.POSITIVE_INFINITY, maxFiles = Number.POSITIVE_INFINITY, onFile }: {
    fs: Workspace['fs']
    directory: string
    tarball: ReadableStream<Uint8Array>
    maxBytes?: number
    maxFiles?: number
    onFile?: (file: ImportedFile) => Promise<void> | void
}): Promise<ImportCounts> => {
    await fs.rm(directory, { recursive: true, force: true })
    await fs.mkdir(directory, { recursive: true })
    try {
        const reader = new ByteReader(tarball.pipeThrough(new DecompressionStream('gzip')))

        let files = 0
        let bytes = 0
        let skipped = 0
        // A pax `x` or GNU `L` header names the path of the entry right after it.
        let nextPath: string | undefined
        for (;;) {
            const header = await reader.read(BLOCK_BYTES)
            // A body cut on a block boundary must not pass for a whole archive: only the zero block ends it.
            if (!header) throw new Error('The tarball ended before its end marker')
            if (header.every((byte) => byte === 0)) break
            const size = headerOctal(header, 124, 12)
            const type = String.fromCharCode(header[156] || 48)
            const paddedSize = Math.ceil(size / BLOCK_BYTES) * BLOCK_BYTES
            const readBody = async () => {
                const body = paddedSize > 0 ? await reader.read(paddedSize) : new Uint8Array(0)
                if (!body) throw new Error('The tarball ended in the middle of a file')
                return body.subarray(0, size)
            }
            if (type === 'x' || type === 'g' || type === 'L') {
                const body = await readBody()
                if (type === 'x') nextPath = paxPath(body) ?? nextPath
                if (type === 'L') nextPath = textDecoder.decode(body).replace(/\0.*$/s, '')
                continue
            }
            const prefix = headerText(header, 345, 155)
            const name = headerText(header, 0, 100)
            const archivePath = nextPath ?? (prefix ? `${prefix}/${name}` : name)
            nextPath = undefined
            // GitHub puts every entry under one top directory, `<owner>-<repo>-<short sha>/`.
            const path = archivePath.split('/').slice(1).join('/').replace(/\/$/, '')
            if (type === '5') {
                if (path) await fs.mkdir(`${directory}/${path}`, { recursive: true })
                continue
            }
            if ((type !== '0' && type !== '7') || !path || isSecretPath(path)) {
                await readBody()
                skipped += 1
                continue
            }
            const content = await readBody()
            await fs.writeFile(`${directory}/${path}`, content)
            await onFile?.({ path, content, mode: headerOctal(header, 100, 8) })
            files += 1
            bytes += size
            // Checked after each file, so a repo with many small files and one with a few big ones both stop at the cap.
            if (files > maxFiles || bytes > maxBytes) {
                throw new Error(`The repo is over the import cap of ${maxFiles} files and ${maxBytes} bytes, so it kept no copy.`)
            }
        }
        return { files, bytes, skipped }
    } catch (error) {
        // A cap or a cut stream keeps no partial copy: the next reader must see nothing to read.
        await fs.rm(directory, { recursive: true, force: true })
        throw error
    }
}


/**
 * Replaces the workspace's `/repo` with commit `sha` of `owner/repo`.
 */
export const importTarball = async ({ workspace, owner, repo, sha, token, onFile, logIds }: {
    workspace: Workspace
    owner: string
    repo: string
    sha: string
    token: string
    onFile?: (file: ImportedFile) => Promise<void> | void
    logIds: LogIds
}): Promise<ImportResult> => {
    const startedAt = Date.now()
    const tarball = await githubStream(token, `/repos/${owner}/${repo}/tarball/${sha}`)
    const counts = await importTarStream({ fs: workspace.fs, directory: REPO_DIR, tarball, onFile })
    const result = { ...counts, ms: Date.now() - startedAt }
    log('tarball imported', { ...logIds, owner, repo, commit: sha, ...result })
    return result
}

/**
 * A checkout at `/repo` as one ustar stream for a sandbox copy: secret files and the root `.git`
 * left out, symlinks skipped. Used by `RepoDO` and `BranchDO`; `onEnd` gets what went in.
 */
export const archiveCheckout = (
    fs: Workspace['fs'],
    onEnd: (counts: { files: number; skippedSecret: number; bytes: number }) => void,
    logIds: LogIds,
): ReadableStream<Uint8Array> => {
    let files = 0
    let skippedSecret = 0
    // Pulled by the tar stream one entry at a time, so the walk and the archive cost the same.
    const walk = async function* (directory: string): AsyncGenerator<TarEntry> {
        for (const entry of await fs.readdir(directory)) {
            const fullPath = `${directory}/${entry.name}`
            // The sandbox runs code, it does not need history, and a copy made before batch 5 still
            // has a `.git`, so the root checkout directory gets no entry and no walk.
            if (fullPath === `${REPO_DIR}/.git`) continue
            if (isSecretPath(fullPath)) {
                skippedSecret += 1
                continue
            }
            // Only files and directories go in: a link can point outside the checkout.
            if (entry.isSymbolicLink) continue
            const path = fullPath.slice(REPO_DIR.length + 1)
            const mtime = Math.floor(entry.mtime / 1000)
            if (entry.isDirectory) {
                yield { path, type: 'directory', mtime, size: 0 }
                yield* walk(fullPath)
            } else if (entry.isFile) {
                files += 1
                yield { path, type: 'file', mtime, size: entry.size, read: () => fs.readFile(fullPath) }
            }
        }
    }
    return tarStream(walk(REPO_DIR), (bytes) => onEnd({ files, skippedSecret, bytes }), logIds)
}

// GitHub's compare lists at most 300 files; a longer list is cut, so a change that big needs a full import.
const COMPARE_FILE_LIMIT = 300

/** One file GitHub's compare lists between two commits. */
export type CompareFile = { filename: string; status: string; sha: string; previous_filename?: string }

/**
 * The files that changed from commit `from` to commit `to`, or null when `to` is not simply ahead
 * of `from` (a force push) or the list is cut at 300 files: then only a full import is right.
 */
export const fetchCompare = async ({ owner, repo, token, from, to }: { owner: string; repo: string; token: string; from: string; to: string }): Promise<CompareFile[] | null> => {
    const compare = await githubJson<{ status: string; files?: CompareFile[] }>(token, 'GET', `/repos/${owner}/${repo}/compare/${from}...${to}`)
    const files = compare.files ?? []
    if (compare.status !== 'ahead' || files.length >= COMPARE_FILE_LIMIT) return null
    return files
}

/**
 * Writes the compare's files into `/repo`: new content for added and changed files, removal for
 * removed ones and a rename's old path. `onWrite` and `onRemove` let a caller keep its own record.
 */
export const applyCompare = async ({ workspace, owner, repo, token, files, onWrite, onRemove }: {
    workspace: Workspace
    owner: string
    repo: string
    token: string
    files: CompareFile[]
    onWrite?: (path: string, sha: string) => void
    onRemove?: (path: string) => void
}): Promise<void> => {
    const fs = workspace.fs
    for (const file of files) {
        if (file.status === 'removed') {
            await fs.rm(`${REPO_DIR}/${file.filename}`, { force: true })
            onRemove?.(file.filename)
            continue
        }
        if (file.status === 'renamed' && file.previous_filename) {
            await fs.rm(`${REPO_DIR}/${file.previous_filename}`, { force: true })
            onRemove?.(file.previous_filename)
        }
        const blob = await githubJson<{ content: string }>(token, 'GET', `/repos/${owner}/${repo}/git/blobs/${file.sha}`)
        const content = Uint8Array.from(atob(blob.content.replace(/\n/g, '')), (character) => character.charCodeAt(0))
        if (file.filename.includes('/')) await fs.mkdir(`${REPO_DIR}/${file.filename.slice(0, file.filename.lastIndexOf('/'))}`, { recursive: true })
        await fs.writeFile(`${REPO_DIR}/${file.filename}`, content)
        onWrite?.(file.filename, file.sha)
    }
}
