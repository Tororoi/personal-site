<footer>
	<span>© 2026 THOMAS CANTWELL</span>
	<div class="social">
		<a href="https://github.com/Tororoi" target="_blank" rel="noreferrer">GITHUB</a>
		<a href="https://codepen.io/tororoi" target="_blank" rel="noreferrer">CODEPEN</a>
	</div>
</footer>

<style>
	footer {
		margin-top: auto;
		border-top: 1px solid var(--hairline);
		padding: var(--foot-pad);
		display: flex;
		align-items: center;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 16px;
		font-family: var(--font-mono);
		font-size: 12px;
		letter-spacing: 0.1em;
		color: var(--muted);
	}

	.social {
		display: flex;
		gap: 24px;
	}

	.social a {
		color: var(--muted);
		transition: color 0.15s;
	}

	.social a:hover {
		color: var(--accent);
	}
</style>
