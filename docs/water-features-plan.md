# Hand-authored water features — plan

Working plan, untracked. Decision made 2026-08-23: **bounded square
map, no wrapping**. The borders are authored features (cliffs, barrier
waves, whirlpool), which collapses the old toroidal prerequisite into
the content itself. The torus write-up is retired; its one surviving
idea is the teleport-recenter machinery (see whirlpool border).

## The two tiers of masks

Everything below hangs off world-space masks `m(x, z, t) ∈ [0, 1]`, but
they split into two classes with very different costs:

- **Tier A — shading masks (GPU-only).** Modulate what the surface
  LOOKS like: FFT detail amplitude, specular/reflectivity, texture
  roughness. No CPU twin exists for these layers (the FFT detail feeds
  the shading normal and nothing else — fftwaves.ts's own header), so
  there is no twin-drift risk, no physics coupling, no audit. A mask
  here is one function in the water fragment shader. All the WEATHER
  features are Tier A.
- **Tier B — displacement masks (twin-compiled).** Modulate the actual
  wave sum: authored barrier trains, the flat patch, the whirlpool
  funnel. These touch `generateWaves`/`wavesGlsl()` and the CPU
  samplers, so the mask definitions must be DATA compiled into both
  languages, never hand-written twice. Boat physics, caustics, foam
  all inherit them automatically — that's the payoff for the rigor.

Build Tier A first: same authoring muscle (shaping, animating,
propagating masks), zero risk. Tier B waits until a feature needs it.

## Phase 0 — bounded map (small now)

- `MAP_HALF` constant (suggest 512–1024 m to start; it's a constant,
  not a knob — borders are authored against it).
- **Failsafe behind the visuals**, implemented before any border art
  exists so the map is playable immediately:
  1. soft zone: an inward current/push that ramps up over the last
     ~30 m past the intended border line (reuses the wave-push code
     shape — an acceleration, so horsepower fights it believably but
     it out-scales the slider);
  2. hard clamp: absolute position clamp a further ~20 m out, the
     wall players should essentially never touch.
- Waves stay EXACTLY as they are: no periodicity, no vector snapping,
  no FFT resizing. Nothing else in the engine changes.
- Corners: each border treatment owns its two half-edges; corners
  resolve to whichever treatment is authored there (whirlpool corner,
  cliff corner). Defer until two treatments exist.

## Phase 1 — weather masks (Tier A)

One shared primitive: a **scrolling world-space scalar field** — a few
octaves of value noise sampled at `worldXZ`, scrolled along a direction
at a speed, thresholded/shaped per use. Procedural in the fragment
shader (no RT, no CPU): each use is a seed + scale + scroll velocity +
shaping curve. Three uses, one function:

### 1a. Wind gusts (FIRST CANDIDATE — see recommendation)

Validated look already exists: detailMin/detailMax at minimum +
detailSlope at max reads as tight wind-ripple. The gust mask blends the
detail params between the CALM set and the GUSTY set per pixel:

```
g = shape(noise(worldXZ / gustScale - windDir · gustSpeed · t))
detailAmp   = mix(detailCalm,  detailGusty,  g)
detailSlope = mix(slopeCalm,   slopeGusty,   g)
```

- Streak the noise ALONG the wind (anisotropic scale: stretched
  downwind, narrow crosswind) so gusts read as travelling cat's-paws,
  not blobs.
- Scroll at gustSpeed ≈ wind speed × ~1.5 (gusts outrun the sea).
- Knobs (WIND group, live): gustMaskScale, gustMaskSpeed, gustCover
  (threshold), gustSharp (feather). The gusty detail set can BE the
  existing detail knobs at their extreme — only the calm set needs
  new values, or reuse current defaults as calm.
- Deliberately visual-only at first: foam drift, spray, boat wind
  forces keep reading the steady wind. If gusts later need to be FELT,
  the same mask function has a CPU twin cost — defer until wanted.

### 1b. Rain patches

Same primitive, storm-gated: the mask marks where the downpour is.
Inside it: rain-roughened texture (detail amp up + specular dulled),
and optionally scale the existing droplet-ripple density by the mask
so the patch crackles. Slower scroll (cells drift with the storm, not
the surface wind), larger scale, softer shaping than gusts. Density
variation is free — the noise IS the density.

### 1c. Sun patches through clouds

The same field inverted and slower still: a cloud-shadow mask scrolled
at cloud-layer speed (its own direction — clouds needn't follow surface
wind). Bright holes raise specular/reflectivity and lift water color;
shadowed sea dulls. Cheapest of the three (pure shading multiplier),
biggest mood payoff on overcast days. Gate on cloudiness once weather
states exist.

### Weather sequencing note

Gusts → rain → sun patches shares one shader function with three
parameter sets. After 1a is judged good, 1b/1c are mostly authoring.

## Phase 2 — displacement mask infrastructure (Tier B)

Only when the first Tier B feature is ready to build:
- Mask table as data: `{ id, kind: disc|band, center/axis, size,
  feather }`, compiled to GLSL constants AND evaluated by a CPU
  function — one source, two emitters.
- Per-wave-group envelope (authored waves exist only inside their
  mask) and global damp (base sea × (1 − m)) as the two operations.
- Feather ≥ a few wavelengths of the masked waves, or envelope
  gradients pollute slopes.
- FFT detail and ripples take the damp factor where "flat" must mean
  flat.

## Phase 3 — borders as features

- **Barrier-wave edge** (first Tier B feature): steep directional
  train × band mask along one map edge. λ ≥ slideLambdaM (24 m) so the
  gravity slide engages (6.86 × slope m/s²); steep enough to fold so
  breakPush joins (up to 12.5 m/s²) — total ~16 m/s² against the
  horsepower table, on top of the Phase 0 failsafe behind it. A train
  moving through a fixed mask breaks at the same world line forever.
- **Cliff edge**: static meshes + damp mask so waves die against the
  base instead of passing through. Landmark value; art-heavy.
- **Whirlpool corner/edge**: flat-patch damp disc + analytic funnel
  (radial depression + swirl) in the twins; swirl added to
  `orbitalVelocityInto` makes the suction real. Escape checks against
  horsepower. On capture: teleport to a random spot = shift boat +
  recenter every traveling sim window (ripples, foam, mist, caustics
  extent, spray) and CLEAR them — the sea isn't periodic, content
  can't be carried — hidden behind a splash/blackout beat. The
  onFieldChange clear pattern already exists per sim; this reuses it.
  Funnel feature size ≥ a few water-mesh triangles or it aliases.

## Cast shadows (Tier A risk class, its own infrastructure)

Shading-only like Tier A — no CPU twin, no physics — but a render
pass, not a mask. Two different mechanisms:

- **Above water**: small orthographic shadow-map pass from the sun,
  window following the player; sampled MANUALLY in the hand-written
  water fragment to dim the direct-sun term (no three.js built-in
  receiving on custom materials). Soft edges mandatory — the old
  sphere-waterline streak came from a hard lighting cutoff, and the
  unified-lighting rule stands. Bias/acne tuning at grazing day-cycle
  sun angles is the main time sink.
- **Below water**: NO shadow map — occlude rays in the caustics splat
  instead. The splat already walks refracted rays from entry points;
  testing them against the existing shader-side occluders (boat SDF,
  analytic sphere, buoy boxes) makes the seabed shadow the ABSENCE of
  caustic light: refracted with the same bend as the light around it,
  softened by the same temporal accumulation, and consistent with the
  "underwater = absorption/refraction/caustics/scattering only" rule.
  A projected shadow map would visibly disagree with the caustics it
  sits in; ray occlusion cannot.

Both read the same sun vector, so surface and seabed shadows agree in
direction and size for free.

## Risks

- Tier B twin drift remains the main budget: data-compiled masks only.
- Tier A is cheap but not free on the frame: the noise function runs
  per water fragment — keep octaves ≤ 3 and reuse one evaluation for
  all three weather uses where possible.
- Gusts visual-only vs felt: accepting the inconsistency (foam drifts
  on steady wind through a visible gust) is fine at this art style;
  revisit only if it reads wrong.
- Failsafe tuning: soft-zone push must out-scale horsepower at max
  (>20 m/s² inside the clamp band) so no slider setting beats the map.
