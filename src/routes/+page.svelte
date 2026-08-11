<svelte:head>
	<title>Thomas Cantwell</title>
	<meta name="description" content="Thomas Cantwell, full-stack developer." />
</svelte:head>

<!-- Reserved for the Threlte canvas. Keep game state in a module-level runes store
     so it survives navigation away from this route. -->
<main id="game-stage">
	<span class="placeholder">[ GAME STAGE ]</span>
</main>

<style>
	main {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.placeholder {
		font-family: var(--font-mono);
		font-size: 12px;
		letter-spacing: 0.14em;
		color: var(--faint);
	}
</style>
