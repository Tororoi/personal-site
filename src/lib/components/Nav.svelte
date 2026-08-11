<script lang="ts">
	import { page } from '$app/state';

	const path = $derived(page.url.pathname);
	const onProjects = $derived(path.startsWith('/projects'));
	const onBlog = $derived(path.startsWith('/blog'));
	const sticky = $derived(path.startsWith('/resume'));
</script>

<nav class:sticky>
	<a class="brand" href="/">
		<img src="/Blackburnian.png" width="34" height="34" alt="Blackburnian warbler" />
		<span class="name">THOMAS CANTWELL</span>
	</a>
	<div class="links">
		<a class="link" class:active={onProjects} href="/projects">PROJECTS</a>
		<a class="link" class:active={onBlog} href="/blog">BLOG</a>
		<a class="btn-outline" href="https://github.com/Tororoi" target="_blank" rel="noreferrer"
			>GITHUB ↗</a
		>
		<a class="btn-solid" href="/resume">RESUME</a>
	</div>
</nav>

<style>
	nav {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: var(--nav-pad);
		border-bottom: 1px solid var(--hairline);
	}

	nav.sticky {
		position: sticky;
		top: 0;
		background: var(--bg);
		z-index: 10;
	}

	.brand {
		display: flex;
		align-items: center;
		gap: 12px;
		min-height: 44px;
	}

	.brand img {
		width: 34px;
		height: 34px;
		object-fit: cover;
	}

	.name {
		font-family: var(--font-mono);
		font-size: 13px;
		font-weight: 700;
		letter-spacing: 0.12em;
	}

	.links {
		display: flex;
		align-items: center;
		gap: var(--nav-gap);
		font-family: var(--font-mono);
		font-size: var(--nav-font);
		letter-spacing: 0.1em;
	}

	.link {
		color: var(--muted);
		padding: 12px 0;
		transition: color 0.15s;
	}

	.link:hover,
	.link.active {
		color: var(--accent);
	}

	.btn-outline {
		color: var(--text);
		border: 1px solid var(--border-btn);
		padding: var(--btn-pad);
		font-weight: 700;
		transition:
			color 0.15s,
			border-color 0.15s;
	}

	.btn-outline:hover {
		border-color: var(--accent);
		color: var(--accent);
	}

	.btn-solid {
		color: var(--bg);
		background: var(--accent);
		padding: var(--btn-pad-solid);
		font-weight: 700;
		transition: background 0.15s;
	}

	.btn-solid:hover {
		background: var(--accent-hi);
		color: var(--bg);
	}

	@media (max-width: 719px) {
		.name {
			display: none;
		}
	}
</style>
