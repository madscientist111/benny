import { Context, Hono } from 'hono'
import { bot } from './bot'
import { handleRepoWebhook } from './push-webhook'
import { cronList } from './cron-list'
import { devRoutes } from './dev-routes'
import { env } from 'cloudflare:workers'
import { WorkspaceServiceProxy } from '@cloudflare/computer'
import { getAgentByName } from 'agents'
import { unknownTaskReply, verifiedThreadIdOfTaskToken, type McpRequest } from './mcp-tools'
import type { PiAgent } from './pi-agent'
import { log } from './log'


export { PiAgent } from './pi-agent'
export { RepoDO } from './repo-do'
export { BranchDO } from './branch-do'
export { ChatStateDO } from 'chat-state-cloudflare-do'
export { WorkspaceServiceProxy }
export { SandboxDO } from './sandbox-do'
export { SandboxEgress } from './sandbox-egress'
// `DirectoryBackup` reaches R2 through this entrypoint, so the Worker must export it.
export { DirectoryBackupGateway } from '@cloudflare/sandbox'

const app = new Hono()

app.get('/', (c) => c.text('Hello Cloudflare Workers!'))

// The cron list and its API, behind Cloudflare Access (`src/cron-list.ts`).
app.route('/', cronList)

// Dev-only routes for live tests; 404 in production (`src/dev-routes.ts`).
app.route('/', devRoutes)

app.post('/api/webhooks/github', async (c: Context) => {
	const waitUntil = (task: Promise<unknown>) => {
		try {
			c.executionCtx.waitUntil(task);
		} catch {
			void task;
		}
	}
	// Push and App-removal events maintain the RepoDO copies and never reach the Chat SDK,
	// which needs to read the body itself for every other event.
	const repoResponse = await handleRepoWebhook(c.req.raw, waitUntil)
	if (repoResponse) return repoResponse
	return bot.webhooks.github(c.req.raw, { waitUntil });

})

// Benny's tools over MCP for a harness outside the Worker (`mcp-tools.ts`). Only a deployment that
// runs Claude Code serves it. The bearer token is signed (`newTaskToken`), so a forged one is refused
// here and never wakes or creates a `PiAgent`; a signed one names its thread, whose agent checks that
// the task is still live. Errors are JSON-RPC answers, never a 401, which an MCP client reads as a
// request to log in.
app.post('/mcp', async (c: Context) => {
	const { HARNESS: harness, CLAUDE_CODE_TOOL_ENABLED: claudeCodeToolEnabled } = env as { HARNESS?: string; CLAUDE_CODE_TOOL_ENABLED?: string }
	if (harness !== 'claude-code' && claudeCodeToolEnabled !== 'true') return c.body(null, 404)
	const request = await c.req.json<McpRequest>().catch(() => undefined)
	if (typeof request !== 'object' || request === null || Array.isArray(request)) {
		return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'the body is not one JSON-RPC request' } })
	}
	// A notification has no id and wants no answer.
	if (request.id === undefined) return c.body(null, 202)
	const token = c.req.header('authorization')?.replace(/^Bearer /, '') ?? ''
	const threadId = await verifiedThreadIdOfTaskToken(token, env.GITHUB_WEBHOOK_SECRET!)
	if (!threadId) {
		log('mcp token rejected', { method: request.method, signed: false })
		return c.json(unknownTaskReply(request))
	}
	const agent = await getAgentByName(env.PI_AGENT as unknown as DurableObjectNamespace<PiAgent>, threadId)
	return c.json(await agent.serveMcp(token, request))
})
// No server-sent events: the client then sends every request as a POST.
app.get('/mcp', (c: Context) => c.body(null, 405))

app.get('/user/:id', async (c: Context) => {
	console.log('user ma aavyu')
	const id = c.req.queries()
	console.log('id', id)

})


export default app