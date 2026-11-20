import { bindings, defineConfig, defineContainer, exports } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

// The thread sandbox (batch 4). The instance size is set at `start()`, not here.
const sandbox = defineContainer({
	name: "bobby-sandbox",
	schedulingPolicy: "durable-object",
	images: { workspace: { dockerfile: "./Dockerfile.sandbox" } },
});

// `npm run dev:remote-sandbox` (the `remote-sandbox` mode, dev only): the thread sandboxes run
// in the deployed `bobby-sandbox-dev` Worker (`sandbox/cloudflare.config.ts`) instead of in local
// Docker, which stalls on native Linux (docs/learnings/sandbox.md). Without the mode nothing
// changes. To remove the mode, work through the list in that page's "Remote sandbox in dev".
const REMOTE_SANDBOX_MODE = "remote-sandbox";
const REMOTE_SANDBOX_WORKER = "bobby-sandbox-dev";

export default defineConfig(({ mode }) => {
	const remoteSandbox = mode === REMOTE_SANDBOX_MODE;
	return {
		containers: remoteSandbox ? [] : [sandbox],
		worker: {
			name: "bobby",
			compatibilityDate: "2026-10-06",
			// `@cloudflare/sandbox` needs Node APIs.
			compatibilityFlags: ["nodejs_compat"],
			entrypoint,
			// Lets the account's Logpush jobs (Axiom today, R2 later) ship this Worker's logs; the jobs are set up outside this file.
			logpush: true,
			env: {
				WORLD: bindings.text("World"),
				// `development` in `.dev.vars` lets logs carry private text (src/log.ts); anything else keeps it out.
				ENVIRONMENT: bindings.text('production'),
				GITHUB_APP_ID: bindings.secret(),
				GITHUB_WEBHOOK_SECRET: bindings.secret(),
				GITHUB_PRIVATE_KEY: bindings.secret(),
				OPENCODE_API_KEY: bindings.secret(),
				EXA_API_KEY: bindings.secret(),
				MODEL_CALLS_ENABLED: bindings.text('true'),
				// Code mode (requirement 16): only the exact `'true'` offers the model the `codemode` tool.
				// A missing binding or any other value keeps today's behaviour.
				CODEMODE_ENABLED: bindings.text('true'),
				PI_AGENT: bindings.durableObject({
					'exportName': 'PiAgent',
					'worker': 'bobby'
				}),
				// Code mode: each script's VM runs in the `bobby-codemode-sandbox` Worker
				// (codemode-sandbox/cloudflare.config.ts), so a script that computes never blocks
				// `PiAgent` (docs/learnings/code-mode.md, "Where scripts run"). Deploy that Worker first.
				CODEMODE_SANDBOX: bindings.durableObject({
					'exportName': 'CodemodeSandbox',
					'worker': 'bobby-codemode-sandbox'
				}),
				// One object per GitHub repo, holding the only copy of its default branch.
				REPO: bindings.durableObject({
					'exportName': 'RepoDO',
					'worker': 'bobby'
				}),
				// One object per work branch (batch 5): the branch's files, committed through the GitHub API.
				BRANCH: bindings.durableObject({
					'exportName': 'BranchDO',
					'worker': 'bobby'
				}),
				// Chat SDK state (subscriptions, locks, dedupe, thread state): one shared object.
				CHAT_STATE: bindings.durableObject({
					'exportName': 'ChatStateDO',
					'worker': 'bobby'
				}),
				...(remoteSandbox
					? {
						// The deployed sandbox Worker's RPC entrypoint; `remote: true` reaches it from `cf dev`.
						SANDBOX_SERVICE: bindings.worker({
							worker: REMOTE_SANDBOX_WORKER,
							exportName: "SandboxService",
							dev: { remote: true },
						}),
					}
					: {
						// One sandbox per thread, named by the thread's PiAgent id.
						SANDBOX: bindings.durableObject({
							'exportName': 'SandboxDO',
							'worker': 'bobby'
						}),
						// pnpm and npm stores, keyed by lockfile hash.
						DEPENDENCY_CACHE: bindings.r2({ name: 'bobby-dependency-cache' }),
					}),
				AI: bindings.ai({ dev: { remote: true } }),
				LOADER: bindings.workerLoader()
			},
			exports: {
				PiAgent: exports.durableObject({
					'storage': 'sqlite',
				}),
				ChatStateDO: exports.durableObject({
					'storage': 'sqlite',
				}),
				RepoDO: exports.durableObject({
					'storage': 'sqlite',
				}),
				BranchDO: exports.durableObject({
					'storage': 'sqlite',
				}),
				...(remoteSandbox
					? {}
					: {
						SandboxDO: exports.durableObject({
							'storage': 'sqlite',
							container: sandbox,
						}),
						SandboxEgress: exports.worker(),
						DirectoryBackupGateway: exports.worker(),
					}),
			}
		},
	};
});
