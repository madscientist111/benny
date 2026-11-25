import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

// A static site: `astro build` writes plain files to `dist`, and `cloudflare.config.ts` serves them.
// The sitemap integration writes `sitemap-index.xml`; `public/robots.txt` points to it.
export default defineConfig({
	site: "https://benny.heyshoo.in",
	integrations: [sitemap()],
});
