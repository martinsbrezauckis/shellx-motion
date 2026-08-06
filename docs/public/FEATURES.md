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
- Text, shape, image, video, audio, grouped/precomposed content, **linear and radial gradients on
  every shape kind** (`layer.gradient`, 2–16 stops, `gradient.angle` keyframable — use it instead of
  stacking translucent shapes, which band), masks/mattes, effects,
  transforms, crop/fit, blend modes, and bounded rich-layer controls.
- Copy auto-fit, safe-area checks, representative-frame plans, frame-quality gates, and revision
  proposals for failed quality evidence.

## Rich rendering and effects

- Deterministic browser and fixture-proven fallback render lanes with preview frames/strips,
  playhead preview, final render, batch jobs, and receipts.
- Render calls **block until the render is finished**, but the job IS observable from another
  process. Name it (`--job-id`, or `jobId` on the Debug API) and query `motion.job.get` /
  `motion.job.list`: they read a per-user job registry, so a second process sees `pending` while the
  work waits for machine capacity, `running` once it starts, and the outcome after the process exits.
- `motion.render.status`/`motion.render.queue` are read-only views **derived from receipt files on
  disk**, so they report finished (and batch-partial) work, not live processes.
  `motion.render.cancel` and `motion.render.retry` write control receipts against an existing render
  receipt: cancel marks a target cancelled, retry records a `not_run` re-run request. Neither signals
  a running process, and nothing consumes a retry record to start a new render.
- H.264/HEVC MP4, VP9/AV1 WebM where the local capability probe permits them, audio, captions,
  alpha-capable outputs, GIF, JPEG/stills, and explicit export-preset capability matching.
- Cinematic rain, wet-ground/reflection, snow, water/liquid surfaces, fog, haze, depth fade, and
  source-aware scene atmosphere.
- Bounded shaders, particles, fixed 3D scenes, glTF scene import, film treatment, motion blur, and
  depth-aware composition. Depth compositions are deliberately narrower than the rest of the
  compositor: a layer carrying `depth` must be a generated visual layer, needs a `camera`, is bounded
  to -0.9…3, is required on **every** generated visual layer once any layer has it, and rejects both
  mattes and any `blendMode` other than `normal` rather than silently changing its compositing.
- Those rich browser-lane features are bounded by a **per-job resident-memory ceiling** (6 GiB by
  default, `SHELLX_MOTION_MAX_JOB_RSS_BYTES`), not only by the frame/pixel-frame limits. A browser
  render reuses one Chromium session for the whole sequence, so peak memory grows with frame count
  and with `effects.motionBlur.samples`; a 15 s 1080p30 delivery carrying two WebGL environment
  layers and 3-sample motion blur measured 5.07 GiB of that 6 GiB budget on the reference host.
  Crossing the ceiling aborts the job with `job_rss_limit_exceeded`. Budget the piece up front — see
  [rendering.md](rendering.md) for the measurements and the levers that move them.
- Fixture-proven mattes and effects, chroma/luma keying with spill/matte cleanup, vector roto,
  compositing graphs, and bounded procedural bindings with enable/disable, bake, and detach.
- Point and planar tracking, confidence/lost-region evidence, stabilization, tracked property
  application, verification, and exact detach restoration.

## Interchange

Reachable from the CLI, the debug/MCP command set, and the SDK:

- Bounded HTML/CSS snippet import/export without script execution, network fetches, unsafe SVG,
  arbitrary transforms, or claims of lossless export for unsupported features
  (`motion.html.snippet.import` / `.export`, CLI `html-snippet-import` / `html-snippet-export`).
- OTIO import/export (`motion.otio.import` / `.export`), package archive/extract
  (`motion.package.archive` / `.extract`), bounded glTF/GLB scene import
  (`motion.scene3d.gltf.import`, SDK `gltfImport`), connector plans, and receiver capability
  inspection.

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

The current product pack has 12 families for agent and host automation. They remain available to
the CLI, SDK, MCP, and Debug API, but are intentionally absent from the human Workbench. Promoted
media-rich references include:

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

Cut's Generate catalog exposes **four** of them as `builtin.motion.*` families:
`cinematic-fog-title`, `editorial-liquid-surface`, `keyed-subject-promo`, and
`tracked-callout-overlay`. `cinematic-rain-launch` declares `shellx-cut` host compatibility in its
manifest but has **no** Cut Generate entry and is not covered by the `template-pack:host-parity`
gate (`RICH_HOST_FAMILIES` in `scripts/template-host-parity-gate.ts`) — reach it through the Motion
CLI/SDK and hand Cut rendered media instead.

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
- `validate` reports schema/asset/manifest results in its JSON envelope only. It emits no receipt
  and creates no `receipts/` directory (`validateCommand` in `packages/cli/src/main.ts`).
- The engine's scope is the local render: authoring, rendering and evidence on one machine. Hosting,
  shared cloud state, marketplace delivery and remote push belong to the products built on top of it.

## Near-term roadmap (post-0.1.0, not yet implemented)

Decided 2026-08-06 while building the 0.1.0 launch demos, which is why each entry names the
limit it removes. None of this exists in 0.1.0; nothing here is a commitment to a date.

- **Instanced `points` layer.** A particle-swarm demo built from individual `shape` layers
  needs one layer per point (the launch film carries 4,201 of them and a 48 MB document). A
  layer type holding position/colour arrays with keyframed interpolation would express the
  same film in a few hundred kilobytes and render it from one draw pass.
- **Trigonometric procedural nodes (`sin`, `cos`).** The procedural relationship graph has
  arithmetic, clamp, map, and ease nodes, but no trig, so a rotating parent chain (a waving
  arm on a character rig) cannot be expressed in-graph today — it has to be baked by
  author-time tooling. Trig nodes plus the existing bake step make simple rigs first-class
  data.
- **Character/cutout rigging path.** The pieces already exist separately — image layers take
  `crop` rects, every layer rotates and scales around its own `originX`/`originY`, and
  audio-envelope nodes can drive a mouth from a voiceover's amplitude. The roadmap item is
  the author-time tooling that turns one illustration into keyed parts with baked parent
  transforms, and the documentation that makes an agent able to do it unassisted.
- **Browser-lane parity for `keyframe.fill` and generated `ellipse` shapes.** Both are
  native-lane-only today, which silently decides the lane for any document that uses them.
- **Audio finished as a feature (targeted at 0.1.1).** More exists today than a roadmap
  usually admits: volume/pan/playbackRate keyframes, track gain/fade/mute/solo, per-track
  two-pass EBU R128 loudness normalization, sidechain and timed ducking, and audio quality
  checks all ship in 0.1.0 (see rendering.md). What 0.1.1 adds is the master bus: a
  document-level loudness target stated as data and proven in the receipt, crossfades and
  fade curves as first-class fields, an envelope producer so existing audio-envelope nodes
  can be fed from an audio file without host tooling, and the CLI surface for the sidechain
  parameters the engine already accepts.
- **External script import** stays out of the engine until it can ship behind a
  human-only, default-off setting, per the security model. Agent-authored project data —
  including everything above — needs no scripting to stay expressive.
