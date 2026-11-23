import { bindings, defineConfig, defineContainer, exports } from "cf/config";
import * as entrypoint from "../src/sandbox-worker.ts" with { type: "cf-worker" };

// The sandbox Worker that Benny in dev reaches (see `../cloudflare.config.ts`): the
// same `SandboxDO`, container image and egress proxy as Benny's own, behind the `SandboxService`
// RPC entrypoint. It holds none of Benny's secrets. Deploy: `npm run sandbox:deploy`.
const sandbox = defineContainer({
	name: "bobby-sandbox-dev",
	schedulingPolicy: "durable-object",
	images: { workspace: { dockerfile: "../Dockerfile.sandbox" } },
});

export default defineConfig({
	containers: [sandbox],
	worker: {
		name: "bobby-sandbox-dev",
		compatibilityDate: "2026-10-06",
		// `@cloudflare/sandbox` needs Node APIs.
		compatibilityFlags: ["nodejs_compat"],
		entrypoint,
		// Reached only through the service binding: no public URL.
		workersDev: false,
		previewUrls: false,
		observability: { enabled: true },
		env: {
			// `SandboxService` reaches each thread's sandbox by name.
			SANDBOX: bindings.durableObject({ exportName: "SandboxDO", worker: "bobby-sandbox-dev" }),
			// pnpm and npm stores, keyed by lockfile hash; kept apart from production's bucket.
			DEPENDENCY_CACHE: bindings.r2({ name: "bobby-dependency-cache-dev" }),
		},
		exports: {
			SandboxDO: exports.durableObject({
				storage: "sqlite",
				container: sandbox,
			}),
			SandboxEgress: exports.worker(),
			DirectoryBackupGateway: exports.worker(),
			SandboxService: exports.worker(),
		},
	},
});
