import { WorkerEntrypoint } from 'cloudflare:workers'
import type { AgentDO, AgentTask, AgentTaskState, WorkspaceCopy } from './agent-do'

// The entry of the deployed `bobby-agent-dev` Worker (`agent/cloudflare.config.ts`): Benny reaches
// each thread's `AgentDO` through the `AgentService` RPC entrypoint. The public probe route
// exists only in a `--mode probe` deploy, which adds `PROBE_KEY` (scripts/probe-agent.mjs).

export { AgentDO } from './agent-do'

/** The bindings `agent/cloudflare.config.ts` gives this Worker. */
export type AgentWorkerEnv = {
    /** One object per thread, named by a 64-hex id. */
    AGENT: DurableObjectNamespace<AgentDO>
    /** The owner's `claude setup-token` token; `AgentDO` puts it on the runner's exec only. */
    CLAUDE_CODE_OAUTH_TOKEN: string
    /** Only in a `--mode probe` deploy: the bearer key of the probe route. */
    PROBE_KEY?: string
}

/** How often the probe route asks how its task stands. */
const PROBE_POLL_MS = 1000

/** A thread's agent is named by a Durable Object id: 64 hex characters, nothing else. */
const AGENT_NAME_PATTERN = /^[0-9a-f]{64}$/

/**
 * This thread's `AgentDO` stub. `getByName` creates an object for any text, so a name that is not
 * an id would quietly become a second, empty agent; it is refused instead.
 */
const agentStub = (env: AgentWorkerEnv, agentName: string): DurableObjectStub<AgentDO> => {
    if (!AGENT_NAME_PATTERN.test(agentName)) throw new Error(`Not an agent name: ${agentName}`)
    return env.AGENT.getByName(agentName)
}

/** What Benny reaches: each `AgentDO` method with the thread's agent name first. It only forwards. */
export class AgentService extends WorkerEntrypoint<AgentWorkerEnv> {
    startTask(agentName: string, task: AgentTask): Promise<void> {
        return agentStub(this.env, agentName).startTask(task)
    }

    stopTask(agentName: string, taskId: string): Promise<boolean> {
        return agentStub(this.env, agentName).stopTask(taskId)
    }

    destroyContainer(agentName: string, reason: string): Promise<boolean> {
        return agentStub(this.env, agentName).destroyContainer(reason)
    }

    taskReport(agentName: string, taskId: string): Promise<AgentTaskState> {
        return agentStub(this.env, agentName).taskReport(taskId)
    }

    workspaceKey(agentName: string): Promise<string | undefined> {
        return agentStub(this.env, agentName).workspaceKey()
    }

    copyWorkspace(agentName: string, copy: WorkspaceCopy): Promise<void> {
        return agentStub(this.env, agentName).copyWorkspace(copy)
    }
}

/** The MCP bearer the probe passes: a hash of the key, so the container never holds the key. */
const probeMcpToken = async (probeKey: string): Promise<string> => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${probeKey}:mcp`))
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * The probe's stand-in for Benny's `/mcp`: JSON-RPC with one `echo` tool, so a probe task proves
 * the runner reaches an MCP server with its bearer, without Benny's Worker.
 */
const answerProbeMcp = async (request: Request, probeKey: string): Promise<Response> => {
    if (request.headers.get('authorization') !== `Bearer ${await probeMcpToken(probeKey)}`) return new Response('Unauthorized', { status: 401 })
    const body = (await request.json()) as { id?: number | string; method: string; params?: { name?: string; arguments?: { text?: string } } }
    // A notification has no id and wants no body.
    if (body.id === undefined) return new Response(null, { status: 202 })
    const reply = (result: unknown) => Response.json({ jsonrpc: '2.0', id: body.id, result })
    if (body.method === 'initialize') {
        return reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'bobby-agent-probe', version: '0' } })
    }
    if (body.method === 'tools/list') {
        return reply({
            tools: [{ name: 'echo', description: 'Returns the text it is given.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }],
        })
    }
    if (body.method === 'tools/call') return reply({ content: [{ type: 'text', text: `echo: ${body.params?.arguments?.text ?? ''}` }] })
    return reply({})
}

export default {
    async fetch(request: Request, env: AgentWorkerEnv): Promise<Response> {
        // Without the probe key (every deploy but `--mode probe`) the Worker has no route at all.
        const probeKey = env.PROBE_KEY
        if (!probeKey) return new Response('Not found', { status: 404 })
        const url = new URL(request.url)
        if (url.pathname === '/mcp') return answerProbeMcp(request, probeKey)
        if (request.headers.get('authorization') !== `Bearer ${probeKey}`) return new Response('Unauthorized', { status: 401 })
        const { agentName, ...input } = (await request.json()) as { agentName: string; [field: string]: unknown }
        const agent = agentStub(env, agentName)
        try {
            if (url.pathname === '/probe/run') {
                const task = input as Omit<AgentTask, 'mcpUrl' | 'mcpToken'>
                await agent.startTask({ ...task, mcpUrl: `${url.origin}/mcp`, mcpToken: await probeMcpToken(probeKey) })
                // The probe's own request may last the task; Benny's calls never do.
                for (;;) {
                    await new Promise((resolve) => setTimeout(resolve, PROBE_POLL_MS))
                    const state = await agent.taskReport(task.taskId)
                    if (state.state === 'done') return Response.json(state.report)
                    if (state.state === 'unknown') return Response.json({ error: `task ${task.taskId} is unknown` }, { status: 500 })
                }
            }
            if (url.pathname === '/probe/stop') return Response.json({ stopped: await agent.stopTask(String(input.taskId)) })
            if (url.pathname === '/probe/destroy') return Response.json({ destroyed: await agent.destroyContainer('probe') })
        } catch (error) {
            return Response.json({ error: String(error) }, { status: 500 })
        }
        return new Response('Not found', { status: 404 })
    },
}
