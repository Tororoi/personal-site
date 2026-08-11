import { posts, formatDate } from '$lib/posts';

export function load() {
	const [latest, ...rest] = posts;

	const byYear = new Map<string, typeof rest>();
	for (const post of rest) {
		const year = post.date.slice(0, 4);
		byYear.set(year, [...(byYear.get(year) ?? []), post]);
	}

	return {
		featured: latest && {
			slug: latest.slug,
			title: latest.title,
			excerpt: latest.excerpt,
			meta: `${formatDate(latest.date, true)} · ${latest.readingTime} MIN`
		},
		years: [...byYear.entries()]
			.sort(([a], [b]) => b.localeCompare(a))
			.map(([year, yearPosts]) => ({
				year,
				posts: yearPosts.map((post) => ({
					slug: post.slug,
					title: post.title,
					excerpt: post.excerpt,
					meta: `${formatDate(post.date)} · ${post.readingTime} MIN`
				}))
			}))
	};
}
