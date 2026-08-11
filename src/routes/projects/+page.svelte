<script lang="ts">
	import { featured, earlier } from '$lib/data/projects';
</script>

<svelte:head>
	<title>Projects · Thomas Cantwell</title>
	<meta name="description" content="Current and past projects by Thomas Cantwell." />
</svelte:head>

<section class="featured">
	<div class="section-head accent">
		<h2>Featured Projects</h2>
		<span class="label">ACTIVELY BUILDING</span>
	</div>
	{#each featured as p (p.title)}
		<div class="feature">
			<a
				class="feature-img"
				href={p.link}
				target="_blank"
				rel="noreferrer"
				style="background-image: url('{p.img}')"
				aria-label={p.title}
			></a>
			<div class="feature-body">
				<a class="feature-title" href={p.link} target="_blank" rel="noreferrer">{p.title}</a>
				<p>{p.desc}</p>
				<div class="links">
					<a class="live" href={p.link} target="_blank" rel="noreferrer">LIVE →</a>
					<a class="code" href={p.code} target="_blank" rel="noreferrer">CODE →</a>
				</div>
			</div>
		</div>
	{/each}
</section>

<section class="archive">
	<div class="section-head">
		<h2>Earlier Projects</h2>
		<span class="label">THE ARCHIVE</span>
	</div>
	<div class="grid">
		{#each earlier as p (p.title)}
			<div class="card">
				<a
					class="card-img"
					href={p.link}
					target="_blank"
					rel="noreferrer"
					style="background-image: url('{p.img}')"
					aria-label={p.title}
				></a>
				<div class="card-body">
					<a class="card-title" href={p.link} target="_blank" rel="noreferrer">{p.title}</a>
					<p>{p.desc}</p>
					<div class="links">
						{#if !p.noLive}
							<a class="live" href={p.link} target="_blank" rel="noreferrer">LIVE →</a>
						{/if}
						<a class="code" href={p.code} target="_blank" rel="noreferrer">CODE →</a>
					</div>
				</div>
			</div>
		{/each}
	</div>
</section>

<style>
	section {
		max-width: 1240px;
		width: 100%;
		margin: 0 auto;
	}

	.featured {
		padding: 64px var(--gutter);
	}

	.archive {
		padding: 0 var(--gutter) 96px;
	}

	.section-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 16px;
		border-bottom: 3px solid var(--text);
		padding-bottom: 10px;
		margin-bottom: 28px;
	}

	.section-head.accent {
		border-bottom-color: var(--accent);
	}

	.section-head h2 {
		font-size: clamp(24px, 3vw, 40px);
		font-weight: 900;
		text-transform: uppercase;
	}

	.section-head.accent h2 {
		color: var(--accent);
	}

	.label {
		font-family: var(--font-mono);
		font-size: 12px;
		color: var(--muted);
		letter-spacing: 0.1em;
		white-space: nowrap;
	}

	/* Featured item */
	.feature {
		display: flex;
		gap: 40px;
		align-items: center;
		flex-wrap: wrap;
	}

	.feature-img {
		display: block;
		flex: 1 1 400px;
		max-width: 620px;
		aspect-ratio: 3 / 2;
		background-size: cover;
		background-position: center;
		border: 1px solid var(--hairline);
		transition: border-color 0.2s;
	}

	.feature-img:hover {
		border-color: var(--accent);
	}

	.feature-body {
		flex: 1 1 380px;
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.feature-title {
		font-size: clamp(30px, 3.4vw, 48px);
		font-weight: 900;
		text-transform: uppercase;
		letter-spacing: -0.02em;
		color: var(--text);
		transition: color 0.15s;
	}

	.feature-title:hover {
		color: var(--accent);
	}

	.feature-body p {
		font-size: 16px;
		line-height: 1.55;
		color: var(--text-body);
		max-width: 460px;
	}

	.feature .links {
		display: flex;
		gap: 24px;
		font-family: var(--font-mono);
		font-size: 13px;
		letter-spacing: 0.08em;
	}

	/* Archive grid */
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
		gap: 24px;
	}

	.card {
		display: flex;
		flex-direction: column;
		border: 1px solid var(--hairline);
		opacity: 0.85;
		transition:
			border-color 0.2s,
			opacity 0.2s;
	}

	.card:hover {
		border-color: var(--accent);
		opacity: 1;
	}

	.card-img {
		display: block;
		aspect-ratio: 3 / 2;
		background-size: cover;
		background-position: center;
		filter: saturate(0.85);
	}

	.card-body {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 16px;
	}

	.card-title {
		font-size: 20px;
		font-weight: 800;
		letter-spacing: -0.01em;
		color: var(--text);
		transition: color 0.15s;
	}

	.card-title:hover {
		color: var(--accent);
	}

	.card-body p {
		font-size: 14px;
		line-height: 1.5;
		color: var(--muted);
	}

	.card .links {
		display: flex;
		gap: 18px;
		margin-top: 4px;
		font-family: var(--font-mono);
		font-size: 12px;
		letter-spacing: 0.08em;
	}

	.links .live {
		color: var(--accent);
	}

	.links .code {
		color: var(--muted);
		transition: color 0.15s;
	}

	.links .code:hover {
		color: var(--accent);
	}

	@media (max-width: 719px) {
		.featured {
			padding: 32px var(--gutter) 48px;
		}

		.archive {
			padding: 0 var(--gutter) 64px;
		}

		.feature {
			gap: 20px;
		}
	}
</style>
