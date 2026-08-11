import { error } from '@sveltejs/kit';
import { posts, formatDate } from '$lib/posts';
import { highlight } from '$lib/server/highlight';
import type { EntryGenerator, PageServerLoad } from './$types';

export const entries: EntryGenerator = () => posts.map((post) => ({ slug: post.slug }));

export const load: PageServerLoad = async ({ params }) => {
	const index = posts.findIndex((post) => post.slug === params.slug);
	if (index === -1) error(404, 'Post not found');

	const post = posts[index];
	// posts is newest first, so the next entry is the older post.
	const older = posts[index + 1];
	const newer = posts[index - 1];

	const blocks = await Promise.all(
		post.blocks.map(async (block) =>
			block.type === 'code'
				? { ...block, html: await highlight(block.code, block.lang) }
				: block
		)
	);

	return {
		title: post.title,
		excerpt: post.excerpt,
		dateLabel: formatDate(post.date, true),
		readLabel: `${post.readingTime} MIN READ`,
		tags: post.tags.map((tag) => tag.toUpperCase()),
		blocks,
		older: older && { slug: older.slug, title: older.title },
		newer: newer && { slug: newer.slug, title: newer.title }
	};
};
