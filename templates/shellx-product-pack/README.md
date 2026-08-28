# ShellX Product Template Pack

Status: active starter pack for polished ShellX Motion templates.

This pack contains templates intended to pass the quality bar in `docs/public/TEMPLATE_QUALITY_BAR.md` and the design-variety matrix in `docs/public/TEMPLATE_DESIGN_MATRIX.md`. Existing `fixtures/packages/*` remain small deterministic test fixtures.

Implemented starters — this is the published pack. Some families exist in the implementation tree
and are deliberately withheld from publication; the withholding is recorded and enforced there, and
the exporter refuses to run when a withholding rule stops matching, so this list cannot silently
drift from what actually ships:

- `launch-bumper` - shape/text SaaS launch opener.
- `feature-announcement` - product feature checklist announcement.
- `social-stat-card` - square-first social metric promo.
- `media-launch` - media-rich generated-asset proof.
- `audio-launch` - package audio and final MP4 audio proof.
- `kinetic-type` - deterministic word-level typography card.
- `product-metric-card` - data/batch metric card with FHD and square variants
  (literal document: renders complete on its own, and `data/*.batch.json` layers
  per-row diffs on top of it for `render-batch`; see its README).
- `cinematic-rain-launch` - scene-aware rain, wet reflections and atmosphere.
- `cinematic-fog-title` - source-aware fog and cinematic light title sequence.
- `editorial-liquid-surface` - image-led editorial story refracted through liquid optics.
- `keyed-subject-promo` - cleaned chroma-key subject inside a moving branded scene.
- `tracked-callout-overlay` - synchronized tracked annotation over a product close-up.

## Catalog Layout

```text
templates/shellx-product-pack/
  launch-bumper/
  feature-announcement/
  social-stat-card/
  media-launch/
  audio-launch/
  kinetic-type/
  product-metric-card/
  cinematic-rain-launch/
  cinematic-fog-title/
  editorial-liquid-surface/
  keyed-subject-promo/
  tracked-callout-overlay/
```

The published pack contains 12 promoted families. Further growth should preserve
semantic media slots, story beats, safe text fit, representative-frame quality
targets, real MP4 proof, and any advertised Cut/Design Studio receipts.

## Proof Command

Run the product-pack proof lane after template edits. Use a caller-owned empty
scratch directory for durable diagnostics:

```bash
pnpm run template-pack:proof -- --out /absolute/caller-scratch/template-product-pack-proof
```

Every starter renders to a real MP4 at native dimensions and full story duration
(only the frame rate is reduced for fast local verification), runs frame/preview
quality checks, verifies audio on audio templates, and writes:

```text
.scratch/template-product-pack-proof/evidence.json
.scratch/template-product-pack-proof/receipts/*.render.receipt.json
```

The release profile is full story duration at the checked 8 fps. It derives
duration/fps/colour/audio facts from the fresh final receipt plus FFprobe
readback, requires measured per-family unique-frame movement, enforces resource
budgets, and verifies the artifact hash against the final receipt. It does not
accept `--full-duration` or another fps until the checked measured policy is
deliberately recalibrated. The RSS budget is the final receipt's FFmpeg encode
process tree only; it does not claim a browser-frame or total end-to-end RSS
budget.

Successful default runs prune MP4s, frames, package copies, and quality
diagnostics after writing the evidence and copied final receipts. Pass
`--retain-artifacts` to keep diagnostics, and `--force` only to intentionally
replace marker-bound proof roles in the same exact scratch directory. The gate
refuses broad roots, symlink roots, markerless non-empty directories, and
unknown content; it never recursively removes an arbitrary caller path. Never
commit the retained media; CI may upload it only as failure diagnostics.

For the one documented frame-root recovery case, `--resume-inspection` opens a
complete marker-bound failed proof without `--force`. It rehashes the retained
media, final receipts, and source frames and performs FFprobe-only delivery
readback without starting a browser render. It rejects stale policy identity,
partial diagnostics, any other failure shape, and tampered artifacts; it is not
a general render-cache switch. A red recovery records only
`resume-inspection.failure.json`, preserving the baseline `evidence.json`.

The built-in `.scratch/template-product-pack-proof` is a repeatable
repository-owned verification location. An explicit `--out` remains
caller-owned and needs `--force` to reset its existing marker-bound proof roles.

The lane **fails closed**. A family it cannot fully inspect is a reported
failure, never a silent pass, and any failure makes the whole run `ok:false`
with exit code 1. Gate codes recorded in `evidence.json`:

| code | meaning |
| --- | --- |
| `uninstantiated_template` | `motion.json` ships `{{tokens}}` with no `manifest.data.rows` to resolve them |
| `unresolved_tokens_after_instantiation` | a token survived expansion and would be painted on screen |
| `unbacked_template_token` | a token has no value in some row, so it silently expands to empty content |
| `missing_quality_manifest` | the family declares no `metadata.qualityTargets.manifest`, so its frames were never visually inspected |
| `missing_preview_poster` / `preview_poster_dimension_mismatch` / `preview_poster_not_a_real_render` | the shipped catalog poster is absent, the wrong size, or blank/near-empty rather than a real render |
| `render_failed` / `quality_check_failed` | the render or the frame/preview comparison failed |
| `artifact_hash_mismatch` / `receipt_copy_hash_mismatch` | rendered bytes do not bind to the fresh final receipt or its retained copy |
| `frame_count_mismatch` / `motion_density_below_policy` | the browser frame sequence is incomplete or has too little measured movement |
| `delivered_*_mismatch` / `receipt_*_mismatch` | FFprobe or final receipt does not prove the policy delivery format, duration, colour, or audio facts |
| `artifact_size_over_budget` / `scratch_over_budget` / `encode_rss_over_budget` | measured artifact, caller scratch, or receipt-observed FFmpeg encode RSS exceeds its family cap |

Because the visual gate is mandatory, **all 12 published families declare a
package-local `quality/representative-frames.json`**.

For resource-conscious local development, keep the full 12-template catalog
gate while rendering only the changed families:

```bash
pnpm run template-pack:proof -- --only cinematic-fog-title,editorial-liquid-surface
```

The targeted lane rejects unknown names, reports the full catalog count beside
the selected render count, and still performs the real MP4 plus browser-preview
comparison for every selected family. The moving-proof profile is fixed at 8
fps.

For a zero-render integration check across the promoted Motion catalog and the
bundled host agent contracts, pass the explicit local host worktrees. This gate
needs checkouts of the host repositories, so it is only runnable where those
exist; without them the check is unavailable rather than failing, in the same way
`PLATFORM_VERIFICATION.md` records an absent capability as absent:

```bash
pnpm run template-pack:host-parity -- \
  --canvas-root /path/to/shellx-canvas \
  --cut-root /path/to/shellx-cut
```

This gate validates all 12 published packages, all five `shellx-cut` manifest
advertisements, the four rich Cut Generate mappings, rain's rendered-media-only
static handoff, decimal-control exposure, and the Design Studio
Edit-in-Motion/Refresh workflow. It records that it launched zero browsers and
created zero rendered media.

Each template directory should contain:

```text
manifest.json
motion.json
template.json
assets/
data/
preview/
README.md
```

Generated media belongs under package-local `assets/generated/` and must have a `shellx-motion/generated-asset-receipt@1` receipt in the render evidence bundle.

## Typography Contract

A shipped template must render the same typeface on any host, so a family may not
depend on a font it does not carry. Three rules, all enforced by
`pnpm run template-pack:proof`:

1. **Every non-generic family is bundled.** If a text layer names a real family
   (today: `Inter`), the package ships that family under `assets/fonts/` — one
   Latin-subset WOFF2 per weight the layers actually select — declares each file
   in `manifest.assets`, binds it in `motion.assets` as a `type: "font"` record,
   and attributes it in `template.metadata.assetsAttribution`. Packages may only
   reference assets inside their own root, so every family carries its own copy;
   there is no shared font directory to point at.
2. **Every stack ends in a generic.** `"fontFamily": "Inter"` on its own resolves
   to the browser's *default* font when Inter is missing, which in Chromium is a
   serif — a geometric-sans design silently painted in Times. Declare
   `"Inter, Arial, Helvetica, sans-serif"` (or a bare CSS generic) so the worst
   case is still a sans face.
3. **A trimmed bundle may not restyle a layer.** Bundling only the weights a
   family selects keeps the pack small, but the selection must be identical to
   what a complete 100-900 static family would give. The gate replays CSS
   Fonts 4 weight matching against both sets and fails on any difference, so
   adding a layer at a weight the package does not carry is caught rather than
   silently rounded to the nearest bundled face.

A family that deliberately wants the host's own UI type declares the generic
`sans-serif` alone; that is allowed, and it is the only case in which output is
host-dependent by design.

## Starter Acceptance

A template is not ready for catalog promotion until `assessTemplateQuality()` can pass every applicable rule:

- `template-sidecar-complete`
- `preview-poster-contact-sheet`
- `fhd-social-output-bounds`
- `text-fit-safe-areas`
- `source-asset-provenance`
- `audio-stream-proof`
- `cut-canvas-connector-receipts`

If a template targets only Motion, omit Cut/Design Studio host compatibility until the connector receipts exist. If a template has no audio layers, the audio rule is not applicable.

## Design Families

The first pack should cover these visual families:

- SaaS launch bumper
- Product feature announcement
- Modern lower third
- Social stat card
- Data/report brief
- Tutorial overlay
- Media-rich hero clip
- Audio-backed release bumper
- Kinetic typography card
- Product metric batch card
- Cinematic rain launch
- Cinematic fog title
- Editorial liquid surface
- Keyed subject promo
- Tracked product callout

The pack should avoid a single visual theme. Use varied composition, contrast, typography scale, and motion language while staying readable inside ShellX Cut and Design Studio workflows.
