import { Context, Hono } from 'hono'
import { bot } from './bot'
import { handleRepoWebhook } from './push-webhook'
import { env } from 'cloudflare:workers'
import { WorkspaceServiceProxy } from '@cloudflare/computer'


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

app.get('/user/:id', async (c: Context) => {
	console.log('user ma aavyu')
	const id = c.req.queries()
	console.log('id', id)

})


export default app