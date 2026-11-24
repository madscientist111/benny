import { env } from 'cloudflare:workers'
import { github } from '../bot'
import { repoObjectName, type RepoDO } from '../repo-do'
import { log } from '../log'

// The GitHub events the Chat SDK never sees: a push to the default branch refreshes the repo's
// `RepoDO` copy, and removing the App deletes it. `index.ts` tries this handler first.

/** What `index.ts` already builds for the Chat SDK; the repo work is reported the same way. */
type WaitUntil = (task: Promise<unknown>) => void

// `Env` describes the binding as a bare namespace, so the object class is named here, the same
// way `bot.ts` names `PiAgent` for `PI_AGENT`.
const repoStub = (owner: string, name: string) =>
    (env.REPO as unknown as DurableObjectNamespace<RepoDO>).getByName(repoObjectName(owner, name))

/** GitHub's `x-github-event` values this handler owns. Every other event goes to the Chat SDK. */
const REPO_EVENTS = new Set(['push', 'installation', 'installation_repositories'])

// Only the parts of the webhook payloads this file reads.
type PushPayload = {
    ref: string
    installation: { id: number }
    repository: {
        name: string
        default_branch: string
        clone_url: string
        owner: { login: string }
    }
}

type RepoRef = { full_name?: string }

type AppPayload = {
    action: string
    repositories?: RepoRef[]
    repositories_removed?: RepoRef[]
}

// GitHub only looks at the status code; the text says what happened.
const accepted = (note: string) => new Response(note, { status: 202 })

/**
 * Keeps one RepoDO copy per repo up to date: a push fast-forwards it, removing the App deletes
 * it. Returns null for every other event, untouched, so `index.ts` hands it to the Chat SDK.
 */
export const handleRepoWebhook = async (
    request: Request,
    waitUntil: WaitUntil,
): Promise<Response | null> => {
    // Read the header before the body: on other events the Chat SDK reads the body itself.
    const event = request.headers.get('x-github-event')
    if (!event || !REPO_EVENTS.has(event)) return null
    // GitHub's own id for this delivery. A push has no comment behind it, so this is the id
    // that ties its work together.
    const deliveryId = request.headers.get('x-github-delivery') ?? undefined

    const body = await request.text()
    if (!github.isSignedByGitHub(body, request.headers.get('x-hub-signature-256'))) {
        return new Response('invalid signature', { status: 401 })
    }
    const payload: unknown = JSON.parse(body)

    if (event === 'push') return handlePush(payload as PushPayload, deliveryId, waitUntil)
    const app = payload as AppPayload
    // The App was removed from the repo, or from some of them.
    if (event === 'installation' && app.action === 'deleted') {
        destroyCopies(app.repositories, deliveryId, waitUntil)
    } else if (event === 'installation_repositories' && app.action === 'removed') {
        destroyCopies(app.repositories_removed, deliveryId, waitUntil)
    }
    return accepted('ok')
}

const handlePush = async (payload: PushPayload, deliveryId: string | undefined, waitUntil: WaitUntil): Promise<Response> => {
    const { repository } = payload
    // Copies hold the default branch only, so other branches need no update.
    if (payload.ref !== `refs/heads/${repository.default_branch}`) return accepted('ignored')

    const repo = `${repository.owner.login}/${repository.name}`
    const stub = repoStub(repository.owner.login, repository.name)
    // Benny must not clone every repo the App is installed on: only refresh copies that exist.
    if ((await stub.commit()) === null) return accepted('not cloned')

    const octokit = github.octokitFor(payload.installation.id)
    const { token } = (await octokit.auth({ type: 'installation' })) as { token: string }
    waitUntil(
        stub.sync({ owner: repository.owner.login, repo: repository.name, token, logIds: { deliveryId } }).catch((error: unknown) => {
            log('repo sync failed', { repo, deliveryId, error: String(error) })
        }),
    )
    return accepted('syncing')
}

const destroyCopies = (repositories: RepoRef[] | undefined, deliveryId: string | undefined, waitUntil: WaitUntil) => {
    for (const { full_name: fullName } of repositories ?? []) {
        // GitHub always sends a name here, but an item without one matches no repo.
        const [owner, name] = fullName?.split('/') ?? []
        if (!owner || !name) continue
        const stub = repoStub(owner, name)
        // `destroy` aborts the object, so its promise rejects by design. The copy is gone
        // either way, and a failure here must not stop the other repos from being cleaned up.
        waitUntil(stub.destroy({ deliveryId }).catch(() => {}))
    }
}
