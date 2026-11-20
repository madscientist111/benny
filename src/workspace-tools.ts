import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { LazyWorkspaceClient, Workspace } from "@cloudflare/computer";
import { createPiTools, type PiToolResultContent } from "@cloudflare/computer/tools/pi-ai";
import { log } from './log'
import { isForbiddenPath } from './github-contract'
import { withNote } from './github-tools'
import { isSecretPath } from "./secret-files";
import { capOutput, isListingTool } from './tool-output-cap'

// The model's file tools, built from Cloudflare Computer's workspace tools. One set reads the repo
// copy, a `pr_` set the PR changes, a `branch_` set the work branch, and a `public_` set the public
// repos a thread imported. Every result passes the secret filter, then the output cap.

const REFUSED_TEXT = 'Refused: this is a secret file. Benny does not read secret files.'

/**
 * A set whose every call names the copy it reads (the public repos, one copy each): `repo` joins
 * each tool's parameters, and `workspaceFor` turns it into the workspace, or throws a refusal.
 */
type RepoArgument = { workspaceFor: (repo: string) => LazyWorkspaceClient | Workspace; description: string }

// A `RepoArgument` set has no workspace of its own: this empty one only gives the tool names and
// schemas, and every call gets the workspace `workspaceFor` names.
const NO_WORKSPACE = {} as Workspace

// A call is refused before it runs when any path it names is a secret file.
const namesSecretPath = (args: unknown) => {
    if (typeof args !== 'object' || args === null) return false
    const { path, paths } = args as { path?: unknown; paths?: unknown }
    if (typeof path === 'string' && isSecretPath(path)) return true
    return Array.isArray(paths) && paths.some((value) => typeof value === 'string' && isSecretPath(value))
}

// A writing call is refused when its path is a workflow file (batch 5 plan, 4.2), or the repo root
// itself: one `delete` must not empty the whole branch.
const namesForbiddenPath = (args: unknown) => {
    if (typeof args !== 'object' || args === null) return false
    const { path } = args as { path?: unknown }
    if (typeof path !== 'string') return false
    return isForbiddenPath(path) || ['/repo', '/repo/', '/', ''].includes(path.trim())
}

// Drops every item that names a secret file, so a grep hit inside `.env` never reaches the
// model (requirement 50). Text that is not such JSON is returned unchanged.
const withoutSecretItems = (text: string) => {
    let listing: unknown
    try {
        listing = JSON.parse(text)
    } catch {
        return text
    }
    if (typeof listing !== 'object' || listing === null) return text
    const fields = listing as Record<string, unknown>
    let hiddenCount = 0
    for (const key of ['matches', 'entries']) {
        const items = fields[key]
        if (!Array.isArray(items)) continue
        const kept = items.filter((item: { path?: unknown; name?: unknown }) =>
            !isSecretPath(String(item?.path ?? item?.name ?? '')))
        hiddenCount += items.length - kept.length
        fields[key] = kept
        if (typeof fields.count === 'number') fields.count = kept.length
    }
    // Without this note the model reads a filtered listing as the whole truth and says a
    // committed `.env` does not exist.
    if (hiddenCount > 0) fields.note = `${hiddenCount} result(s) in secret files are hidden from Benny. They exist, but Benny cannot read them.`
    return JSON.stringify(fields)
}

const withoutSecrets = (toolName: string, content: PiToolResultContent[]) => isListingTool(toolName)
    ? content.map((block) => block.type === 'text' ? { ...block, text: withoutSecretItems(block.text) } : block)
    : content

/** How a second tool set differs from the default one. */
type WorkspaceToolsOptions = {
    /** The extension name. Default `'workspace'`; pi-durable needs unique names. */
    name?: string
    /** Added to each tool name, so `read` becomes `pr_read`. Default `''`. */
    toolPrefix?: string
    /** Maps each tool description. Default: unchanged. */
    describe?: (description: string) => string
    /** The run a call belongs to, which its `tool` line carries. */
    currentRunId: () => Promise<string | undefined>
    /** Who may call the tools. Default: the model and scripts. `['tools']` offers them to code mode scripts only. */
    callers?: readonly ('model' | 'tools')[]
    /**
     * Adds `write`, `edit` and `delete` (the work branch, batch 5). They are offered to the model only,
     * run only when `mayWrite` says so, and refuse workflow files before they touch the workspace.
     */
    writeAccess?: { mayWrite: () => Promise<boolean>; refusedText: string }
    /** Put in front of every result, for files from outside this repo. */
    resultNote?: string
}

// The tools that change files; every other tool here only reads.
const WRITING_TOOLS = new Set(['write', 'edit', 'delete'])
// Computer's writable set also has `publish`, which makes a public artifact: never offered.
const OFFERED_TOOLS = new Set(['read', 'ls', 'find', 'grep', ...WRITING_TOOLS])

// Cloudflare Computer ships its workspace tools (read, ls, find, grep, write, edit, delete,
// exec) in pi-ai's shape. pi-durable takes the same JSON Schema parameters, so each tool is
// declared again as a pi-durable tool that forwards the call.
// The same workspace can back two sets (the repo copy and the PR changes), so the name, the
// tool-name prefix and the descriptions are options.
export const workspaceTools = (
    source: LazyWorkspaceClient | Workspace | RepoArgument,
    { name = 'workspace', toolPrefix = '', describe = (description: string) => description, currentRunId, callers, writeAccess, resultNote }: WorkspaceToolsOptions,
) => {
    // One tool set per workspace, made on that workspace's first call. The lazy client reaches its
    // RepoDO then. Its `fs` has wider overloads than the tools' file-store boundary, so cast to the
    // shape the tools read.
    const toolSets = new Map<unknown, ReturnType<typeof createPiTools>>()
    const toolSetFor = (target: LazyWorkspaceClient | Workspace) => {
        const found = toolSets.get(target)
        if (found) return found
        const made = createPiTools({ workspace: target as unknown as Workspace, readonly: !writeAccess })
        toolSets.set(target, made)
        return made
    }
    const repoArgument = 'workspaceFor' in source ? source : undefined
    const workspace = repoArgument ? NO_WORKSPACE : source as LazyWorkspaceClient | Workspace
    // The names, descriptions and schemas are the same for every workspace.
    const { tools } = toolSetFor(workspace)

    return defineExtension({
        name,
        tools: tools.filter((tool) => OFFERED_TOOLS.has(tool.name)).map((tool) => {
            const toolName = toolPrefix + tool.name
            const writes = WRITING_TOOLS.has(tool.name)
            // A script must not loop over file changes: the writing tools are the model's only.
            const toolCallers = writes ? (['model'] as const) : callers
            // A repo set asks every call which workspace it reads, so `repo` joins the schema.
            const parameters = repoArgument
                ? {
                    ...tool.parameters,
                    properties: { ...(tool.parameters.properties ?? {}), repo: { type: 'string', description: repoArgument.description } },
                    required: [...(tool.parameters.required ?? []), 'repo'],
                }
                : tool.parameters
            return defineTool({
                name: toolName,
                description: describe(tool.description),
                parameters,
                ...(toolCallers ? { callers: toolCallers } : {}),
                async execute(args, api) {
                    const startedAt = Date.now()
                    // The arguments without `repo`, which names a workspace and is not a file path.
                    let target = workspace
                    let callArgs = args
                    let repoRefusal: string | undefined
                    if (repoArgument) {
                        const { repo, ...rest } = (args ?? {}) as Record<string, unknown>
                        try {
                            target = repoArgument.workspaceFor(String(repo ?? ''))
                            callArgs = rest
                        } catch (error) {
                            repoRefusal = `${toolName} ${error instanceof Error ? error.message : String(error)}`
                        }
                    }
                    // A refused call names a secret path, so its arguments never reach the log.
                    const refused = namesSecretPath(args)
                    const writeRefusal = writes && writeAccess && !refused
                        ? (!(await writeAccess.mayWrite()) ? writeAccess.refusedText
                            : namesForbiddenPath(args) ? 'Refused: Benny never changes workflow files (.github/workflows, .github/actions) or the whole repo at once. Describe the change in your reply instead.' : undefined)
                        : undefined
                    const result = refused
                        ? { content: [{ type: 'text' as const, text: REFUSED_TEXT }], isError: true }
                        : writeRefusal
                            ? { content: [{ type: 'text' as const, text: writeRefusal }], isError: true }
                            : repoRefusal
                                ? { content: [{ type: 'text' as const, text: repoRefusal }], isError: true }
                                : await toolSetFor(target).execute({ id: api.callId, name: tool.name, arguments: callArgs })
                    // Arguments can hold whole files (write, edit), so only the start is logged.
                    const argsFields = refused ? {} : { args: JSON.stringify(args).slice(0, 200) }
                    // The secret filter runs first: it drops whole items, and the cap counts what is left.
                    const filtered = withoutSecrets(tool.name, result.content)
                    const noted = resultNote
                        ? filtered.map((block) => block.type === 'text' ? { ...block, text: withNote(resultNote, block.text) } : block)
                        : filtered
                    const capped = capOutput(tool.name, noted, args)
                    const runId = await currentRunId()
                    log('tool', {
                        name: toolName, ...argsFields, ms: Date.now() - startedAt, isError: result.isError,
                        // A nested call's id is `<script call id>/c<n>`, so a script's calls group by the
                        // part before the last `/`.
                        callId: api.callId,
                        ...(capped.cutChars > 0 ? { cutChars: capped.cutChars } : {}), runId,
                    })
                    return { output: capped.content, isError: result.isError }
                },
            })
        }),
    })
}
