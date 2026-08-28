# Tideglass Almanac — V25-B2 hybrid segmented acceptance film

`Tideglass Almanac` is an original 12-second 1920x1080, 30fps GPU-only art film: a nocturnal
glass tide moves inside two rotating brass observatory rings, with a slow camera drift and a
restrained paper-and-vignette finish. It is deliberately a product-film composition, not a
technical card or frame-export sample.

The film has four continuous 90-frame visual arcs. Their half-open frame ranges and 3-second
boundaries are deliberately part of the fixture design:

| frames | time | visual arc |
| --- | --- | --- |
| `[0, 90)` | `[0, 3s)` | Quartz Wake — a low, pale tide opens through the dark glass. |
| `[90, 180)` | `[3s, 6s)` | Copper Meridian — the orbit lines widen while the tide accelerates. |
| `[180, 270)` | `[6s, 9s)` | Deep Eclipse — the field densifies and the inner orbit contracts. |
| `[270, 360)` | `[9s, 12s)` | Returning Tide — the glass clears into a calmer closing orbit. |

## Strict hybrid boundary

The package declares exactly one `shader` layer, `tideglass-window`, with seed `20260815`. Its
one source file, `assets/tideglass-almanac.glsl`, is canonical UTF-8, 668 bytes, and its
SHA-256 is `6446d73b702e9b6f066a1af82e999992eb8ed4eabd10a9be4db56c408cbca44b`. It is one
`glsl-es-100-expression` function under the existing restricted validator, not package WebGPU,
JavaScript, HTML, or arbitrary package code. The declared isolated capture texture is 1600x900
(1,440,000 pixels), inside the 4096px / 16-megapixel ceiling.

All surrounding composition is declarative Motion: a radial background, a rounded mask, fixed
glow, two stroked ellipses, a bounded camera transform, and a vignette/grain adjustment. There
are no HTML, canvas, scripts, fonts, images, video, audio, network origins, Cut compatibility,
or binary assets. Its source and visual design are original project work authored in the checked-in
recipe; no source material is copied or attributed.

## Regeneration

[`templates/generators/tideglass-almanac/recipe.json`](../../../templates/generators/tideglass-almanac/recipe.json)
and its adjacent generator deterministically write this fixture's `manifest.json`, `motion.json`,
and GLSL source. The recipe pins canonical JSON and UTF-8 GLSL digests. Regenerate into a new or
empty location, then source-validate it:

```bash
python3 templates/generators/tideglass-almanac/generate.py \
  --out .scratch/creative-samples/tideglass-almanac/package
pnpm --filter @shellx-motion/cli run cli -- validate \
  .scratch/creative-samples/tideglass-almanac/package
```

## Accepted native boundary

`segmentFrames: 90` is the accepted V25-B2 selector. On the qualified Linux RTX 5080 rig, a bounded first job sealed
range 0 and stopped by its declared deadline while range 1 was incomplete. Runtime commit
`77faf57440bc4b7d2f203028664ae1da3995acc0` resumed that verified prefix, rendered the remaining
three ranges, published one 360-frame H.264 final, and removed the successful store. A separate
cold four-range replay on the same commit produced the same frame-sequence hash, frame-plan hash,
aggregate hybrid capture identities, and exact MP4 SHA-256
`1948035852449a7ac0858ecf31905787c153a736dc9d016702debcaf888c7ce1`.

This accepts the one restricted-GLSL texture and surrounding declarative composition shown here.
It does not claim arbitrary GLSL, package WebGPU, a second hybrid surface, native HTML/web/canvas
visual qualification, cross-host pixel identity, or release readiness. Full host, receipt, range,
cleanup, and visual limits follow the public
[rendering contract](../../../docs/public/rendering.md).
