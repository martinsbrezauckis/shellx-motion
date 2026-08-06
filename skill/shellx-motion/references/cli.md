# ShellX Motion agent reference

**Invoking.** `shellx-motion <cmd>` (installed build) / `pnpm --filter @shellx-motion/cli run cli --
<cmd>` (source checkout). No `motion` binary; dotted ids are MCP — [detail](invocation-and-permissions.md).

## Discover first

```bash
shellx-motion actions find "<user request>"
shellx-motion actions guide <exact-action-id>
shellx-motion actions plan "<user request>"
shellx-motion debug actions-panel
```

Exact action IDs are matched exactly. An unknown `motion.*` ID returns no action; it must never
fall through to a vaguely related workflow. Natural-language discovery requires meaningful phrase
overlap instead of one shared word.

## Inspect and render

```bash
shellx-motion validate /path/to/package
shellx-motion inspect /path/to/package
shellx-motion debug state --package /path/to/package
shellx-motion debug timeline-inspect --package /path/to/package
shellx-motion debug preview-frame --tier render_motion --trusted-local-tier \
  --package /path/to/package --at-ms 1500 --out /path/to/previews
shellx-motion render /path/to/package --out /path/to/output.mp4
```

Lane options are not interchangeable between commands:

```bash
shellx-motion preview /path/to/package --lane native|browser  --out /path/to/previews
shellx-motion render  /path/to/package --lane ffmpeg --frame-lane browser|native \
  --out /path/to/output.mp4
shellx-motion render  /path/to/package --lane native --at-ms 1500 --out /path/to/still.png
```

`preview --lane` selects the frame renderer (`native` default). `render --lane` selects the output
stage (`ffmpeg` default); its frame renderer is `--frame-lane` (`browser` default).
`preview --lane ffmpeg` and `render --lane browser` are rejected as `unsupported_lane`.
`render --lane native` writes a single PNG still, not a video. The debug command
`motion.render.final` accepts `frameLane: "browser"` only.

Never claim success from a command envelope alone. Confirm package and motion identity, validation,
output hash, and render/preview timestamp. Confirm the receipt too — but know where it is:
`validate` produces none; CLI `render` returns the receipt inline and always writes the same receipt
beside the delivered file (or inside an image-sequence output directory). The Debug API
`motion.render.final` returns the receipt inline and writes it under `receiptsRoot` when the caller
or server supplies one. Read the returned `receiptPath` instead of guessing. `preview` writes
`<packageId>-<lane>-preview.receipt.json` into `--out`; package-writing commands
(`template apply`, `template media-replace`, `render-batch`) write
into the output package's `receipts/`. `debug screenshot` was REMOVED — it could only relay a request to a host and report success for
something it could not verify. Use `debug preview-frame` for a real PNG plus receipt.

## Output ownership: what Motion will and will not overwrite

Motion refuses to destroy a path a caller named. Every command that writes a deliverable checks
first, deletes nothing on the refusal path, and returns a typed code you can act on:

| Target | Rule | Refusal code |
|---|---|---|
| `--out <dir>` (`png-sequence`, `template apply`, `template media-replace`, `preview`) | must be empty or absent | `output_dir_not_empty` |
| `--out <file>` (encoded video/GIF: `mp4-h264`, `webm-vp9`, …) | must not exist | `output_path_exists` |
| CLI `--frames-dir <root>` (encoder scratch; frames land in `<root>/<packageId>`, not in `<root>`) | that subdirectory must be empty, absent, or hold only Motion's own PNG frames | `output_dir_not_empty` |
| Debug API / MCP `motion.render.final` `framesDir` (the exact frame directory — **no** `<packageId>` suffix is appended) | must be empty or absent; Motion's own leftover frames do **not** pass here, and there is no `force` on this path | `invalid_args` |
| connector `--out` (`package/`, `render/`, `preview/`, `receipts/`, `artifacts/`, `frames/`, the Cut plan and run receipt) | each must be empty or absent | `output_dir_not_empty`, `output_path_exists` |

`--force` is the single opt-in that restores overwriting, and it reaches every one of those checks.
Two deliberate exceptions: Motion's DEFAULT frame scratch (`.scratch/frames`, used when no
`--frames-dir` is given) is wiped without asking because no caller named it, and a DIRECTORY sitting
at a file `--out` is refused even with `--force` — Motion never recursive-deletes a directory to
write a file. Re-rendering into the same **CLI** `--frames-dir` needs no flag: a directory holding
only Motion's own frames is provably Motion's to replace.

That allowance does not exist on the Debug API: `motion.render.final` tests its `framesDir` for
emptiness alone. Any entry refuses it — hidden ones (`.DS_Store`, `Thumbs.db`, `desktop.ini`)
included, and the frames Motion itself just wrote. A render killed part-way by the memory ceiling,
a deadline or Ctrl-C therefore makes **every retry at the same `framesDir` fail with
`invalid_args`** until you delete it or name a fresh path; omitting `framesDir` is the reliable
retry. A relative `framesDir` there resolves against the **server's** cwd — pass an absolute path.

## Plan and review a media-rich template

```bash
shellx-motion debug template-plan \
  --template-root /path/to/templates \
  --request "cinematic product launch with a rainy night scene" \
  --target-host shellx-canvas --target-lane browser \
  --aspect-ratio 16:9 --duration-ms 6000
```

Inspect `selectedTemplate`, `inputReadiness`, and the returned `authoringLoop`. For every entry in
`authoringLoop.representativeFrames`, run its exact `motion.preview.frame` package/timestamp pair.
Apply only declared controls and semantic media slots, render final media after frame review, run
the declared quality gates, and call `motion.agent.revision.plan` with failed receipts before
another mutation. The canonical rich example is
`templates/shellx-product-pack/cinematic-rain-launch`.

If the plan returns `authoringLoop.qualityManifestPath`, verify the final render with it:

```bash
shellx-motion quality-check /path/to/final.mp4 \
  --manifest /path/to/package/quality/representative-frames.json \
  --preview-package /path/to/package --preview-lane browser
```

## Create a bounded snow environment

```bash
shellx-motion debug layer-create \
  --tier edit_motion --trusted-local-tier \
  --package /path/to/package --out /path/to/revision \
  --created-by local-agent \
  --layer-json '{
    "id":"snow-stage",
    "type":"environment",
    "startMs":0,
    "durationMs":6000,
    "transform":{"x":0,"y":0,"width":1920,"height":1080},
    "environment":{
      "schema":"shellx-motion/environment@1",
      "kind":"snow",
      "seed":20260715,
      "quality":"cinematic",
      "mode":"scene",
      "backgroundColor":"#07111F",
      "snowColor":"#F8FCFF",
      "fall":{"intensity":0.72,"speed":0.66,"wind":0.18,"turbulence":0.48,"flakeSize":1.14,"depthLayers":4,"focusFalloff":0.7},
      "ground":{"horizon":0.62,"accumulation":0.72,"drift":0.56,"contactAmount":0.5},
      "atmosphere":{"haze":0.34,"depthFade":0.62}
    }
  }'
```

Use the same layer type with `kind: "rain"`, `kind: "water"`, or `kind: "fog"` and the corresponding schema-bound
controls. Copy from the fixture packages under `fixtures/packages/environment-*-cinematic` when a
complete proven example is needed.

`quality` is a closed set — `preview`, `balanced`, `cinematic`, and nothing else; `"standard"`,
`"high"` and `"draft"` are refused by `validate` with `must be preview, balanced, cinematic`. It
caps the shader's per-frame cost (effective depth layers 2 / 3 / 4, recorded in the receipt), which
is not the same as capping memory. `kind` is `rain|water|snow|fog`, `mode` is `scene|overlay`,
colours are `#RRGGBB` with no alpha, and a document holds at most four environment layers.

A fog environment declares `backgroundColor`, `fogColor`, `lightColor`, and a bounded `fog` record
of `density`, `speed`, `scale`, `turbulence`, `height`, `depthLayers` (≤4) and `lightStrength`.
Animate the scalars through targets such as `environment.fog.density` and
`environment.fog.lightStrength`. Depth layers are a bounded rich control rather than a keyframe
target. The fixed shader remains package-code-free and receipt-visible. Every closed set, the
camera-parallax arithmetic, and the measured render memory budget:
[environments-depth-and-budget.md](environments-depth-and-budget.md).

## Bind an environment to package-local footage

Create the image source first, then create the environment after it with this declared field:

```json
{
  "id": "rain-stage",
  "type": "environment",
  "startMs": 0,
  "durationMs": 6000,
  "transform": { "x": 0, "y": 0, "width": 1920, "height": 1080 },
  "environment": {
    "schema": "shellx-motion/environment@1",
    "kind": "rain",
    "mode": "scene",
    "sceneSourceLayerId": "footage",
    "seed": 20260713
  }
}
```

The complete environment still needs its kind-specific bounded controls. The `footage` layer must
be a visible, earlier image that spans the environment timing, uses `fit: "fill"`, opacity 1, and
the exact document-sized identity transform; crop, mask, matte, effects, keyframes and blend modes
are rejected because the fixed shader samples decoded package pixels directly, and `overlay` mode is
rejected for a source binding. Complete package: `fixtures/packages/environment-rain-footage`.

To add deterministic occlusion, shore, or accumulation coverage, create another earlier full-frame
image with effective opacity 0 and declare `environment.effectMaskLayerId`. White enables the
effect, black protects the underlying scene, grayscale gives a soft boundary. It stays enabled (so
the runtime can decode it) at opacity 0, under the same timing/fit/transform/no-lossy rules.

Once the binding is declared, an agent may rebind it without raw JSON editing:

```bash
shellx-motion debug layer-rich-set \
  --tier edit_motion --trusted-local-tier \
  --package /path/to/package --out /path/to/revision \
  --layer rain-stage --path environment.sceneSourceLayerId --value alternate-footage

shellx-motion debug layer-rich-set \
  --tier edit_motion --trusted-local-tier \
  --package /path/to/revision --out /path/to/masked-revision \
  --layer rain-stage --path environment.effectMaskLayerId --value alternate-effect-mask
```

## Edit and animate rich controls

```bash
shellx-motion debug layer-rich-set \
  --tier edit_motion --trusted-local-tier \
  --package /path/to/package --out /path/to/revision \
  --layer snow-stage --path environment.fall.turbulence --value 0.74

shellx-motion debug keyframe-upsert \
  --tier edit_motion --trusted-local-tier \
  --package /path/to/revision --out /path/to/keyframed \
  --layer snow-stage --target environment.fall.intensity \
  --at-ms 2400 --value 0.92 --easing ease-in-out

shellx-motion debug keyframe-distribute \
  --tier edit_motion --trusted-local-tier \
  --package /path/to/keyframed --out /path/to/distributed \
  --layer snow-stage --target environment.fall.intensity \
  --start-ms 0 --end-ms 4800
```

Use paired spatial commands for a position path; do not patch the X/Y lanes separately:

```bash
shellx-motion debug spatial-position-upsert \
  --tier edit_motion --trusted-local-tier \
  --package /path/to/package --out /path/to/path-revision-1 \
  --layer subject --at-ms 0 --x 120 --y 180 --easing ease-in-out \
  --mode broken --in-x 0 --in-y 0 --out-x 90 --out-y -40

shellx-motion debug spatial-position-move \
  --tier edit_motion --trusted-local-tier \
  --package /path/to/path-revision-1 --out /path/to/path-revision-2 \
  --layer subject --from-ms 0 --to-ms 250

shellx-motion debug spatial-position-delete \
  --tier edit_motion --trusted-local-tier \
  --package /path/to/path-revision-2 --out /path/to/path-revision-3 \
  --layer subject --at-ms 250
```

Spatial modes are `linear`, `smooth`, `broken`, and `auto`. Handle values are pixel deltas from the
position vertex. Smooth handles must be collinear and opposite; auto handles are derived
deterministically from neighboring points. Every command updates both coordinate lanes atomically.

## Typed compositing graph

Inspect before authoring or replacing a graph:

```bash
shellx-motion debug compositing-graph-inspect \
  --package /path/to/package
```

Author the graph as bounded data in a reviewed JSON file, then compile it into one copy-on-write
package. Source nodes reference one contiguous block of existing layer ids. A unary node uses its
`input` port; matte uses `input` plus `matte`; blend uses `background` plus `foreground`; every edge
starts at `output`.

```bash
shellx-motion debug compositing-graph-set \
  --tier edit_motion --trusted-local-tier \
  --package /path/to/package --out /path/to/composited \
  --graph-file /path/to/graph.json --created-by local-agent

shellx-motion debug preview-frame \
  --tier render_motion --trusted-local-tier \
  --package /path/to/composited --at-ms 1200 --out /path/to/previews
```

The accepted schema is `shellx-motion/compositing-graph@1`; node kinds are `source`, `transform`,
`mask`, `matte`, `blend`, `color`, `blur`, and `output`. Exactly one output is required. Graph set
fails before package copying for unknown fields, prototype/accessor-shaped data, invalid ports,
occupied inputs, cycles, disconnected nodes, unsafe matte branches, or resource amplification.
Source fan-out is allowed and compiled layer identities remain deterministic.

Remove the graph through its typed operation; do not delete hidden source or generated layers by
hand:

```bash
shellx-motion debug compositing-graph-remove \
  --tier edit_motion --trusted-local-tier \
  --package /path/to/composited --out /path/to/restored
```

Removal restores the original editable source stack and visibility, removes compile metadata, and
emits a verified `compositing.graph.remove` receipt. Cut should consume rendered linked media for a
graph unless every lowered construct is separately fixture-proven receiver-exact.

## Deterministic procedural relationships

Inspect readable source/target bindings and optional evaluated values before editing:

```bash
shellx-motion debug procedural-inspect \
  --package /path/to/package --at-ms 500
```

Author one reviewed data-only relationship, disable it reversibly, or detach it without baking:

```bash
shellx-motion debug procedural-set \
  --tier edit_motion --trusted-local-tier \
  --package /path/to/package --out /path/to/linked \
  --relationship-file /path/to/relationship.json --created-by local-agent

shellx-motion debug procedural-enabled-set \
  --tier edit_motion --trusted-local-tier \
  --package /path/to/linked --out /path/to/disabled \
  --relationship time-to-x --disabled

shellx-motion debug procedural-detach \
  --tier edit_motion --trusted-local-tier \
  --package /path/to/linked --out /path/to/detached \
  --relationship time-to-x
```

Bake selected enabled relationships to ordinary numeric keyframes in one package revision:

```bash
shellx-motion debug procedural-bake \
  --tier edit_motion --trusted-local-tier \
  --package /path/to/linked --out /path/to/baked \
  --relationships time-to-x,x-to-rotation \
  --start-ms 0 --end-ms 2000 --sample-every-frames 2
```

Read `sampleCount`, `keyframeCount`, and the deterministic bake fingerprint, then inspect the
keyframe panel and preview representative times. Allowed nodes are constants, property/time/frame/
audio-envelope reads, bounded arithmetic, clamp/map/ease/distance, and seeded deterministic noise.
Unknown fields, cycles, missing inputs, duplicate targets, resource excess, JavaScript, callbacks,
plugin code, dynamic property access, and file/network access fail closed. Trusted hosts use SDK
`proceduralInspect`, `proceduralSet`, `proceduralSetEnabled`, `proceduralBake`, and
`proceduralDetach`; one successful SDK mutation is one Design Studio history transaction.

Supported rich families include declared shader uniforms, particle emitters, fixed 3D scene
objects/cameras/lights, layer depth, motion blur, film treatments, and rain/water/snow environment
parameters. The exact accepted paths are generated into the Motion/Design Studio control projection; a
rejected path is a contract failure, not an invitation to patch raw JSON.

## Import a bounded glTF or GLB scene

```bash
shellx-motion debug gltf-import \
  --tier write_local --trusted-local-tier \
  --source /path/to/model.glb --out /path/to/model-package \
  --created-by local-agent

shellx-motion debug preview-frame \
  --tier render_motion --trusted-local-tier \
  --package /path/to/model-package --at-ms 500 --out /path/to/previews
```

The source must be glTF 2.0 with static triangle geometry in canonical embedded base64 buffers or
one GLB BIN chunk. Import preserves original bytes and normalized JSON, generates normals when
absent, and reports mesh, vertex, triangle, and lossiness evidence. External paths/URLs, extensions,
animations, skins, textures, morph targets, sparse accessors, matrix transforms, and non-uniform
scale fail closed. Do not convert those failures into hand-authored scene data.

Design Studio opens the resulting Motion package and uses its normal scene controls. For Cut, retain the
`layer.type:scene3d` fallback reason and one `cut.media.import_rendered` operation. Trusted hosts may
call typed SDK `gltfImport`, but must set `authoringInputRoots` and `authoringOutputRoots` in local
SDK/server configuration.

## Track and stabilize package footage

Choose reference bounds and points in Design Studio or from an explicit reviewed pixel coordinate set.
The source must be a `kind: "video"` Motion asset whose `source.path` is also listed in
`manifest.assets`.

```bash
shellx-motion debug tracking-request \
  --tier write_local --trusted-local-tier \
  --package /path/to/package --out /path/to/tracked-package \
  --analysis-id hero-plate-track --asset-id hero-plate \
  --mode planar --model similarity \
  --reference-json '{"atMs":0,"bounds":{"x":320,"y":180,"width":640,"height":360},"points":[{"x":360,"y":220},{"x":880,"y":220},{"x":880,"y":500},{"x":360,"y":500}]}' \
  --settings-json '{"startMs":0,"endMs":5000,"stepMs":40,"direction":"forward","searchRadiusPx":48,"pyramidLevels":2,"maxIterations":40,"confidenceFloor":0.7,"deterministicSeed":20260714}'

shellx-motion debug tracking-inspect \
  --package /path/to/tracked-package --analysis-id hero-plate-track
```

Two settings above behave differently from what their names suggest, and both are measured, not
assumed:

- **`pyramidLevels` is not free accuracy — choose it from the feature scale.** Each extra level
  halves the resolution, so a level whose pixels are wider than the tracked feature cannot see it
  and coarse-to-fine locks onto a neighbour instead. On the repository's own 6-point homography
  fixture, whose features are 5 px wide, depth 2 tracks to a **0.193 px** residual while depth 3
  mis-associates points and returns **10.879 px** with a `partial` status — 56x worse from one extra
  level. The solver rejects a depth the source cannot hold, by name, but it cannot reject a depth
  that is merely too coarse for the feature. Start at 2 and raise it only if a large
  `searchRadiusPx` will not otherwise fit the operation budget.
- **`deterministicSeed` is inert.** The search is exhaustive and fully ordered and consumes no
  randomness, so no seed value changes any result. It is required by the schema, hashed into
  `settingsSha256` as part of the request identity, and reported as inert by every tracking receipt.
  Changing it changes the request identity — and therefore cache hits — and nothing else.

Apply only after inspection reports `current: true`. A partial lifecycle requires the reviewed
confidence-qualified segment explicitly:

```bash
shellx-motion debug tracking-apply \
  --tier edit_motion --trusted-local-tier \
  --package /path/to/tracked-package --out /path/to/stabilized-package \
  --analysis-id hero-plate-track --layer hero-footage --segment-index 0

shellx-motion debug tracking-verify \
  --package /path/to/stabilized-package --layer hero-footage \
  --analysis-id hero-plate-track
```

Omit `--segment-index` only for a ready single-segment track. Never pass
`--include-low-confidence` automatically. Preview representative times and read the apply receipt
before rendering or constructing a Cut import plan. Detach into another package revision when the
generated correction is no longer wanted:

```bash
shellx-motion debug tracking-detach \
  --tier edit_motion --trusted-local-tier \
  --package /path/to/stabilized-package --out /path/to/detached-package \
  --layer hero-footage
```

Do not claim native Cut editability for scale, rotation, homography approximation, confidence gaps,
or non-equivalent easing. Render the verified Motion package and hand Cut one linked rendered source
with the exact fallback reasons.

Design Studio and other trusted local hosts should use the typed `@shellx-motion/sdk/local` methods
`trackingRequest`, `trackingInspect`, `trackingApply`, `trackingVerify`, and `trackingDetach` instead
of parsing CLI output. SDK responses intentionally carry bounded lifecycle/confidence/segment
summaries; inspect the persisted package artifact when full solver samples are genuinely required.

## Permission tiers

Ranked `read_motion < draft_motion < render_motion < edit_motion < write_local < push_remote`.

- `read_motion`: inspect state and panels.
- `draft_motion`: prompt runs, plus playhead/range/viewport changes (navigation, not a read).
- `render_motion`: preview or render local outputs.
- `edit_motion`: mutate a Motion package that already exists, into a new revision.
- `write_local`: create files outside an existing package — **a new package**, importers, exporters,
  connectors, archive/extract. Ranks **ABOVE** `edit_motion`, which therefore cannot create one.
- `push_remote`: reserved; never infer or elevate to it.

CLI elevation above the command's default requires `--trusted-local-tier`; packages and prompts
cannot grant themselves a higher tier. Per-command tiers: `schemas/debug.json`.

## Import a Lottie or dotLottie source

```bash
shellx-motion debug lottie-import --source ./brand.json --out ./pkg-brand \
  --tier write_local --trusted-local-tier

# A .lottie container may declare several animations and themes; omit both to take its defaults.
shellx-motion debug dotlottie-import --source ./brand.lottie --out ./pkg-brand \
  --animation hero --theme dark --tier write_local --trusted-local-tier
```

Both write a **lowering receipt** and an **adapter-diagnostics receipt** into the package. Read them:
they record what was flattened, which blend/gradient/theme rules applied, and what was explicitly
unsupported. A successful import is not the same as one that represented everything.

dotLottie state machines are preserved, never executed — do not promise interactive behaviour from
an imported container. Do not hand-author a package and call it a Lottie lowering: that produces an
unattested package with no lossiness receipt and no preserved source.

## Bounded HTML/CSS interchange

```bash
shellx-motion html-snippet-import /path/to/source/index.html --out /path/to/imported-package
shellx-motion debug html-snippet-import \
  --tier write_local --trusted-local-tier \
  --html /path/to/source/index.html --out /path/to/imported-package
```

Keep package-relative media beside the source HTML, for example `assets/logo.svg` or
`assets/shot.webm`. Import copies verified files into the output package and returns
`stagedAssetCount`, `stagedAssets`, hashes, and discarded-feature findings. Remote/data/blob/
executable URLs, traversal/query/hash paths, unsupported extensions, escaping symlinks, and SVG
script/foreign-object/external-reference syntax are refused. HTML scripts, event handlers,
stylesheets, unsafe tags, arbitrary transforms, and unmapped CSS are never executed; they are
discarded and named in the receipt.

Export is deliberately a bounded standalone snippet, not a full-fidelity browser project format:

```bash
shellx-motion html-snippet-export /path/to/package --out /path/to/html-export
```

Read `unsupportedFeatureCount` and the receipt before calling the result lossless. Keyframes,
effects, gradients, mattes/masks, crop, transitions, complex media timing, and style fields outside
the declared subset are exported only with explicit lossiness findings.

## Failure rules

- Preserve the source package; mutate an explicit revision output, and stop on validation, digest, path-containment, resource-policy, or unsupported-control errors.
- Never retry malformed or unsupported package data by broadening the contract.
- Keep the last known-good render when a refresh fails; do not include secret values, full environment dumps, or arbitrary local paths in receipts.
