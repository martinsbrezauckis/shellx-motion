# Agent-authored procedural script cookbook

This is a **cookbook of small composition primitives**, not a catalog of ready-made animations.
Use it when a trusted local agent has been authorised to author a package-local `web`, `html`,
or `canvas` script for a specific Motion package. Combine the primitives with package data,
keyframes, particles, gradients, glow, film treatment, motion blur, depth, shaders, and
environments; do not turn this page into a collection of copied films, logos, characters, or
brand interfaces.

The current operating policy and implementation gap are deliberate:

- Agent-authored local scripts are permitted only in an operator-approved local write context.
  Creating a package needs the host's `write_local` authority; authoring a package-local script
  does not elevate a Motion tier or grant itself any new authority. Existing typed package revisions
  need at least their declared edit authority. The server grant remains the ceiling and every
  elevation needs `--trusted-local-tier`.
- Script **import** remains blocked in supported authoring/import workflows. Do not fetch, paste,
  import, or execute a foreign package's source, URL, module, CDN asset, or marketplace snippet.
  The HTML snippet importer strips scripts. A directly opened package can still contain executable
  web content and remains blocked unless the host resolves its approved-agent-entry provenance.
  The only authoring route is the server-observed-agent, host-gated `motion.package.script.author`
  command. Its observed-session fact is created only after the first valid `2025-06-18` legacy MCP
  `initialize` on a persistent WebSocket; it is connection-local and never serialized. Stateless
  legacy/modern MCP HTTP, malformed or duplicate initialize, and a first WebSocket `tools/call`
  cannot establish trust; local filesystem location or package claims alone are not trust evidence.
- A `web`, `html`, or `canvas` layer runs JavaScript in Chromium. The render fence denies network
  by default, blocks service workers and secondary pages, and confines reads to the package root;
  it does not make unreviewed code safe. Never render a package carrying source you do not trust.
- This page adds no action, Debug API, MCP method, importer, or package type. Create and validate
  packages through the existing typed Motion contracts, preview representative timestamps, then
  read the render receipt. Final file-video renders stream frames by default; use `--keep-frames`
  only when retaining source frames is intentional. See [Quickstart](quickstart.md),
  [the security model](security-model.md), and [rendering lanes](rendering.md).

## Choose the implementation route first

| Route | Use it for | Do not claim |
| --- | --- | --- |
| **Works today: data Motion** | Keyframed shapes/text, gradients, spring easing, portable radial/vortex particle deflection, bounded ordered `points`, static `effects.trail` on ordinary points/particles, and the strict high-density GPU v2 field with weighted origins, fixed flow/turbulence/impact/axis-plane collision, analytic trails, shading, and one bounded mask or matte. Also: radians-only `sin` / `cos`, browser path reveal plus its narrower fixed GPU subset, constrained shaders, scene 3D, environments, glow, film treatment, and motion blur. | Native `pathReveal` parity, arbitrary per-point custom fields, general collision systems, persistent particle state, arbitrary-layer or persistent trails, multi-subpath reveal, geometry generation/morph, arbitrary GPU/WGSL compute, or reusable physics fields. |
| **Works today: package-local canvas script** | A bounded, deterministic custom 2D simulation or drawing loop admitted by the host-gated approved-agent-entry route. It is browser-lane work. | Semantic or human authorship proof, portable trust, native-lane parity, permission to use unreviewed code, or a general plugin/import surface. |
| **Works today but bake at author time** | Generate stable coordinate/keyframe data before package creation: mask sampling, correspondence, recursive geometry, complex or multi-subpath paths, and field trajectories. Keep the resulting package data-only. | Live editable procedural controls where only baked coordinates were produced. |
| **Planned engine work (not yet an API)** | General native/GPU physics fields, mesh or particle-particle collision, arbitrary-layer or persistent trails, multi-subpath reveal, geometry generation/morph, richer per-point attributes, and general programmable GPU instancing beyond Motion's fixed analytic 100,000..131,072-particle descriptors. | That the present CPU `points` draw paths, bounded WebGPU scene lane, fixed compute descriptors, bounded trails, scalar trig nodes, analytic particle deflection, or browser/fixed-GPU path reveal already provide those systems. |

Older cookbook shorthand called the browser contract "browser-only single-subpath stroked `pathReveal`".
That is now incomplete: browser keeps the broader validated contract and the GPU scene lane admits the
documented fixed subset. A static bounded `effects.trail` on points/particles remains an ordinary
exact-time geometry effect. Compute v1 refuses `effects.trail`; compute v2 instead carries its own
fixed analytic lookback trail inside the closed renderer ABI.

The practical rule for a dense drone/rebuild treatment is especially important: use a small,
measured canvas-script pool today, or bake a modest data swarm. Do not default to thousands of
individual `shape` layers. The retained demonstration that used 4,201 shape layers produced about
48 MB of document data; the current bounded `points` layer now expresses that ordered formation in
one payload and one browser canvas/native draw pass. It is still CPU-rendered and is not a hardware
GPU-instancing claim.

## Shared contract for every sample

Every sample below is intentionally small. Give it explicit inputs, a stable seed, a finite pool,
and a fixed simulation step. A quality setting changes the caps; it must never change the seed or
silently replace one technique with a different one.

```js cookbook-testable
function makeRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

function smoothstep(edge0, edge1, value) {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function resolveBudget(quality) {
  const budgets = {
    preview: { particles: 250, links: 80, fields: 1, substeps: 2 },
    balanced: { particles: 700, links: 160, fields: 2, substeps: 4 },
    detail: { particles: 1000, links: 240, fields: 3, substeps: 6 }
  };
  return budgets[quality] ?? budgets.balanced;
}
```

Use the numbers as conservative starting budgets at 1080p, not as engine promises. A long
browser delivery can reach Motion's process-memory ceiling before a single frame looks expensive.
Preview a short prefix, read `resources.peakProcessTreeRssBytes` from the receipt, then lower
duration, point count, field count, or motion-blur samples before raising a host limit.

```js cookbook-testable
function advanceFixed(sim, frameSeconds, stepOne, options) {
  const hz = options.hz ?? 60;
  const maxSteps = options.maxSteps ?? 4;
  const dt = 1 / hz;
  sim.carry = Math.min(sim.carry + Math.max(0, frameSeconds), dt * maxSteps);
  let steps = 0;
  while (sim.carry >= dt && steps < maxSteps) {
    stepOne(sim, dt);
    sim.carry -= dt;
    steps += 1;
  }
  return { steps, interpolation: sim.carry / dt };
}
```

For final rendering, derive `frameSeconds` from Motion's fixed frame time, not from wall clock,
`Date`, or `Math.random()`. Keep the simulation state package-local; never use network time,
browser storage, service workers, or a remote image to decide a frame.

## The reusable primitive set

| Primitive | Inputs / outputs | Reuse it in |
| --- | --- | --- |
| `makeRng(seed)` | A seed to repeatable scalar samples. | All variation: hues, phase, delay, launch angle, glyph choice. |
| `resolveBudget(quality)` | A named quality tier to hard counts. | Every pool, link pass, field pass, and trail length. |
| Fixed-step integrator | `{x,y,vx,vy,age}` plus explicit `dt`. | Sparks, sand, drones, debris, orbit, waves, paths. |
| Target correspondence | A stable `id` maps one particle to one target slot. | Rebuild, assembly, disassembly, glyph/image formation. |
| Field sampler | A bounded list of force sources returns one capped acceleration. | Attraction, repulsion, charge, vortex, tractor beam, singularity. |
| Path sampler | A normalized `t` to one point/tangent on a polyline or curve. | Laser engraving, reveal, tunnels, infinity paths, orbit guides. |
| Pulse / envelope | An event time to a 0…1 scalar. | Impacts, countdown beats, fireworks, shield rings, glow. |
| Draw pass | A known count of discs, strokes, glyphs, or segments. | Preserve the visual grammar without growing work per frame. |

### Bounded analytic particle deflection

Data Motion's `particles` emitter now has a deliberately narrow, renderer-shared field option:
`emitter.field` uses schema `shellx-motion/particle-field@1` and contains **one to three ordered**
sources. Each source is `radial` or `vortex`, has normalized `centerX`/`centerY` in 0…1, signed
`strength` in -1…1, and `softening` in 0.01…1. The evaluator first resolves the existing seeded
ballistic position and lifetime progress `p`; every source reads that same base position, contributes
`strength * p² * softening² / (distance² + softening²)` in its radial or tangent direction, and the
summed normalized deflection is clamped to +/-2 per axis before one six-decimal output round. At the
source centre the contribution is zero. It is analytic kinematic deflection, not a force integrator:
there is no collision, velocity carry-over, noise, arbitrary formula, or callback. Ordinary counts
use the shared Core evaluator; a valid circular 100,000..131,072-particle emitter uses Motion's
fixed GPU v1 descriptor. An optional static `effects.trail` applies only to the ordinary route and
is a separate bounded lookback, not retained particle state.

| Contract check | Expected proof |
| --- | --- |
| Bounds and refusal | Core schema/validator accepts only 1…3 known sources and rejects formulas, extra source fields, out-of-range scalars, or another schema. |
| Deterministic trajectory | Core goldens cover start/mid/end lifetime progress, centre singularity, source order, sign reversal, clamp, and six-decimal samples. |
| Renderer parity | Browser consumes the Core samples; native raster consumes the same samples. A seeded native timestamp is byte-stable on repeat and changes at an active later timestamp. |
| Generic control plane | Existing `layer.create` and `rich.set` carry the payload and scalar source controls through Debug, MCP, CLI, and local SDK; no new action or script/import route exists. |

### High-density fixed v2 particle field

`shellx-motion/particle-field@2` is additive and closed. It is valid only for a circular
100,000..131,072-particle emitter and never falls back to the CPU evaluator. One descriptor may
carry one to four weighted origins and one to four ordered sources selected from radial, vortex,
flow, seeded turbulence, finite impact, and one-sided axis-plane collision. The optional trail is a
two-to-four-sample analytic lookback; flat/soft/glow shading is fixed Motion code. A v2 layer may
use one rect/rounded authored mask or one static rect/ellipse/triangle alpha/luma matte, but not
both. It retains two 64-byte-per-instance buffers (12,800,000 bytes at 100,000; 16,777,216 bytes at
131,072), one compute dispatch, and one head plus optional trail raster pass.

These controls do not imply general physics. There is no mutable simulation step, particle-particle
interaction, mesh collision, texture/SDF field, package formula, user WGSL, variable workgroup, or
unbounded allocation. Unknown v2 nested fields, a capacity/ABI change across one retained session,
and any unsupported mask/effect/blend combination are strict refusals.

### Stable target correspondence for rebuild and assembly

The main quality cue in a swarm rebuild is **identity**: a point should have a stable target, a
slightly different phase, and a deterministic route. A target may be an original abstract mask,
an approved package-local asset sampled at author time, a text rasterization made in the package, or
a hand-authored primitive. It must not be a copied character silhouette or unreviewed image.

```js cookbook-testable
function rebuildPoint(point, target, progress, scatterRadius) {
  const arrive = smoothstep(0.08, 0.92, progress);
  const leave = 1 - arrive;
  return {
    x: point.startX * leave + target.x * arrive + point.scatterX * scatterRadius * leave,
    y: point.startY * leave + target.y * arrive + point.scatterY * scatterRadius * leave,
    alpha: smoothstep(0, 0.12, progress) * smoothstep(1, 0.86, progress),
    size: point.size * (0.75 + 0.25 * arrive)
  };
}

function staggeredProgress(globalProgress, index, count, spread) {
  const offset = ((index * 0.61803398875) % 1) * spread;
  return clamp((globalProgress - offset) / Math.max(0.001, 1 - spread), 0, 1);
}
```

Keep the target count fixed through a morph. Generate or sample once, retain the point order, and
only then interpolate. If the effect needs a more organic transition, add a bounded arc midpoint,
per-point stagger, and a small idle drift while holding—not a second random resample every frame.

### Bounded sparks and connecting lines

This sample is the base for small electric sparks, constellation lines, firework fragments, and
energy-arc accents. It is deliberately capped: a simple all-pairs line pass is acceptable only for
the small pool below. Move to a uniform-grid neighbor lookup before increasing it.

```js cookbook-testable
function drawNearestLinks(ctx, points, maxDistance, maxSegments) {
  const maxDistanceSquared = maxDistance * maxDistance;
  let segments = 0;
  for (let a = 0; a < points.length && segments < maxSegments; a += 1) {
    for (let b = a + 1; b < points.length && segments < maxSegments; b += 1) {
      const dx = points[a].x - points[b].x;
      const dy = points[a].y - points[b].y;
      if (dx * dx + dy * dy > maxDistanceSquared) continue;
      ctx.globalAlpha = Math.min(points[a].alpha, points[b].alpha) * 0.45;
      ctx.beginPath();
      ctx.moveTo(points[a].x, points[a].y);
      ctx.lineTo(points[b].x, points[b].y);
      ctx.stroke();
      segments += 1;
    }
  }
  ctx.globalAlpha = 1;
  return segments;
}
```

Use this at `preview` / `balanced` size only (80 / 160 endpoints and 80 / 160 strokes). For a
drone swarm, make the drone body a small layered disc/cross/halo rather than a generic dot, give
each one a deterministic flicker phase, and reserve links for a few nearby pairs. Detail comes from
the sprite grammar and motion hierarchy, not an unbounded count.

### Field-based motion with fixed timestep

One field function can support gravity, attraction/repulsion, magnetic-looking charge motion,
vortices, tractor beams, orbital debris, plasma cores, and a singularity. Always soften the center,
cap acceleration, and cap speed so a point cannot become an infinite value or skip through the
frame.

```js cookbook-testable
function radialField(point, source) {
  const dx = source.x - point.x;
  const dy = source.y - point.y;
  const distanceSquared = Math.max(dx * dx + dy * dy, source.softening * source.softening);
  const scale = source.strength / distanceSquared;
  return { ax: dx * scale, ay: dy * scale };
}

function vortexField(point, source) {
  const dx = point.x - source.x;
  const dy = point.y - source.y;
  const distance = Math.max(Math.hypot(dx, dy), source.softening);
  const scale = source.strength / distance;
  return { ax: -dy * scale, ay: dx * scale };
}

function integratePoint(point, force, dt, limits) {
  point.vx = (point.vx + force.ax * dt) * limits.drag;
  point.vy = (point.vy + force.ay * dt) * limits.drag;
  const speed = Math.hypot(point.vx, point.vy);
  if (speed > limits.maxSpeed) {
    point.vx = (point.vx / speed) * limits.maxSpeed;
    point.vy = (point.vy / speed) * limits.maxSpeed;
  }
  point.x += point.vx * dt;
  point.y += point.vy * dt;
}
```

Compose at most the `fields` cap from `resolveBudget()`. Pair attraction with a tangential vortex
for orbit; negate strength for repulsion; apply a short radial envelope for a shockwave; derive a
perpendicular, bounded flow vector for a curl-like turbulence approximation. For collision, use a
small uniform grid and a fixed number of relaxation passes. Do not use all-pairs collision checks
on a detail pool.

### Paths and engraving sketches — browser `pathReveal`, canvas, and baked routes

Use an original polyline, rounded rectangle, abstract emblem, number, or approved package-local
asset contour. Browser `pathReveal` is current for one existing `shape: "path"` or `"freeform"`
layer with exactly one SVG subpath and a visible positive-width stroke. Animate its independent
`pathReveal.start` / `pathReveal.end` scalars through the existing rich setter or keyframe routes;
`end <= start` is an empty window. Call `motion.capabilities.match` before choosing a lane: native
refuses this browser-only feature rather than silently drawing the full stroke.

Keep the existing routes for everything outside that narrow contract: bake complex or multi-subpath
geometry at author time, and use the bounded canvas route for custom contour drawing, live geometry,
or general path-trail behaviour. Pair an engraving with a small spark pool rather than thousands
of independent strokes. Multi-subpath reveal, geometry generation/morph, arbitrary-layer or
persistent trails, and native path reveal remain planned engine work; the bounded points/particles
`effects.trail` primitive is separate.

```js cookbook-testable
function pointOnPolyline(points, progress) {
  const scaled = clamp(progress, 0, 1) * (points.length - 1);
  const index = Math.min(points.length - 2, Math.floor(scaled));
  const local = scaled - index;
  const a = points[index];
  const b = points[index + 1];
  return { x: a.x + (b.x - a.x) * local, y: a.y + (b.y - a.y) * local };
}

function pulse(eventProgress, width) {
  const distance = Math.abs(eventProgress - 0.5);
  return 1 - smoothstep(width, width * 1.8, distance);
}
```

## Technique taxonomy and composition recipes

Each row is a technique family, not a canned scene. Begin with the listed primitives, choose a
palette and geometry for the current package, and make all user-visible timing parameters explicit.

| Technique family | Reusable composition primitives | Current route | Starting budget and scalable degradation |
| --- | --- | --- | --- |
| Multiple sparks drawing lines | `Pulse`, short-lived particle pool, `drawNearestLinks`, glow. | **Works today** with a particle emitter and bounded `effects.trail` for simple sparks/tails; use canvas for controlled links. | 80/160 link cap. Drop links first, then trail samples, before lowering spark size. |
| Detailed light-drone animation / swarm rebuild | Stable target correspondence, drone sprite grammar, stagger, idle drift, field/path transition. | **Works today** with bounded ordered `points`, the strict GPU scene route for its admitted data subset, or a reviewed canvas pool for richer sprites. The fixed GPU compute route is only for a radial/vortex analytic circular field, not arbitrary drone behavior. | 250/700/1000 particles. Preserve target identity and reduce halo/links before reducing count. |
| Rebuild, assembly, disassembly, teleport | `rebuildPoint`, scatter disk, arc midpoint, phase offset, pulse. | **Works today** in canvas; **bake at author time** for data-only results. | Keep one target per point. Reduce scatter layers and re-entry passes, never resample identity. |
| Fireworks | Radial launch, gravity, finite lifetime, colour/alpha envelope, a short tail. | **Works today** with particles and bounded `effects.trail` for basic bursts; canvas for tailored choreography. | 3 simultaneous bursts, then cap fragment count; lower trail samples before fragment count. |
| Sand / magnetic graphite | Particle state, attraction/repulsion, drag, field ripple, target mask. | The analytic emitter field can make simple browser/native visual attraction or repulsion; use bounded canvas for settle, drag, target masks, collision, or persistent state. | 250/700 particles, 1/2 fields, no all-pairs collision. Degrade to fewer grains with a stronger directional field. |
| Laser, engraving, and path reveal | Path sampler, progress envelope, spark pool, blur/glow, matte. | **Works today** with browser `pathReveal`, its narrower fixed GPU path subset, keyframed/baked data for complex paths, or canvas for custom contours. Native, multi-subpath reveal, geometry generation/morph, and general path trails remain planned. | 1 active path, 1 reveal head, 24–96 sparks. Drop sparks before path precision. |
| Pulsating countdown | Numeric text, `Pulse`, spring easing, radial gradient, glow. | **Works today: data Motion**; no script required. | 1 text layer plus 1–3 accent shapes. Lower motion blur before removing contrast/pulse. |
| Endless tunnel in / out | Repeated rings/tiles, depth scale, path progress, fog/vignette. | **Works today** with canvas or bounded scene/shape data; a general hardware-instanced primitive remains planned engine work. | 24/64/120 slices. Reduce far slices and blur first. |
| Factorial-type workflows | Interpreted as **recursive, fractal, or procedural iteration**: recurrence, bounded depth, and deterministic parameter sweeps. | **Works today but bake**; canvas can draw small live iterations. Bounded scalar `sin` / `cos` controls are current; live data-only recurrence remains planned engine work. | Hard depth 5/7/9 and one reusable motif. Lower recursion depth, never use unbounded recursion. |
| Odds-board / reel-like effects | Discrete symbol grid, seeded permutation, step timing, pulse, original numerals/icons. | **Works today** with data keyframes or canvas. | 3–5 columns, 8–16 visible rows. Slow reveal / reduce symbol change rate before reducing legibility. |
| Code rain | Original glyph alphabet, vertical streams, seeded delay, fade envelope, scan-line/path masks. | **Works today** in canvas or data with a small glyph pool. | 24/64/120 streams. Reduce stream count and glyph turnover; do not copy a familiar film/interface alphabet or presentation. |
| Infinity paths and horizon fields | Lemniscate/polyline path, phase offsets, perspective grid, depth fade, vignette. | **Works today** in data for keyframed paths or canvas for procedural drawing. | 1–3 paths plus 24/64/120 grid lines. Drop distant lines first. |
| Black hole / singularity / wormhole | Softened radial field, vortex, depth scale, event horizon matte, debris pool, pulse. | The analytic emitter field can deflect debris visually in browser/native; use bounded canvas or constrained shader/3D for orbital state, depth behaviour, or a real singularity treatment. | 150/450/800 debris points, 1 radial + 1 vortex field. Reduce debris then radial samples. |
| Galaxies, spiral arms, starfields, and twinkle | Polar/spiral sampler, orbital/vector field, seeded size/phase, sparse glow. | **Works today** in canvas, baked data, bounded ordered `points`, or the admitted strict GPU scene route; the fixed analytic emitter field only deflects ballistic debris, so live orbit/state controls and general programmable GPU instancing remain future work. | 200/600/1000 stars, 2–4 arms, one twinkle envelope. Drop far stars and glow passes before arm structure. |
| Tree and leaf-vein skeleton growth | Deterministic branching / L-system-like rewrite, path sampler, bounded recursion depth, growth envelope. The reported “three/leaf” request is treated as **tree/leaf**. | **Works today but bake at author time**; a small canvas path-growth loop also works today. | Depth 5/7/9, branch cap 128/384/768. Lower depth before shortening the visible main trunk. |
| Flowers opening and nature growth | Radial/phyllotaxis placement, petal transform/morph progress, branch/path growth, seeded timing. | **Works today** with data keyframes, bounded points, canvas, or the admitted strict GPU scene route; reusable growth graphs and general programmable GPU instancing remain future work. | 12/36/72 petals or leaves, 1–3 growth waves. Reduce secondary rings/leaves before primary petal motion. |
| Sun and day/night cycles | Atmospheric gradient, radial solar disc, seeded glow, horizon path, slow phase envelope. | **Works today: data Motion**; a canvas field is optional for custom sky grain. | 1 gradient, 1–2 discs, 8–32 cloud/stars accents. Drop accents before gradient/horizon contrast. |
| Lissajous, rose curves, spirals, hypotrochoids, and epicycles | Bounded parametric sampler, baked/keyframed path sketch or canvas trail, phase/time parameter. | **Works today** with allow-listed data-only `sin` / `cos` relationships for scalar controls plus bounded points/baked geometry; browser `pathReveal` can draw one qualifying baked stroke and moving points can use bounded `effects.trail`. General path trails, multi-subpath reveal, geometry morph, and arbitrary formula evaluation remain unsupported. | 128/384/768 samples, 1–3 bounded trails. Reduce samples before changing the curve parameters. |
| Superformula and calculated-result forms | Parameter vector to a deterministic contour, target correspondence, radial sampling, fill/path render. | **Works today but bake at author time** for the contour, which can then use bounded points; free-form/live formula evaluation remains unsupported. | 128/384/768 contour points. Keep the parameter vector visible in provenance/controls. |
| Strange attractors and complex-plane mappings | Fixed-step recurrence / bounded complex mapping, clamp/escape rule, point/trail pool, colour-by-iteration. | **Works today** in a small canvas pool or **bake at author time**; no arbitrary evaluator/imported expression. | 1/3/6 iterations per frame and 250/700 points. Lower iterations and trail length before point count. |
| Harmonic and interference waves | 1–3 scalar waves, amplitude envelope, path/field ripple, additive draw pass. | **Works today** in canvas, baked/keyframed data, or bounded `sin` / `cos` scalar relationships; reusable spatial field nodes remain future work. | 1/2/3 wave sources, 64/192/384 samples. Reduce sources before sample resolution. |
| Fractal / recursive forms and calculated growth | Bounded rewrite/recurrence, fixed maximum depth, path growth, target/sample points. | **Works today but bake at author time**; canvas can show a small live iteration. Native reusable iteration controls remain planned engine work. | Depth 5/7/9, explicit escape/count cap. Never use unbounded recursion or arbitrary code evaluation. |
| Gravity and orbit | Radial field, tangential velocity, drag, fixed timestep, path guide. | The analytic emitter field can make visual radial/vortex deflection only; use canvas, scalar `sin` / `cos`, or baked points/keyframes for orbit trajectories. Reusable physics fields remain future work. | 1 attractor, 1 vortex, 250/700 bodies. Reduce bodies, not timestep determinism. |
| Attraction / repulsion / magnetic charge | Signed field strength, charge flag, capped acceleration, drag. | The analytic emitter field supports visual signed radial/vortex deflection; canvas is still required for charge interactions, acceleration/state, or drag. | At most 1/2/3 sources by quality. Merge sources before reducing particle identity. |
| Springs, constraints, and collision | Spring relaxation, fixed iteration count, uniform grid, bounded restitution. | **Works today** in canvas for a small pool; a first-class physics graph remains planned engine work. | 2/4/6 solver passes, grid collisions only. Lower solver passes before pool count. |
| Turbulence, curl-like flow, advection | Seeded low-frequency field, perpendicular gradient approximation, drag, capped velocity. | **Works today** in canvas; bake a short deterministic trajectory when data-only is needed. | 1/2 field octaves, 250/700 particles. Lower octaves before point count. |
| Vortices, shockwaves, wave interference, field ripples | Vortex/radial fields, pulse envelope, two or three scalar wave sources, additive draw pass. | **Works today** in canvas; simple rings are data/keyframe friendly. | 1–3 emitters, 24–96 rings. Reduce interference sources before ring resolution. |
| Tractor beam, shield impact, energy arc | Cone/path field, radial impact pulse, bounded spark links, glow/matte. | **Works today** with canvas plus Motion compositing; no custom imported shader required. | 1 beam, 1 impact, 24–96 accent sparks. Drop links/trails before the primary silhouette. |
| Orbital debris and plasma core | Orbit plus vortex, low-speed debris, core pulse, additive/glow layers. | **Works today** in canvas or constrained scene/shader composition. | 150/450/800 debris, 1–2 fields. Reduce debris/shell count before core resolution. |
| Magnetic sand and drone formations | Target correspondence, signed fields, path/arc motion, idle drift, small sprite variants. | **Works today** in canvas, bounded ordered points, or the admitted strict GPU scene route; the fixed GPU compute route supports only its declared radial/vortex field, while live reusable signed fields and general programmable GPU instancing remain future work. | Quality pool only; preserve count/order while changing target geometry. |

## Mathematical visual studies: named recipes, never free-form evaluation

Mathematical graphics are useful because a small verified parameter vector can produce radically
different shapes without importing an image or accepting arbitrary source. Use an allow-listed
deterministic node/recipe in reviewed package-local code, or calculate and bake verified
point/keyframe data at author time. Never evaluate a user-supplied expression string, import a
formula library, or treat an unbounded recurrence as a rendering primitive.

```js cookbook-testable
function parametricPoint(kind, t, params) {
  if (kind === "lissajous") {
    return {
      x: Math.sin(params.a * t + params.phase),
      y: Math.sin(params.b * t)
    };
  }
  if (kind === "rose") {
    const radius = Math.cos(params.petals * t);
    return { x: radius * Math.cos(t), y: radius * Math.sin(t) };
  }
  if (kind === "spiral") {
    const radius = params.startRadius + params.growth * t;
    return { x: radius * Math.cos(t), y: radius * Math.sin(t) };
  }
  throw new Error(`unsupported parametric recipe: ${kind}`);
}

function sampleParametric(kind, params, count) {
  const samples = [];
  const safeCount = Math.max(2, Math.min(count, 768));
  for (let index = 0; index < safeCount; index += 1) {
    samples.push(parametricPoint(kind, (index / (safeCount - 1)) * params.turns * Math.PI * 2, params));
  }
  return samples;
}
```

| Named recipe | Explicit parameters | What a parameter change does | Current route |
| --- | --- | --- | --- |
| Lissajous | Integer-ish frequencies `a`, `b`, phase, turns. | `3:4` makes a woven lobe structure; `5:2` becomes broad crossing arcs; phase changes the symmetry without changing the pool identity. | Use bounded `sin` / `cos` scalar controls and bake/sample the ordered point geometry; no free-form formula evaluator. |
| Rose curve | Petal factor, phase, radius. | Odd/even factors change the visible petal count and overlaps; phase rotates the same curve. | Canvas today or bake points. |
| Spiral / hypotrochoid / epicycle | Turns, growth, inner/outer radii, phase. | Radius ratio changes from smooth coil to gear-like loops; turns controls tunnel/arm density. | Canvas today or bake points; bounded ordered `points` are current for sampled geometry, while dense GPU instancing remains planned. |
| Superformula contour | `m`, `n1`, `n2`, `n3`, scale, sample count. | Small changes turn rounded stars into boxes, petals, or organic lobes while retaining a compact provenance vector. | Bake today; a small reviewed canvas implementation is allowed. |
| Harmonic/interference field | 1–3 amplitudes, frequencies, phases, spatial scale. | Frequency ratio controls band spacing; phase moves nodes; amplitude controls the contrast of the same field. | Canvas or baked samples today; bounded scalar `sin` / `cos` nodes are current, while reusable spatial field nodes remain planned. |
| Strange attractor / recurrence | Named recurrence constants, fixed iteration count, escape radius, seed. | Constants change lobe count and orbit density; escape radius prevents runaway values. | Small canvas or baked trajectory today; no free-form formula evaluation. |
| Complex-plane mapping | Named mapping enum, bounded complex input grid, iteration cap, escape radius. | Mapping choice changes the topology; iteration/escape change detail density, not the underlying provenance. | Bake today; a small reviewed canvas map is allowed. |

For these studies, retain the recipe name and parameter object alongside the seed. The resulting
points can feed the same target correspondence, particles, bounded `effects.trail`, baked/canvas
trails, branch growth, or radial-petal layout used elsewhere in this cookbook. Arbitrary-layer or
persistent trails and general GPU instancing beyond the strict static points PNG profile remain planned engine work. The value is the verified
calculation and its controllable parameters, not a hard-coded visual copied from a prior render.

## Composable physics recipes

Build a requested effect by joining one **source**, one **motion law**, one **event envelope**, and
one **draw grammar**. This makes a tractor beam and a sand assembly variants of the same controlled
system rather than separate one-off animations. The table is composition grammar, not a claim that
the data-only emitter has each listed law: force integration, velocity carry-over, drag, collision,
and persistent simulation state are canvas-only or bake-at-author-time today. The current analytic
emitter contributes only radial/vortex visual deflection of a ballistic position; its optional
`effects.trail` is a stateless bounded lookback over that resolved motion.

| Requested look | Source | Motion law | Event / draw grammar |
| --- | --- | --- | --- |
| Tractor beam | A path or cone from emitter to target. | Attraction along the path plus mild vortex. | A travelling pulse, sparse links, and a small halo around the beam head. |
| Shield impact | Impact point on a circle or mesh. | Short repulsive shockwave; optional tangential drift. | Two expanding rings, one decaying spark pool, and a clipped glow. |
| Energy arc | Two approved endpoints. | Jittered subdivided path with a seeded phase, not a random redraw. | 1–3 strokes, short-lived branch sparks, envelope-driven brightness. |
| Orbital debris | Center plus initial tangential velocity. | Softened attraction plus vortex and drag. | Small discs/crosses with depth/size bands; deterministic phase offsets. |
| Plasma core | Center point plus shell radii. | Vortex with capped radial jitter. | Additive-looking rings, pulse, compact particles, and a restrained glow. |
| Teleport / disassembly | Stable start and target slots. | Scatter, arc midpoint, then `rebuildPoint`. | Opacity envelope plus one optional path/portal silhouette. |
| Wormhole / singularity | Center and a ring/tunnel guide. | Vortex plus attraction; perspective scale or depth band. | Repeated slices, field ripple, fading debris; do not use copied imagery. |
| Magnetic sand | Original mask / approved target slots. | Attraction/repulsion with strong drag and a small relaxation pass. | Fine grains, low-speed trails, and a controlled settle pulse. |
| Drone formation | Stable point cloud and original target geometry. | Field-guided travel plus staggered rebuild. | Detailed small light sprites, optional nearby links, quiet hover drift. |
| Spiral galaxy / starfield | A spiral-arm point sampler with per-star phase. | Orbital/vector field plus very weak drag. | Two to four arms, sparse twinkle pulse, brightness by stable depth band. |
| Tree / leaf-vein growth | One deterministic grammar or branch list. | Bounded rewrite, then path-growth progression. | Main trunk first, child branches by depth, a separate small leaf/vein pass. |
| Flower opening | A radial seed layout and petal prototype. | Petal scale/rotation/morph progress, staggered by index. | Center/core pulse, then one to three petal rings; retain the same index order. |
| Day / night horizon | A horizon line and original solar/lunar disc. | Slow phase interpolation and optional star scatter. | Atmospheric gradient, radial disc glow, sparse stars only after the sky has darkened. |
| Parametric curve study | An explicit equation parameter vector and finite sample count. | Sample/bake points in stable parameter order. | Browser `pathReveal` only for one qualifying baked stroke; otherwise use points or a canvas/baked short trail. Show the parameter values in provenance. |
| Attractor / complex mapping study | A named recurrence/mapping encoded directly in reviewed local source. | Fixed iteration and escape/clamp rule. | Colour by bounded iteration/age, fade old trails; never accept free-form evaluated formula text. |

## A minimal agent authoring loop

1. Identify the requested result as a combination of the table primitives. State the route and
   whether each part is current data Motion, browser-script, baked data, or planned engine work.
2. Use `motion.package.script.author` only through a valid initialized `2025-06-18` legacy MCP WebSocket session whose
   host already supplies the required private authority and authoring roots. Its evidence attests the admitted
   bytes, not semantic review or human authorship; a package path is not provenance. Do not hand-edit
   `motion.json`; use Motion's package/timeline contracts for the package data around the script.
   The entry must use classic inline scripts only: dynamic code construction, script/module/worker
   loading, inert script data, event-handler or `javascript:` markup, frames, and secondary
   compositions are refused before authority minting. Motion hashes browser-normalized admitted
   script bodies into a CSP that disables eval and excludes unlisted executable code.
3. Fix `seed`, quality tier, canvas dimensions, FPS-derived timestep, entity cap, field cap, and
   duration before authoring. Store those values with the package's declared provenance/controls.
4. Preview at an arrival frame, an active-motion frame, an event frame, and the final hold. Check
   that a held swarm still has a deliberately bounded drift rather than accidental frozen frames.
5. Render a short prefix through the browser frame lane, inspect the receipt and memory ratio, then
   scale density only if the measured budget permits it. Render final media and verify identity,
   duration/frame count, output hash, quality result, and receipt.

## Verification matrix

This matrix is the acceptance baseline for a cookbook-derived package. It is not a claim that every
future recipe has already been rendered on every host.

| Check | How to verify | Expected evidence |
| --- | --- | --- |
| Source boundary | Inspect the authored package and the agent change. | Package-local authored source only; no remote module/URL, no imported script, no unapproved assets. |
| Determinism | Render the same seed, dimensions, FPS, and timestamp twice on one host. | Matching package/input identity and materially identical expected frame output; explain any renderer-specific encoding difference separately. |
| Analytic particle field | For a field-backed emitter, run Core start/mid/end/singularity/sign/clamp vectors, then repeat one seeded native timestamp and inspect an active later timestamp. | The field stays within its 1…3-source schema and six-decimal sample contract; the repeated native PNG hash matches, the active timestamp changes, and no claim is made for physics/GPU or browser/native pixel equality. |
| Bounds | Read the named budget and instrumented count/field/link limits. | Counts never exceed the selected quality cap; recursion/substeps/solver passes are finite. |
| Representative frames | Preview arrival, motion, impact/rebuild, and hold timestamps. | No accidental blank/frozen state, target correspondence remains coherent, primary silhouette remains legible. |
| Resource behavior | Render a short browser-lane prefix and inspect the receipt. | `resources.peakProcessTreeRssBytes` remains below the host policy; lower density/duration/blur before exceeding it. |
| Final delivery | Render with the existing final command and inspect its receipt and output. | Correct artifact path/hash, expected duration/frame evidence, output quality result, and explicit lane evidence. |
| Cross-host claim | Repeat the actual package on each intended host. | Separate receipt/probe evidence per host; WSL proof does not prove Windows or macOS. |

## Non-goals and next engine work

This cookbook does not make script imports safe, prove semantic or human authorship, add a
marketplace, grant permissions, or make browser scripts native-editable. The bounded data-only `points` layer,
`sin` / `cos` nodes, and analytic particle deflection are current CPU/data primitives; browser path reveal
and its narrower fixed GPU subset are current data-only primitives. They do not provide general native
physics/fields, collisions, persistent state, arbitrary-layer or persistent trails, multi-subpath reveal,
geometry generation/morph, arbitrary formulas, arbitrary GPU/WGSL compute, or native path reveal. The strict
GPU scene route is public, but its source support is not host hardware proof; WSL is not GPU hardware proof, and any
availability, performance, or physical-host claim needs separate evidence. Use bounded package-local canvas scripts for the approved custom live
route, bake deterministic coordinates where current typed data is insufficient, and keep final
visual intent original.
