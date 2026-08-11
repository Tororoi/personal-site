<script lang="ts">
	let { data } = $props();
</script>

<svelte:head>
	<title>{data.title} · Thomas Cantwell</title>
	<meta name="description" content={data.excerpt} />
</svelte:head>

<article>
	<a class="back" href="/blog">← ALL WRITING</a>
	<h1>{data.title}</h1>
	<div class="meta">
		<span class="date">{data.dateLabel}</span>
		<span>{data.readLabel}</span>
		{#each data.tags as tag (tag)}
			<span class="tag">{tag}</span>
		{/each}
	</div>

	<div class="rule"></div>

	{#each data.blocks as block, i (i)}
		{#if block.type === 'h2'}
			<h2>{block.text}</h2>
		{:else if block.type === 'p'}
			<p>{block.text}</p>
		{:else if block.type === 'code'}
			<div class="code">
				<div class="code-head"><span>{block.lang.toUpperCase()}</span></div>
				<div class="code-body">
					<!-- eslint-disable-next-line svelte/no-at-html-tags -- highlighted at build time by Shiki -->
					{@html block.html}
				</div>
			</div>
		{:else if block.type === 'list'}
			<div class="list">
				{#each block.items as item (item)}
					<div class="item"><span class="marker">→</span><span>{item}</span></div>
				{/each}
			</div>
		{/if}
	{/each}

	<div class="rule bottom"></div>

	<div class="pager">
		{#if data.older}
			<a class="older" href="/blog/{data.older.slug}">← {data.older.title}</a>
		{/if}
		{#if data.newer}
			<a class="newer" href="/blog/{data.newer.slug}">{data.newer.title} →</a>
		{/if}
	</div>
</article>

<style>
	article {
		max-width: 780px;
		width: 100%;
		margin: 0 auto;
		padding: 64px var(--gutter) 96px;
		flex: 1;
	}

	.back {
		font-family: var(--font-mono);
		font-size: 12px;
		letter-spacing: 0.1em;
		color: var(--muted);
		transition: color 0.15s;
	}

	.back:hover {
		color: var(--accent);
	}

	h1 {
		margin-top: 24px;
		font-size: clamp(34px, 4.5vw, 56px);
		font-weight: 900;
		line-height: 1.05;
		letter-spacing: -0.02em;
		text-wrap: pretty;
	}

	.meta {
		margin-top: 20px;
		display: flex;
		align-items: center;
		gap: 16px;
		flex-wrap: wrap;
		font-family: var(--font-mono);
		font-size: 12px;
		letter-spacing: 0.06em;
		color: var(--muted);
	}

	.meta .date {
		color: var(--accent);
	}

	.tag {
		color: var(--teal);
		border: 1px solid var(--hairline-strong);
		padding: 3px 8px;
	}

	.rule {
		height: 3px;
		background: var(--text);
		margin: 32px 0;
	}

	.rule.bottom {
		margin: 48px 0 24px;
	}

	h2 {
		margin-top: 40px;
		font-size: 26px;
		font-weight: 900;
		letter-spacing: -0.01em;
		text-transform: uppercase;
	}

	p {
		margin-top: 20px;
		font-size: 17px;
		line-height: 1.7;
		color: var(--text-post);
		text-wrap: pretty;
	}

	.code {
		margin-top: 24px;
		background: var(--surface);
		border: 1px solid var(--hairline);
	}

	.code-head {
		display: flex;
		justify-content: space-between;
		padding: 8px 16px;
		border-bottom: 1px solid var(--hairline);
		font-family: var(--font-mono);
		font-size: 11px;
		letter-spacing: 0.1em;
		color: var(--muted);
	}

	.code-body :global(pre) {
		margin: 0;
		padding: 16px;
		overflow-x: auto;
		font-family: var(--font-mono);
		font-size: 13.5px;
		line-height: 1.6;
	}

	.list {
		margin-top: 20px;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.item {
		display: flex;
		gap: 12px;
		font-size: 17px;
		line-height: 1.6;
		color: var(--text-post);
	}

	.marker {
		color: var(--accent);
		flex: none;
	}

	.pager {
		display: flex;
		justify-content: space-between;
		gap: 16px;
		flex-wrap: wrap;
		font-family: var(--font-mono);
		font-size: 13px;
		letter-spacing: 0.08em;
	}

	.pager a {
		color: var(--muted);
		transition: color 0.15s;
	}

	.pager a:hover {
		color: var(--accent);
	}

	.pager .newer {
		margin-left: auto;
		text-align: right;
	}

	@media (max-width: 719px) {
		article {
			padding: 36px var(--gutter) 64px;
		}
	}
</style>
