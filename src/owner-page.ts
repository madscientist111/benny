import { env } from 'cloudflare:workers'
import { createMiddleware } from 'hono/factory'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { log } from './log'
import designSystem from './benny-design.css?raw'

// What the owner's pages (`/crons` in `cron-list.ts`; the Desk page joins in part 3) share: the
// Cloudflare Access check in front of them and their APIs, and the Benny Design System stylesheet,
// which goes inline into each page so a page load stays one request.

/** The page with the design system's stylesheet in place of its `<!-- benny-design.css -->` comment. */
export const withDesignSystem = (page: string) => page.replace('<!-- benny-design.css -->', () => `<style>\n${designSystem}</style>`)

// The Access team's signing keys, fetched once per isolate and cached by jose.
let accessKeys: ReturnType<typeof createRemoteJWKSet> | undefined

/**
 * Answers 401 unless the request carries a valid Access token for this app (`docs/crons/plan.md`,
 * requirement 17). Access already stands in front of these paths; this check makes a request that
 * reaches the Worker some other way, such as the `workers.dev` hostname, get 401. Without both
 * settings nothing passes.
 */
export const requireAccess = createMiddleware(async (c, next) => {
    const teamDomain = env.ACCESS_TEAM_DOMAIN
    const audience = env.ACCESS_AUD
    const token = c.req.header('cf-access-jwt-assertion')
    if (!teamDomain || !audience || !token) return c.text('Unauthorized', 401)
    const issuer = `https://${teamDomain}`
    accessKeys ??= createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`))
    try {
        await jwtVerify(token, accessKeys, { issuer, audience })
    } catch (error) {
        log('access token refused', { path: c.req.path, error: String(error) })
        return c.text('Unauthorized', 401)
    }
    await next()
})
