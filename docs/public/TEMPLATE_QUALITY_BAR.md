# ShellX Motion Template Quality Bar

Status: active acceptance contract for ShellX Motion template packs.

This document mirrors the machine-readable rules in `packages/core/src/template-quality.ts`. A template can be useful as a fixture without passing this bar, but it must pass this bar before it is marketed as a polished starter-pack template for ShellX Motion, ShellX Cut, or Design Studio.

## Required Rules

### `template-sidecar-complete`

Every catalog template needs a `template.json` sidecar with:

- params, controls, and bindings;
- compatible render lanes;
- compatible hosts;
- metadata for input schema, output bounds, suitability, license, provenance, and performance.

Media-rich templates should additionally declare:

- `metadata.story.beats` with bounded timing, editorial intent, and referenced layers/media params;
- `metadata.mediaSlots` with semantic role, accepted media kinds, fit/dimension guidance, and rights requirements;
- `metadata.qualityTargets` with ordered representative frames and deterministic visual gates.

`metadata.qualityTargets.manifest` is **required** for every promoted product-pack family, not
optional. It must be a package-local `quality/` path. `pnpm run template-pack:proof` refuses to
certify a family that does not declare one (`missing_quality_manifest`): without a manifest there is
no per-frame inspection at all, and a family that was never inspected must not be reported as
passing. The rule is written this way because the opposite once held: when the manifest was
optional, only the families that happened to declare one were visually inspected, the rest were
silently skipped, and the run still reported `ok:true` — a green result that covered a fraction of
what it appeared to cover.

The quality manifest can enforce per-frame brightness, edges,
luma range, chroma-rich pixel coverage, and perceptual comparison thresholds. Later representative
samples can also require a minimum changed-pixel count and mean pixel delta from the preceding
sample, so a nominally animated template cannot pass with a static or nearly static sequence.
Chroma-rich means a non-transparent pixel has an RGB channel span of at least 32; both the measured
counts and cross-sample diffs are preserved in receipts.

#### Visual-regression baseline: pre-encode renderer identity

For a video render (`mp4-*` / `webm-*` presets), each representative sample's `maxMeanDiff` /
`minPsnrDb` / `minSsim` comparison is measured against **pre-encode renderer identity**: the exact
pre-encode renderer frame the encoder consumed for the sample's delivered instant. The gate resolves
the delivered-frame index from the output's own timeline (`round(atMs * fps / 1000)`), extracts that
frame **by index** (`select=eq(n,N)`, frame-accurate) — not by a wall-clock `-ss` seek, which snaps
to a neighbouring frame — and compares it to source frame `N`. Because the encoder preserves frame
order 1:1, delivered frame `N` always decodes source frame `N`, so the two sides are the *same
rendered frame* and the metrics isolate **encode fidelity** rather than cross-frame animation delta.
This is why the thresholds can be tight even at low proof frame rates on fast-moving content; a
`-ss`-based, re-rendered-at-exact-`atMs` baseline compared a *different composition instant* against
the delivered frame and produced large, misleading deltas on animated templates.

Both sides are compared in the same colour domain. Every preset encodes full-range renderer RGB into
limited-range ("tv") BT.709 YUV; the extractor applies the explicit inverse (`in_range=tv:out_range=full`)
so the decoded frame is full-range RGB matching the source PNG. On a failed comparison the receipt
records the offending sample's full metric breakdown plus an amplified per-pixel **diff image**, so a
uniform colour/range offset (flat grey wash) is distinguishable from a content/timing regression
(bright silhouettes) without re-running.

Tolerances are calibrated from clean golden runs of the declared SDR-BT.709 delivery profile, not
widened until green. Golden worst-case across the five rich product-pack manifests (software libx264
CRF 18, proof profile fps 8): **PSNR ≥ 41.5 dB, SSIM ≥ 0.978, mean abs diff ≤ 1.39**. The shipped
thresholds (`minPsnrDb: 35`, `minSsim: 0.95`, `maxMeanDiff: 3`) therefore retain ~6.5 dB / 0.028 /
1.6 headroom over clean encode loss while still rejecting a one-frame content shift (which drops PSNR
to ~25 dB and SSIM to ~0.67 on rain-class motion).

These fields are validated against the loaded Motion package: beat layers and media params must
exist, beat and review times must fit the document duration, and every semantic media slot must
reference one declared `media` param.

### `instantiated-template`

A promoted template must render real content, never its own authoring placeholders.

- A `motion.json` that carries `{{token}}` placeholders is a **batch source document** and must
  declare `manifest.data.rows`. Without rows there is nothing to resolve the tokens and a plain
  `render` paints raw mustache text on screen; the proof lane rejects this outright
  (`uninstantiated_template`).
- Every declared row must expand token-free — not only the first one
  (`unresolved_tokens_after_instantiation`).
- Every token the document depends on must have a value in **every** row
  (`unbacked_template_token`). `packages/core/src/data.ts` substitutes a missing row key with an
  empty string, so an unbacked token leaves a token-free document with a blanked layer. Checking
  only for surviving `{{...}}` text would miss it.

### `preview-poster-contact-sheet`

Every catalog template needs:

- a preview poster path in `metadata.preview.poster`;
- a human-review contact sheet artifact that shows the template in context.

Contact sheets should show meaningful frames, not blank first frames or static placeholders.
When `metadata.qualityTargets.representativeFramesMs` exists, use those exact timestamps so the
catalog preview, agent revision loop, and human review inspect the same editorial beats.

The poster is a shipped artifact — the workbench gallery and the Cut/Design Studio template pickers render
it — so the proof lane gates it directly. It must exist, decode as a PNG, match the template's own
output dimensions, and be a real render rather than an empty frame: `inspectPngFile` must report
`blank: false` and an edge ratio above `0.003`. That floor was calibrated by measuring every poster
in the pack rather than picked round: the sparsest legitimate render came in at `0.00524`, and a
poster accidentally captured from an un-instantiated template — the failure the gate exists to
catch — came in at `0.00180`. The floor sits between them with roughly 1.7x headroom on each side,
so it separates a genuinely minimal overlay from a frame that never rendered.

### `fhd-social-output-bounds`

Every starter-pack template needs declared and proven output coverage for:

- FHD 16:9 MP4;
- at least one social aspect output: 1:1, 9:16, or 4:5.

The proof is rendered media evidence, not only metadata.

### `text-fit-safe-areas`

Every text-bearing template needs:

- text-fit evidence for representative longest-copy cases;
- safe-area evidence;
- `motion.safeAreas` metadata when the package contains visible text.

### `source-asset-provenance`

Every template needs source and asset rights evidence:

- template provenance with source hash;
- license metadata;
- asset attribution when assets are bundled;
- generated-asset receipts when package assets come from a media generator.

Generated assets must be imported under package-local `assets/` paths before render.

### `audio-stream-proof`

Templates with audio layers need:

- FFmpeg/ffprobe audio stream evidence;
- audio quality or loudness evidence;
- a receipt path that can be linked from the rendered output bundle.

Templates with no audio layers are marked not applicable for this rule.

### `cut-canvas-connector-receipts`

Templates advertised for ShellX Cut or Design Studio need passed connector receipts for each advertised host.

Do not add `shellx-cut` or `shellx-canvas` compatibility until the connector proof exists.

## Review Outputs

Each production template family should keep generated evidence outside Git under `.scratch/`:

```text
.scratch/template-quality/<template-id>/
  contact-sheet.png
  fhd.mp4
  square.mp4
  text-fit.receipt.json
  safe-area.receipt.json
  audio.receipt.json
  cut.receipt.json
  canvas.receipt.json
```

Only durable source packages, documentation, fixtures, and tests belong in Git.
