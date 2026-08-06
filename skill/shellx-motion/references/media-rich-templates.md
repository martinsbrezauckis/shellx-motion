# Media-rich template authoring — full detail

Moved out of `SKILL.md` so the skill stays inside its context budget while first-contact material
(how to start a package, what the machine needs, how to watch a job) fits. This is reference depth:
read it when you are actually authoring against a template pack.

Start from `motion.template.plan`, not a guessed package path. A production template may declare:

- `metadata.story.beats` for bounded shot/scene intent and the layers/media slots active in each beat;
- `metadata.mediaSlots` for semantic role, accepted image/video kinds, fit, minimum dimensions,
  duration guidance, and rights requirements;
- `metadata.qualityTargets` for strictly ordered representative frame times, distinct/blank-frame,
  edge/luma, text-fit, and safe-area gates, plus an optional package-local `quality/` manifest.

The returned `authoringLoop` is the default sequence: apply declared controls, capture every
representative frame, render final media, run quality checks, create a proposal-only agent revision
plan on failure, then hand a passed package to Cut. Read `authoringLoop.mediaSlots` before replacing
media; package-local `assets/` containment is still mandatory. Do not claim that a video is accepted
when a scene-sampled effect currently requires a stable image source.

When `authoringLoop.qualityManifestPath` is present, pass it to final render/quality commands. Its
per-frame `minLumaRange` gate is enforced alongside edge/brightness and perceptual comparison
thresholds; do not reduce a failed gate merely to make a render pass.

Only the five rich families below declare `metadata.mediaSlots` and `metadata.story.beats`. The other
seven of the 12 pack families declare typed controls and `metadata.qualityTargets` (all 12 do) but no
slots or beats — plan those from `motion.template.controls`, and do not expect
`authoringLoop.mediaSlots` to be populated for them. No family ships a rendered MP4 as proof; the
single `.mp4` in the pack is a composited source asset. Render and read the receipt yourself.

Use the promoted rich references according to the requested visual job:

- `cinematic-rain-launch` for wet-ground rain and reflected atmosphere;
- `cinematic-fog-title` for source-aware fog depth and travelling light;
- `editorial-liquid-surface` for water optics, caustics, and refraction;
- `keyed-subject-promo` for spill-suppressed presenter compositing;
- `tracked-callout-overlay` for synchronized product annotations.

All keep copy auto-fit against declared safe areas and use moving scene effects rather than slide
transitions. Cut agents discover **four** of them as `builtin.motion.*` Generate families —
`cinematic-fog-title`, `editorial-liquid-surface`, `keyed-subject-promo`, and
`tracked-callout-overlay`. `cinematic-rain-launch` is **not** in Cut's Generate catalog and is not
covered by the parity gate, despite advertising `shellx-cut` in its manifest; hand rain to Cut as
rendered media. For the four that are exposed: preview before insert, then open the linked package
in Design Studio for projected-control edits and one verified rerender. Run `template-pack:host-parity` to
check the 12-family Motion catalog plus both bundled host-agent workflows without rendering media or
starting a browser.
