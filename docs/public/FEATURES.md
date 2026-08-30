# ShellX Motion implemented features

This is the current implemented-capability map for agents and host-product developers. It describes
what exists now, not aspirational roadmap items. Exact machine contracts remain in `schemas/`, and
the callable surface is indexed in [`DEBUG_API_COMMANDS.md`](DEBUG_API_COMMANDS.md).

## Product and trust boundary

- Local-first, self-hosted engine that runs on a user's own machine.
- Declarative Motion layers cannot execute arbitrary code, fetch remote assets implicitly, or raise
  host resource limits. The `web`/`html`/`canvas` layer family is the deliberate exception: it
  renders package-local HTML in Chromium with JavaScript enabled, fenced by the network and
  filesystem controls in [security-model.md](security-model.md) but genuinely executing. The HTML
  importer strips scripts from foreign markup; the render path does not.
- Package-relative asset fencing, validation, hashing, receipts, permission tiers, deterministic
  revision outputs, and explicit fallback/lossiness reporting.
- Loopback debug server with capability authentication, Host/Origin checks, request bounds, and no
  direct non-loopback exposure.

## Authoring and animation

- Canonical package, manifest, motion document, assets, receipts, archives, validation, inspection,
  patching, and compatibility metadata.
- Layer, track, scene, caption, transition, marker, selection, timeline, and range operations.
- Visible keyframe creation, update, movement, duplication, deletion, range transforms, easing,
  interpolation, curve handles, spatial paths, snapping, presets, and undoable package revisions.
- Text, shape, image, video, audio, **linear and radial gradients on Browser-renderable closed
  legacy primitives** (`rect`/`rectangle`, `rounded-rect`, `ellipse`, `triangle`, and `star`; 2–16
  stops; `gradient.angle` keyframable — use it instead of stacking translucent shapes, which band),
  masks/mattes, effects, transforms, crop/fit, blend modes, and bounded rich-layer controls. Strict
  GPU accepts gradients only on `rect` and Native refuses them. Legacy `path` / `freeform`
  gradients remain refused until their closure is proven; open v1 line, polyline, and arc contours
  are stroke-only; see [Shape geometry v1](shape-geometry.md).
- [Path reveals](path-reveals.md) on one explicitly stroked SVG path: independently keyframable
  normalized start/end windows for line drawing and light traces. Browser accepts the broader
  validated contract; the strict GPU lane accepts its documented fixed path subset; native refuses
  the feature rather than showing an unrevealed line.
- **Current v0.2 addition — bounded cutout-rig bake.**
  [`motion.timeline.cutout.rig.bake`](cutout-rigging.md) replaces one verified static PNG image
  layer with 1–16 ordinary cropped image layers and sampled transform keyframes. It is an
  author-time approximation with source identity, cadence, and receipt evidence; it is not live
  parent-child hierarchy, automatic image segmentation, arbitrary scripts, or a new renderer
  primitive.
- **Current v0.2 addition — named transition presets.** Seven [transition presets](transition-presets.md)
  are discoverable and atomically applicable through typed Debug/MCP and CLI routes. They compile
  to ordinary transitions, keyframes, and bounded effects with receipt evidence; capability
  matching still decides whether a revised package fits a renderer lane.
- **Current v0.2 addition — atomic revisions and read-only planning.** One closed
  `motion.revision.transaction` request applies up to 32 allow-listed timeline edits to a new
  copy-on-write package and emits one aggregate receipt. Its separate `.plan` command replays the
  same typed steps only in memory, writes no package or receipt, and never authorizes a later edit.
- **Current v0.2 addition — compact agent snapshot.** `motion.agent.snapshot` returns a fresh,
  pathless, private-scope orientation record capped at 12 KiB; an opt-in host may expose the same
  bounded view through one fixed MCP resource URI. It does not invent persisted selection or turn
  a snapshot id into a freshness lease. See [agent integration](agent-integration.md).
- Grouped/precomposed Motion timelines are supported by the strict WebGPU lane as bounded local
  timelines with explicit child ownership, depth-4 nesting, isolated transforms/effects/masks and
  blend compositing. Other lanes may refuse them. Lottie imports separately flatten only supported
  static precompositions and report the result in their lowering diagnostics. See
  [Groups and local timelines](groups-and-local-timelines.md) for the typed structural contract.
- Copy auto-fit, safe-area checks, representative-frame plans, frame-quality gates, and revision
  proposals for failed quality evidence.

## Rich rendering and effects

- Deterministic browser and fixture-proven fallback render lanes with preview frames/strips,
  playhead preview, final render, batch jobs, and receipts. Ordinary file-video final rendering
  uses a bounded streamed handoff; opt-in segmented final delivery adds deterministic derived
  FFV1 checkpoints, exclusive locking, explicit resume, no-clobber publication, and receipt
  evidence without exposing raw storage or concat controls; materialisation remains deliberate for
  retained frames, captured workflows, exact-source quality, streaming capacity, and
  injected-renderer cases.
- **V25-B1 accepted implementation — bounded WebGPU scene lane.** `preview --lane
  gpu`, Debug `motion.preview.frame` with `lane: "gpu"`, and SDK `preview({ lane: "gpu" })` use
  the same strict static scene compiler as GPU final delivery. It accepts the documented data-only
  scene subset: manifest-bound MotionIR text and captions, shapes (including bounded
  paths/reveals), images, active video, points/particles, groups, effects/masks/mattes,
  camera/depth, fixed 3D/environment passes, and fixed Motion-owned materials. It emits
  PNG/hash/runtime/resource evidence and never substitutes CPU or browser rasterization.

  For active video, a host-owned provider snapshots admitted zero-origin CFR source bytes once;
  Core maps each playhead, trim, loop, and scalar playback-rate request once to integer
  microseconds; and the provider binds the requested source time, decode contract, immutable-source
  hash, and decoded-RGBA hash before replacing a pre-reserved dynamic WebGPU texture. Its completed
  decoded-frame LRU is capped at 32 entries / 128 MiB, with at most 64 MiB in flight. The preview
  receipt records this under `output.gpuVideoPreview`, including source/frame identities, CFR
  selection, cache telemetry, texture metrics, and the explicit limits `audio-not-rasterized` and
  `final-not-attested`. This is visual-only preview, not a V25-B1 final-video, audio, encoding, or
  mux capability; existing GPU-final rules remain unchanged. Native Linux RTX 5080 rig scrub
  accepted forward, backward, random, and repeated playheads with exact repeated pixels, one
  retained dynamic texture, bounded cache high water, zero late-allocation refusals, and complete
  GPU/provider cleanup at runtime commit
  `40b965bb69b02c2bcfc0b0972beaca2a07e4defa`.
- Fixed rain, water, snow, and fog environments can retain bounded 2..8-sample authored shutter
  blur on the GPU lane. Motion evaluates each sample at exact canonical time, accumulates the
  premultiplied samples through retained textures, and composites the layer once. The four-authored-
  environment ceiling remains unchanged; sample work, frame plans, retained high-water resources,
  and cleanup stay evidence-bound. This does not widen temporal blur to video, 3D, materials,
  hybrid surfaces, compute particles, or package-selected shaders.
- `motion.render.final` with `frameLane: "gpu"` streams straight raw RGBA into FFmpeg for
  supported video delivery and binds the GPU adapter, immutable resource identities, exact frame
  plans, and decoded RGBA hashes in the receipt. It can also use derived, resumable FFV1 segments
  for an admitted non-hybrid scene or exactly one governed hybrid texture; the store, runtime,
  capture plan, range ledgers, and resume identity are host-owned. GPU delivery does not claim a
  GPU is available or fast on this host until a fresh execution attests an adapter.
- **V25-B2 accepted implementation — governed hybrid final delivery.** A GPU package may contain
  one strict data-only package HTML source (`web`/`html`/`canvas`) or one
  isolated restricted-GLSL layer, never both. The former forbids scripts, active URLs, interaction,
  temporal CSS, embeds, and remote origins. The latter stable-reads and validates declared GLSL,
  captures only that layer through legacy WebGL, then lets WebGPU composite its texture. Neither
  form runs package code in WebGPU. Both are final-video-only and may use ordinary streaming or
  durable segmented delivery. Segmented delivery freezes the source, browser/runtime policy, exact
  Core microsecond requests, capture plan, per-range pixel ledger, and cleanup evidence before
  checkpoint publication; changed or missing facts refuse. Native Linux RTX 5080 rig restricted-GLSL
  interrupted-resume and cold replay produced identical 360-frame plans, pixels, and final MP4 at
  runtime commit `77faf57440bc4b7d2f203028664ae1da3995acc0`. Strict HTML aliases retain
  source/integration proof but do not yet carry the same native visual qualification.
- Fixed analytic particle compute is a separate, refusal-first route: one normal-blend circular
  emitter may use exactly 100,000..131,072 particles. V1 keeps one to three radial/vortex sources.
  Closed v2 adds up to four weighted origins and four fixed radial/vortex/flow/turbulence/finite-
  impact/axis-plane-collision sources, a short analytic trail, fixed shading, and one authored mask
  or static-shape alpha/luma matte. Motion owns the WGSL, workgroup shape, retained buffers, and
  canonical-time evaluation; ordinary particles remain Core CPU exact-time evaluation. V2 is not
  arbitrary compute, a particle script, retained physics, mesh or particle-particle collision, or
  a performance/hardware-availability guarantee.
- Chromium is the typography authority only for generated MotionIR text whose requested family is
  backed by a regular, manifest-declared package font asset: Motion hashes and embeds those bytes,
  waits for the faces, and records a canvas-metric fallback attestation. HTML/web/canvas layers can
  still render, but their active typography scope is expressly unverified (including dynamic canvas
  text); they carry a warning and cannot satisfy `maxFontFallbacks`. Native remains the bounded
  block-glyph lane and refuses delivery text outside that proof. The GPU lane advertises text only
  through its separate manifest-bound shaping contract with provenance, load/fallback evidence and
  fixture coverage; arbitrary HTML/canvas text remains unverified.
- Compatibility render calls **block until the render is finished**. A persistent Debug/MCP or local
  SDK host with an authenticated owner principal can instead call `motion.job.submit` for an
  ordinary streamed or opt-in segmented final-video render, which
  returns a durable job id before expensive work starts; query `motion.job.get` / `.list` / `.events`
  for its lifecycle. Workflow capture, quality manifests, retained frames, dry runs, stills, and
  image sequences remain blocking `motion.render.final` compatibility work.
- `motion.render.status`/`motion.render.queue` are read-only views **derived from receipt files on
  disk**, so they report finished (and batch-partial) work, not live processes.
  `motion.render.cancel` and `motion.render.retry` are historical receipt annotations only. For
  coordinator-owned streamed work, `motion.job.cancel` signals the real producer and FFmpeg worker
  and reports `cancelRequested` until the worker settles; `motion.job.retry` creates a distinct
  linked run only after a retryable failed job. The four receipt-root operations currently require
  Linux's stable-reader capability; macOS and Windows return `capability_unavailable` before receipt
  state is read or written, while `motion.job.*` remains portable.
- **Current v0.2 addition — attested render reuse and cache planning.** Blocking final render may
  opt into reuse only when the exact output, complete bounded inputs, source receipt, artifact
  handle, engine version, v2 descriptor, and host-HMAC producer proof all verify. A public
  output-root co-writer cannot mint that proof. A hit emits a fresh `render.reuse` receipt;
  corruption refuses instead of silently rerendering. The separate read-only cache-plan command
  predicts hit, miss, or refusal without creating directories, locks, outputs, or authority. See
  [rendering](rendering.md).
- H.264/HEVC MP4, VP9/AV1 WebM where the local capability probe permits them, audio, captions,
  alpha-capable outputs, GIF, JPEG/stills, and explicit export-preset capability matching.
- **Current SDR colour/alpha boundary.** Authored colours use Motion's restricted CSS/hex syntax as
  SDR sRGB-encoded values, and unprofiled raster input is assumed to be sRGB. The exact
  `linear-srgb-sdr@1` static-rectangle final route performs premultiplied linear-sRGB WebGPU
  composition, including the F2a rectangular linear/radial subset with stop interpolation in linear
  light (2–16 canonical opaque stops, static angle/centre, normal source-over only), explicit
  straight-sRGB frame publication, fixed limited-BT.709 H.264 conversion,
  FFprobe validation, and mandatory inverse-decoded frame comparison before output publication.
  Native PNG and general Browser/GPU paths retain their documented encoded/Chromium-defined
  behaviour and make no cross-renderer colour-parity claim. HDR, wide-gamut, ICC profile
  conversion, OCIO, and selectable working spaces remain unsupported.
- **Fenced HDR10 implementation — not a Motion capability.** The source retains a narrow
  `internal/*` glTF PBR HDR10 implementation so the generic-render fence can compose. A package
  carrying its authenticated marker is refused by every generic final route before generic resource
  or output admission. HDR10 has no declared Motion-document field and no CLI, Debug/MCP, local SDK,
  Action, integration-capability, connector, or host route. `internal/*` remains an implementation
  detail, not a supported API: it does not make HDR, wide-gamut, colour management, a delivery
  format, or installed/native qualification available. See [Rendering lanes](rendering.md#fenced-hdr10-implementation).
- Cinematic rain, wet-ground/reflection, snow, water/liquid surfaces, fog, haze, depth fade, and
  source-aware scene atmosphere.
- Bounded shaders, particles, ordered `points` layers, static declarative trails, fixed 3D scenes, glTF scene import, film treatment, motion blur, and
  depth-aware composition. Depth compositions are deliberately narrower than the rest of the
  compositor: a layer carrying `depth` must be a generated visual layer, needs a `camera`, is bounded
  to -0.9…3, is required on **every** generated visual layer once any layer has it, and rejects both
  mattes and any `blendMode` other than `normal` rather than silently changing its compositing.
- Those rich browser-lane features are bounded by an **adaptive per-job resident-memory ceiling**,
  not only by frame/pixel-frame limits. Motion reserves the larger of 4 GiB or 20% of physical RAM,
  considers currently free RAM, divides the safe pool across concurrent jobs, and reports the exact
  resolved ceiling through `doctor` / `motion.platform.requirements`. A trusted host may still pin
  `SHELLX_MOTION_MAX_JOB_RSS_BYTES`; 6 GiB is now only the fallback when host facts are unavailable. A browser
  render reuses one Chromium session for the whole sequence, so peak memory grows with frame count
  and with `effects.motionBlur.samples`; a 15 s 1080p30 delivery carrying two WebGL environment
  layers and 3-sample motion blur measured 5.07 GiB on the reference host.
  A shared preflight still guards materialised browser sequences when their conservative estimate
  exceeds the resolved admission budget, with that estimate, budget and retention cardinality in
  dry-run/receipt evidence. Ordinary file-video final rendering streams instead; the preflight
  remains relevant only when the pre-execution transport decision requires materialisation.
  Crossing the ceiling after admission still aborts the job with `job_rss_limit_exceeded`. Budget the
  piece up front — see [rendering.md](rendering.md) for the measurements and the levers that move them.
- Fixture-proven mattes and effects, chroma/luma keying with spill/matte cleanup, vector roto,
  compositing graphs, and bounded procedural bindings with enable/disable, bake, and detach.
- A `points` layer keeps stable ordered points and up to 12 position samples in one bounded payload
  (four layers per document). Every host supports 8,192 points/layer; adaptive tiers admit 16,384,
  32,768, or 65,536 when resolved per-job memory and CPU allow it. State/payload caps scale from
  65,536 records / 8 MiB at the portable tier to 524,288 / 64 MiB at maximum. Browser renders one
  fixed-engine canvas; native draws the same interpolated geometry directly. A package above the
  current host tier refuses before launch/allocation—points are never dropped. Browser/native points
  are CPU-rendered; their limits do not describe the distinct fixed-compute GPU route above.
  None of these paths implies physics or arbitrary script execution.
- `points` and `particles` may carry a static bounded `effects.trail` record that makes a short,
  deterministic lookback stroke. Browser and native lower the same Core trail geometry through CPU
  renderers without claiming byte or antialias parity. The GPU scene lane may raster the same
  bounded ordinary-particle/point trail plan, but its fixed 100k+ compute route refuses trails.
  Trails do not add physics, persistent history, arbitrary script execution, or a density claim. See
  [bounded trails](trails.md).
- A seeded `particles` emitter may carry one to three ordered analytic field sources. A source is
  radial or vortex, has a normalized centre, signed bounded strength, and finite softening. Browser
  and native share the same deterministic CPU evaluator: it deflects each particle's existing
  ballistic position as a function of its lifetime progress. This is visual kinematic deflection,
  not a general physics simulation: collisions, persistent velocity/state, noise, formulas, arbitrary
  callbacks, and general GPU execution are not part of the contract. The separately documented
  fixed 100k..131072 GPU route can consume the same radial/vortex data only under its tighter
  compute descriptor; its optional CPU-style trail is refused there.
- The data-only procedural graph includes allow-listed `sin` and `cos` unary nodes. Inputs are
  radians, bounded to +/-1,000,000, and evaluated/baked with six-decimal quantization. It still
  rejects arbitrary expressions, imports, callbacks, and dynamic code.
- Point and planar tracking, confidence/lost-region evidence, stabilization, tracked property
  application, verification, and exact detach restoration.

## Interchange

The Debug/MCP and CLI routes cover the complete interchange set below. The local SDK's only
dedicated interchange operation is bounded glTF/GLB scene import (`gltfImport`):

- Bounded HTML/CSS snippet import/export without script execution, network fetches, unsafe SVG,
  arbitrary transforms, or claims of lossless export for unsupported features
  (`motion.html.snippet.import` / `.export`, CLI `html-snippet-import` / `html-snippet-export`).
- OTIO import/export (`motion.otio.import` / `.export`), package archive/extract
  (`motion.package.archive` / `.extract`), bounded glTF/GLB scene import
  (`motion.scene3d.gltf.import`; local SDK `gltfImport`), connector plans, and receiver capability
  inspection.
- Canvas, Cut connector, scripted-video, source Markdown, OTIO, and package archive inputs share
  explicit byte, file-count, depth, aggregate, and concurrency caps with no-follow stable-file
  admission. Exact limits and the receipt boundary are in [Host interchange and archive limits](interchange-limits.md).
- glTF/GLB source import additionally admits one **contained PNG base-color PBR direct-final subset**:
  static opaque triangles with exact `TEXCOORD_0`, base-color/metallic/roughness/emissive factors,
  immutable 1280x720 canonical scene state, copied PNG assets (max 16 primitives/textures, 16 MiB decoded each, 48 MiB GPU, 4 MiB readback), and bound package/renderer/FFmpeg
  receipts. It is GPU-to-FFmpeg direct final only; generic preview, Native, segmented/resume,
  JPEG, external URIs, samplers, extensions/compression, skins, and animation refuse. This is
  source integration, not an installed or hardware qualification.

**Lottie and dotLottie import into a Motion package.** The parsing and lowering library —
inventory, normalized source, lowering receipt, bounded precomp flattening, supported
blend/gradient/theme rules, explicit unsupported diagnostics, and preserved (never executed)
dotLottie state machines — is reachable through `motion.lottie.import` and
`motion.dotlottie.import` (CLI `debug lottie-import` / `debug dotlottie-import`). Both require
`write_local` and host-approved input and output roots, exactly like
`motion.scene3d.gltf.import`. A `.lottie` container may declare several animations and themes;
`animationId` and `themeId` select one, and omitting them takes the container's declared
defaults. Each import writes a lowering receipt and an adapter-diagnostics receipt into the
package it creates, so what was and was not representable is attested rather than assumed.

## Agent template references

The current product pack has 12 families for agent and host automation. Full template catalog,
plan, control, apply, and media-replacement routes are available through the CLI and Debug/MCP,
but are intentionally absent from the human Workbench. The local SDK has no dedicated template
catalog, plan, apply, or media-replacement operation: its generic validate, render, and timeline
edit operations can act only on a package that the caller has already selected. Promoted media-rich
references include:

- `cinematic-rain-launch` — wet-ground rain and reflected atmosphere;
- `cinematic-fog-title` — source-aware fog depth and travelling light;
- `editorial-liquid-surface` — water optics, caustics, and refraction;
- `keyed-subject-promo` — keyed presenter with matte/spill cleanup;
- `tracked-callout-overlay` — tracked annotation attached to moving footage.

Every family declares bounded controls and `metadata.qualityTargets` (12/12) and ships a rendered
`preview/poster.png` (12/12). Semantic media slots (`metadata.mediaSlots`) and story beats
(`metadata.story.beats`) are declared by the **five** families listed above only (5/12 each); the
other seven expose typed controls without them. No family ships a checked-in rendered MP4 — the one
`.mp4` in the pack (`keyed-subject-promo/assets/generated/atmosphere-fog-rays.mp4`) is a source
asset, not render proof. Their moving scene effects are Motion compositions, not slide-transition
stand-ins.

The agent-only [procedural script cookbook](agent-authored-scripts.md) is a separate reference for
small, composable, operator-approved locally authored package scripts. The narrow
`motion.package.script.author` MCP route now admits one host-attested local inline entry from a
data-only package; it does not permit script import, copied-script promotion, or marketplace enablement,
and distinguishes bounded CPU-rendered `points`, `sin` / `cos`, and analytic particle deflection
from the distinct fixed GPU compute descriptor and from general physics-field graphs.

The source admission matrix currently marks all five promoted rich templates GPU-ready:
`tracked-callout-overlay`, the three cinematic environment templates
`cinematic-rain-launch`, `cinematic-fog-title`, and `editorial-liquid-surface`, and
`keyed-subject-promo` are eligible for the bounded GPU preview/final scene profile. The keyed
template's active video uses the host-owned V25-B1 visual-only preview provider and therefore
remains subject to its exact CFR/source-identity/cache/receipt admission; this does not turn a
source-admitted template into native proof or a final/mux claim. The cinematic templates retain
their authored fixed shutter sampling rather than silently dropping temporal blur. These are
source-admission results, not hardware, performance, or rendered-film proof on a particular host.

Cut's Generate catalog exposes **four** of them as `builtin.motion.*` families:
`cinematic-fog-title`, `editorial-liquid-surface`, `keyed-subject-promo`, and
`tracked-callout-overlay`. `cinematic-rain-launch` declares `shellx-cut` host compatibility in its
manifest but has **no** Cut Generate entry. The `template-pack:host-parity` gate covers every
Cut-advertised template: the four catalog entries are Generate contracts, while rain has a separate
rendered-media-only static handoff contract. Reach rain through the Motion CLI or Debug/MCP
template workflow, then hand Cut rendered media instead; this is not a Generate/runtime-parity
claim. A local SDK host can render a caller-selected rain package, but cannot discover, plan, apply,
or replace template media through a dedicated template API.

Promoted-template moving proof is a release gate, not a checked-in video set:
each of the twelve public IDs renders a fresh short MP4 in scratch and must bind
its artifact hash to a final receipt, pass FFprobe duration/fps/BT.709/audio
readback, meet its measured unique-frame threshold, and stay under its
source-owned artifact/scratch/FFmpeg-encode budget. Successful runs retain only
evidence and copied final receipts; failure diagnostics may retain media outside
Git. See [the template quality bar](TEMPLATE_QUALITY_BAR.md) for the exact
policy and scratch-boundary contract.

## Design Studio and Cut ownership

- Design Studio is the visual authoring host: it opens path-free Motion sessions, presents the timeline,
  curves, spatial paths, projected rich controls, tracking/keying/roto/compositing/procedural panels,
  and saves verified package revisions.
- Motion validates, analyzes, previews, renders, hashes, writes receipts, and maps connector output.
- Cut is the editorial host: it discovers/previews/inserts Motion generators and edits, refreshes,
  relinks, rolls back, or detaches a stable linked Motion clip.
- Cut-native lowering is receiver-exact, and that is now checked rather than asserted. A ShellX Cut
  target declares which editable receiver it runs, and the planner validates every lowered payload
  against that receiver's exact accepted field set before claiming `editable_lowering`. Anything
  outside it — mixed easing, scale/rotation, environments, shaders, particles, 3D, film/motion blur,
  tracking math, keying/roto, compositing, procedural effects, an unrecognised transform or style
  field — is reported with a reason naming the field, and the plan degrades to linked rendered
  media. Motion used to be a deny-list producer against an allow-list receiver, so a plan could
  claim full support and then be rejected on arrival.
- Direct Lottie/dotLottie parsing is Motion-owned, and Design Studio does not maintain a competing
  importer. `motion.lottie.import` / `motion.dotlottie.import` route it through Motion.
- A successful command envelope is not successful media: verify the expected identity, artifact,
  duration/frame, hash, receipt, and quality result.
- Unsupported or unproven interchange never silently lowers. Preserve source data and report the
  fallback or lossiness.
- glTF, HTML/CSS, codecs, and native Cut editability are bounded to the declared fixture/capability
  contracts; they are not general-purpose browser, 3D, or NLE compatibility. Lottie/dotLottie is
  bounded the same way. (An earlier revision of this file called Lottie unreachable; that was
  corrected when `motion.lottie.import` / `motion.dotlottie.import` were wired up — see above.)
- `validate` reports ordered structural-schema and runtime-semantic results in its JSON envelope;
  a schema pass alone is not a renderability claim. See [Motion document validation](MOTION_VALIDATION.md).
  With a governed
  `--receipts-root` / `receiptsRoot` outside the package, it also persists a typed passed or failed
  `package.validate` receipt; without one it remains read-only and creates no `receipts/` directory.
- The engine's scope is the local render: authoring, rendering and evidence on one machine. Hosting,
  shared cloud state, marketplace delivery and remote push belong to the products built on top of it.

## Current v0.2 additions

These capabilities were planned while building the 0.1.0 launch demos and are now implemented in
the bounded forms described below.

- **Browser support for `keyframe.fill` and generated `ellipse` shapes.** Both browser and native
  preview lanes support them, so neither feature alone decides a render lane. Deterministic browser
  capture is pinned by the named `renders generated MotionIR %s shapes without filling their full
  layer box` and `renders generated MotionIR fill color keyframes at capture time` regressions in
  the [browser renderer test suite](../../packages/renderer-browser/src/index.test.ts).
- **Document audio-master slice (v0.2).** Alongside volume/pan/playbackRate keyframes, track
  gain/fade/mute/solo, per-track two-pass EBU R128 normalization, and timed/sidechain ducking,
  Motion now has a bounded document master. It realizes declared final-program loudness through
  fixed single-pass post-mix `loudnorm` — deterministic delivery control, not two-pass or broadcast
  mastering — then proves the delivered file against the declared LUFS, true-peak, and optional LRA
  limits in the render receipt. Matched linear/equal-power crossfades,
  a local data-only RMS envelope producer, and CLI controls for `sidechain` `mode`, `threshold`,
  and `ratio` are available through the Debug/MCP, CLI, action, and receipt boundaries. The local
  SDK has no dedicated ducking operation. It still accepts no arbitrary audio plugin, filter,
  script, or import.

## Near-term roadmap (not implemented)

These items name limits that remain after v0.2; they are not commitments to a date.

- **External script import** stays out of the engine. The only active-script path is the
  host-owned approved-agent-entry route described in the security model; it does not make
  imported/copied scripts, marketplace delivery, or general plugins executable. Agent-authored
  project data — including everything above — needs no scripting to stay expressive.
