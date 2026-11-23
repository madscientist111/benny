import { Hono } from 'hono'
import { env } from 'cloudflare:workers'
import { getAgentByName } from 'agents'
import { github } from './bot'
import { log } from './log'
import type { PiAgent } from './pi-agent'

// Dev-only routes for live tests (`scripts/verify.mjs`); `index.ts` mounts them. Never in
// production: they answer 404 unless `DEV_ROUTES_ENABLED` is exactly `'true'`, which
// `cloudflare.config.ts` sets only outside production, and `PiAgent.fireCronNow` checks it again.
// The dev server is reachable through a tunnel, so a request must also be signed like a webhook.

export const devRoutes = new Hono()

/**
 * `POST /dev/crons/fire` with `{ threadId, fail? }`: fires the thread's cron now through the real
 * firing code (`fail` notes a failed firing instead of starting a run), and answers with the cron's
 * record after, or `{ cron: null }`, so a test can check it without the Access-protected cron list.
 */
devRoutes.post('/dev/crons/fire', async (c) => {
    if ((env.DEV_ROUTES_ENABLED as string) !== 'true') return c.notFound()
    const body = await c.req.text()
    // The same HMAC as a GitHub webhook, compared in constant time by the adapter.
    if (!github.isSignedByGitHub(body, c.req.header('x-hub-signature-256') ?? null)) return c.text('invalid signature', 401)
    let request: { threadId?: unknown; fail?: unknown }
    try {
        request = JSON.parse(body)
    } catch {
        return c.text('the body is not JSON', 400)
    }
    const { threadId, fail } = request
    if (typeof threadId !== 'string' || !threadId.startsWith('github:')) return c.text('threadId must be github:<owner>/<repo>:issue:<number>', 400)
    const agent = await getAgentByName(env.PI_AGENT as unknown as DurableObjectNamespace<PiAgent>, threadId)
    const cron = await agent.fireCronNow({ fail: fail === true })
    log('dev route cron fired', { threadId, cronId: cron?.id, fail: fail === true, status: cron?.status })
    if (!cron) return c.json({ cron: null })
    return c.json({
        cron: {
            id: cron.id,
            status: cron.status,
            failuresInARow: cron.failuresInARow,
            countedFirings: cron.countedFirings,
            firingLimit: cron.firingLimit ?? null,
            nextFiringAt: cron.nextFiringAt,
            lastFiring: cron.firings.at(-1) ?? null,
        },
    })
})
