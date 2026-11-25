import { getCollection } from "astro:content";

// The published blog posts, newest first. Used by /blog, each post page and the RSS feed, so a
// draft is left out of all three the same way.
export async function publishedPosts() {
	const posts = await getCollection("blog", (post) => !post.data.draft);
	return posts.sort((a, b) => b.data.published.getTime() - a.data.published.getTime());
}
