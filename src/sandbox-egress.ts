import { WorkerEntrypoint } from 'cloudflare:workers'
import { log } from './log'

const REGISTRY_HOST = 'registry.npmjs.org'
const ALLOWED_METHODS = ['GET', 'HEAD']
// The container has no credentials and must not send any it finds, and `cf-` headers describe
// our edge, not the registry request.
const DROPPED_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization'])
const REFUSAL_BODY = 'Refused: the sandbox may only GET or HEAD https://registry.npmjs.org.'

/**
 * The container's only way out (requirement 41): it lets an install download from the npm
 * registry while `enableInternet: false` keeps every other host closed. It holds no secret and
 * forwards none: the request leaves with its path, its query and no credentials. Its props name
 * the run whose install made the request, which `SandboxDO` sets before it starts the container.
 */
export class SandboxEgress extends WorkerEntrypoint<Env, { runId: string }> {
    async fetch(request: Request): Promise<Response> {
        const requestUrl = new URL(request.url)
        const allowed =
            requestUrl.hostname === REGISTRY_HOST &&
            (requestUrl.protocol === 'http:' || requestUrl.protocol === 'https:') &&
            ALLOWED_METHODS.includes(request.method)
        if (!allowed) {
            // Host and method only: a registry path or query can carry a token.
            log('egress refused', { runId: this.ctx.props.runId, method: request.method, host: requestUrl.hostname })
            return new Response(REFUSAL_BODY, { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } })
        }
        // Path and query onto a fixed https origin, so no other host, port or userinfo rides along.
        const upstreamUrl = new URL(`https://${REGISTRY_HOST}`)
        upstreamUrl.pathname = requestUrl.pathname
        upstreamUrl.search = requestUrl.search
        const upstreamHeaders = new Headers()
        for (const [name, value] of request.headers) {
            if (DROPPED_HEADERS.has(name) || name.startsWith('cf-')) continue
            upstreamHeaders.set(name, value)
        }
        // Manual redirects: a redirect to another host is handed to the container, not followed by us.
        return fetch(upstreamUrl, { method: request.method, headers: upstreamHeaders, redirect: 'manual' })
    }
}

/** Routes the container's registry traffic to `SandboxEgress`. Call before `container.start()`. */
export const registerEgress = async ({ container, egress }: { container: Container; egress: Fetcher }): Promise<void> => {
    await container.interceptOutboundHttp(REGISTRY_HOST, egress)
    await container.interceptOutboundHttps(REGISTRY_HOST, egress)
}
