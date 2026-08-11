<script lang="ts">
	let { data } = $props();
</script>

<svelte:head>
	<title>Blog · Thomas Cantwell</title>
	<meta name="description" content="Writing by Thomas Cantwell." />
</svelte:head>

<main>
	{#if data.featured}
		<a class="featured" href="/blog/{data.featured.slug}">
			<span class="label">LATEST · {data.featured.meta}</span>
			<div class="title">{data.featured.title}</div>
			<p>{data.featured.excerpt}</p>
		</a>
	{/if}

	{#each data.years as group (group.year)}
		<div class="year">
			<div class="numeral">{group.year}</div>
			<div class="posts">
				{#each group.posts as post (post.slug)}
					<a class="row" href="/blog/{post.slug}">
						<div class="row-head">
							<span class="row-title">{post.title}</span>
							<span class="row-meta">{post.meta}</span>
						</div>
						<p>{post.excerpt}</p>
					</a>
				{/each}
			</div>
		</div>
	{/each}
</main>

<style>
	main {
		max-width: 1000px;
		width: 100%;
		margin: 0 auto;
		padding: 64px var(--gutter) 96px;
		flex: 1;
	}

	.featured {
		display: block;
		border: 1px solid var(--accent);
		padding: 28px 32px;
		margin-bottom: 36px;
		color: var(--text);
		transition: background 0.2s;
	}

	.featured:hover {
		background: rgba(139, 152, 171, 0.06);
		color: var(--text);
	}

	.label {
		font-family: var(--font-mono);
		font-size: 11px;
		letter-spacing: 0.12em;
		color: var(--accent);
	}

	.featured .title {
		font-size: clamp(24px, 3vw, 34px);
		font-weight: 900;
		margin-top: 10px;
		letter-spacing: -0.01em;
		text-wrap: pretty;
	}

	.featured p {
		margin-top: 10px;
		font-size: 15px;
		line-height: 1.5;
		color: var(--muted);
		max-width: 640px;
	}

	.year {
		display: flex;
		gap: 32px;
		padding: 40px 0;
		border-top: 3px solid var(--text);
	}

	.numeral {
		flex: none;
		width: 120px;
		font-size: clamp(28px, 3vw, 44px);
		font-weight: 900;
		color: var(--accent);
		letter-spacing: -0.02em;
	}

	.posts {
		flex: 1;
		display: flex;
		flex-direction: column;
	}

	.row {
		display: block;
		padding: 18px 0;
		border-bottom: 1px solid var(--hairline);
		color: var(--text);
	}

	.row:hover {
		color: var(--text);
	}

	.row-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 16px;
		flex-wrap: wrap;
	}

	.row-title {
		font-size: clamp(19px, 2vw, 26px);
		font-weight: 800;
		letter-spacing: -0.01em;
		transition: color 0.15s;
	}

	.row-meta {
		font-family: var(--font-mono);
		font-size: 12px;
		color: var(--muted);
		letter-spacing: 0.06em;
	}

	.row p {
		margin-top: 8px;
		font-size: 15px;
		line-height: 1.5;
		color: var(--muted);
		max-width: 640px;
	}

	@media (max-width: 719px) {
		main {
			padding: 32px var(--gutter) 64px;
		}

		.featured {
			padding: 20px;
		}

		.year {
			flex-direction: column;
			gap: 8px;
			padding: 28px 0;
		}
	}
</style>
