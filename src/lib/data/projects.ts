export type Project = {
	title: string;
	desc: string;
	img: string;
	link: string;
	code: string;
	/** Items without a live deployment show only CODE → and link the thumbnail to the repo. */
	noLive?: boolean;
};

export const featured: Project[] = [
	{
		title: 'Pixel V',
		desc: 'Advanced pixel drawing app built around an undo function.',
		img: '/undo_thumb.png',
		link: 'https://pixelvee.netlify.app/',
		code: 'https://github.com/Tororoi/pixel-vee'
	}
];

export const earlier: Project[] = [
	{
		title: 'Artist Portfolio Site',
		desc: 'Portfolio site designed and built for artist Katy Wang.',
		img: '/katy-website_thumb.png',
		link: 'https://www.katywangstudio.com/',
		code: 'https://github.com/Tororoi/katy-website'
	},
	{
		title: 'Pathfinding Visualizer',
		desc: 'Watch how various algorithms find the shortest path. Includes a random maze generator.',
		img: '/path_visualizer.png',
		link: 'https://astarpathfinder.netlify.app/',
		code: 'https://github.com/Tororoi/astar-pathfinding-js'
	},
	{
		title: 'Snail Racing Game',
		desc: 'Create custom snails and bet on their races.',
		img: '/snailrace_thumb.png',
		link: 'https://github.com/Tororoi/snail-race-web',
		code: 'https://github.com/Tororoi/snail-race-web',
		noLive: true
	},
	{
		title: 'Dungeon Maker',
		desc: 'Build custom dungeons, then play them.',
		img: '/dungeon_thumb.png',
		link: 'https://codepen.io/tororoi/pen/ExKedbP',
		code: 'https://github.com/Tororoi/dungeon-maker'
	}
];
