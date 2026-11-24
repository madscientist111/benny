// GitHub REST calls from a Durable Object (`RepoDO`, `BranchDO`). The installation token goes into
// the request headers only: it never reaches the model, a file or a log line. `PiAgent`'s tools use
// the Chat SDK adapter's Octokit instead; a Durable Object has only the token it was handed.

const GITHUB_API = 'https://api.github.com'

export const githubHeaders = (token: string): Record<string, string> => ({
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'bobby-sb',
    'X-GitHub-Api-Version': '2022-11-28',
})

/** A GitHub answer that was not 2xx. `status` lets a caller tell a refused ref update (422) from a failure. */
export class GitHubRequestError extends Error {
    constructor(readonly status: number, message: string) {
        super(message)
    }
}

/** One JSON request. `path` starts with `/repos/...`; the error names the method, path and status, never the token. */
export const githubJson = async <T>(token: string, method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${GITHUB_API}${path}`, {
        method,
        headers: { ...githubHeaders(token), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!response.ok) {
        // GitHub's own message is short and holds no secret; it says why (for example "Reference already exists").
        const detail = await response.text().then((text) => text.slice(0, 300), () => '')
        throw new GitHubRequestError(response.status, `GitHub ${method} ${path}: ${response.status} ${detail}`)
    }
    return response.json() as Promise<T>
}

/** A streamed GitHub download, such as a tarball. */
export const githubStream = async (token: string, path: string): Promise<ReadableStream<Uint8Array>> => {
    const response = await fetch(`${GITHUB_API}${path}`, { headers: githubHeaders(token) })
    if (!response.ok || !response.body) throw new GitHubRequestError(response.status, `GitHub GET ${path}: ${response.status}`)
    return response.body
}
