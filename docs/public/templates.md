# Agent template reference

This page is reference material for agents and host integrations. Full template catalog, plan,
control, apply, and media-replacement routes are Motion CLI and Debug/MCP contracts, but ShellX
Motion does not present them as a human Workbench gallery. The 35-operation local SDK has no
dedicated template catalog, plan, apply, or media-replacement API; its generic validate, render,
and timeline-edit operations may act on a package the caller has selected. Templates are starting
material for package automation, not a promise that Motion generates narration, music, or sound
effects.

A ShellX Motion template exposes a controlled edit surface over a composition:
designers publish typed controls, media slots, and text slots without exposing
every implementation detail. This is the useful part of the MOGRT / Apple Motion
template idea, expressed as ShellX data.

> **Invoking the CLI.** Shell commands on this page are written as `shellx-motion <command>` — the
> single `bin` the `@shellx-motion/cli` package publishes. From a ShellX Motion source checkout, run
> them as `pnpm --filter @shellx-motion/cli run cli -- <command>` instead. There is no `motion` binary
> in either form; dotted names such as `motion.render.final` are Debug API / MCP command ids, not
> shell commands. See [Quickstart](quickstart.md).

## The product pack: 12 families

The current product pack (`templates/shellx-product-pack/`) has 12 promoted
families. They deliberately span visual styles rather than one theme. What every
family actually carries, measured against the checked-in pack:

| Attribute | Coverage |
|---|---|
| Typed controls (TemplateIR `params`) | 12 / 12 |
| Representative-frame quality targets (`metadata.qualityTargets`) | 12 / 12 |
| Rendered poster (`preview/poster.png`) | 12 / 12 |
| Semantic media slots (`metadata.mediaSlots`) | 5 / 12 |
| Story beats (`metadata.story.beats`) | 5 / 12 |
| Checked-in rendered MP4 | 0 / 12 |

The five families carrying media slots and story beats are the rich cinematic
ones: `cinematic-rain-launch`, `cinematic-fog-title`, `editorial-liquid-surface`,
`keyed-subject-promo`, and `tracked-callout-overlay`. The other seven expose typed
controls and quality targets without slot/beat metadata — plan those with
`template controls`, not with `authoringLoop.mediaSlots`.

No family ships a rendered MP4 as proof. The pack contains exactly one `.mp4`
(`keyed-subject-promo/assets/generated/atmosphere-fog-rays.mp4`) and it is a
**source asset the template composites**, not evidence of a render. Render the
family yourself and read the receipt if you need MP4 evidence.

| Family | One-liner |
|---|---|
| `launch-bumper` | Shape/text SaaS launch opener. |
| `feature-announcement` | Product feature checklist announcement. |
| `social-stat-card` | Square-first social metric promo. |
| `media-launch` | Media-rich generated-asset hero clip. |
| `audio-launch` | Package-local audio (`assets/audio/*.wav`) carried into the final MP4 when you render it. |
| `kinetic-type` | Deterministic word-level typography card. |
| `product-metric-card` | Data/batch metric card, FHD and square variants. |
| `cinematic-rain-launch` | Scene-aware rain, wet reflections, atmosphere. |
| `cinematic-fog-title` | Source-aware fog depth and travelling light. |
| `editorial-liquid-surface` | Image-led story refracted through liquid optics. |
| `keyed-subject-promo` | Cleaned chroma-key subject inside a moving branded scene. |
| `tracked-callout-overlay` | Synchronized tracked annotation over a product close-up. |

The moving effects in these templates are Motion compositions, not slide-transition
stand-ins.

Cut's Generate catalog exposes **four** of them — `builtin.motion.cinematic-fog-title`,
`builtin.motion.editorial-liquid-surface`, `builtin.motion.keyed-subject-promo`,
and `builtin.motion.tracked-callout-overlay`. `cinematic-rain-launch` is **not**
one of them: it declares `shellx-cut` host compatibility in its manifest, but it
has no Cut Generate entry. `template-pack:host-parity` accounts for all five
Cut-advertised templates: it checks the four Generate entries and records rain's
separate rendered-media-only static handoff. To get rain into Cut, render it
through Motion and hand Cut linked rendered media; that is not a Generate or
Cut-runtime parity claim.

## Typed controls: TemplateIR

TemplateIR describes the editable surface over a MotionIR fragment:

- **Typed params** with defaults, labels, ranges, enums, validation, and grouping.
- **Media slots and text slots** with semantic role, accepted image/video kinds,
  fit, minimum dimensions, duration guidance, and rights requirements.
- **Supported placements, aspect ratios, durations, and render lanes.**
- **Lowering hints** for Design Studio and Cut, sample rows, preview frames, and
  compatibility notes with unsupported-feature fallbacks.

Controls are declared, not free-form. A rejected control path is a contract
failure — it is not an invitation to hand-patch package JSON.

## Template apply → a concrete package

Start from `motion.template.plan`, not a guessed path. The plan returns the
selected template, input readiness, and an `authoringLoop`: apply the declared
controls, capture each representative frame, render final media, run the quality
checks, and (on failure) create a proposal-only revision plan before mutating
again.

```bash
# Discover the controls a template exposes.
shellx-motion template controls fixtures/packages/editable-lower-third

# Apply typed controls into a new, explicit output package.
shellx-motion template apply fixtures/packages/editable-lower-third \
  --out .scratch/template-apply/editable-lower-third-updated \
  --set "title=Dr. Mira Chen" \
  --set "accentColor=#ff006e" \
  --set "titleScale=1.2"

# Render the concrete package to final media.
shellx-motion render .scratch/template-apply/editable-lower-third-updated \
  --lane ffmpeg --out .scratch/template-apply/lower-third.mp4
```

Applying controls patches MotionIR, emits a `template.apply` receipt, and produces
an ordinary Motion package that Design Studio can reopen and Cut can consume. When the
plan returns `authoringLoop.qualityManifestPath`, pass it to the final render/
quality commands so per-frame luma/edge/brightness and perceptual gates are
enforced — do not lower a failed gate merely to make a render pass.

## Batch and data rows

A template package can carry package-local data rows (`data/`) and expand them
into one rendered output per row:

```bash
shellx-motion render-batch fixtures/packages/batch-card --out .scratch/batch-card-real
```

This materializes a concrete Motion package per row and renders one MP4 per row
with a `render.batch` receipt. Non-video presets work too (for example
`--preset png-sequence` writes one frame directory per row). Batch runs can carry
the same quality manifest used by single renders; row tokens such as `{{rowId}}`,
`{{rowKey}}`, and any data-row field are available in manifest strings, including
per-row baseline paths, so row-specific review baselines stay reproducible.

For a package with `template.json`, top-level row keys matching declared template
params or `metadata.inputSchema.properties` are applied through the same typed
bindings as `template apply`. A provided typed key must change at least one real
binding; an unknown, invalid, or unbound declared key refuses the row before any
package copy or render. The deterministic precedence is token interpolation,
typed template bindings, `replace.text` / `replace.media`, `layers.<id>` patches,
then `motion` document overrides. This lets compact rows drive ordinary template
controls while retaining `layers.<id>` for deliberate low-level per-row changes.

## Media slots and containment

Read `authoringLoop.mediaSlots` before replacing media. Package-local `assets/`
containment is mandatory — imported media is copied into the package, hashed in
the receipt, and bounded by per-file and total limits. A template that declares a
scene-sampled effect may currently require a stable image source; do not claim a
video is accepted where the effect needs an image. See
[Rendering lanes](rendering.md) for what each effect family supports today.
