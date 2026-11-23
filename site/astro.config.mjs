import { defineConfig } from "astro/config";

// A static site: `astro build` writes plain files to `dist`, and `cloudflare.config.ts` serves them.
export default defineConfig({
	site: "https://benny.heyshoo.in",
});
