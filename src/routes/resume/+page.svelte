<script lang="ts">
	import { page1Jobs, page2Jobs } from '$lib/data/resume';
</script>

<svelte:head>
	<title>Resume · Thomas Cantwell</title>
	<meta name="description" content="Resume of Thomas Cantwell, full-stack developer." />
</svelte:head>

<div class="wrap">
	<a class="download" href="/Resume.pdf" target="_blank" download="Thomas Cantwell Resume.pdf"
		>↓ DOWNLOAD PDF</a
	>

	<main>
		<div class="paper">
			<div class="rs-name">Thomas Cantwell</div>
			<div class="rs-role">Full-Stack Developer</div>
			<!-- Web version shows the city only; the downloadable PDF keeps the full address. -->
			<div class="rs-contact">
				Palo Alto, CA · (650) 387-5366 · cantwell.tom@gmail.com · thomascantwell.com
			</div>

			<div id="rs-about" class="rs-heading first">ABOUT</div>
			<p class="rs-about-text">
				Full-stack developer with 5+ years of agency experience building production systems
				end-to-end. Backend-leaning, but comfortable across the stack, including migrations and
				infrastructure work.
			</p>

			<div id="rs-experience" class="rs-heading">EXPERIENCE</div>
			<div class="rs-job-head">
				<span class="rs-job-name">Future Foundry, Full Stack Developer</span>
				<span class="rs-job-years">May 2021 – Present</span>
			</div>
			<p class="rs-job-summary">
				Remote web and app development agency. Contracted across a diverse range of clients and
				industries, owning responsibilities including database design, backend architecture, and
				frontend implementation.
			</p>

			{#each page1Jobs as job (job.name)}
				<div>
					<div class="rs-job-head">
						<span class="rs-job-name">{job.name}</span>
						<span class="rs-job-years">{job.years}</span>
					</div>
					<div class="rs-stack">{job.stack}</div>
					<ul class="rs-bullets">
						{#each job.bullets as bullet (bullet)}
							<li>{bullet}</li>
						{/each}
					</ul>
				</div>
			{/each}

			<div class="rs-page-number">1 of 2</div>
		</div>

		<div class="paper">
			{#each page2Jobs as job (job.name)}
				<div>
					<div class="rs-job-head">
						<span class="rs-job-name">{job.name}</span>
						<span class="rs-job-years">{job.years}</span>
					</div>
					<div class="rs-stack">{job.stack}</div>
					<ul class="rs-bullets">
						{#each job.bullets as bullet (bullet)}
							<li>{bullet}</li>
						{/each}
					</ul>
				</div>
			{/each}

			<div class="rs-job-head">
				<span class="rs-job-name">Ready-Set-Wear, New York, Co-owner</span>
				<span class="rs-job-years">August 2015 – January 2020</span>
			</div>
			<p class="rs-job-summary">
				Online resale business specializing in selling designer handbags and clothing through
				merchant sites such as eBay and Tradesy. Managed finances, customer relations, shipments,
				and photography.
			</p>

			<div id="rs-side-projects" class="rs-heading">SIDE PROJECTS</div>
			<div class="rs-job-head">
				<span class="rs-job-name">Pixel V, Advanced Pixel Art Drawing App</span>
				<span class="rs-job-years">pixelvee.netlify.app</span>
			</div>
			<div class="rs-stack">JavaScript | Svelte 5 | Rust/WebAssembly | HTML | CSS</div>
			<ul class="rs-bullets">
				<li>
					Offloads performance-critical rendering (dither, flood fill, pixel transforms) to
					Rust/WebAssembly for native execution speed
				</li>
				<li>
					Built a hybrid Svelte 5 + Vanilla JS architecture with a dual-canvas layer system pairing
					offscreen pixel sampling with desynchronized GPU rendering
				</li>
				<li>
					Implemented vector editing tools with line, quadratic, and cubic Bézier rasterization
					using Bresenham's and Zingl's algorithms
				</li>
				<li>
					Designed a command-pattern undo/redo system with full state snapshots and a custom
					versioned file format
				</li>
			</ul>

			<div id="rs-education" class="rs-heading">EDUCATION</div>
			<div class="rs-job-head">
				<span class="rs-job-name">Flatiron School, New York, NY</span>
				<span class="rs-job-years">January 2020 – May 2020</span>
			</div>
			<p class="rs-edu-text">Full Stack Web Development, Ruby on Rails and JavaScript</p>
			<div class="rs-job-head">
				<span class="rs-job-name">University of California, Irvine</span>
				<span class="rs-job-years">September 2006 – June 2010</span>
			</div>
			<p class="rs-edu-text">Bachelor of Arts in Studio Art</p>

			<div id="rs-frameworks" class="rs-heading">FRAMEWORKS &amp; TOOLS</div>
			<p class="rs-list-text">
				Next.js, React, Vue, Laravel, Rails, Node.js, Electron, AWS, GCP, Firebase, Vercel, Supabase,
				Auth0, Heroku, Photoshop
			</p>

			<div id="rs-languages" class="rs-heading">LANGUAGES</div>
			<p class="rs-list-text">JavaScript, TypeScript, Python, PHP, Ruby, SQL, HTML, CSS</p>

			<div class="rs-page-number">2 of 2</div>
		</div>
	</main>
</div>

<style>
	.wrap {
		/* Single column at every width; the paper keeps its letter-page proportions. */
		--paper-width: 824px;
		/* Sticks flush under the nav, which is sticky on this page. */
		--nav-height: 85px;

		display: flex;
		flex-direction: column;
		gap: 20px;
		max-width: calc(var(--paper-width) + 2 * var(--gutter));
		width: 100%;
		margin: 0 auto;
		padding: 40px var(--gutter) 96px;
	}

	.download {
		position: sticky;
		top: var(--nav-height);
		z-index: 5;
		text-align: center;
		color: var(--bg);
		background: var(--accent);
		padding: 13px 0;
		font-family: var(--font-mono);
		font-size: 12px;
		letter-spacing: 0.1em;
		font-weight: 700;
		transition: background 0.15s;
	}

	.download:hover {
		background: var(--accent-hi);
		color: var(--bg);
	}

	main {
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 32px;
		font-family: Helvetica, Arial, sans-serif;
	}

	/* Paper: mirrors the PDF, so it keeps its own light palette. */
	.paper {
		background: #fdfdfb;
		color: #1c1c1c;
		padding: 52px 60px 40px;
		box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
	}

	.rs-name {
		font-size: 32px;
		font-weight: 700;
	}

	.rs-role {
		font-size: 16px;
		margin-top: 2px;
	}

	.rs-contact {
		font-size: 11.5px;
		color: #555;
		margin-top: 6px;
	}

	.rs-heading {
		font-size: 12.5px;
		font-weight: 700;
		letter-spacing: 0.06em;
		border-bottom: 1px solid #999;
		padding-bottom: 4px;
		margin-top: 24px;
		/* Clears the sticky nav and download button when a section is deep-linked. */
		scroll-margin-top: 140px;
	}

	.rs-heading.first {
		margin-top: 28px;
	}

	.rs-about-text {
		font-size: 12.5px;
		line-height: 1.55;
		margin-top: 10px;
	}

	.rs-job-head {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		flex-wrap: wrap;
		gap: 2px 12px;
		margin-top: 16px;
		font-size: 13px;
	}

	.rs-job-name {
		font-weight: 700;
	}

	.rs-job-years {
		font-size: 12px;
	}

	.rs-job-summary {
		font-size: 12px;
		line-height: 1.55;
		margin-top: 5px;
		color: #333;
	}

	.rs-stack {
		font-size: 11px;
		color: #666;
		margin-top: 2px;
		font-style: italic;
	}

	.rs-bullets {
		font-size: 12px;
		line-height: 1.55;
		margin-top: 6px;
		padding-left: 18px;
		color: #333;
	}

	.rs-edu-text,
	.rs-list-text {
		font-size: 12px;
		line-height: 1.55;
		color: #333;
	}

	.rs-edu-text {
		margin-top: 4px;
	}

	.rs-list-text {
		margin-top: 8px;
	}

	.rs-heading + .rs-job-head {
		margin-top: 12px;
	}

	.rs-page-number {
		text-align: center;
		font-size: 10px;
		color: #999;
		margin-top: 36px;
	}

	@media (max-width: 719px) {
		.wrap {
			--nav-height: 65px;

			max-width: none;
			padding: 20px 16px 64px;
		}

		.paper {
			padding: 28px 20px 24px;
		}
	}
</style>
