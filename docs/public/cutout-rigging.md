# Bounded cutout-rig bake

`motion.timeline.cutout.rig.bake` turns one verified static PNG illustration into ordinary Motion
image layers and transform keyframes. It is an **author-time sampled bake**, not a live rig:
renderers receive no parent graph, simulation, scripts, GPU work, or hidden history.

## Call contract

The Debug API and MCP tool `motion_timeline_cutout_rig_bake` require `edit_motion` and accept only
`packageRoot`, an absent or empty copy-on-write `outDir`, `sourceLayerId`, and a data-only `rig`.
`createdBy` and a host-governed `receiptsRoot` are optional. The complete generated argument and
receipt contract is in [DEBUG_API_COMMANDS.md](DEBUG_API_COMMANDS.md#motiontimelinecutoutrigbake).

The CLI accepts a local JSON file only through its governed input policy:

```bash
shellx-motion debug cutout-rig-bake \
  --tier edit_motion \
  --package /work/source-package \
  --out /work/baked-package \
  --source-layer character-art \
  --rig-file /work/rigs/character.json
```

`--rig-file` is transport-only. The CLI reads one regular non-symlink JSON file no larger than
128 KiB after declaring its parent as a local authoring input; its path is removed before Debug,
MCP, SDK, and receipt processing. Direct API/SDK callers provide `rig` itself.

## Data model and timing

`rig` has schema `shellx-motion/cutout-rig@1`, 1–16 nodes, and `sampleEveryFrames` from 1 through
16. Every node has one output `layerId`, a unique `stackIndex` forming exactly `0..N-1`, an optional
`parentId`, integer PNG-pixel `crop`, crop-local PNG-pixel `origin`, and 1–32 strictly increasing
poses. A pose supplies finite bounded `atMs`, `x`, `y`, `scale`, `rotation`, and optional named
easing; no formula, callback, unknown field, getter, or executable value is accepted.

The source image and crop use PNG pixels. A pose `x`/`y` is the cropped child box's top-left in its
parent's untransformed crop-local pixels; `origin` is measured in the child crop. Nodes evaluate in
deterministic parent-before-child topological order independent of input order, while `stackIndex`
alone fixes output draw order. The source's static Motion transform is preserved. Skew, reflection,
singular/non-decomposable transforms, and scale outside `0.001..100` refuse.

Only renderer-observable timestamps in the source active half-open interval `[startMs, endMs)` are
sampled. Poses clamp to their first value before the first pose and their last value after the last
pose. The final selected renderer frame is retained even when it is off cadence; no synthetic
`endMs` key is added. The bake refuses before materialising more than 256 samples or 16,384 emitted
transform keyframes.

## Source and output boundary

The source must be one visible unlocked image on exactly one unlocked track, with one
manifest-declared package-local `assets/` PNG. Motion reads it through `O_NOFOLLOW`, checks it is a
regular stable file at or below the shared 64 MiB package-source limit, decodes its identity, and
repeats that check inside the private copy-on-write stage. Crop, keyframes/spatial animation,
effects, masks/mattes, keying, style/fit/blend/opacity, transitions, relationships, compositing
references, and track locking are refused rather than approximated.

The committed package replaces the source layer with ordinary `image` layers carrying the same
asset reference, crop, static transform, and `transform.x`, `transform.y`, `transform.scale`, and
`transform.rotation` keyframes. Browser and native consume those existing data features; this adds
no native fallback or renderer-specific rig primitive. The current ShellX Cut editable receiver
cannot preserve the emitted crop/origin transform payload, so Cut planning truthfully selects
`rendered_media` instead of claiming editable lowering.

## Receipt and acceptance matrix

The `timeline.cutout.rig.bake` receipt binds source manifest/Motion/PNG hashes and the canonical
rig request. It records output layer ids, changed paths, source static transform, selected cadence,
and this approximation statement: ordinary linear transform tracks between sampled renderer frames.
It never claims in-between live-parent equivalence.

| Check | Focused evidence |
| --- | --- |
| Core data and bounds | `packages/core/src/cutout-rig.test.ts` checks clamping, half-open sampling, exact stack order, bounded samples/keyframes, and native/browser capability matching. |
| Source, hidden stage, receipt | `packages/debug-api/src/domains/authoring-cutout-rig.test.ts` checks a copy-on-write bake, source-animation refusal, persisted receipt facts, and capability match. |
| Agent/API parity | CLI, SDK, Actions, Debug/MCP tests cover governed `--rig-file` removal, typed transport, action discovery, closed MCP arguments, and `edit_motion` admission. |
| Native and browser frames | Native CPU raster pixels prove both declared samples; the separate focused Chromium proof samples both positions. No browser/native byte or antialias-parity claim follows. |
| Cut handoff | `packages/adapters-cut/src/cutout-rig-bake.test.ts` requires rendered-media fallback when the editable receiver refuses crop/origin output. |
