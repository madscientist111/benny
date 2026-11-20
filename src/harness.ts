import {
    CompactionTask,
    createRegistry,
    DEFAULT_COMPACTION_POLICY,
    defineExtension,
    Harness,
    hook,
    type CompactionSettings,
    type Registry,
} from "@earendil-works/pi-durable";
import { PiHarness } from "agents/harness/pi";
import { log } from "./log";
import { createAssistantModels, defaultModel, modelsInUse } from "./models";

// The pi-durable harness every `PiAgent` runs on: the models, the turn limit of one run, and the
// context size above which a long thread is summarised (compaction).

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

export const createAssistantHarness = (env: Env) => {
    const registry: Registry = createRegistry();
    registry.install(compactionLog);
    const harness = new PiHarness({
        harness: ({ storage, context, onWake }) => {
            const models = createAssistantModels(
                env.OPENCODE_API_KEY,
                env.MODEL_CALLS_ENABLED === "true",
            );

            return Harness.open(storage, { models, registry, onWake, settings: { compaction: compactionSettings } }, context);
        },
        // Most tool rounds one run takes, so a run cannot loop forever (requirement 28).
        defaults: { model: defaultModel, thinkingLevel: "max", maxTurns: 50 },
    });

    return { harness, registry };
};
