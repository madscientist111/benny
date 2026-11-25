import type { APIRoute } from "astro";
import type { CollectionEntry } from "astro:content";
import { publishedPosts } from "../../lib/posts";

// Each post as plain Markdown at /blog/<slug>.md, for coding agents and answer engines that read
// Markdown. The post page links to it with rel="alternate", and llms.txt lists it.
export async function getStaticPaths() {
	const posts = await publishedPosts();
	return posts.map((post) => ({ params: { slug: post.id }, props: { post } }));
}

export const GET: APIRoute = ({ props, site }) => {
	const { post } = props as { post: CollectionEntry<"blog"> };
	const pageUrl = new URL(`/blog/${post.id}/`, site).href;
	const published = post.data.published.toISOString().slice(0, 10);
	const markdown = `# ${post.data.title}\n\n> ${post.data.description}\n\nBy Devanshu Bhatt, ${published}. Web version: ${pageUrl}\n\n${(post.body ?? "").replaceAll("](/", `](${new URL("/", site).href}`)}`;
	return new Response(markdown, { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
};
