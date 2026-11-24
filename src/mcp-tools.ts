import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { validateToolArguments } from '@earendil-works/pi-ai/utils/validation'
import type { ToolExecutionApi, ToolExecutionResult, ToolHookCall, ToolRegistration } from '@earendil-works/pi-durable'
import { CODEMODE_TOOL_NAME } from '@earendil-works/pi-durable/codemode'
import { renderToolSample } from '@earendil-works/pi-codemode/declarations'
import type { CodemodeResult, CodemodeSandboxBase, CodemodeTool } from '@earendil-works/pi-codemode/portable'
import { framedScriptText } from './codemode'
import { codemodeCallRefusal, type CodemodeCallKind } from './codemode-limits'
import { WRITE_REFUSED_TEXT } from './github/tools'
import { log } from './log'
import { RUN_CODE_REFUSED_TEXT } from './sandbox-tools'

// Benny's tools over MCP, for a harness that runs outside the Worker (Claude Code in its container).
// `PiAgent.serveMcp` calls `answerMcpRequest` with the tool task its token names; the same tool
// registrations pi runs are listed and executed here, so results and caps match pi's. The gate is
// the task's record, decided in the Worker: the container holds only the token.

/**
 * What a tool needs from the task that calls it: `read` is every task's, `write` (GitHub writes,
 * the work branch) needs `mayWrite`, `code` (the sandbox) needs `canRunCode`.
 */
export type ToolAccess = 'read' | 'write' | 'code'

/** One tool served over MCP: the registration pi runs, and the access a task needs to call it. */
export type ServedTool = { tool: ToolRegistration; access: ToolAccess }

/**
 * One harness task's record, made when the task starts, from the same rules `PiAgent` uses for pi
 * (`#runMayWrite`, `#configureToolAccess`). `expiresAt` (ms) ends a token whose run never ended it.
 */
export type McpTask = {
    runId: string; mayWrite: boolean; canRunCode: boolean; expiresAt: number
    /**
     * When set, the only write tools the task may call, even with `mayWrite`: pi's `claude_code` tool
     * gets `CLAUDE_CODE_TOOL_WRITE_TOOLS`, so text injected into its task cannot commit or open a PR.
     */
    writeTools?: readonly string[]
}

/** The write tools a `claude_code` tool task may call: start the work branch and put files on it. Benny commits and opens the PR. */
export const CLAUDE_CODE_TOOL_WRITE_TOOLS: readonly string[] = ['branch_start', 'branch_write_files']

/** What a request contributes to its run's tool access. Missing fields come from older records and count as false. */
export type RequestAccess = { hasWriteAccess?: boolean; mentionsBenny?: boolean }

/**
 * What a run's tools may do once `joining` joins the requests already `pending` (none on an idle
 * thread): run code when every request is from a writer (requirement 37), write to GitHub when
 * every one is also a mention (plan 4.1). `PiAgent.#configureToolAccess` decides with it for both
 * harnesses; a tool task's record copies it.
 */
export const toolAccessFor = (pending: readonly RequestAccess[], joining: { hasWriteAccess: boolean; mentionsBenny: boolean }) => {
    const canRunCode = joining.hasWriteAccess && pending.every((request) => request.hasWriteAccess === true)
    const mayWrite = canRunCode && joining.mentionsBenny && pending.every((request) => request.mentionsBenny === true)
    return { canRunCode, mayWrite }
}

/** What a refused call reads, by access; the same words pi's tools refuse with. */
const REFUSED_TEXT: Record<Exclude<ToolAccess, 'read'>, string> = {
    write: WRITE_REFUSED_TEXT,
    code: RUN_CODE_REFUSED_TEXT,
}

/** The refusal for a write tool outside a task's `writeTools`. */
const NARROWED_WRITE_REFUSED_TEXT = 'This task may only start the work branch and write files to it. Benny commits, pushes and opens PRs itself: list what you changed in your answer.'

/** The refusal for a call to `served` from `task`, or `undefined` when the task may call it. */
export const toolCallRefusal = ({ access, tool }: ServedTool, task: McpTask): string | undefined => {
    if (access === 'write' && !task.mayWrite) return REFUSED_TEXT.write
    if (access === 'write' && task.writeTools && !task.writeTools.includes(tool.name)) return NARROWED_WRITE_REFUSED_TEXT
    if (access === 'code' && !task.canRunCode) return REFUSED_TEXT.code
    return undefined
}

/**
 * Tools that work on pi's sandbox. Claude Code runs commands with its own Bash in its own container,
 * so a second container per thread would only hold a second copy of the code, out of step with the
 * one it edits. Its files reach the work branch with `branch_write_files` instead.
 */
const SANDBOX_TOOL_NAMES: ReadonlySet<string> = new Set(['exec', 'server_start', 'server_request', 'sandbox_keep_changes'])

/**
 * The tools served over MCP: `read` for every task, and `write` for a task that may write: the
 * GitHub write tools and the branch tools pi offers a writer, plus `branch_write_files`. The sandbox
 * tools are left out (`SANDBOX_TOOL_NAMES`). No tool merges, approves or closes a PR, here or in pi.
 */
export const servedTools = ({ read, write }: { read: readonly ToolRegistration[]; write: readonly ToolRegistration[] }): ServedTool[] => [
    ...read.map((tool): ServedTool => ({ tool, access: 'read' })),
    ...write.filter((tool) => !SANDBOX_TOOL_NAMES.has(tool.name)).map((tool): ServedTool => ({ tool, access: 'write' })),
]

/**
 * Lines Claude Code adds to commits and PRs: a co-author trailer, a "Generated with Claude Code"
 * line, a session link. The owner's rule is no co-author trailer and no AI name in commits or PRs.
 */
const AI_ATTRIBUTION_LINE = /^[^\S\n]*(?:co-authored-by:.*|claude-session:.*|\S*\s*generated (?:with|by) \[?claude\b.*)$/gim

/**
 * `text` without Claude Code's attribution lines, and without the blank lines they leave behind.
 * The runner turns attribution off; this catches what the model writes itself.
 */
export const withoutAiAttribution = (text: string): string =>
    text.replace(AI_ATTRIBUTION_LINE, '').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').trimEnd()

/** The text arguments of the tools that write commits and PRs, cleaned with `withoutAiAttribution`. */
const ATTRIBUTED_ARGUMENTS: Readonly<Record<string, readonly string[]>> = {
    branch_commit_push: ['message'],
    github_create_pr: ['title', 'body'],
    github_update_pr: ['title', 'body'],
}

/** What the MCP server needs besides its tools. */
export type McpToolsOptions = {
    tools: readonly ServedTool[]
    /**
     * Code mode, or `undefined` to serve no `codemode` tool. `sandbox` builds one script's sandbox
     * with the tools it may call (`codemode.ts`'s `scriptSandbox` in the Worker); `countCodemodeCall`
     * is the run's counter pi's caps read, so a run's scripts count once whichever harness made them.
     */
    codemode?: {
        sandbox: (tools: CodemodeTool[]) => CodemodeSandboxBase
        countCodemodeCall: (kind: CodemodeCallKind) => number
    }
}

/** A tool result in MCP's shape. */
type McpToolResult = { content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]; isError?: boolean }

const textResult = (text: string, isError = false): McpToolResult => ({ content: [{ type: 'text', text }], ...(isError ? { isError } : {}) })

/**
 * What a tool's `execute` gets for `api`: the call id the tools log and key their stored calls by.
 * Benny's read tools use nothing else; a tool that reaches for more fails loudly, naming the field,
 * instead of acting on a value pi would have set.
 */
const mcpToolApi = (callId: string): ToolExecutionApi => new Proxy({ callId } as ToolExecutionApi, {
    get(target, field) {
        if (field in target || typeof field === 'symbol') return Reflect.get(target, field)
        throw new Error(`api.${String(field)} is not available to a tool called over MCP`)
    },
})

/** A script's result as pi's `codemode` tool writes it, before Benny frames it (pi-durable's `formatResult`, without images or spill files). */
const scriptResultText = (result: CodemodeResult, wallMs: number): string => {
    const output = [...result.output]
    if (result.ok && result.value !== undefined) {
        output.push({ type: 'text', text: typeof result.value === 'string' ? result.value : JSON.stringify(result.value) ?? String(result.value) })
    }
    const textItems = output.flatMap((item) => (item.type === 'text' && !item.console ? [item.text] : []))
    const consoleLines = output.flatMap((item) => (item.type === 'text' && item.console ? [item.text] : []))
    const parts = textItems.map((text, index) => (textItems.length > 1 ? `==> text ${index + 1}/${textItems.length} <==\n${text}` : text))
    if (consoleLines.length > 0) parts.push(`<console_output>\n${consoleLines.join('\n')}\n</console_output>`)
    if (!result.ok) {
        const { error } = result
        const head = error.kind === 'script' ? (error.stack ?? `${error.name ?? 'Error'}: ${error.message}`)
            : error.kind === 'timeout' ? `Script timed out: ${error.message}`
            : error.kind === 'aborted' ? `Script aborted: ${error.message}`
            : `Script sandbox failed: ${error.message}`
        const madeCalls = result.calls.length === 0 ? 'No tool calls were made.'
            : `Tool calls made before the failure (they are not undone): ${result.calls.map((call) => `${call.name} (${call.status})`).join(', ')}`
        parts.push(`Script error:\n${head}\n\n${madeCalls}`)
    }
    const header = `${result.ok ? 'Script completed' : 'Script failed'}\nWall time ${(wallMs / 1000).toFixed(1)} seconds\nOutput:\n`
    // Each part starts on its own line: a newline goes between two parts only when the first lacks one.
    const body = parts.reduce((joined, part) => (joined === '' || joined.endsWith('\n') ? joined + part : `${joined}\n${part}`), '')
    return `${header}\n${body}`
}

/** A tool as a script sees it: its declaration, without the code that runs it. */
type ScriptToolDeclaration = Omit<CodemodeTool, 'execute'>

/**
 * The `codemode` tool's description over MCP: what the script environment gives, then each tool a
 * script can call. pi says the second part in its `codemode` prompt section; an MCP tool has only
 * its description. The caps are pi's, so their numbers stay in `codemode-limits.ts`.
 */
const codemodeDescription = (scriptTools: ScriptToolDeclaration[]) => [
    'Run JavaScript that calls Benny\'s read tools, to batch many reads in one step. The input is raw JavaScript, ' +
    'run as an async function body in a QuickJS sandbox: top-level `await` and `return` work. No Node, file system, network, or timers.',
    '- `await tools.<name>({ ...args })` resolves to the tool\'s text and rejects with an Error on failure. Calls still running when the script ends are cancelled.',
    '- `text(value)`, `console.log(...)` and `return` add output; `exit()` ends the script. Print only what you need: long output is cut.',
    '- Tool calls per script, tool calls per run and scripts per run are capped; a call over a cap rejects with a message that names it.',
    'The tools a script can call:',
    ...scriptTools.map((declared) => renderToolSample(declared)),
].join('\n')

/**
 * The MCP server's tools for one PiAgent: `list` and `call` for a task, and `codemode` when code mode
 * is on. Every call is validated against the tool's schema the way pi validates it, gated by the
 * task, then run with the tool's own `execute`, so its output cap, data note and secret filter apply.
 */
export const mcpTools = ({ tools, codemode }: McpToolsOptions) => {
    const servedByName = new Map(tools.map((served) => [served.tool.name, served]))

    /** One call, from the model or from a script. A refusal or a bad argument is an error result, never a throw. */
    const callTool = async (task: McpTask, name: string, args: unknown, callId: string): Promise<McpToolResult> => {
        const served = servedByName.get(name)
        if (!served) return textResult(`Tool ${name} is not available`, true)
        const refusal = toolCallRefusal(served, task)
        if (refusal) {
            log('mcp tool refused', { name, access: served.access, callId, runId: task.runId })
            return textResult(refusal, true)
        }
        let validArgs: unknown
        try {
            const prepared = served.tool.prepareArguments ? served.tool.prepareArguments(args) : args
            validArgs = validateToolArguments(served.tool, { type: 'toolCall', id: callId, name, arguments: prepared as Record<string, never> })
            for (const field of ATTRIBUTED_ARGUMENTS[name] ?? []) {
                const fields = validArgs as Record<string, unknown>
                if (typeof fields[field] === 'string') fields[field] = withoutAiAttribution(fields[field])
            }
        } catch (error) {
            return textResult(error instanceof Error ? error.message : String(error), true)
        }
        let result: ToolExecutionResult
        try {
            result = await served.tool.execute(validArgs as never, mcpToolApi(callId), BACKGROUND_CONTEXT)
        } catch (error) {
            return textResult(error instanceof Error ? error.message : String(error), true)
        }
        const content = (result.output ?? []).map((block) => block.type === 'text'
            ? { type: 'text' as const, text: block.text }
            : { type: 'image' as const, data: block.data, mimeType: block.mimeType })
        return { content, ...(result.isError ? { isError: true } : {}) }
    }

    /** The tools a script may call: those pi lets scripts call (`callers`), less those the task may not call. */
    const scriptTools = (task: McpTask): ScriptToolDeclaration[] => tools
        .filter((served) => (!served.tool.callers || served.tool.callers.includes('tools')) && !toolCallRefusal(served, task))
        .map(({ tool }) => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters as Record<string, unknown>, outputSchema: { type: 'string' } }))

    /**
     * One script: pi's caps first (scripts per run, then each nested call), then the sandbox pi uses,
     * whose tools call back into `callTool`. A nested call's id is `<script call id>/c<n>`, as pi
     * numbers it, so `codemodeCallRefusal` reads the per-script cap from it.
     */
    const runScript = async (
        { sandbox: scriptSandbox, countCodemodeCall }: NonNullable<McpToolsOptions['codemode']>,
        task: McpTask, code: string, callId: string,
    ): Promise<McpToolResult> => {
        const scriptCall = { type: 'toolCall', id: callId, name: CODEMODE_TOOL_NAME, arguments: {} } as ToolHookCall
        const scriptRefusal = codemodeCallRefusal(scriptCall, countCodemodeCall('script'))
        if (scriptRefusal) {
            log('codemode call limit', { cap: scriptRefusal.cap, callId, runId: task.runId })
            return textResult(`Tool call blocked: ${scriptRefusal.block}`, true)
        }
        let nestedCallCount = 0
        const sandbox = scriptSandbox(scriptTools(task).map((declared) => ({
            ...declared,
            execute: async (args: unknown) => {
                nestedCallCount += 1
                const nestedCallId = `${callId}/c${nestedCallCount}`
                const nestedCall = { type: 'toolCall', id: nestedCallId, name: declared.name, arguments: {}, parent: { taskId: callId, callId } } as unknown as ToolHookCall
                const refusal = codemodeCallRefusal(nestedCall, countCodemodeCall('nested'))
                if (refusal) {
                    log('codemode call limit', { cap: refusal.cap, callId: nestedCallId, runId: task.runId })
                    throw new Error(refusal.block)
                }
                const result = await callTool(task, declared.name, args, nestedCallId)
                const text = result.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
                if (result.isError) throw new Error(text || `Tool ${declared.name} failed`)
                return text
            },
        })))
        const startedAt = Date.now()
        const result = await sandbox.execute(code)
        const text = scriptResultText(result, Date.now() - startedAt)
        log('tool', { name: CODEMODE_TOOL_NAME, ms: Date.now() - startedAt, isError: !result.ok, nestedCalls: nestedCallCount, callId, runId: task.runId })
        // As pi's `afterTool` hook does: a successful script's text is capped and framed, a failed one passes as it is.
        return result.ok ? textResult(framedScriptText(text)) : textResult(text, true)
    }

    return {
        /** The tools `task` may call, as MCP lists them; the gated ones are left out, as pi hides them. */
        list: (task: McpTask) => [
            ...tools.filter((served) => !toolCallRefusal(served, task)).map(({ tool }) => ({
                name: tool.name, description: tool.description, inputSchema: tool.parameters,
            })),
            ...(codemode ? [{
                name: CODEMODE_TOOL_NAME,
                description: codemodeDescription(scriptTools(task)),
                inputSchema: { type: 'object', properties: { code: { type: 'string', description: 'Raw JavaScript source.' } }, required: ['code'] },
            }] : []),
        ],
        /** Runs one call for `task`; `callId` names it in the tools' log lines and stored calls, as pi's call ids do. */
        call: (task: McpTask, name: string, args: unknown, callId: string): Promise<McpToolResult> => {
            if (name !== CODEMODE_TOOL_NAME || !codemode) return callTool(task, name, args, callId)
            const code = (args as { code?: unknown } | null)?.code
            if (typeof code !== 'string') return Promise.resolve(textResult('codemode needs `code`: a string of JavaScript.', true))
            return runScript(codemode, task, code, callId)
        },
    }
}

export type McpTools = ReturnType<typeof mcpTools>

/** One JSON-RPC request as the MCP client sends it. */
export type McpRequest = { jsonrpc?: string; id?: string | number | null; method?: string; params?: { name?: string; arguments?: unknown } }

/** The MCP protocol version the spike's client spoke (docs/learnings/claude-agent-sdk.md). */
const PROTOCOL_VERSION = '2025-06-18'
/** JSON-RPC error codes: a token that names no live task, a method this server lacks. */
const UNKNOWN_TOKEN_CODE = -32001
const METHOD_NOT_FOUND_CODE = -32601

/**
 * Answers one JSON-RPC request with an id. `task` is the record the request's token names, or
 * `undefined` when it names none: every method then answers with an error, `initialize` too.
 * A `tools/call` that fails or is refused is still a result, with `isError`, as MCP asks.
 * `callId` names a `tools/call` in the tools' log lines and stored calls, as pi's call ids do.
 */
export const answerMcpRequest = async (server: McpTools, task: McpTask | undefined, request: McpRequest, callId: string): Promise<McpReply> => {
    const reply = (result: unknown) => ({ jsonrpc: '2.0' as const, id: request.id ?? null, result })
    if (!task) return unknownTaskReply(request)
    if (request.method === 'initialize') {
        return reply({ protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: 'bobby', version: '1' } })
    }
    if (request.method === 'ping') return reply({})
    if (request.method === 'tools/list') return reply({ tools: server.list(task) })
    if (request.method === 'tools/call') {
        return reply(await server.call(task, String(request.params?.name ?? ''), request.params?.arguments ?? {}, callId))
    }
    return mcpErrorReply(request, METHOD_NOT_FOUND_CODE, `method ${String(request.method)} is not served`)
}

/** A JSON-RPC answer: a result, or an error. */
export type McpReply = { jsonrpc: '2.0'; id: string | number | null; result?: unknown; error?: { code: number; message: string } }

const mcpErrorReply = (request: McpRequest, code: number, message: string): McpReply =>
    ({ jsonrpc: '2.0', id: request.id ?? null, error: { code, message } })

/** The answer to a request whose token names no live task. Never says why: a wrong token learns nothing. */
export const unknownTaskReply = (request: McpRequest): McpReply => mcpErrorReply(request, UNKNOWN_TOKEN_CODE, 'unknown or expired task token')

const hex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')

/**
 * The key that signs task tokens: HKDF from `GITHUB_WEBHOOK_SECRET` with its own label, so no new
 * secret is needed and a token's signature is never a webhook signature. The Worker checks a token
 * with it before it wakes any `PiAgent`.
 */
const taskTokenSigningKey = async (secret: string): Promise<CryptoKey> => {
    const baseKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), 'HKDF', false, ['deriveKey'])
    return crypto.subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode('bobby mcp task token v1') },
        baseKey, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign', 'verify'],
    )
}

/**
 * A new tool task token: the thread's id (so the Worker finds the thread's `PiAgent` the way
 * `bot.ts` does), 32 random bytes, and an HMAC of both with `taskTokenSigningKey(secret)`. The thread
 * id is not a secret; the signature lets the Worker refuse a forged token without waking an object,
 * and the random part is what `PiAgent` keeps a record of.
 */
export const newTaskToken = async (threadId: string, secret: string): Promise<string> => {
    const signed = `${btoa(threadId).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')}.${hex(crypto.getRandomValues(new Uint8Array(32)))}`
    const signature = await crypto.subtle.sign('HMAC', await taskTokenSigningKey(secret), new TextEncoder().encode(signed))
    return `${signed}.${hex(new Uint8Array(signature))}`
}

/**
 * The thread id a token names when its signature is right, or `undefined`. A signed token was minted
 * by a `PiAgent`; it may still be expired or ended, which that `PiAgent` checks (`serveMcp`).
 */
export const verifiedThreadIdOfTaskToken = async (token: string, secret: string): Promise<string | undefined> => {
    const match = /^([A-Za-z0-9_-]+\.[0-9a-f]{64})\.([0-9a-f]{64})$/.exec(token)
    if (!match) return undefined
    const signature = new Uint8Array(match[2].match(/../g)!.map((pair) => parseInt(pair, 16)))
    // `verify` compares in constant time.
    const valid = await crypto.subtle.verify('HMAC', await taskTokenSigningKey(secret), signature, new TextEncoder().encode(match[1]))
    if (!valid) return undefined
    try {
        return atob(match[1].split('.')[0].replaceAll('-', '+').replaceAll('_', '/'))
    } catch {
        return undefined
    }
}

/** The prefix of every tool task record in a `PiAgent`'s storage. */
export const TASK_TOKEN_KEY_PREFIX = 'taskToken:'

/** The storage key of a token's record: its SHA-256, so storage never holds a usable token. */
export const taskTokenKey = async (token: string): Promise<string> => {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))
    return `${TASK_TOKEN_KEY_PREFIX}${hex(digest)}`
}
