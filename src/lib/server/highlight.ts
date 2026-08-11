import { createHighlighter, type Highlighter, type ThemeRegistrationRaw } from 'shiki';
import { posts } from '$lib/posts';

/**
 * Site palette as hex (Shiki themes cannot take oklch):
 * keywords = accent blue, strings = green, numbers = teal, comments = #5c6575.
 */
const theme: ThemeRegistrationRaw = {
	name: 'cantwell-dark',
	type: 'dark',
	colors: {
		'editor.background': '#171d28',
		'editor.foreground': '#c6cfdd'
	},
	settings: [
		{ settings: { background: '#171d28', foreground: '#c6cfdd' } },
		{
			scope: ['comment', 'punctuation.definition.comment'],
			settings: { foreground: '#5c6575' }
		},
		{
			scope: ['string', 'string.quoted', 'constant.character', 'punctuation.definition.string'],
			settings: { foreground: '#73c385' }
		},
		{
			scope: ['constant.numeric', 'constant.language.boolean', 'constant.language.null'],
			settings: { foreground: '#1ad1d1' }
		},
		{
			scope: [
				'keyword',
				'keyword.control',
				'keyword.operator.new',
				'keyword.other',
				'storage',
				'storage.type',
				'storage.modifier',
				'variable.language',
				'support.type.primitive'
			],
			settings: { foreground: '#55c4fe' }
		},
		{
			scope: ['entity.name.function', 'support.function', 'meta.function-call.generic'],
			settings: { foreground: '#e9eef6' }
		},
		// Operators and punctuation stay body-colored: only word keywords take the accent.
		{
			scope: ['keyword.operator', 'punctuation'],
			settings: { foreground: '#c6cfdd' }
		}
	]
};

/** Every language used by the bundled posts, so the highlighter loads exactly what it needs. */
const langs = [
	...new Set(
		posts.flatMap((post) =>
			post.blocks.filter((block) => block.type === 'code').map((block) => block.lang)
		)
	)
];

let highlighterPromise: Promise<Highlighter> | undefined;

function getHighlighter(): Promise<Highlighter> {
	highlighterPromise ??= createHighlighter({ themes: [theme], langs });
	return highlighterPromise;
}

/** Build-time syntax highlighting. Runs during prerender, so nothing ships to the client. */
export async function highlight(code: string, lang: string): Promise<string> {
	const highlighter = await getHighlighter();
	return highlighter.codeToHtml(code, {
		lang: highlighter.getLoadedLanguages().includes(lang) ? lang : 'text',
		theme: 'cantwell-dark'
	});
}
