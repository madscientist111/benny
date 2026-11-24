import type { GitHubAdapter } from '@chat-adapter/github'
import type { PrChanges } from '../pi-agent'
import { log } from '../log'
import { isSecretPath } from '../secret-files'

// Loads a PR's version of its changed files from GitHub for `PiAgent.replacePrChanges`, and writes
// the summary that tells the model which files the PR changes. Secret, binary and oversized files
// are left out and named in that summary.

type Octokit = GitHubAdapter['octokit']
type ChangedFile = Awaited<ReturnType<Octokit['pulls']['listFiles']>>['data'][number]

// Blobs are read eight at a time: enough to hide the round trip, few enough that GitHub's
// secondary rate limits stay quiet.
const BLOB_BATCH_SIZE = 8
// One file larger than this rarely helps an answer, and 300 of them would not fit anyway.
const MAX_BLOB_BYTES = 512 * 1024
const MAX_PR_CHANGES_BYTES = 5 * 1024 * 1024
const MAX_PR_CHANGES_FILES = 300
const HEAD_SHA_CHARS = 7

// Why a changed file is not in the PR changes. The summary spells each reason out for the model.
type SkipReason = 'secret' | 'too big' | 'binary' | 'over the PR size limit'

export const loadPrChanges = async (
    octokit: Octokit,
    { owner, repo, prNumber, requestId, knownHead }: {
        owner: string; repo: string; prNumber: number; requestId: string; knownHead: string | null
    },
): Promise<{ headSha: string; prChanges: PrChanges | null; summary: string }> => {
    const startedAt = Date.now()
    const { data: pull } = await octokit.pulls.get({ owner, repo, pull_number: prNumber })
    const headSha = pull.head.sha
    const changedFiles = await octokit.paginate(octokit.pulls.listFiles, {
        owner, repo, pull_number: prNumber, per_page: 100,
    })

    const changedFileContents: PrChanges['files'] = []
    const skipReasons = new Map<string, SkipReason>()
    let prChangesBytes = 0

    // The thread already holds this head commit, so reading the blobs again would change nothing
    // (requirement 30).
    if (knownHead !== headSha) {
        // Files whose PR version can be read, with a blob sha the type still marks as optional.
        const fetchable: (ChangedFile & { sha: string })[] = []
        for (const file of changedFiles) {
            // A removed file has no PR version to read.
            if (file.status === 'removed') continue
            if (isSecretPath(file.filename)) {
                skipReasons.set(file.filename, 'secret')
                continue
            }
            // GitHub sends a blob sha for every file it keeps, though the type allows null.
            if (!file.sha) continue
            fetchable.push({ ...file, sha: file.sha })
        }

        let nextIndex = 0
        while (nextIndex < fetchable.length && changedFileContents.length < MAX_PR_CHANGES_FILES && prChangesBytes < MAX_PR_CHANGES_BYTES) {
            const batch = fetchable.slice(nextIndex, nextIndex + BLOB_BATCH_SIZE)
            nextIndex += batch.length
            const fileBlobs = await Promise.all(batch.map(async (file) => {
                const { data: blob } = await octokit.git.getBlob({ owner, repo, file_sha: file.sha })
                return { file, blob }
            }))
            for (const { file, blob } of fileBlobs) {
                if (changedFileContents.length >= MAX_PR_CHANGES_FILES || prChangesBytes >= MAX_PR_CHANGES_BYTES) {
                    skipReasons.set(file.filename, 'over the PR size limit')
                    continue
                }
                // GitHub sends the size; a null one is measured after decoding.
                if (blob.size !== null && blob.size > MAX_BLOB_BYTES) {
                    skipReasons.set(file.filename, 'too big')
                    continue
                }
                // `atob` gives one character per byte; a NUL byte means the file is not text.
                const bytes = Uint8Array.from(atob(blob.content), (character) => character.charCodeAt(0))
                if (bytes.length > MAX_BLOB_BYTES) {
                    skipReasons.set(file.filename, 'too big')
                    continue
                }
                if (bytes.includes(0)) {
                    skipReasons.set(file.filename, 'binary')
                    continue
                }
                changedFileContents.push({ path: file.filename, content: new TextDecoder().decode(bytes) })
                prChangesBytes += bytes.length
            }
        }
        // These files were never fetched, because the cap was reached first.
        for (const file of fetchable.slice(nextIndex)) skipReasons.set(file.filename, 'over the PR size limit')
    }

    // Walk the changed files again so the skipped list keeps the order GitHub gave.
    const skipped = changedFiles.flatMap((file) => {
        const reason = skipReasons.get(file.filename)
        return reason ? [{ path: file.filename, reason }] : []
    })

    // A removed file has no PR version, and a renamed one leaves its old path in the branch copy:
    // both have to go from the sandbox's copy before the PR files land on top.
    const removedPaths = changedFiles.flatMap((file) => {
        if (file.status === 'removed') return [file.filename]
        if (file.status === 'renamed' && file.previous_filename) return [file.previous_filename]
        return []
    })

    const summaryLines = [
        `This is PR #${prNumber} at head commit ${headSha.slice(0, HEAD_SHA_CHARS)}. The PR changes these files:`,
        ...changedFiles.map((file) => file.status === 'renamed' && file.previous_filename
            ? `renamed ${file.previous_filename} -> ${file.filename}`
            : `${file.status} ${file.filename}`),
        // Worded for both modes: with code mode on, scripts call these tools as `tools.pr_read(...)`.
        'The pr_read, pr_ls, pr_find and pr_grep tools read the PR version of a changed file at the same /repo/... paths. Files the PR does not change are the same as in /repo.',
    ]
    // Only files skipped by this fetch belong here; a known head fetched none.
    if (skipped.length > 0) {
        summaryLines.push(`Not available in the PR version: ${skipped.map((file) => `${file.path} (${file.reason})`).join(', ')}.`)
    }

    const prChanges = knownHead === headSha ? null : { headSha, files: changedFileContents, removedPaths }
    log('pr changes loaded', {
        owner, repo, prNumber, requestId, headSha,
        fetched: changedFileContents.length,
        removed: removedPaths.length,
        skipped: skipped.length,
        ms: Date.now() - startedAt,
    })
    return { headSha, prChanges, summary: summaryLines.join('\n') }
}
