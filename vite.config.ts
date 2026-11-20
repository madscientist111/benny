import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig, loadEnv } from "vite";
import { codemodeSandboxWorker } from "./codemode-sandbox/worker-definition.ts";

export default defineConfig(({ mode }) => ({
	plugins: [cloudflare({
		// `cf dev` runs the code mode sandbox Worker next to Benny in one dev server, so Benny's
		// `CODEMODE_SANDBOX` binding (cloudflare.config.ts) reaches a local object. `devOnly` keeps
		// it out of this Worker's build: in production the binding reaches the deployed
		// `bobby-codemode-sandbox` (codemode-sandbox/cloudflare.config.ts), which is the only copy
		// `npm run codemode-sandbox:deploy` updates. Both read the Worker's fields from
		// `codemode-sandbox/worker-definition.ts`, so the two cannot disagree; only the entrypoint's
		// form differs: a path here, the imported module there.
		auxiliaryWorkers: [
			{
				devOnly: true,
				config: {
					...codemodeSandboxWorker,
					entrypoint: "./src/codemode-sandbox-worker.ts",
				},
			},
		],
	})],
	server: {
		// Tunnel hosts that may reach the dev server, comma-separated in `.env` (see `.env.example`).
		'allowedHosts': loadEnv(mode, process.cwd(), '').DEV_ALLOWED_HOSTS?.split(',') ?? []
	}
}));
