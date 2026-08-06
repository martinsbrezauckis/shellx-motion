---
name: shellx-motion
description: Author, inspect, composite, track, stabilize, keyframe, preview, render, and connect local ShellX Motion packages through bounded CLI/debug contracts. Use for typed compositing graphs, bounded glTF/GLB import, Motion package edits, tracking, rich effects, local rendering, receipts, Design Studio handoff, or Cut linked-Motion workflows.
---

# ShellX Motion agent skill

Use this skill for local ShellX Motion package work and Motion-owned rendering called from Design Studio or Cut.

## Operating contract

1. Inspect before editing: validate the package, read `motion.state`, and query action discovery.
2. Use typed debug commands. Do not hand-edit package JSON when a command owns the operation.
3. Treat rich controls as allow-listed scalar properties, never as generic JSON paths.
4. Preview the affected timestamp after mutation and read the returned receipt.
5. Keep Design Studio as the precision authoring host and Cut as the editorial/link-lifecycle host.
6. Keep all execution local. Never infer permission for remote publish or hosted rendering.
7. Invoke as `shellx-motion <cmd>`, or `pnpm --filter @shellx-motion/cli run cli -- <cmd>` in a source
   checkout. No `motion` binary; dotted ids are MCP, not shell; a new package needs `write_local`,
   which outranks `edit_motion`. [All three](references/invocation-and-permissions.md).

## Cold-start recipe

When configured as MCP, Motion's bridge reads the private key and live port per call; never put a token in agent config. If stopped, run `pnpm start` (or the Workbench launcher) and retry; remote publishing stays off.

```bash
# Installed form. In a source checkout: pnpm --filter @shellx-motion/cli run cli -- <cmd>
shellx-motion validate /path/to/package
shellx-motion actions find "change snow intensity"
shellx-motion actions guide motion.timeline.layer.rich.set
shellx-motion debug state --package /path/to/package
```

For an edit, write to an explicit output package and use the required trusted local tier:

```bash
shellx-motion debug layer-rich-set \
  --tier edit_motion --trusted-local-tier \
  --package /path/to/package --out /path/to/revision \
  --layer snowfall-stage --path environment.fall.intensity --value 0.81 \
  --created-by local-agent

shellx-motion debug preview-frame \
  --tier render_motion --trusted-local-tier \
  --package /path/to/revision --at-ms 2400 --out /path/to/previews
```

Use `--value-json` only for typed JSON syntax; rich controls still accept only declared scalar controls and construct-specific bounds.

## Surface facts that trap agents

Each of these is verified current behaviour, not a caveat. Read them before scripting.

1. **`--lane` means different things in `preview` and `render`.** `preview --lane` takes
   `native|browser`; `render --lane` takes `native|ffmpeg`, while its browser choice is
   `--frame-lane browser|native`. Invalid cross-use fails with `unsupported_lane`; `render --lane
   native` writes one PNG still, not video. `motion.render.final` accepts `frameLane: "browser"` only.
2. **There is no `motion.screenshot`.** It was removed because Motion is a headless engine with no
   panel of its own: the command could only relay a request to a host and report `ok: true` for
   something it could not verify. Use `debug preview-frame` / `motion.preview.frame` for a real PNG
   plus receipt.
3. **`validate` emits no receipt.** It returns identity, layer count, hosts, and lanes in the JSON
   envelope and creates no `receipts/` directory. Do not look for one, and do not report a validate
   receipt id.
4. **`render` / `motion.render.final` return the receipt inline AND write it to disk** when a
   receipts root is known (`--receipts-root`, or `receiptsRoot` on the Debug API). `preview` and
   `capture-browser` write theirs beside the frame in `--out`; `template apply`, `template
   media-replace` and `render-batch` write into the output package's `receipts/`.
5. **Renders block, but the job IS observable from another process** — name it with `--job-id` and
   poll `motion.job.get` (see "Watching work you started"). Not live: `motion.render.status` /
   `.queue` summarize receipt files and cannot see work in flight. `motion.render.cancel` writes a
   `render.cancel` receipt and touches no process; `motion.render.retry` writes a `not_run` record
   nothing consumes. Re-run by invoking the render again; never say those two stopped anything.
6. **Depth compositions reject non-`normal` blend modes and all mattes.** Giving one layer `depth`
   makes it mandatory on every generated visual layer, requires a `camera`, bounds it to -0.9…3, and
   refuses any `blendMode` but `normal` (`depth planes do not yet support layer blend modes`). Build
   a lighten/screen glow as a `layer.gradient` under `normal`, or keep it out of the depth stack;
   `adjustment` layers are exempt and stay screen-space.
7. **A long 1080p browser render can hit a per-job 6 GiB memory ceiling and die without JSON.** The governor
   aborts with `job_rss_limit_exceeded`; through the CLI that is a non-zero exit and stack trace. Peak grows with FRAME COUNT and
   `effects.motionBlur.samples` multiplies it — measured, 450 frames at 1080p30 with two environment
   layers and 3-sample blur peaked at 5.07 GiB of 6. Budget the piece before authoring it.
8. **MCP supports two protocol eras.** Modern `2026-07-28` clients call `server/discover` without initialize;
   legacy `2025-06-18` clients retain initialize/list/call. Trust the schemas in either mode; the server grant remains the ceiling.
9. **Discovery reports the shared cached update status.** Startup, periodic, About-page, and agent
   checks use one result; read `updateAvailable`, `latestVersion`, and `checkedAt` instead of making a separate network request.

## Environment authoring

Create rain, water, snow, or fog as a bounded `type: "environment"` layer through
`debug layer-create --layer-json`. Then use `debug layer-rich-set` for declared parameters and
`debug keyframe-upsert` for animation. Use `debug keyframe-distribute` to evenly space three or more
keyframes in one receipt-backed edit. Seeds, quality, and timebase must remain explicit so preview
and final rendering converge.

For editable 2D position paths, use `debug spatial-position-upsert`, `-move`, and `-delete` rather
than issuing separate X/Y edits. One spatial edit owns the aligned `transform.x` and `transform.y`
point, one receipt, and one undo boundary. Temporal `easing` controls progress along a segment;
`linear`, `smooth`, `broken`, or `auto` spatial handles control its geometry and remain independent.

For reusable compositing branches, use `motion.compositing.graph.inspect`, `set`, and `remove` (CLI
aliases `compositing-graph-inspect`, `-set`, and `-remove`). The graph is versioned data, not code.
Allowed nodes are source, transform, mask, matte, blend, color, blur, and output; edges use typed
ports. Set validates identifiers, node fields, cycles, occupied inputs, disconnected branches,
matte constraints, depth, pixel work, and working memory before creating the output package. It
keeps the editable source layers as hidden round-trip data and records a deterministic fingerprint.
Inspect that fingerprint and compile metadata, then preview before handoff. Remove restores source
visibility and removes generated output. Never add expressions, callbacks, plugin names, URLs,
dynamic imports, commands, or package-selected binaries to a graph.

For deterministic property relationships, inspect first with `motion.procedural.inspect` or CLI
`procedural-inspect`. Relationships are typed scalar node graphs with stable layer/property refs;
they are not JavaScript or After Effects expressions. Author through `procedural-set`, toggle with
`procedural-enabled-set`, convert selected links to ordinary keyframes with `procedural-bake`, and
remove without baking through `procedural-detach`. Every mutation writes one copy-on-write package
and receipt, so Design Studio can map it to one undo entry. Bake only enabled relationships, inspect its
sample/keyframe/fingerprint evidence, then review the keyframe panel and preview. Never place code,
callbacks, globals, file/network access, plugin references, or dynamic property lookup in a node.

`kind` is `rain|water|snow|fog`, `quality` is `preview|balanced|cinematic` (there is no
`"standard"`), `mode` is `scene|overlay`, every colour is `#RRGGBB` with no alpha, and a document
holds at most four environment layers — `validate` refuses anything else before you render. Footage
binding (`sceneSourceLayerId`), effect masks, the bounded fog record, and those closed sets in full:
[references/environments-depth-and-budget.md](references/environments-depth-and-budget.md).

Do not add JavaScript, expressions, external shader URLs, commands, or network sources to a layer.
Restricted shaders reference validated package-local assets; fixed 3D scenes remain data-only.

## glTF and GLB scene import

Use `debug gltf-import` for a local `.gltf` or `.glb`; never embed a model by patching scene JSON.
The importer preserves the source, accepts only glTF 2.0 static triangles with embedded/GLB buffers,
and denies external buffers, network access, extensions, animation, skins, textures, and non-uniform
scale. Read the lowering warnings, preview actual mesh pixels, and inspect `scenes3d` receipt evidence.
Design Studio may reopen and edit the resulting ordinary Motion package. Cut must receive its rendered-media
handoff; it does not claim native editable 3D. Trusted programmatic hosts use SDK `gltfImport` with
host-configured `authoringInputRoots` and `authoringOutputRoots`, never roots supplied by agent input.

## Lottie and dotLottie import

`motion.lottie.import` ingests a Lottie JSON file; `motion.dotlottie.import` ingests a `.lottie`
container. CLI: `debug lottie-import` / `debug dotlottie-import` with `--source` and `--out`. Both
need `write_local` and host-approved input and output roots, exactly like
`motion.scene3d.gltf.import`.

- A `.lottie` container may declare several animations and several themes. `--animation` /
  `--theme` (`animationId` / `themeId`) select one; omit them to take the container's declared
  defaults.
- Every import writes a **lowering receipt** and an **adapter-diagnostics receipt** into the
  package it creates. Read them: they record what was flattened, what blend/gradient/theme rules
  applied, and what was explicitly unsupported. An import that succeeded is not the same as an
  import that represented everything.
- dotLottie state machines are **preserved, never executed**. Do not promise interactive
  behaviour from an imported container.
- Do not hand-author a Motion package and claim it is a Lottie lowering. The lowering rules exist
  only inside that library; reproducing them by hand produces an unattested package with no
  lossiness receipt.

## `transform.originX` / `originY` are PIXELS, not fractions

The rotation and scale pivot, measured in **pixels from the layer's top-left** — not 0..1.

```jsonc
// A 108x108 sprite that should spin about its own centre:
"transform": { "x": 500, "y": 300, "originX": 54, "originY": 54, "rotation": 90 }
```

Writing `originX: 0.5` sets the pivot half a pixel from the corner, so the layer rotates about its
top-left and **visibly slides away from where you placed it** — by roughly its own size at 180°.
The symptom is direction-dependent, which makes it easy to misread as a positioning bug.

Layers are positioned by **top-left**, so to centre a `w x h` layer on a point, set
`x = cx - w/2`, `y = cy - h/2`, `originX = w/2`, `originY = h/2`.

## Gradients: use `layer.gradient`, not stacked shapes

Any shape layer takes a gradient. **Reach for this before building an SVG asset or stacking
translucent ellipses** — stacked flat fills band visibly, because shape fills are flat by design.

```jsonc
{ "id": "glow", "type": "shape", "shape": "ellipse",
  "startMs": 0, "durationMs": 4000,
  "transform": { "x": 300, "y": 200, "width": 800, "height": 800 },
  "gradient": {
    "type": "radial", "centerX": 0.5, "centerY": 0.5,
    "stops": [ { "offset": 0,   "color": "#3f7fe0" },
               { "offset": 0.6, "color": "#16306a" },
               { "offset": 1,   "color": "#080b14" } ] } }
```

- `type` is `radial` or `linear`. Linear takes `angle` (degrees, clockwise from "to top");
  radial takes `centerX` / `centerY` in 0..1.
- 2–16 stops, each `offset` in 0..1.
- Works on every shape kind: rect, rounded-rect, ellipse, triangle, star, freeform path.
- `gradient.angle` is keyframable, so a linear gradient can sweep.
- This is how you build a glow, a vignette, a soft light or a sky wash. A flat-filled ellipse at
  low opacity renders as a **grey disc**, not as light.

## Bounded HTML/CSS interchange

For ShellX/HyperFrames-style HTML interchange, use `html-snippet-import` or
`motion.html.snippet.import`; never render the input page as authority for editable content. The
bounded importer reads declared layer metadata and a small inline CSS subset without executing
scripts, handlers, stylesheets, or arbitrary transforms. Image/video `src` values must be supported
package-relative paths beside the source HTML. Imported assets are copied into the new package,
hashed in the receipt, bounded by per-file/total limits, and checked against traversal, symlink
escape, and executable/external SVG syntax. Read every discarded-feature finding before handoff.

HTML export likewise records Motion keyframes, effects, gradients, masks, media timing, and other
features it cannot preserve instead of presenting a flattened page as lossless interchange.

## Tracking and stabilization

Use `motion.analysis.tracking.request`, `inspect`, `apply`, `verify`, and `detach`; do not construct
tracking JSON or generated transform keyframes by hand. Request accepts only a manifest-declared
package-local video asset, runs FFprobe/FFmpeg in the contained `analysis` lane, and writes a copied
package with `analysis/tracking/<analysisId>.lifecycle.json`. Failed and cancelled retries preserve
`lastGood`; inspect source identity before applying it.

Point tracking uses translation. Planar tracking uses similarity or bounded homography; homography
stabilization is explicitly approximated as position, uniform scale, and rotation around the
reference bounds. Apply requires an explicit `segmentIndex` for partial results and keeps lost or
low-confidence gaps visible. Do not include low-confidence samples unless the user deliberately
chooses that tradeoff. Verify source bytes and generated keyframes before preview, render, or Cut
handoff. Detach restores the exact prior x/y/scale/rotation keyframes.

Design Studio owns visual point/bounds selection and later curve refinement. Cut receives linked rendered
media when stabilization uses scale, rotation, homography approximation, mixed easing, or any other
math Cut has not fixture-proven as receiver-exact. Read the exact CLI calls in
[references/cli.md](references/cli.md).

## Media-rich template authoring

Start from `motion.template.plan`, not a guessed package path — it returns the `authoringLoop`
sequence, declared media slots, and quality targets for that family. Only 5 of the 12 pack families
declare `metadata.mediaSlots` / `story.beats`; plan the other seven from `motion.template.controls`.
No family ships a rendered MP4 as proof — render and read the receipt yourself, and never lower a
failed quality gate to make a render pass.

Full detail, including the five rich families and Cut's Generate-catalog exceptions:
[references/media-rich-templates.md](references/media-rich-templates.md).

## Connector ownership

- Design Studio authors and keyframes Motion controls through its path-free Motion session API.
- Design Studio presents procedural source/target labels, enable/disable, bake, and detach; it never asks
  users or agents to author JavaScript expressions.
- Motion validates, previews, renders, records receipts, and maps supported connector output.
- Cut-native editable lowering is receiver-exact: basic text/shapes may carry uniform opacity and
  `transform.x`/`transform.y` tracks. Motion normalizes positions through the Cut plan and routes
  mixed easing, transform scale/rotation, or other non-equivalent animation to rendered media.
- Cut edits, refreshes, relinks, rolls back, or detaches a linked Motion clip. It must not pretend
  to natively edit shaders, particles, 3D, environments, Motion blur, or non-equivalent film math.
- Unsupported native Cut constructs use an explicit rendered-media fallback with a reason.

## Starting from nothing

Every other authoring command edits a package that already exists. To make one:
`shellx-motion package-create ./my-piece --name "My Piece" --duration-ms 5000`, or `motion.package.create`
over MCP — which needs **`write_local`, NOT `edit_motion`**: `write_local` is the higher grant
(`… < edit_motion < write_local < push_remote`), so `edit_motion` cannot create a package. Ask for it;
never hand-write one instead. Then `motion.package.validate` to check it **without rendering**.
The new package validates and renders as-is with one visible layer — an empty document renders a
blank frame you cannot tell from a failure. Creating into a non-empty directory is refused, not
merged. Do NOT start an original piece with the importers (glTF, Lottie, HTML snippet); those bring
in existing assets.

## Check the machine can render, before you author

One call answers it: `motion.platform.requirements` (CLI `doctor`). Read `satisfied` as "runs the
way you are about to invoke it" and `possible` as "runs at all"; when they differ, `alternative`
names the flag. Full response shape, statuses and the traps:
[references/platform-readiness.md](references/platform-readiness.md).

## Watching work you started

A render blocks until it finishes. To report progress, **name the job when you start it** and ask
about it from anywhere:

```bash
shellx-motion render ./pkg --out out.mp4 --job-id my:render-1 --caller-id my-host:main
shellx-motion job get my:render-1 --caller-id my-host:main   # from any other process, while it runs
```

Over MCP: `motion.job.get` / `motion.job.list`, with `jobId` passed to `motion.render.final`.

- **You choose the id** — that is how you hold the handle before the work starts. Omit it and Motion
  mints one, returned as `jobId` on the result: enough to look up afterwards, useless for live progress.
- **`--caller-id` must match** between render and query. Visibility is per-owner, so a mismatch
  correctly answers `job_not_visible`. One stable value per workspace, never a pid.
- **`motion.render.status`/`.queue` cannot see running work** — they read receipt files, written when
  an operation finishes. Use `motion.job.*` for anything live.

**`pending` means waiting for a machine slot — say "waiting", not "rendering".** `startedAtMs` is
absent for exactly that period; once ended, `queueWaitMs` says how much was queueing.

Switch on `job.state` (`pending` · `running` · `succeeded` · `failed` · `cancelled` · `skipped`),
stop polling when `pollAfterMs` is absent, and never treat a query error (`job_unknown`,
`job_expired`, `job_not_visible`) as a failed render — they describe the lookup, not the job.

## Source-of-truth references

- Read [references/cli.md](references/cli.md) for exact calls, layer examples, verification, and
  failure rules.
- Read [environments, depth cameras and the render budget](references/environments-depth-and-budget.md)
  before authoring an environment, a depth camera, or anything longer than a few seconds at 1080p:
  the closed value sets, the exact camera-parallax arithmetic, and the measured memory ceiling.
- Read [implemented features](../../docs/public/FEATURES.md) before promising a capability or native host
  editability.
- Building or updating a HOST integration (Cut, Design Studio, anything driving Motion)? Read
  [host-integration.md](../../docs/public/host-integration.md) — it states what changed on Motion's
  side and what the host has to change on its own, and ends with a checklist. For the job/progress
  surface specifically, [cut-job-integration-spec.md](../../docs/public/cut-job-integration-spec.md)
  is the precise implementation spec.
- Read [JOB_STATUS.md](../../docs/public/JOB_STATUS.md) before acting on the state of work you asked
  for. It defines every state, what you should do in it, which fields it guarantees, and which
  neighbouring state it is confusable with. Two rules carry most of the weight: **switch on
  `outcome`, never on whether an artifact path is present** — a failed encode can leave a
  truncated file — and **never auto-retry a `cancelled` job**, which is why `cancelled` never
  carries an `error` and `failed` always does.
- Read the [Debug API operator guide](../../docs/public/DEBUG_API.md) for server authentication,
  transports, and discovery. The complete command/tier/mutation index is generated at
  [DEBUG_API_COMMANDS.md](../../docs/public/DEBUG_API_COMMANDS.md) from `schemas/debug.json`.
- Treat `schemas/actions.json`, `schemas/debug.json`, `schemas/motion.schema.json`, and the host
  connector schemas as the machine contracts. If prose and a schema differ, stop and repair the
  drift before mutation or handoff.
