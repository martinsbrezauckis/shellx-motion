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

Full-render motion-density evidence uses two independent signals: whole-frame Y/Cb/Cr mean absolute
difference against the first frame of each unchanged run, and the fraction of full-resolution luma
pixels whose byte delta from the adjacent frame is greater than 2. An interval is frozen only when
both are quiet (defaults:
mean difference at most `0.003`, changed-pixel fraction at most `0.001`). This keeps the metric
comparable to FFmpeg `freezedetect` while preventing a thin chart line, caption or path reveal from
being mislabeled as dead air merely because it occupies a small part of the frame. These signals do
not by themselves prove meaningful composition motion: noise and film grain require a separate
release-proof policy. A promoted family that declares `film-grain-stripped` analysis is therefore
measured a second time from the exact materialized package with only `effects.filmGrain` removed;
the decorative per-pixel noise cannot meet a composition-motion cap.

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

### `promoted-moving-proof`

The promoted product pack has a separate moving-media release gate. Its checked
source-owned policy table is exact over the twelve public family IDs in
`fixtures/template-moving-proof-policy.json`. Each family must declare either
completed motion-density caps or the explicit `calibration-required` state;
the latter is a release failure, never an advisory. The current table is
calibrated for all twelve families from the qualified Linux GPU-host diagnostic at commit
`e6ae73c9c8f0224384f98dc548e0aa033848f6c8`, evidence SHA-256
`cab468a4129ac9a301698a552366f2d22008767703a0ff45ef7178753e336b65`.
That run rendered twelve primary MP4s plus the five required grain-stripped
alternates with zero failures. Calibration remains diagnostic provenance only:
the ordinary proof's fresh receipts, source-frame measurements and FFprobe
readback are the authority for release acceptance.

For each selected family, `template-pack:proof` renders the full story to a
short 8-fps MP4 in caller scratch, then fails closed unless all of the following
are true:

- the final artifact SHA-256 matches the fresh final render receipt;
- FFprobe readback, not requested MotionIR fields, reports the expected MP4
  H.264 container, 8 fps, story duration (within one delivered frame), and
  limited-range BT.709 colour; audio presence/stream count is checked from that
  same readback;
- rasterized source-frame hashes meet the measured per-family unique-frame
  threshold. The proof explicitly retains the exact materialized browser PNG
  sequence only long enough to measure it, then prunes it on a green run; a
  family that no longer has enough movement fails rather than silently
  receiving a lower threshold;
- completed frame-sequence density satisfies that family's checked maximum
  frozen ratio and longest frozen run. For a grain-bearing family this is the
  film-grain-stripped alternate, not raw hash diversity or raw pixel noise;
- artifact bytes, per-family caller-scratch bytes, and receipt-attested FFmpeg
  process-tree peak RSS stay within their checked policy caps. That RSS is only
  the final receipt's FFmpeg encode process tree; it is **not** browser-frame or
  total end-to-end process RSS; and
- every `shellx-cut` manifest advertisement has a declared static parity mode.
  Four rich families are checked against Cut's Generate catalog;
  `cinematic-rain-launch` is explicitly rendered-media-only and is never
  claimed as Cut Generate/runtime parity.

The serialized release-gate invocation is:

```bash
pnpm run template-pack:proof -- --out /absolute/caller-scratch/template-product-pack-proof
```

The chosen output directory must be empty. Use `--force` only to intentionally
replace the gate's own marker-bound proof roles in that exact scratch directory;
it refuses filesystem roots, the repository root, the home directory, symlink
roots, unmarked non-empty directories, and unknown content. Use
`--retain-artifacts` only when a human or CI needs diagnostics. On a successful
default run, large MP4s, raster frames, package copies, and quality diagnostics
are pruned; only evidence and byte-identical copied render receipts remain.
Failed runs retain their scratch diagnostics. CI may upload retained failure
diagnostics, but no rendered media is committed to Git.

When a family is `calibration-required`, use the explicit diagnostic command
on a qualified renderer host:

```bash
pnpm run template-pack:proof -- --calibrate-motion-density --retain-artifacts
```

It intentionally exits non-zero and writes `not_release_eligible` calibration
evidence. Review the retained source-frame sequences, then commit the measured
per-family frozen-ratio and frozen-run caps before rerunning the ordinary
release command. The diagnostic render uses the fixed source-owned floor of
one unique source-frame hash, so it can retain and measure even a fully static
control; its evidence records `uniqueFrameHashGate: "calibration-diagnostic"`,
`minUniqueFrameHashes: 1`, and the family's still-unmodified
`releaseMinUniqueFrameHashes`. It does not lower that release threshold:
ordinary proof records `uniqueFrameHashGate: "release-policy"` and continues
to pass and re-check the checked per-family value. This command may not be used
with `--resume-inspection`.

The calibrated caps use the exact measured frozen ratio and longest frozen run
with no invented headroom. Product Metric Card's unique-frame release floor is
22, matching the fresh compiler-backed render rather than the superseded
pre-line-box measurement. Other family unique-frame floors remain unchanged
because the qualified calibration met them. A later source change that alters
these measurements must run this diagnostic again and commit a new evidence
identity before ordinary release proof can pass.

`--resume-inspection` is a narrow recovery path for one interrupted proof, not
a cache or a substitute for rendering. It accepts only the marker-bound
diagnostics from the exact 12-family failed run whose checked policy hash still
matches and whose sole failure is the documented product-metric frame-root
recovery. It never combines with `--force`, never starts a browser render, and
rehashes every retained final MP4, receipt, and browser-frame sequence before
running FFprobe-only delivery readback. A green recovery writes normal evidence
and performs the same default media cleanup; stale, partial, markerless, or
tampered diagnostics are refused. If recovery itself is red, it writes only the
marker-owned `resume-inspection.failure.json` sidecar and never overwrites the
baseline failed-run `evidence.json`.

The built-in `.scratch/template-product-pack-proof` location is repository-owned
for repeatable platform verification and may reset its own marker-bound roles;
an explicit `--out` remains caller-owned and requires `--force` before a
non-empty, marked proof directory is reset.

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
