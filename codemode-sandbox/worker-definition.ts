import { exports } from "cf/config";

// The code mode sandbox Worker's fields, written once: the deploy (`cloudflare.config.ts`) and
// `cf dev` (`../vite.config.ts`) both start this Worker, and only their entrypoint forms differ.
// Everything the two must agree on lives here, so a change cannot reach one and miss the other.
export const codemodeSandboxWorker = {
	name: "bobby-codemode-sandbox",
	compatibilityDate: "2026-10-06",
	// Reached only through Benny's `CODEMODE_SANDBOX` binding: no public URL.
	workersDev: false,
	previewUrls: false,
	observability: { enabled: true },
	exports: {
		// One object per script: `PiAgent` asks for a fresh name per script, and an object never
		// keeps anything, so no script waits on another.
		CodemodeSandbox: exports.durableObject({
			storage: "sqlite",
		}),
	},
} as const;
