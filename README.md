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
| `src/routes/+page.svelte` | Home: metadata + accessible heading. The game stage itself lives in the layout. |
| `src/lib/game/` | The fishing game (Threlte + three.js, lazy-loaded on `/` only). |
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

## The game

A low-poly isometric fishing game, being built in phases. Phase 0/1 (shell, ocean,
day/night) is in. The water currently renders as a **wireframe tuning mode** while the
simulation is dialed in; lighting (analytic normals + toon ramp) and the low-poly
treatment return after sign-off. The sea is a 16-component directional Gerstner spectrum;
tune it in `DEFAULT_FIELD` in `src/lib/game/waves.ts` with `npm run dev` hot-reloading.
Planned, from reference review: JONSWAP-shaped band energies keyed to wind speed,
Jacobian-based whitecap/caustic detection (caustics project onto submerged fish backs),
and a jeantimex-style interactive ripple heightfield for splashes, wake, and rain.
Decisions already made:

- 24 real minutes per in-game day (`DAY_SECONDS` in `src/lib/game/env.ts`).
- Boat drifts on a current while the player steers; holds position when idle. (Phase 2.)
- No textures: cel-shaded flat colors only. Fish will be static unrigged meshes; swim
  motion is a vertex-shader sine bend. Only the character gets a rig.
- Ambient on load, no start gate.

Architecture invariants worth knowing before touching it:

- The canvas mounts in `+layout.svelte` and is hidden (not unmounted) off `/`, so the WebGL
  context and game state survive navigation. `three` is dynamically imported; content
  routes never ship it.
- `src/lib/game/waves.ts` holds the wave function twice, GLSL and TypeScript, sharing one
  parameter array. Everything that floats samples the TS twin. If they diverge, floaters
  detach from the surface.
- All lighting/color/weather flows through `computeEnv()` in `env.ts`. In a true isometric
  ortho view the sky is never on screen, so time of day reads entirely through light,
  water palette, and fog.
- Simulation is fixed-step (60Hz) with a free-running renderer; the loop stops when the
  route isn't `/`. `/?tod=0.5` forces a time of day for debugging (0 = midnight).
- `prefers-reduced-motion` keeps the static placeholder and never loads the game.

## Still to build

- Game phases 2+: boat + casting, fish, weather, fishing log (see the plan artifact).
- Blender assets: 13 fish, rowboat, character (asset contract in the plan).
- Real blog posts. All four bundled posts are placeholder samples (`"sample": true`).
- A `demo` block type in the post renderer, for posts that embed interactive components.
