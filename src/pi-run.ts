import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ConversationIdle, type Registry } from "@earendil-works/pi-durable";
import type { PiHarness } from "agents/harness/pi";
import { CLAUDE_CODE_TOOL_NAME, type ClaudeCodeToolDetails } from "./claude-code-tool";
import type { Harness, RunResult, RunUsage } from "./harness-contract";
import { mergedIntervalsMs, type SandboxDetails, type SandboxInterval } from "./sandbox-tools";

// The `Harness` contract over pi-durable: the thread's root pi session. `harness.ts` builds it when
// `HARNESS` is `pi`, and `PiAgent` calls it. The code is what `PiAgent` called on pi directly
// before the contract; the footnote's counts are read from pi's transcript here.

export class PiRun implements Harness {
    readonly #pi: PiHarness
    // Benny's tools as pi extensions: `hideTools` finds the registrations its names belong to.
    readonly #registry: Registry
    // Only a sandbox tool's result carries the details the footnote counts, so the tool name, never
    // the shape of `details`, decides which results count.
    readonly #isSandboxTool: (toolName: string) => boolean

    constructor(pi: PiHarness, registry: Registry, isSandboxTool: (toolName: string) => boolean) {
        this.#pi = pi
        this.#registry = registry
        this.#isSandboxTool = isSandboxTool
    }

    async messageCount(): Promise<number> {
        return (await this.#pi.session().messages()).length
    }

    async submit(prompt: string): Promise<{ operationId: string; joined: boolean }> {
        const session = this.#pi.session()
        try {
            // One step joins the running work or is refused, so it cannot race the run's end.
            const { operationId } = await session.submit(prompt, { whenBusy: 'steer', whenIdle: 'reject' })
            return { operationId, joined: true }
        } catch (error) {
            // A second copy of pi-durable in the bundle would break `instanceof`, so the name counts too.
            const idle = error instanceof ConversationIdle || (error instanceof Error && error.name === 'ConversationIdle')
            if (!idle) throw error
            // Nothing was running, so this request leads a run of its own.
            const { operationId } = await session.submit(prompt)
            return { operationId, joined: false }
        }
    }

    async startRunWhenIdle(prompt: string): Promise<{ operationId: string }> {
        const { operationId } = await this.#pi.session().submit(prompt, { whenBusy: 'reject' })
        return { operationId }
    }

    wait(operationId: string): Promise<RunResult> {
        return this.#pi.session().wait(operationId)
    }

    async abort(operationId?: string): Promise<void> {
        await this.#pi.session().abort(operationId)
    }

    async hideTools(toolNames: readonly string[]): Promise<void> {
        const installedTools = this.#registry.snapshot().tools().map(({ tool }) => tool)
        const hidden = toolNames.flatMap((name) => installedTools.find((tool) => tool.name === name) ?? [])
        const root = await (await this.#pi.pi()).root(BACKGROUND_CONTEXT)
        // `null` offers every tool the model may call again; tools with `callers: ['tools']` stay hidden (code mode).
        await root.configure({ modelTools: hidden.length === 0 ? null : { remove: hidden } }, BACKGROUND_CONTEXT)
    }

    // Counts only the messages after `messageCountBefore`, which inherits the compaction index
    // issue (#21): after a compaction that count points into a shorter list. pi-ai's
    // `usage.input` alone leaves cached tokens out, so `tokensIn` adds `cacheRead` and `cacheWrite`.
    async usageSince(messageCountBefore: number): Promise<RunUsage> {
        const usage: RunUsage = {
            tokensIn: 0, cachedTokensIn: 0, tokensOut: 0, toolCalls: 0, webSearches: 0, webFetches: 0,
            turns: 0, peakContextTokens: 0,
            sandboxCalls: 0, sandboxWallMs: 0, sandboxStarts: 0, sandboxInstallMs: 0,
            claudeCodeTasks: 0, claudeCodeCostUsd: 0,
        }
        // A sandbox call's span on the clock, so parallel calls that waited on the same start
        // count that wait once.
        const sandboxIntervals: SandboxInterval[] = []
        // A result from before `sandboxStartedAt` was stored has no place on the clock, so its
        // own time is added alone: whether it overlapped the others is unknown.
        let sandboxMsWithoutStart = 0
        for (const entry of (await this.#pi.session().messages()).slice(messageCountBefore)) {
            for (const message of entry.model ?? []) {
                if (message.role === 'toolResult') {
                    // A sandbox tool's result says what its call did there, a failed call too; a
                    // refused call, and a result from before the footnote counted this, has none.
                    const sandboxCall = this.#isSandboxTool(message.toolName)
                        ? message.details as Partial<SandboxDetails> | undefined
                        : undefined
                    // A `claude_code` call that ran a task says what it cost; a refused one has no details.
                    const claudeCodeTask = message.toolName === CLAUDE_CODE_TOOL_NAME
                        ? message.details as Partial<ClaudeCodeToolDetails> | undefined
                        : undefined
                    if (typeof claudeCodeTask?.costUsd === 'number') {
                        usage.claudeCodeTasks += 1
                        usage.claudeCodeCostUsd += claudeCodeTask.costUsd
                    }
                    if (typeof sandboxCall?.sandboxMs === 'number') {
                        usage.sandboxCalls += 1
                        usage.sandboxInstallMs += sandboxCall.installMs ?? 0
                        if (typeof sandboxCall.sandboxStartedAt === 'number') {
                            sandboxIntervals.push({ start: sandboxCall.sandboxStartedAt, end: sandboxCall.sandboxStartedAt + sandboxCall.sandboxMs })
                        } else {
                            sandboxMsWithoutStart += sandboxCall.sandboxMs
                        }
                        if (sandboxCall.started === true) usage.sandboxStarts += 1
                    }
                }
                if (message.role !== 'assistant') continue
                // One assistant message is one turn, and every turn sent the whole context
                // again: the largest of those sends is the context the request reached.
                const contextTokens = message.usage.input + message.usage.cacheRead + message.usage.cacheWrite
                usage.turns += 1
                usage.tokensIn += contextTokens
                usage.cachedTokensIn += message.usage.cacheRead
                usage.tokensOut += message.usage.output
                usage.peakContextTokens = Math.max(usage.peakContextTokens, contextTokens)
                for (const block of message.content) {
                    if (block.type !== 'toolCall') continue
                    // Every call the model made, refused ones too: a refusal happens before Exa,
                    // so the footnote shows the attempts.
                    usage.toolCalls += 1
                    if (block.name === 'web_search') usage.webSearches += 1
                    if (block.name === 'web_fetch') usage.webFetches += 1
                }
            }
        }
        usage.sandboxWallMs = mergedIntervalsMs(sandboxIntervals) + sandboxMsWithoutStart
        return usage
    }
}
