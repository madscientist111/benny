import { bindings, defineConfig, defineContainer, exports } from "cf/config";
import * as entrypoint from "../src/agent-worker.ts" with { type: "cf-worker" };

// The agent Worker (issue #61): each thread's `AgentDO` and its Claude Code container, behind the
// `AgentService` RPC entrypoint. Two copies: `bobby-agent-dev` for dev servers (`pnpm agent:deploy`)
// and `bobby-agent` for the deployed Benny (`pnpm agent:deploy:production`). Both take
// `--secrets-file <file>` with `CLAUDE_CODE_OAUTH_TOKEN`.
// `--mode probe` adds a public route behind `PROBE_KEY` for scripts/probe-agent.mjs; redeploy
// without it and delete the secret when done.
const PROBE_MODE = "probe";

export default defineConfig(({ mode }) => {
	const probe = mode === PROBE_MODE;
	const workerName = mode === "production" ? "bobby-agent" : "bobby-agent-dev";
	const agentContainer = defineContainer({
		name: workerName,
		schedulingPolicy: "durable-object",
		images: { agent: { dockerfile: "../Dockerfile.agent" } },
	});
	return {
		containers: [agentContainer],
		worker: {
			name: workerName,
			compatibilityDate: "2026-10-06",
			compatibilityFlags: ["nodejs_compat"],
			entrypoint,
			// Reached only through the service binding, except in probe mode.
			workersDev: probe,
			previewUrls: false,
			observability: { enabled: true },
			env: {
				AGENT: bindings.durableObject({ exportName: "AgentDO", worker: workerName }),
				CLAUDE_CODE_OAUTH_TOKEN: bindings.secret(),
				...(probe ? { PROBE_KEY: bindings.secret() } : {}),
			},
			exports: {
				AgentDO: exports.durableObject({ storage: "sqlite", container: agentContainer }),
				AgentService: exports.worker(),
			},
		},
	};
});
