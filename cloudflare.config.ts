import { bindings, defineConfig, defineContainer, exports } from "cf/config";
import { loadEnv } from "vite";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

// The thread sandbox (batch 4). The instance size is set at `start()`, not here.
const sandbox = defineContainer({
	name: "bobby-sandbox",
	schedulingPolicy: "durable-object",
	images: { workspace: { dockerfile: "./Dockerfile.sandbox" } },
});

// Everywhere but production (`pnpm dev`), the thread sandboxes run in the deployed
// `bobby-sandbox-dev` Worker (`sandbox/cloudflare.config.ts`) instead of in local Docker, which
// stalls on native Linux (docs/learnings/sandbox.md). To remove the remote sandbox, work through
// the list in that page's "Remote sandbox in dev".
const REMOTE_SANDBOX_WORKER = "bobby-sandbox-dev";

// Which GitHub App Benny answers as: `bobby-sb` when deployed, `bobby-local` everywhere else.
// `userId` is the numeric id of the App's `<slug>[bot]` account (api.github.com/users/<slug>%5Bbot%5D).
const PRODUCTION_APP = { slug: "bobby-sb", userId: "356604674" };
const LOCAL_APP = { slug: "bobby-local", userId: "359884495" };

// Claude Code is every thread's harness (issue #61) in production and in `npm run dev:claude-code`
// (the `claude-code` mode); plain `pnpm dev` runs `pi`. Its containers run in a deployed agent
// Worker (`agent/cloudflare.config.ts`), reached through `AGENT_SERVICE`; they call Benny's `/mcp`
// back at `PUBLIC_BASE_URL`, the host GitHub's webhooks reach. Production and dev each have their
// own agent Worker and base URL: a thread's container is named by the thread, so one shared agent
// Worker would give `bobby-sb` and `bobby-local` the same container in the same issue.
const CLAUDE_CODE_MODE = "claude-code";
// `npm run dev:claude-code-tool` (the `claude-code-tool` mode, dev only): pi stays the harness and
// gets the `claude_code` tool (issue #61, T7), which runs one task in the same agent Worker.
const CLAUDE_CODE_TOOL_MODE = "claude-code-tool";
// Deploy the production agent Worker before a production deploy of this one: `pnpm agent:deploy:production`.
// Each base URL comes from `.env` (see `.env.example`): production's is this Worker's own URL, and
// dev's is the tunnel to the dev server.
const PRODUCTION_AGENT = { worker: "bobby-agent", publicBaseUrlName: "PUBLIC_BASE_URL_PRODUCTION" };
const DEV_AGENT = { worker: "bobby-agent-dev", publicBaseUrlName: "PUBLIC_BASE_URL_DEV" };

export default defineConfig(({ mode }) => {
	const production = mode === "production";
	const claudeCode = production || mode === CLAUDE_CODE_MODE;
	const claudeCodeTool = mode === CLAUDE_CODE_TOOL_MODE;
	const agent = claudeCode || claudeCodeTool ? (production ? PRODUCTION_AGENT : DEV_AGENT) : undefined;
	const publicBaseUrl = agent && loadEnv(mode ?? '', process.cwd(), '')[agent.publicBaseUrlName];
	// Without it the agent's containers have no `/mcp` to call, and every Claude Code task fails later.
	if (agent && !publicBaseUrl) throw new Error(`Set ${agent.publicBaseUrlName} in .env: the mode "${mode}" needs it (see .env.example).`);
	const remoteSandbox = !production;
	return {
		containers: remoteSandbox ? [] : [sandbox],
		worker: {
			name: "bobby",
			// Pinned: the installed workerd refuses a date newer than it knows, so "today" broke `pnpm dev`
			// a week after each install. Raise it by hand when `cf` is updated.
			compatibilityDate: "2026-11-10",
			// `@cloudflare/sandbox` needs Node APIs.
			compatibilityFlags: ["nodejs_compat"],
			entrypoint,
			// Lets the account's Logpush jobs (Axiom today, R2 later) ship this Worker's logs; the jobs are set up outside this file.
			logpush: true,
			env: {
				// `development` in `.env` lets logs carry private text (src/log.ts); anything else keeps it out.
				ENVIRONMENT: bindings.text('production'),
				// `mode` is "production" only when `pnpm deploy` passes `--mode production`.
				BOT_USERNAME: bindings.text(mode === "production" ? PRODUCTION_APP.slug : LOCAL_APP.slug),
				BOT_USER_ID: bindings.text(mode === "production" ? PRODUCTION_APP.userId : LOCAL_APP.userId),
				GITHUB_APP_ID: bindings.secret(),
				GITHUB_WEBHOOK_SECRET: bindings.secret(),
				GITHUB_PRIVATE_KEY: bindings.secret(),
				OPENCODE_API_KEY: bindings.secret(),
				EXA_API_KEY: bindings.secret(),
				// The decision model, Jev through OpenRouter (src/jev/classify.ts).
				OPENROUTER_KEY: bindings.secret(),
				// The cron list's Cloudflare Access app (`src/cron-list.ts`): the team domain, such as
				// `example.cloudflareaccess.com`, and the app's Application Audience (AUD) tag. Without
				// both, the list answers 401 to everyone.
				ACCESS_TEAM_DOMAIN: bindings.secret(),
				ACCESS_AUD: bindings.secret(),
				// The dev-only routes (`src/dev-routes.ts`, such as firing a cron now for a live test): only
				// the exact `'true'` turns them on, and production never gets it.
				DEV_ROUTES_ENABLED: bindings.text(mode === "production" ? 'false' : 'true'),
				MODEL_CALLS_ENABLED: bindings.text('true'),
				// Code mode (requirement 16): only the exact `'true'` offers the model the `codemode` tool.
				// A missing binding or any other value keeps today's behaviour.
				CODEMODE_ENABLED: bindings.text('true'),
				// The harness every thread runs on (issue #61): `pi` (pi-durable) or `claude-code`. Read once
				// per `PiAgent` in `src/pi/harness.ts`; any other value fails there.
				HARNESS: bindings.text(claudeCode ? 'claude-code' : 'pi'),
				// pi's `claude_code` tool: only the exact `'true'`, with `AGENT_SERVICE` bound, offers it.
				CLAUDE_CODE_TOOL_ENABLED: bindings.text(claudeCodeTool ? 'true' : 'false'),
				...(agent
					? {
						// Each thread's `AgentDO` in the deployed agent Worker; `remote: true` reaches it from `cf dev`.
						AGENT_SERVICE: bindings.worker({
							worker: agent.worker,
							exportName: "AgentService",
							dev: { remote: true },
						}),
						PUBLIC_BASE_URL: bindings.text(publicBaseUrl!),
					}
					: {}),
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
