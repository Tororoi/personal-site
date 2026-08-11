# thomascantwell.com

Personal site: [thomascantwell.com](https://www.thomascantwell.com/)

SvelteKit (Svelte 5 runes) + TypeScript, fully prerendered, deployed on Netlify.

## Develop

```bash
npm install
npm run dev      # dev server
npm run build    # prerender to build/
npm run preview  # serve the production build
npm run check    # svelte-check
```

## Layout

| Path | What |
| --- | --- |
| `src/routes/+page.svelte` | Home. Empty stage reserved for the Threlte game. |
| `src/routes/projects/` | Featured + archive project lists. |
| `src/routes/blog/` | Post list, grouped by year under the latest post. |
| `src/routes/blog/[slug]/` | Post page. Code highlighted at build time. |
| `src/routes/resume/` | Resume papers under a sticky PDF download button. |
| `src/lib/data/` | `posts.json`, `projects.ts`, `resume.ts`. |
| `src/lib/server/highlight.ts` | Shiki highlighter with a theme matched to the site palette. |
| `src/app.css` | Design tokens (colors, type, responsive metrics). |
| `static/` | Images and `Resume.pdf`. |

Everything prerenders (`export const prerender = true` in `src/routes/+layout.ts`), so the
deploy is static files. Adding a post to `src/lib/data/posts.json` is enough: the `[slug]`
route generates its own prerender entries.

## Design notes

- Single breakpoint at 720px, driven by CSS custom properties in `src/app.css`.
- No border radius anywhere; the bird logo is the only warm color on the site.
- Copy rule: no em dashes, in site copy or blog content.
- The resume page reproduces `static/Resume.pdf` word for word, except that the web version
  shows `Palo Alto, CA` in place of the full street address.
- The resume sidebar holds actions, not navigation. The document is only about two screens
  tall, too short for a section index, so the column is the two downloads (PDF solid, DOCX
  outline) plus a linked contact block. It sticks on desktop and stacks above the paper on
  mobile. The paper's own contact line stays inert because it mirrors the PDF; the sidebar
  is the actionable copy.
- `static/Resume.pdf` and `static/Resume.docx` are the same resume in two formats and must
  be regenerated together. A stale docx next to a fresh PDF is the failure mode to watch.

## Still to build

- The home page game (Threlte). Keep its state in a module-level `state.svelte.ts` runes
  store so it survives navigation, pause the render loop on `visibilitychange`, and cap DPR
  on mobile.
- Real blog posts. All four bundled posts are placeholder samples (`"sample": true`).
- A `demo` block type in the post renderer, for posts that embed interactive components.
