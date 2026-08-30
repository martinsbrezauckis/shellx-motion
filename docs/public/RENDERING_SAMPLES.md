# Rendering samples for agents

This page is generated from [`rendering-sample-catalog.json`](rendering-sample-catalog.json). It is the one public, machine-readable mapping from each published **delivery-output** capability to one canonical checked-in package, with explicitly tagged supplemental samples when a broader family needs additional source evidence; it does not contain rendered media.

Catalog fingerprint: `c3e73ba37b78eab704631cfdf190715bd90d4ac26881f97c224c03517adf28d4`. Validate it and every package with `pnpm run docs:rendering-samples:check`.

This is a delivery-output catalog foundation. Its delivery set is mechanically derived from the documented preview/final routes and `MOTION_EXPORT_PRESETS`. The primary MotionLayerType map below is a discoverability index only: it maps each public layer type to one relevant rendering family, but does **not** claim every authoring mutation, inspector control, or tool has a sample. Catalog coverage is derived from the checked [public family authority inventory](rendering-sample-family-authorities.json), so an added public authority blocks until it has matching checked package or workflow evidence.

Run `pnpm run rendering-samples:proof` to execute every registered workflow in fresh proof-owned `.scratch/rendering-samples-proof/run-*` roots. It validates each declared output and succeeded receipt operation; it is the separate runtime source-workflow gate, not installed/native qualification. Catalog coverage being ready below does not claim that a fresh runtime proof has passed.

`familyWorkflowBindings` is an exclusive runtime plan: it proves only the source, commands, outputs, and receipts named by its own bound rows. Canonical invocations without their own bound workflow are checked structural recipes, not executed runtime proof; they need their own fresh release/native evidence before any delivery, installed, or host-qualification claim.

## Catalog coverage: ready

Every catalog-authority rendering family has a checked sample or workflow registration. Runtime readiness still requires `pnpm run rendering-samples:proof`.

Every inventoried public rendering family has a checked registration.

## Agent non-delivery tool boundaries

This is a routing index, not a rendering or delivery catalog. Use the named Debug/MCP command family and source boundary; a refusal is the product boundary, not a fallback prompt.

| Surface | Debug/MCP route | Source boundary | Refusal boundary |
|---|---|---|---|
| Checkpoint storyboard | `motion.timeline.checkpoint-storyboard.create`, `motion.timeline.checkpoint-storyboard.inspect`, `motion.timeline.checkpoint-storyboard.preview` | Host-sealed checkpoint record lifecycle only; it is not a Motion package sample or a catalog delivery route. Sources: `schemas/debug.json`. | No CLI, local SDK, or Action route; create/inspect/preview do not by themselves create a package, final render, or delivery proof. |
| Layout-gap animation | `motion.timeline.layout-gap-animation.inspect`, `motion.timeline.layout-gap-animation.track.upsert`, `motion.timeline.layout-gap-animation.keyframe.upsert` | Persisted Core/Debug copy-on-write record after one trusted static layout.apply application. Sources: `skill/shellx-motion/references/layout-gap-animation.md`. | Browser, Native, GPU, FFmpeg, Cut, CLI, SDK, Action, provider, and Unreal refuse before resource or output work. |
| Procedural bindings | `motion.procedural.inspect`, `motion.procedural.relationship.set`, `motion.procedural.relationship.bake`, `motion.procedural.relationship.detach` | Data-only scalar relationship document; the checked package is structural source evidence, not proof of every mutation or lane. Sources: `fixtures/packages/procedural-relationships/motion.json`. | No JavaScript, callbacks, plugins, dynamic property lookup, file access, or network access; unbound recipes remain structural. |
| Scene3D animation | `motion.timeline.scene3d-animation.inspect`, `motion.timeline.scene3d-animation.track.upsert`, `motion.timeline.scene3d-animation.keyframe.upsert` | Persisted Debug/MCP authoring has one separate source-only direct renderer-browser GPU PNG lowerer. Sources: `fixtures/packages/gpu-scene3d-animation-preview/motion.json`. | Generic Debug/Action preview, CLI, local SDK, Browser HTML, Native, FFmpeg/final, provider, Cut, and Unreal refuse; no delivery claim follows. |
| Analytic particle field v1 | `motion.timeline.layer.create`, `motion.timeline.layer.rich.set`, `motion.timeline.particles.structural.inspect` | Ordinary particle data uses the shared typed layer/rich-control path and deterministic CPU analytic deflection. Sources: `skill/shellx-motion/references/particle-fields.md`. | No collision or velocity physics, persistent state, formula, callback, arbitrary GPU execution, or game-physics claim. |
| Fixed analytic particle field v2 | `motion.timeline.particles.structural.inspect`, `motion.timeline.particles.field.source.insert`, `motion.timeline.particles.emitter.origin.insert`, `motion.timeline.particles.field.collision.axis.update`, `motion.timeline.particles.emitter.trail.add`, `motion.timeline.particles.emitter.shading.add` | Closed 100,000..131,072-particle strict-GPU descriptor with typed sources, origins, analytic trail, and fixed shading; the tidal fixture is structural source evidence. Sources: `fixtures/packages/gpu-v020-tidal-reassembly/motion.json`, `fixtures/packages/gpu-v020-tidal-reassembly/manifest.json`. | No fallback to CPU, package WGSL, arbitrary compute, mesh or particle-particle collision, mutable simulation, retained physics, or game-physics claim. |

## Primary public layer-type discovery map

Each public `MotionLayerType` has one primary rendering-family pointer. This is not a complete mutation or tool index; use Action/Debug discovery for the exact operation contract.

| Motion layer type | Primary rendering family |
|---|---|
| `text` | `family.2d-geometry-text-keyframes@1` — 2D geometry, text, and keyframes |
| `shape` | `family.2d-geometry-text-keyframes@1` — 2D geometry, text, and keyframes |
| `image` | `family.keying-and-roto@1` — Keying and roto |
| `video` | `family.tracking-and-stabilization@1` — Tracking and stabilization |
| `caption` | `family.caption-import-and-delivery@1` — Caption import and delivery |
| `audio` | `family.audio-delivery@1` — Audio-layer final delivery |
| `web` | `family.html-css-and-canvas@1` — Bounded HTML/CSS import and host-gated Canvas packaging |
| `html` | `family.html-css-and-canvas@1` — Bounded HTML/CSS import and host-gated Canvas packaging |
| `canvas` | `family.html-css-and-canvas@1` — Bounded HTML/CSS import and host-gated Canvas packaging |
| `adjustment` | `family.governed-shader-and-hybrid-gpu-delivery@1` — Governed shader and hybrid GPU delivery |
| `camera` | `family.environments-and-depth@1` — Environments and depth-aware composition |
| `particles` | `family.points-particles-trails@1` — Points, particles, and trails |
| `points` | `family.points-particles-trails@1` — Points, particles, and trails |
| `shader` | `family.governed-shader-and-hybrid-gpu-delivery@1` — Governed shader and hybrid GPU delivery |
| `scene3d` | `family.fixed-scene3d-and-gltf@1` — Fixed 3D scenes and glTF import |
| `environment` | `family.environments-and-depth@1` — Environments and depth-aware composition |
| `group` | `family.cutout-rig-bake@1` — Cutout-rig bake |

## Registered public family samples

| Family | Checked source/render sample | Sample role | Capability-specific recipe evidence | Public limit |
|---|---|---|---|---|
| `family.2d-geometry-text-keyframes@1` | `sample.keyframed-lower-third.browser-preview@1` — `fixtures/packages/keyframed-lower-third` | canonical delivery sample | `fixtures/packages/keyframed-lower-third/motion.json` | These checked packages prove ordinary shape/text/keyframe authoring plus one bounded static F2a linear/radial-gradient rectangle final route. They do not prove all rich-layer or renderer-lane variants, gradients beyond the closed F2a contract, human visual acceptance, or host qualification. |
| `family.2d-geometry-text-keyframes@1` | `sample.linear-srgb-sdr-f2a-gradients.gpu-h264@1` — `fixtures/packages/linear-srgb-sdr-f2a-gradients` | supplemental family evidence | `fixtures/packages/linear-srgb-sdr-f2a-gradients/motion.json` | These checked packages prove ordinary shape/text/keyframe authoring plus one bounded static F2a linear/radial-gradient rectangle final route. They do not prove all rich-layer or renderer-lane variants, gradients beyond the closed F2a contract, human visual acceptance, or host qualification. |
| `family.path-reveals@1` | `sample.path-reveal-browser.family-evidence@1` — `fixtures/packages/path-reveal-browser` | supplemental family evidence | `fixtures/packages/path-reveal-browser/motion.json` | This checked browser source binds the public rich-set authority to a single-subpath serialized reveal contract and browser preview receipt shape; it does not claim a rich-set execution/revision receipt, native behavior, multi-subpath/reverse reveals, GPU host qualification, or rendered delivery. |
| `family.environments-and-depth@1` | `sample.environment-rain-cinematic.browser-preview@1` — `fixtures/packages/environment-rain-cinematic` | supplemental family evidence | `fixtures/packages/environment-rain-cinematic/motion.json` | These paired browser-preview samples prove a bounded rain environment/effect and a separate camera-backed multi-plane depth composition; they do not claim a single combined fixture, arbitrary 3D, native/GPU parity, or a rendered delivery. |
| `family.environments-and-depth@1` | `sample.rich-depth-promo.browser-preview@1` — `fixtures/packages/rich-depth-promo` | supplemental family evidence | `fixtures/packages/rich-depth-promo/motion.json` | These paired browser-preview samples prove a bounded rain environment/effect and a separate camera-backed multi-plane depth composition; they do not claim a single combined fixture, arbitrary 3D, native/GPU parity, or a rendered delivery. |
| `family.points-particles-trails@1` | `sample.gpu-points-preview@1` — `fixtures/packages/gpu-points-preview` | canonical delivery sample | `fixtures/packages/gpu-points-preview/motion.json` | These GPU-preview samples prove an ordered points layer plus a particles layer carrying the bounded static effects.trail record; they do not prove physics, persistent history, fixed-compute particles, or browser/native parity. |
| `family.points-particles-trails@1` | `sample.gpu-orbital-particle-trails-preview@1` — `fixtures/packages/gpu-g9-orbital-depth` | supplemental family evidence | `fixtures/packages/gpu-g9-orbital-depth/motion.json` | These GPU-preview samples prove an ordered points layer plus a particles layer carrying the bounded static effects.trail record; they do not prove physics, persistent history, fixed-compute particles, or browser/native parity. |
| `family.analytic-particle-field-compute@2` | `sample.tidal-reassembly.v2-particle-compute.gpu-preview@1` — `fixtures/packages/gpu-v020-tidal-reassembly` | supplemental family evidence | `fixtures/packages/gpu-v020-tidal-reassembly/motion.json` | This checked source fixture structurally binds one 100,000-particle particle-field@2 descriptor with weighted origins, four closed source kinds, analytic trail, fixed shading, and a strict GPU data-only manifest. It is bounded analytic compute, not game physics, arbitrary compute, retained physics, rendered delivery, or hardware/installed-host proof. |
| `family.procedural-bindings@1` | `sample.procedural-relationships.native-preview@1` — `fixtures/packages/procedural-relationships` | canonical delivery sample | `fixtures/packages/procedural-relationships/motion.json` | This package proves the bounded procedural relationship document and its native-preview receipt boundary; it does not imply arbitrary expressions or browser/GPU parity. |
| `family.compositing-graphs@1` | `sample.compositing-graph-parity.browser-preview@1` — `fixtures/packages/compositing-graph-parity` | supplemental family evidence | `fixtures/packages/compositing-graph-parity/motion.json` | These paired browser-preview fixtures pin one data-only source/matte/blend/output graph and its direct alpha-matte/screen/blur counterpart. They do not claim an executed pixel-parity result, arbitrary graph code/plugins, native/GPU parity, or a rendered delivery. |
| `family.compositing-graphs@1` | `sample.compositing-direct-parity.browser-preview@1` — `fixtures/packages/compositing-direct-parity` | supplemental family evidence | `fixtures/packages/compositing-direct-parity/motion.json` | These paired browser-preview fixtures pin one data-only source/matte/blend/output graph and its direct alpha-matte/screen/blur counterpart. They do not claim an executed pixel-parity result, arbitrary graph code/plugins, native/GPU parity, or a rendered delivery. |
| `family.governed-shader-and-hybrid-gpu-delivery@1` | `sample.tideglass.gpu-h264@1` — `fixtures/packages/gpu-v25b2-tideglass-almanac` | supplemental family evidence | `fixtures/packages/gpu-v25b2-tideglass-almanac/motion.json` | This strict GPU final sample pins one checked restricted-GLSL shader and adjustment-layer source package. It does not claim arbitrary shader code, general hybrid content, a GPU on the current host, or every authoring mutation that can target these layer types. |
| `family.keying-and-roto@1` | `sample.keyed-subject-promo.browser-preview@1` — `templates/shellx-product-pack/keyed-subject-promo` | supplemental family evidence | `templates/shellx-product-pack/keyed-subject-promo/motion.json` | The supplemental browser package pins bounded chroma key, spill suppression, and matte cleanup. Separately, the checked source workflow copies one public PNG, upserts a tracked roto mask, and detaches that attachment through copy-on-write revisions with package and host receipts. This does not claim segmentation, arbitrary media/keying controls, generic installed-host authority, or rendered delivery. |
| `family.tracking-and-stabilization@1` | `sample.tracked-callout-overlay.browser-preview@1` — `templates/shellx-product-pack/tracked-callout-overlay` | supplemental family evidence | `templates/shellx-product-pack/tracked-callout-overlay/motion.json` | The supplemental browser package pins an authored pre-baked tracked-callout path. Separately, the checked source workflow generates a bounded synthetic video and executes real request, inspect, apply, verify, and detach tracking lifecycle calls with receipts. This does not establish arbitrary footage quality, generic tracking models, installed-host authority, or rendered delivery. |
| `family.fixed-scene3d-and-gltf@1` | `sample.fixed-scene3d.browser-preview@1` — `fixtures/packages/fixed-scene3d` | supplemental family evidence | `fixtures/packages/fixed-scene3d/motion.json` | The supplemental source packages expose a fixed declarative Scene3D record plus a bounded lowered glTF mesh and package boundary. Separately, the checked triangle glTF CLI route creates a new package and adapter-lowering receipt after explicit write_local local authority. This does not claim generic glTF/GLB coverage, animation, materials outside the bounded importer subset, installed-host qualification, or rendered delivery. |
| `family.fixed-scene3d-and-gltf@1` | `sample.gltf-orbital-scene3d.gpu-preview@1` — `fixtures/packages/gpu-g9-orbital-depth` | supplemental family evidence | `fixtures/packages/gpu-g9-orbital-depth/motion.json` | The supplemental source packages expose a fixed declarative Scene3D record plus a bounded lowered glTF mesh and package boundary. Separately, the checked triangle glTF CLI route creates a new package and adapter-lowering receipt after explicit write_local local authority. This does not claim generic glTF/GLB coverage, animation, materials outside the bounded importer subset, installed-host qualification, or rendered delivery. |
| `family.fixed-scene3d-and-gltf@1` | `sample.gltf-orbital-package-boundary.gpu-preview@1` — `fixtures/packages/gpu-g9-orbital-depth` | supplemental family evidence | `fixtures/packages/gpu-g9-orbital-depth/manifest.json` | The supplemental source packages expose a fixed declarative Scene3D record plus a bounded lowered glTF mesh and package boundary. Separately, the checked triangle glTF CLI route creates a new package and adapter-lowering receipt after explicit write_local local authority. This does not claim generic glTF/GLB coverage, animation, materials outside the bounded importer subset, installed-host qualification, or rendered delivery. |
| `family.scene3d-animation-gpu-preview@1` | `sample.scene3d-animation.direct-gpu-preview@1` — `fixtures/packages/gpu-scene3d-animation-preview` | supplemental family evidence | `fixtures/packages/gpu-scene3d-animation-preview/motion.json` | This checked asset-free package binds persisted scene3dAnimation@1 source data to the direct renderer-browser strict GPU PNG preview and inline receipt shape only. It does not establish general glTF animation, browser/native parity, final media, installed qualification, or public-host qualification. |
| `family.html-css-and-canvas@1` | `sample.hyperframes-card.browser-preview@1` — `fixtures/packages/hyperframes-card` | supplemental family evidence | `fixtures/packages/hyperframes-card/motion.json` | The checked web package and separate workflows cover bounded HTML import plus a Linux-only host-authorized Canvas package path. They do not claim arbitrary executable Canvas, browser-native parity, Canvas availability on macOS or Windows, or a rendered delivery. |
| `family.lottie-and-dotlottie@1` | `sample.lottie-primitives-lowered.browser-preview@1` — `fixtures/packages/lottie-primitives-lowered` | supplemental family evidence | `fixtures/packages/lottie-primitives-lowered/manifest.json` | These paired checked lowered packages bind one static Lottie JSON input and one selected dotLottie archive to source/installed import forms, package outputs, and lowering/diagnostics receipt shapes; they do not qualify an installed build, complete format representation, executed state machines, or browser/native/GPU pixel parity. |
| `family.lottie-and-dotlottie@1` | `sample.dotlottie-primitives-lowered.browser-preview@1` — `fixtures/packages/dotlottie-primitives-lowered` | supplemental family evidence | `fixtures/packages/dotlottie-primitives-lowered/manifest.json` | These paired checked lowered packages bind one static Lottie JSON input and one selected dotLottie archive to source/installed import forms, package outputs, and lowering/diagnostics receipt shapes; they do not qualify an installed build, complete format representation, executed state machines, or browser/native/GPU pixel parity. |
| `family.templates-data-and-batch@1` | `sample.editable-lower-third.browser-jpeg@1` — `fixtures/packages/editable-lower-third` | canonical delivery sample | `fixtures/packages/editable-lower-third/template.json` | These paired samples prove a package template and package-local data rows rendered in batch; they do not claim every product-pack family or external data-import route. |
| `family.templates-data-and-batch@1` | `sample.batch-card.mixed-preset@1` — `fixtures/packages/batch-card` | canonical delivery sample | `fixtures/packages/batch-card/data/rows.json` | These paired samples prove a package template and package-local data rows rendered in batch; they do not claim every product-pack family or external data-import route. |
| `family.cutout-rig-bake@1` | `sample.second-take-cutout-pivot.gpu-preview@1` — `fixtures/packages/gpu-v25c-second-take` | supplemental family evidence | `fixtures/packages/gpu-v25c-second-take/motion.json` | The supplemental strict-GPU source package pins an image subject's explicit pixel pivot and bounded pose tracks. Separately, the checked source workflow copies one public PNG into a deliberately static source package, runs the bounded data-only rig bake, and verifies package plus host receipts. This is not segmentation, a live hierarchy, generic installed-host authority, or rendered delivery. |
| `family.transition-presets@1` | `sample.editable-lower-third.transitions.browser-preview@1` — `fixtures/packages/editable-lower-third` | supplemental family evidence | `fixtures/packages/editable-lower-third/motion.json` | The checked package pins ordinary serialized slide and wipe transitions only. It deliberately does not claim a selected preset, preset-apply copy-on-write revision or receipt, native/GPU parity, delivery, or installed qualification. |

## Registered workflow evidence

| Family | Checked workflow | Public input or source | Contract evidence | Public limit |
|---|---|---|---|---|
| `family.keying-and-roto@1` — Keying and roto | `pnpm run keying-roto-workflow:smoke` | `scripts/keying-roto-workflow-smoke.ts`, `fixtures/packages/gpu-material-admitted/assets/poster.png` | `motion.keying.apply`, `motion.keying.inspect`, `motion.roto.upsert`, `motion.roto.tracking.detach`, `keying.apply` receipt, `roto.upsert` receipt, `roto.tracking.detach` receipt | This source-only workflow copies one checked public PNG into .scratch/rendering-samples, proves bounded chroma-key and tracked-roto copy-on-write edits with package and host receipts, then removes only the tracking attachment. It is not generic media keying, segmentation, or installed-host proof. |
| `family.tracking-and-stabilization@1` — Tracking and stabilization | `pnpm run tracking:smoke` | `scripts/tracking-analysis-smoke.ts` | `motion.analysis.tracking.request`, `motion.analysis.tracking.inspect`, `motion.analysis.tracking.apply`, `motion.analysis.tracking.verify`, `motion.analysis.tracking.detach`, `analysis.tracking.request` receipt, `analysis.tracking.apply` receipt, `analysis.tracking.detach` receipt | This source-only workflow deterministically generates a tiny synthetic video in .scratch, then proves one point-translation tracking lifecycle through request, inspect, stabilization apply, verify, and detach. It does not qualify arbitrary footage, tracking models, installed hosts, or rendered delivery. |
| `family.fixed-scene3d-and-gltf@1` — Fixed 3D scenes and glTF import | `pnpm --filter @shellx-motion/cli run cli -- debug gltf-import --tier write_local --trusted-local-tier --source fixtures/imports/gltf-triangle/input.gltf --out .scratch/rendering-samples/gltf-triangle-import` | `fixtures/imports/gltf-triangle/input.gltf` | `motion.scene3d.gltf.import`, `adapter.lower` receipt | This is the real bounded glTF CLI import route for one checked triangle and requires host-approved local input/output roots plus explicit write_local authority. It does not claim generic glTF/GLB support, animation, renderer qualification, or installed-host proof. |
| `family.cutout-rig-bake@1` — Cutout-rig bake | `pnpm run cutout-rig-bake-workflow:smoke` | `scripts/cutout-rig-bake-workflow-smoke.ts`, `fixtures/packages/gpu-material-admitted/assets/poster.png` | `motion.timeline.cutout.rig.bake`, `timeline.cutout.rig.bake` receipt | This source-only workflow copies one checked public PNG into .scratch/rendering-samples, bakes one bounded data-only cutout rig into an ordinary Motion package, and verifies package plus host receipts. It is not segmentation, live rigging, or installed-host proof. |
| `family.audio-delivery@1` — Audio-layer final delivery | `pnpm run render-audio:smoke` | `scripts/render-audio-smoke.ts` | `motion.render.final`, `render.final` receipt | This source workflow creates its own bounded sine WAV under .scratch and verifies one H.264 MP4. It is a reproducible delivery contract, not a generic audio import, mix-authoring, or installed-host claim. |
| `family.caption-import-and-delivery@1` — Caption import and delivery | `pnpm run render-caption:smoke` | `scripts/render-caption-smoke.ts`, `fixtures/packages/keyframed-lower-third` | `motion.timeline.caption.import`, `motion.render.final`, `timeline.caption.import` receipt, `render.final` receipt | This source workflow creates a short SRT under .scratch, copies the checked lower-third package, and asserts import plus final-render evidence. It is not transcript generation, word timing, arbitrary caption styling, or installed-host proof. |
| `family.html-css-and-canvas@1` — Bounded HTML/CSS import and host-gated Canvas packaging | `pnpm --filter @shellx-motion/cli run cli -- html-snippet-import fixtures/imports/html-snippet/input.html --out .scratch/rendering-samples/html-snippet-import` | `fixtures/imports/html-snippet/input.html` | `motion.html.snippet.import`, `html.snippet.import` receipt | This imports one checked contained HTML/CSS document into a new package and expects the import receipt. It does not execute scripts, authorize external origins, prove a generic web layer, or qualify native/GPU rendering. |
| `family.html-css-and-canvas@1` — Bounded HTML/CSS import and host-gated Canvas packaging | `pnpm run canvas-package-preview:smoke` | `scripts/canvas-package-preview-smoke.ts`, `fixtures/canvas/frame-selection.json` | `motion.canvas.package`, `export.final` receipt | This is a Linux-only host-authorized source workflow with a checked Canvas frame-selection fixture; macOS and Windows refuse before output. It is not generic runnable Canvas behavior and agents cannot create the required host roots from a request. |


## Registered interchange source invocations

### `family.lottie-and-dotlottie@1` — Lottie and dotLottie import

Checked input: `fixtures/imports/lottie-primitives/input.json` (application/json). The checked lowered package is the binding sample; the import writes a new package, never into that fixture.

Source checkout:
```bash
pnpm --filter @shellx-motion/cli run cli -- debug lottie-import --tier write_local --trusted-local-tier --source fixtures/imports/lottie-primitives/input.json --out .scratch/rendering-samples/lottie-primitives-import
```

Installed package:
```bash
shellx-motion debug lottie-import --tier write_local --trusted-local-tier --source <input-file> --out .scratch/rendering-samples/lottie-primitives-import
```

Expected artifact: `.scratch/rendering-samples/lottie-primitives-import` (application/vnd.shellx.motion.package). Expected receipts: `adapter.lower` / inside-output-directory, `adapter.diagnostics` / inside-output-directory.

The explicit local write tier is an authorization requirement, not an installed-build qualification; read the lowering and diagnostics receipts before claiming representation or pixel output.

### `family.lottie-and-dotlottie@1` — Lottie and dotLottie import

Checked input: `fixtures/imports/dotlottie-primitives/input.lottie` (application/vnd.lottie). The checked lowered package is the binding sample; the import writes a new package, never into that fixture.

Source checkout:
```bash
pnpm --filter @shellx-motion/cli run cli -- debug dotlottie-import --tier write_local --trusted-local-tier --source fixtures/imports/dotlottie-primitives/input.lottie --out .scratch/rendering-samples/dotlottie-primitives-import
```

Installed package:
```bash
shellx-motion debug dotlottie-import --tier write_local --trusted-local-tier --source <input-file> --out .scratch/rendering-samples/dotlottie-primitives-import
```

Expected artifact: `.scratch/rendering-samples/dotlottie-primitives-import` (application/vnd.shellx.motion.package). Expected receipts: `adapter.lower` / inside-output-directory, `adapter.diagnostics` / inside-output-directory.

The explicit local write tier is an authorization requirement, not an installed-build qualification; read the lowering and diagnostics receipts before claiming representation or pixel output.


## Registered direct renderer source invocations

### `family.scene3d-animation-gpu-preview@1` — Scene3D animation strict GPU preview

Checked package: `fixtures/packages/gpu-scene3d-animation-preview`. This is a source-only package API route: there is no CLI, Debug/Action preview, or installed-command equivalent for this document shape.

Source API shape (not a shell command):
```ts
import { loadMotionPackage } from "@shellx-motion/core";
import { renderMotionGpuPreview } from "@shellx-motion/renderer-browser";

const pkg = await loadMotionPackage("fixtures/packages/gpu-scene3d-animation-preview");
const result = await renderMotionGpuPreview(pkg, { atMs: 500, outDir: ".scratch/rendering-samples/gpu-scene3d-animation-preview" });
if (!result.ok) throw new Error(result.error.message);
```

Checked source route: `packages/core/src/index.ts`, `packages/core/src/package.ts`, `packages/renderer-browser/src/index.ts`, `packages/renderer-browser/src/gpu-points-preview.ts`, `packages/renderer-browser/src/gpu-preview-output.ts`.

Expected artifact: `.scratch/rendering-samples/gpu-scene3d-animation-preview/pkg_gpu_scene3d_animation_preview-gpu-500.png` (image/png). Expected receipt: `preview.gpu.frame` / inline-return with `output.gpuScene3dAnimation.schema = shellx-motion/gpu-scene3d-animation-preview-receipt@1`.

Limitation: This source-only direct API sample binds a strict bounded GPU PNG preview and source/receipt evidence for persisted scene3dAnimation@1. It does not establish general glTF animation, browser/native parity, final media, installed qualification, or public-host qualification.


| Capability | Rendering route | Checked-in sample | Expected artifact | Expected receipt |
|---|---|---|---|---|
| `preview.native-png@1` | Native PNG preview | `fixtures/packages/procedural-relationships` | `.scratch/rendering-samples/preview-native/pkg_procedural_relationships-native-1000.png` (image/png) | `preview.frame` / beside-output |
| `preview.browser-png@1` | Browser PNG preview | `fixtures/packages/keyframed-lower-third` | `.scratch/rendering-samples/preview-browser/pkg_keyframed_lower_third-browser-750.png` (image/png) | `preview.frame` / beside-output |
| `preview.gpu-png@1` | Strict GPU PNG preview | `fixtures/packages/gpu-points-preview` | `.scratch/rendering-samples/preview-gpu/pkg_gpu_points_preview-gpu-500.png` (image/png) | `preview.frame` / beside-output |
| `render.native-png-still@1` | Native PNG still | `fixtures/packages/procedural-relationships` | `.scratch/rendering-samples/native-still.png` (image/png) | `render.final` / beside-output |
| `render.native-mp4-h264@1` | Native-frame H.264 MP4 | `fixtures/packages/procedural-relationships` | `.scratch/rendering-samples/native-h264.mp4` (video/mp4) | `render.final` / beside-output |
| `render.browser-mp4-h264@1` | Browser-frame H.264 MP4 | `fixtures/packages/keyframed-lower-third` | `.scratch/rendering-samples/browser-h264.mp4` (video/mp4) | `render.final` / beside-output |
| `render.browser-mp4-hevc@1` | Browser-frame HEVC MP4 | `fixtures/packages/keyframed-lower-third` | `.scratch/rendering-samples/browser-hevc.mp4` (video/mp4) | `render.final` / beside-output |
| `render.browser-webm-av1@1` | Browser-frame AV1 WebM | `fixtures/packages/keyframed-lower-third` | `.scratch/rendering-samples/browser-av1.webm` (video/webm) | `render.final` / beside-output |
| `render.browser-webm-vp9@1` | Browser-frame VP9 WebM | `fixtures/packages/keyframed-lower-third` | `.scratch/rendering-samples/browser-vp9.webm` (video/webm) | `render.final` / beside-output |
| `render.browser-webm-vp9-alpha@1` | Browser-frame VP9-alpha WebM | `fixtures/packages/keyframed-lower-third` | `.scratch/rendering-samples/browser-vp9-alpha.webm` (video/webm) | `render.final` / beside-output |
| `render.browser-gif@1` | Browser-frame GIF | `fixtures/packages/keyframed-lower-third` | `.scratch/rendering-samples/browser.gif` (image/gif) | `render.final` / beside-output |
| `render.browser-mov-prores@1` | Browser-frame ProRes 4444 MOV | `fixtures/packages/keyframed-lower-third` | `.scratch/rendering-samples/browser-prores.mov` (video/quicktime) | `render.final` / beside-output |
| `render.browser-png-sequence@1` | Browser-frame PNG sequence | `fixtures/packages/keyframed-lower-third` | `.scratch/rendering-samples/browser-sequence` (image/png) | `render.final` / inside-output-directory |
| `render.browser-png-frame@1` | Browser-frame PNG still | `fixtures/packages/keyframed-lower-third` | `.scratch/rendering-samples/browser-still.png` (image/png) | `render.final` / beside-output |
| `render.browser-jpeg-frame@1` | Browser-frame JPEG still | `fixtures/packages/editable-lower-third` | `.scratch/rendering-samples/browser-still.jpg` (image/jpeg) | `render.final` / beside-output |
| `render.gpu-mp4-h264@1` | Strict GPU H.264 MP4 | `fixtures/packages/linear-srgb-sdr-final` | `.scratch/rendering-samples/linear-srgb-sdr-final.mp4` (video/mp4) | `render.final` / beside-output |
| `render-batch.mixed-preset@1` | Mixed-preset batch render | `fixtures/packages/batch-card` | `.scratch/rendering-samples/batch` (application/x-shellx-motion-batch) | `render.batch` / inside-batch-output |

## Canonical invocations and limits

### `preview.native-png@1` — Native PNG preview

Source checkout:
```bash
pnpm --filter @shellx-motion/cli run cli -- preview fixtures/packages/procedural-relationships --lane native --at-ms 1000 --out .scratch/rendering-samples/preview-native
```

Installed package:
```bash
shellx-motion preview <package-root> --lane native --at-ms 1000 --out .scratch/rendering-samples/preview-native
```

Limitation: Native is a bounded renderer; it refuses unsupported visual features and never falls back to browser pixels.

### `preview.browser-png@1` — Browser PNG preview

Source checkout:
```bash
pnpm --filter @shellx-motion/cli run cli -- preview fixtures/packages/keyframed-lower-third --lane browser --at-ms 750 --out .scratch/rendering-samples/preview-browser
```

Installed package:
```bash
shellx-motion preview <package-root> --lane browser --at-ms 750 --out .scratch/rendering-samples/preview-browser
```

Limitation: Browser preview needs a discovered Chromium runtime and is not evidence of native or GPU pixel parity.

### `preview.gpu-png@1` — Strict GPU PNG preview

Source checkout:
```bash
pnpm --filter @shellx-motion/cli run cli -- preview fixtures/packages/gpu-points-preview --lane gpu --at-ms 500 --out .scratch/rendering-samples/preview-gpu
```

Installed package:
```bash
shellx-motion preview <package-root> --lane gpu --at-ms 500 --out .scratch/rendering-samples/preview-gpu
```

Limitation: GPU is strict and host-dependent: unsupported packages or unavailable WebGPU refuse rather than falling back.

### `render.native-png-still@1` — Native PNG still

Source checkout:
```bash
pnpm --filter @shellx-motion/cli run cli -- render fixtures/packages/procedural-relationships --lane native --at-ms 1000 --out .scratch/rendering-samples/native-still.png
```

Installed package:
```bash
shellx-motion render <package-root> --lane native --at-ms 1000 --out .scratch/rendering-samples/native-still.png
```

Limitation: render --lane native writes one PNG still, not a video and not an image sequence.

### `render.native-mp4-h264@1` — Native-frame H.264 MP4

Source checkout:
```bash
pnpm --filter @shellx-motion/cli run cli -- render fixtures/packages/procedural-relationships --lane ffmpeg --frame-lane native --preset mp4-h264 --out .scratch/rendering-samples/native-h264.mp4
```

Installed package:
```bash
shellx-motion render <package-root> --lane ffmpeg --frame-lane native --preset mp4-h264 --out .scratch/rendering-samples/native-h264.mp4
```

Limitation: This route needs FFmpeg and a package admitted by native; it does not use Chromium.

### `render.browser-mp4-h264@1` — Browser-frame H.264 MP4

Source checkout:
```bash
pnpm --filter @shellx-motion/cli run cli -- render fixtures/packages/keyframed-lower-third --lane ffmpeg --frame-lane browser --preset mp4-h264 --out .scratch/rendering-samples/browser-h264.mp4
```

Installed package:
```bash
shellx-motion render <package-root> --lane ffmpeg --frame-lane browser --preset mp4-h264 --out .scratch/rendering-samples/browser-h264.mp4
```

Limitation: The browser frame lane and an FFmpeg H.264 encoder must both be available; delivery receipts, not this fixture, prove a host render.

### `render.browser-mp4-hevc@1` — Browser-frame HEVC MP4

Source checkout:
```bash
pnpm --filter @shellx-motion/cli run cli -- render fixtures/packages/keyframed-lower-third --lane ffmpeg --frame-lane browser --preset mp4-hevc --out .scratch/rendering-samples/browser-hevc.mp4
```

Installed package:
```bash
shellx-motion render <package-root> --lane ffmpeg --frame-lane browser --preset mp4-hevc --out .scratch/rendering-samples/browser-hevc.mp4
```

Limitation: HEVC is conditional on the local FFmpeg encoder probe; unsupported hosts refuse the preset rather than relabeling H.264.

### `render.browser-webm-av1@1` — Browser-frame AV1 WebM

Source checkout:
```bash
pnpm --filter @shellx-motion/cli run cli -- render fixtures/packages/keyframed-lower-third --lane ffmpeg --frame-lane browser --preset webm-av1 --out .scratch/rendering-samples/browser-av1.webm
```

Installed package:
```bash
shellx-motion render <package-root> --lane ffmpeg --frame-lane browser --preset webm-av1 --out .scratch/rendering-samples/browser-av1.webm
```

Limitation: AV1 is conditional on the local FFmpeg encoder probe and its software or hardware availability.

### `render.browser-webm-vp9@1` — Browser-frame VP9 WebM

Source checkout:
```bash
pnpm --filter @shellx-motion/cli run cli -- render fixtures/packages/keyframed-lower-third --lane ffmpeg --frame-lane browser --preset webm-vp9 --out .scratch/rendering-samples/browser-vp9.webm
```

Installed package:
```bash
shellx-motion render <package-root> --lane ffmpeg --frame-lane browser --preset webm-vp9 --out .scratch/rendering-samples/browser-vp9.webm
```

Limitation: VP9 delivery needs Chromium for frames and a locally supported FFmpeg VP9 encoder.

### `render.browser-webm-vp9-alpha@1` — Browser-frame VP9-alpha WebM

Source checkout:
```bash
pnpm --filter @shellx-motion/cli run cli -- render fixtures/packages/keyframed-lower-third --lane ffmpeg --frame-lane browser --preset webm-vp9-alpha --out .scratch/rendering-samples/browser-vp9-alpha.webm
```

Installed package:
```bash
shellx-motion render <package-root> --lane ffmpeg --frame-lane browser --preset webm-vp9-alpha --out .scratch/rendering-samples/browser-vp9-alpha.webm
```

Limitation: This opaque fixture proves the VP9-alpha route shape only; use a separately qualified transparent package to claim surviving alpha pixels.

### `render.browser-gif@1` — Browser-frame GIF

Source checkout:
```bash
pnpm --filter @shellx-motion/cli run cli -- render fixtures/packages/keyframed-lower-third --lane ffmpeg --frame-lane browser --preset gif --out .scratch/rendering-samples/browser.gif
```

Installed package:
```bash
shellx-motion render <package-root> --lane ffmpeg --frame-lane browser --preset gif --out .scratch/rendering-samples/browser.gif
```

Limitation: GIF has no delivered audio and uses the bounded generated palette route rather than a video container.

### `render.browser-mov-prores@1` — Browser-frame ProRes 4444 MOV

Source checkout:
```bash
pnpm --filter @shellx-motion/cli run cli -- render fixtures/packages/keyframed-lower-third --lane ffmpeg --frame-lane browser --preset mov-prores --out .scratch/rendering-samples/browser-prores.mov
```

Installed package:
```bash
shellx-motion render <package-root> --lane ffmpeg --frame-lane browser --preset mov-prores --out .scratch/rendering-samples/browser-prores.mov
```

Limitation: This opaque fixture proves the ProRes route shape only; transparent-pixel delivery needs its own qualified package and receipt.

### `render.browser-png-sequence@1` — Browser-frame PNG sequence

Source checkout:
```bash
pnpm --filter @shellx-motion/cli run cli -- render fixtures/packages/keyframed-lower-third --lane ffmpeg --frame-lane browser --preset png-sequence --out .scratch/rendering-samples/browser-sequence
```

Installed package:
```bash
shellx-motion render <package-root> --lane ffmpeg --frame-lane browser --preset png-sequence --out .scratch/rendering-samples/browser-sequence
```

Limitation: PNG sequence delivery materializes a frame directory; it is not a streamed final-video output.

### `render.browser-png-frame@1` — Browser-frame PNG still

Source checkout:
```bash
pnpm --filter @shellx-motion/cli run cli -- render fixtures/packages/keyframed-lower-third --lane ffmpeg --frame-lane browser --preset png-frame --at-ms 750 --out .scratch/rendering-samples/browser-still.png
```

Installed package:
```bash
shellx-motion render <package-root> --lane ffmpeg --frame-lane browser --preset png-frame --at-ms 750 --out .scratch/rendering-samples/browser-still.png
```

Limitation: A PNG-frame render is one browser-rasterized still; it does not claim video encoding or muxing.

### `render.browser-jpeg-frame@1` — Browser-frame JPEG still

Source checkout:
```bash
pnpm --filter @shellx-motion/cli run cli -- render fixtures/packages/editable-lower-third --lane ffmpeg --frame-lane browser --preset jpeg-frame --at-ms 750 --out .scratch/rendering-samples/browser-still.jpg
```

Installed package:
```bash
shellx-motion render <package-root> --lane ffmpeg --frame-lane browser --preset jpeg-frame --at-ms 750 --out .scratch/rendering-samples/browser-still.jpg
```

Limitation: JPEG delivery has no alpha channel and is a still output, not a final-video route.

### `render.gpu-mp4-h264@1` — Strict GPU H.264 MP4

Source checkout:
```bash
pnpm --filter @shellx-motion/cli run cli -- render fixtures/packages/linear-srgb-sdr-final --lane ffmpeg --frame-lane gpu --preset mp4-h264 --out .scratch/rendering-samples/linear-srgb-sdr-final.mp4
```

Installed package:
```bash
shellx-motion render <package-root> --lane ffmpeg --frame-lane gpu --preset mp4-h264 --out .scratch/rendering-samples/linear-srgb-sdr-final.mp4
```

Limitation: The exact linear-srgb-sdr@1 route accepts a static opaque background plus bounded flat or F2a linear/radial-gradient rectangles; this checked sample covers only flat rectangles. Gradients require 2–16 canonical opaque stops, static angle/centre, and linear-light interpolation. It requires admitted WebGPU, zscale, libx264, FFprobe validation, and decoded-frame comparison; all other strict content and fallback lanes refuse.

### `render-batch.mixed-preset@1` — Mixed-preset batch render

Source checkout:
```bash
pnpm --filter @shellx-motion/cli run cli -- render-batch fixtures/packages/batch-card --out .scratch/rendering-samples/batch
```

Installed package:
```bash
shellx-motion render-batch <package-root> --out .scratch/rendering-samples/batch
```

Limitation: Batch rows are package-local, output once per row, and must be checked through each row receipt rather than a guessed aggregate success.
