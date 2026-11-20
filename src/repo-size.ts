import type { GitHubAdapter } from '@chat-adapter/github'
import { log } from './log'

type Octokit = GitHubAdapter['octokit']

// A Durable Object holds about 10 GB, and Cloudflare's docs say the workspace is not for very
// large repos: a clone past one gigabyte is slow or fails instead of answering the question.
const MAX_REPO_KB = 1024 * 1024

export const checkRepoSize = async (octokit: Octokit, owner: string, repo: string, requestId: string): Promise<void> => {
    const { data: repository } = await octokit.repos.get({ owner, repo })
    // `size` is in kilobytes.
    const sizeKb = repository.size
    if (sizeKb <= MAX_REPO_KB) return
    // The cap is exactly one gigabyte, so it doubles as the divisor.
    const sizeGb = (sizeKb / MAX_REPO_KB).toFixed(1)
    log('repo too big', { owner, repo, requestId, sizeKb })
    throw new Error(`This repository is about ${sizeGb} GB. Benny can read repositories up to 1 GB`)
}
