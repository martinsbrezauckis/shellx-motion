# Named transition presets

ShellX Motion v0.2 exposes seven reusable transition treatments that compile to ordinary,
validated Motion transitions, keyframes, and bounded effects. They are convenience data, not a
renderer plugin or executable effect language.

Use `motion.timeline.transition.presets` to discover the current catalog. Apply one preset to one
existing editable layer with `motion.timeline.transition.preset.apply`; the edit copies the source
package to a new empty `outDir`, validates the resulting Motion document, and writes one package
receipt. The source package is unchanged.

| Preset | Default | Intended use | Declared lanes |
| --- | ---: | --- | --- |
| `soft-fade` | 420 ms | titles, captions, UI callouts | native, browser, FFmpeg |
| `slide-cover` | 560 ms | cards, overlays, feature callouts | native, browser, FFmpeg |
| `wipe-accent` | 480 ms | branded reveals and section changes | browser, FFmpeg |
| `card-stack` | 620 ms | social, comparison, and dashboard cards | browser, FFmpeg |
| `push-zoom` | 640 ms | hero media and screenshots | browser, FFmpeg |
| `scan-sweep` | 520 ms | diagnostics and automation visuals | browser, FFmpeg |
| `split-reveal` | 580 ms | before/after and comparison beats | browser, FFmpeg |

The apply request is closed: `packageRoot`, `outDir`, `layerId`, and `preset` are required;
`durationMs`, `direction`, `distance`, `easing`, `receiptsRoot`, and `createdBy` are optional.
Unknown fields, preset ids, directions, and invalid numeric overrides are refused.

```bash
shellx-motion debug transition-presets

shellx-motion debug transition-preset-apply \
  --package /path/to/source-package \
  --out /path/to/revised-package \
  --layer hero-card \
  --preset card-stack \
  --duration-ms 620 \
  --direction left \
  --distance 72
```

The apply receipt records the preset id, layer id, resolved enter/exit transitions, affected
keyframe/effect paths, validation result, and package hashes. A preset does not promise that every
renderer supports every compiled feature: use `motion.capabilities.match` against the revised
package before choosing a lane. There is no silent effect drop or fallback claim.

## Acceptance matrix

| Boundary | Evidence |
| --- | --- |
| Catalog authority | Debug/MCP enum values are generated from Core's seven preset ids. |
| Atomic mutation | Focused Debug test proves source preservation, revised-package validation, and receipt output. |
| Typed refusal | Unknown presets, unsupported directions, and invalid numeric overrides refuse before publication. |
| Agent discovery | Actions resolve catalog and apply language to the two typed commands. |
| CLI parity | Focused CLI projection proves the same closed fields and numeric conversions. |
| Renderer boundary | Existing Core preset tests prove deterministic lowering; capability matching remains the lane admission authority. |
