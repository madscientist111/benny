import { defineConfig } from "cf/config";
import * as entrypoint from "../src/codemode-sandbox-worker.ts" with { type: "cf-worker" };
import { codemodeSandboxWorker } from "./worker-definition.ts";

// The code mode sandbox Worker: every script's QuickJS VM runs in one of its Durable Objects,
// off `PiAgent`'s thread (docs/learnings/code-mode.md). `cf dev` runs it next to Benny as an
// auxiliary Worker (`../vite.config.ts`), so this file is only for the deploy. Deploy it before
// Benny: `npm run codemode-sandbox:deploy`. It imports nothing of Benny's and holds no secrets.
// The Worker's fields are in `worker-definition.ts`, which dev reads too; only the entrypoint's
// form differs here: the module namespace, compiled by the deploy.
export default defineConfig({
	worker: {
		...codemodeSandboxWorker,
		entrypoint,
	},
});
