import { createModels, type Provider } from "@earendil-works/pi-ai/models";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { OPENCODE_GO_MODELS } from "@earendil-works/pi-ai/providers/opencode-go.models";
import type { ProviderHeaders } from "@earendil-works/pi-ai";

// Which model answers, and how it is called: the default model on OpenCode Go with the Worker's
// API key, plus the old Workers AI model reference, so conversations that stored it still resolve.

export const defaultModel = OPENCODE_GO_MODELS["deepseek-v4.1-flash"];

// Registered below so pi-durable can resolve the model reference that older conversations stored.
// Existing Workers AI sessions use Go without rewriting their Pi records.
const legacyModel = {
    ...defaultModel,
    provider: "cloudflare",
    id: "@cf/zai-org/glm-5.3-flash",
};

/**
 * Every model reference Benny writes or has written (the git history of this file has no other);
 * `src/harness.ts` sets their compaction limit once at startup.
 */
export const modelsInUse = [defaultModel, legacyModel] as const;

export const createAssistantModels = (
    apiKey: string | undefined,
    enabled: boolean,
) => {
    const models = createModels();
    const provider: Provider = opencodeGoProvider();

    const requestOptions = <T extends { headers?: ProviderHeaders }>(
        options?: T,
    ) => {
        if (!enabled) throw new Error("AI is disabled locally. Start pnpm dev:ai.");
        if (!apiKey?.trim())
            throw new Error("OpenCode Go API key is not configured.");

        return {
            apiKey,
            headers: { ...options?.headers, "User-Agent": "pi-durable-chat/1.0" },
        };
    };

    const securedProvider: Provider = {
        ...provider,
        auth: {
            apiKey: {
                name: "OpenCode Go API key",
                resolve: async () => ({
                    auth: { apiKey: requestOptions().apiKey },
                    source: "Worker secret OPENCODE_API_KEY",
                }),
            },
        },
        stream: (model, input, options) =>
            provider.stream(model, input, Object.assign({}, options, requestOptions(options))),
        streamSimple: (model, input, options) =>
            provider.streamSimple(model, input, {
                ...options,
                ...requestOptions(options),
            }),
    };

    models.setProvider(securedProvider);

    models.setProvider({
        ...securedProvider,
        id: "cloudflare",
        getModels: () => [legacyModel],
        getAllModels: () => [legacyModel],
        stream: (model, input, options) =>
            securedProvider.stream(
                { ...model, id: defaultModel.id, provider: defaultModel.provider },
                input,
                options,
            ),
        streamSimple: (model, input, options) =>
            securedProvider.streamSimple(
                { ...model, id: defaultModel.id, provider: defaultModel.provider },
                input,
                options,
            ),
    });

    return models;
};
