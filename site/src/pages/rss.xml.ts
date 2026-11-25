import type { APIRoute } from "astro";
import { publishedPosts } from "../lib/posts";

// The blog's RSS feed at /rss.xml, written by hand so the site needs no feed package.
const escapeXml = (text: string) =>
	text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const GET: APIRoute = async ({ site }) => {
	const posts = await publishedPosts();
	const blogUrl = new URL("/blog/", site).href;
	const items = posts
		.map((post) => {
			const postUrl = new URL(`/blog/${post.id}/`, site).href;
			return `<item><title>${escapeXml(post.data.title)}</title><link>${postUrl}</link><guid>${postUrl}</guid><description>${escapeXml(post.data.description)}</description><pubDate>${post.data.published.toUTCString()}</pubDate></item>`;
		})
		.join("");
	const feed = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Benny blog</title><link>${blogUrl}</link><description>Running a software factory on GitHub, where your team already works.</description><language>en</language>${items}</channel></rss>`;
	return new Response(feed, { headers: { "Content-Type": "application/rss+xml; charset=utf-8" } });
};
