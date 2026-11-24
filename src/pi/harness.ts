import {
    CompactionTask,
    createRegistry,
    DEFAULT_COMPACTION_POLICY,
    defineExtension,
    Harness as PiDurableHarness,
    hook,
    type CompactionSettings,
    type Registry,
} from "@earendil-works/pi-durable";
import type { Agent } from "agents";
import { PiHarness } from "agents/harness/pi";
import { AGENT_SERVICE_BINDING, ClaudeCodeRun, type AgentServiceMethods, type AgentWorkspace, type ToolTaskAccess } from "../claude-code-run";
import type { Harness } from "./harness-contract";
import { log } from "../log";
import { createAssistantModels, defaultModel, modelsInUse } from "./models";
import { PiRun } from "./run";

// Builds the harness a `PiAgent` runs its thread on, chosen by `HARNESS`. For `pi`: the pi-durable
// harness, its models, the turn limit of one run, and the context size above which a long thread
// is summarised (compaction). For `claude-code`: `ClaudeCodeRun` over the `AGENT_SERVICE` binding.

/**
 * Size of one model call's context above which the thread is summarised (issue #19). Not the
 * footnote's "sent" total, which adds up every call of a request; the footnote's "context" is this
 * size for the largest call.
 */
const COMPACT_ABOVE_TOKENS = 500_000;

// pi-durable compacts above `contextWindow - reserveTokens`, so each model gets the reserve that
// puts that point at `COMPACT_ABOVE_TOKENS`. Per model, not one general `reserveTokens`: on a
// window at or below 500k that would compact on every call. A model whose window would leave less
// than pi-durable's default reserve for the answer, or one not in `modelsInUse`, keeps the default
// (16,384 below its window). Computed once at startup from `modelsInUse`.
const compactionSettings: CompactionSettings = {
    modelOverrides: Object.fromEntries(
        modelsInUse
            .filter((model) => model.contextWindow >= COMPACT_ABOVE_TOKENS + DEFAULT_COMPACTION_POLICY.reserveTokens)
            .map((model) => [`${model.provider}/${model.id}`, { reserveTokens: model.contextWindow - COMPACT_ABOVE_TOKENS }]),
    ),
};

// Logs when a compaction starts, before the summary is written, so a run's logs show when one
// began. Never decides.
const compactionLog = defineExtension({
    name: "compaction-log",
    hooks: [
        hook(CompactionTask, {
            beforeCompact: ({ reason, entries }, api) => {
                log("compaction started", {
                    conversationId: api.conversationId,
                    reason,
                    // The active entries the summary replaces, the head marker first.
                    replacedEntryCount: entries.length,
                });
                return undefined;
            },
        }),
    ],
});

const createAssistantHarness = (env: Env) => {
    const registry: Registry = createRegistry();
    registry.install(compactionLog);
    const harness = new PiHarness({
        harness: ({ storage, context, onWake }) => {
            const models = createAssistantModels(
                env.OPENCODE_API_KEY,
                env.MODEL_CALLS_ENABLED === "true",
            );

            return PiDurableHarness.open(storage, { models, registry, onWake, settings: { compaction: compactionSettings } }, context);
        },
        // Most tool rounds one run takes, so a run cannot loop forever (requirement 28).
        defaults: { model: defaultModel, thinkingLevel: "max", maxTurns: 50 },
    });

    return { harness, registry };
};

/** The values `HARNESS` may hold; the binding in `cloudflare.config.ts` defaults to `pi`. */
const HARNESS_KINDS = ['pi', 'claude-code'] as const
type HarnessKind = typeof HARNESS_KINDS[number]

/**
 * The thread's harness from `HARNESS`, and the registry Benny's tools are installed on (pi-durable
 * extensions, whatever the harness). Any value but `pi` or `claude-code` is a config error, so the
 * object fails at construction instead of running on a harness nobody chose.
 */
export const createHarness = (env: Env, { lifecycle, isSandboxTool, newTaskToken, agentName, store, workspace }: {
    lifecycle: Agent<Env>['lifecycle']
    /** Whether a tool is one of the sandbox tools, whose results the footnote counts. */
    isSandboxTool: (toolName: string) => boolean
    /**
     * Starts a tool task for the run working now and returns its token and what it may do; a harness
     * outside the Worker sends the token to `/mcp` to call Benny's tools (`mcp-tools.ts`). pi runs
     * its tools itself and never calls it.
     */
    newTaskToken: () => Promise<{ token: string; access: ToolTaskAccess }>
    /** The thread's `AgentDO` name, for `claude-code`. */
    agentName: string
    /** The `PiAgent`'s synchronous storage, where `claude-code` keeps its runs. */
    store: SyncKvStorage
    /** The code a `claude-code` task starts from. */
    workspace: () => Promise<AgentWorkspace>
}): { harness: Harness; registry: Registry } => {
    // The cast: the generated type is the config's own literal (`'pi'`), and a deployment may set another.
    const kind = (env.HARNESS as string | undefined) ?? 'pi'
    if (!(HARNESS_KINDS as readonly string[]).includes(kind)) {
        throw new Error(`HARNESS is '${kind}': it must be one of ${HARNESS_KINDS.join(', ')}`)
    }
    if ((kind as HarnessKind) === 'claude-code') {
        // Both bindings exist only in the `claude-code` mode of `cloudflare.config.ts`, so the
        // generated `Env` lacks them and the cast names them.
        const { [AGENT_SERVICE_BINDING]: agentService, PUBLIC_BASE_URL: publicBaseUrl } = env as unknown as {
            [AGENT_SERVICE_BINDING]?: AgentServiceMethods; PUBLIC_BASE_URL?: string
        }
        if (!agentService) {
            throw new Error(`HARNESS is 'claude-code' but the ${AGENT_SERVICE_BINDING} binding is missing: bind the agent Worker's AgentService (cloudflare.config.ts, --mode claude-code)`)
        }
        if (!publicBaseUrl) {
            throw new Error("HARNESS is 'claude-code' but PUBLIC_BASE_URL is not set: the container reaches Benny's /mcp at that URL")
        }
        const harness = new ClaudeCodeRun({
            store, agentService, agentName, newTaskToken, workspace,
            mcpUrl: new URL('/mcp', publicBaseUrl).toString(),
        })
        // Benny's tools still install on a registry: `/mcp` serves the same registrations pi runs.
        return { harness, registry: createRegistry() }
    }
    const { harness, registry } = createAssistantHarness(env)
    lifecycle.use(harness)
    return { harness: new PiRun(harness, registry, isSandboxTool), registry }
}
