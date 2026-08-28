# Bounded particles and points trails

`effects.trail` is a small declarative lookback-stroke effect for an existing `particles` or ordered
`points` layer. It makes moving sparks, drones, laser heads, fireworks accents, orbit/field motion,
and short light tails possible without an expression runtime, general GPU-density claim, physics solver, or retained
history. For drawing or engraving a fixed vector path, use [path reveal](path-reveals.md):
the browser supports the broader validated contract and the GPU lane accepts its documented
fixed subset.

## Data contract

```json
{
  "effects": {
    "trail": { "durationMs": 480, "samples": 4 }
  }
}
```

- `durationMs` is a finite static millisecond lookback in `1..2000`.
- `samples` is a static integer count of trajectory vertices, including the current head, in `2..8`.
- The record is accepted only on `particles` and `points`; its only fields are `durationMs` and
  `samples`. A direct object with accessors or unknown fields is rejected without reading it.
- It is deliberately absent from the keyframe target set. Existing `motion.timeline.layer.rich.set`
  may edit `effects.trail.durationMs` or `effects.trail.samples` only after the layer declares the
  record. There is no new Debug/MCP/SDK verb.

## Time and geometry

At requested document time `T`, Core samples `N = samples` evenly spaced times from
`max(layer.startMs, T - durationMs)` through `T` for points. Particles use the same stateless seeded
evaluator as their heads, but history begins no earlier than the current particle lifetime, so a tail
never crosses a cycle reset. Particle vertices attach to the evaluated head centre; point vertices use
their existing centre coordinates. No state survives from an earlier frame and wall-clock time is not
an input.

For a segment ending at newer vertex index `i` (`1..N-1`), the stroke uses that newer vertex's colour,
diameter, and opacity multiplied by `i / (N-1)`. The visual result is a forward linear taper behind
the current head. Degenerate zero-length segments are omitted.

Core keeps this geometry in document coordinates. Before paint each renderer runs the same transformed
stroke-work plan with translation, scale, origin, rotation, output clipping, and stroke radius. It
preserves an authored finite positive transformed width; it never quietly clamps it.

## Bounds and refusals

- At every overlapping layer interval, the total declared `instanceCount * samples` must be at most
  8,192 trail vertices. The check is an event sweep over `[startMs, startMs + durationMs)`.
- The shared per-frame plan counts transformed, radius-aware clipped stroke work. More than 2,000,000
  pixels throws the typed `trail_draw_budget_exceeded` refusal before paint.
- Existing point and particle count/payload limits still apply. A trail is not collision, force,
  noise, persistent velocity, reverse/wrap history, custom attributes, callback, formula, or script.

## Renderer and capability facts

Browser and native both advertise `effect.trail` and draw it through CPU lowering: fixed Canvas2D
strokes in browser and a bounded round-cap CPU raster stroke in native. The bounded GPU scene lane
also consumes this exact-time ordinary-particle/point trail geometry through its fixed WebGPU raster
path; it is not a compute-particle trail. In the GPU lane, the fixed ribbon and round-cap draws
inherit the points/particles layer's declared GPU compositor blend mode (including `screen`); they
do not install a trail-specific shader or blend path. Native paints inside its existing layer
transform shell, including rotation; browser paints inside the equivalent CSS layer shell. GPU
trails still refuse non-trail spatial effects rather than composing them approximately. A GPU
trail remains three fixed ribbon/cap/head draws, so non-normal blend is applied per draw rather
than after isolating the complete trail as one source surface.

The shared geometry and admission rules are deterministic. Browser and native do **not** claim byte,
pixel, colour-blend, or antialias parity. Fixed compute v1 explicitly refuses `effects.trail`.
Closed compute v2 has a separate two-to-four-sample analytic lookback trail inside its fixed GPU
ABI, with no history texture/state; it is not this portable CPU `effects.trail` contract. No
renderer falls back to another lane or adds a command hidden behind either form.

## Agent and MCP route

Use action discovery for `add a spark trail`, `add a drone trail`, or `set particle trail duration`.
It returns the existing `motion.timeline.layer.create` and `motion.timeline.layer.rich.set` commands.
Over MCP, those are the existing generated tools; supply the full typed layer record when creating,
then the normal `richPath`/`richValue` pair for either scalar edit. Read the edit receipt and preview
the requested frame before handoff.

## Focused test matrix

| Surface | Focused evidence |
| --- | --- |
| Core contract/geometry | `packages/core/src/motion-trail.test.ts`: owner/field bounds, getter-safe direct validation, active vertex sweep, point interpolation, particle-centre/cycle sampling, rotation, radius-aware clipping, un-clamped width, and typed 2M-work refusal. |
| Native CPU lowering | `packages/renderer-native/src/points-render.test.ts`: sampled point head plus an otherwise uncovered trail pixel in the emitted native PNG. |
| Browser CPU lowering | `packages/renderer-browser/src/trail-render.test.ts`: one real Chromium point-trail frame checks nonzero tapered history, stronger newer segment, and a black pre-history region. It is serial, one worker, with no file parallelism. |
| GPU fixed-compositor admission | `packages/core/src/gpu-scene-2d-plan.test.ts` and `gpu-capability-match.test.ts`: a screen-blended trail emits screen ribbon/cap/head draws, accounts three fixed compositor passes, and stays aligned with static capability admission. |
| Generated contracts | `pnpm run contracts:generate`, then `pnpm run contracts:check` and `pnpm run docs:debug-api` keep `effects.trail`, action discovery, Debug/MCP metadata, and public schemas fresh. |

Run only focused serial proofs in constrained WSL sessions; do not overlap browser or full Vitest chains.
