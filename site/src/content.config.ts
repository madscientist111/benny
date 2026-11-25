import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

// Blog posts are Markdown files in `src/content/blog/`; the file name is the URL slug.
// A post with `draft: true` is built nowhere: not in /blog, the RSS feed or the sitemap.
const blog = defineCollection({
	loader: glob({ pattern: "*.md", base: "./src/content/blog" }),
	schema: z.object({
		title: z.string(),
		description: z.string().max(170),
		published: z.coerce.date(),
		updated: z.coerce.date().optional(),
		draft: z.boolean().default(false),
		// Paths under public/: `image` is shown at the top of the post, `shareImage` is the
		// 1200x630 JPG that link previews use (LinkedIn and X handle JPG better than WebP).
		image: z.string().optional(),
		imageAlt: z.string().optional(),
		shareImage: z.string().optional(),
	}),
});

export const collections = { blog };
