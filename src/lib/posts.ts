import data from './data/posts.json';

export type Block =
	| { type: 'p'; text: string }
	| { type: 'h2'; text: string }
	| { type: 'code'; lang: string; code: string }
	| { type: 'list'; items: string[] };

export type Post = {
	slug: string;
	title: string;
	/** ISO date, YYYY-MM-DD */
	date: string;
	tags: string[];
	readingTime: number;
	excerpt: string;
	/** Placeholder content, to be replaced with real writing. */
	sample?: boolean;
	blocks: Block[];
};

/** Newest first. */
export const posts: Post[] = [...(data.posts as Post[])].sort((a, b) => b.date.localeCompare(a.date));

const MONTHS = [
	'JAN',
	'FEB',
	'MAR',
	'APR',
	'MAY',
	'JUN',
	'JUL',
	'AUG',
	'SEP',
	'OCT',
	'NOV',
	'DEC'
];

/** "NOV 18", or "NOV 18, 2025" with the year. Parsed by hand to stay timezone-proof. */
export function formatDate(iso: string, withYear = false): string {
	const [year, month, day] = iso.split('-');
	const base = `${MONTHS[Number(month) - 1]} ${Number(day)}`;
	return withYear ? `${base}, ${year}` : base;
}
