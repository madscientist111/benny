import { defineConfig } from "cf/config";

// The landing page's Worker: it has no code and only serves the files `astro build` writes.
// `pnpm run deploy` builds first and hands `cf` the `dist` folder, because `cf` cannot read an
// Astro build without the Cloudflare adapter. It publishes to benny.heyshoo.in.
export default defineConfig({
	worker: {
		name: "benny-site",
		compatibilityDate: "2026-11-01",
		domains: ["benny.heyshoo.in"],
		assets: { notFoundHandling: "404-page" },
	},
});
