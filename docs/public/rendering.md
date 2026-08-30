# Rendering lanes

ShellX Motion follows one architectural rule: **editability is data-level;
rendering is lane-level.** Design Studio, Cut, the Engine Room, and future hosts edit
structured package data; replaceable renderer lanes consume that data to produce
frames, media, and receipts. No host parses a renderer's private internals to
build its UI.

> **Invoking the CLI.** Shell commands on this page are written as `shellx-motion <command>` — the
> single `bin` the `@shellx-motion/cli` package publishes. From a ShellX Motion source checkout, run
> them as `pnpm --filter @shellx-motion/cli run cli -- <command>` instead. There is no `motion` binary
> in either form; dotted names such as `motion.render.final` are Debug API / MCP command ids, not
> shell commands. See [Quickstart](quickstart.md).

There are four lanes. They are honest about what each one does today.

## Shape geometry v1 lanes

[Shape geometry v1](shape-geometry.md) is lowered by Core to bounded colored
triangles. The strict GPU Browser and native lanes consume that same compiled
triangle form when admitted; the direct Browser lane deliberately refuses a v1
record before rendering because it does not consume the new geometry contract.
This is source-tested integration, not evidence of an installed executable,
native runtime, WebGPU adapter, or hardware pixel qualification on the current
machine. Legacy `x-path` and its existing path ABI are unchanged.

## Native lane

Purpose: fast local preview and still-frame rasterization for ShellX-native
primitives — shapes, images, simple video clips, bounded seeded particle emitters and point clouds,
and the deliberately narrow block-glyph text lane. It needs no browser and no
external codec, which makes it useful for quick inspection. Native particles use
the same Core ballistic/analytic-field evaluator as browser, then raster their
circle or square samples. That is deterministic CPU raster support, not a GPU or
general-physics claim.

Particles and ordered point clouds may also declare the static [`effects.trail`](trails.md) record.
Native runs the shared bounded lookback geometry and CPU round-cap stroke rasterizer inside the same
layer transform shell as the head. It refuses transformed stroke work above the declared limit instead
of clamping authored width. This is a capability-gated CPU lowering, not a claim of browser/native
byte or antialias parity.

**Native text is not production typography.** The lane draws a built-in 5×7,
uppercase-folded ASCII glyph set. It has no font rasterizer, shaping, kerning, or
Unicode coverage. Delivery refuses text that would change case, use fallback
glyphs, or ignore a requested family (`native_text_not_deliverable`); it does not
silently switch to Chromium. Select `--frame-lane browser` / `frameLane: "browser"`
when the render needs typographic fidelity.

## Browser lane

Purpose: render rich HTML/CSS/SVG/canvas/WebGL scenes and captured pages. Chromium
is the production typography authority **only for generated MotionIR text whose
requested font family is backed by declared package font bytes**. This is the
honest renderer when browser layout is the truth of the composition: design-to-video,
Design Studio page/frame animation, SVG/CSS animation, and captured websites.

For that narrow production-typography claim, Motion requires all of the following:

- The text is generated from MotionIR, not arbitrary page or canvas code.
- Its requested primary family has a `MotionFontAsset` declared in `motion.json`,
  listed in `manifest.assets`, and read as a bounded regular non-symlink file. The
  bytes are embedded as a data URL and their SHA-256 joins the frame input hashes.
- Chromium's `document.fonts` readiness completes, then Motion records the requested
  and resolved family, direction/language, and a canvas-metric fallback probe for
  each generated text layer. `manifest.quality.maxFontFallbacks` turns that evidence
  into a quality gate.

An HTML, web, or canvas layer remains a supported browser capture input, but its
text is intentionally marked `unverified` in the frame/final receipt and adds an
explicit warning. Motion cannot truthfully infer whether arbitrary script or
canvas code drew text, which font bytes it chose, or its fallback coverage. If a
package asks for `maxFontFallbacks`, final preflight refuses that scope with
`browser_html_typography_unverified`; generated MotionIR text whose requested family
is not manifest-bound similarly refuses with `browser_motion_typography_unverified`.
This does **not** promise arbitrary host fonts or byte/pixel typography parity
between different browser builds or hosts.

The current browser production claim is specifically font provenance, face loading,
and fallback observation. It is not a ShellX Motion complex-script or glyph-coverage
conformance claim. The GPU scene lane has a separate manifest-bound shaping contract
with its own fixture; that does not extend to arbitrary HTML or canvas text.

The browser lane runs generated or package HTML in a bounded Playwright Chromium
session. It is deterministic by construction: animations are disabled during
capture, the caret is hidden, device scale is fixed, and frames are captured on a
fixed clock. It is also network-denied by default — see
[Security model](security-model.md). Most rich features (gradients, cameras,
depth, motion blur, film grain/vignette, particles, restricted shaders, fixed 3D
scenes, and rain/water/snow/fog environments) render here and, where needed, feed
their sampled frames to the FFmpeg lane for final encoding.

Browser frame batches retain a bounded per-frame wall-clock deadline. By default it
is the source-owned `30,000ms + ceil(outputPixels × 15,000 / 1,000,000)` policy,
where `outputPixels` includes the declared device scale; it is capped at `120,000ms`.
Thus a 1920×1080 proof frame receives `61,104ms`, while a stalled or pathological
frame still aborts the shared Browser session. A programmatic caller may request a
different deadline only in the bounded 100–120,000ms range; this is common policy
across hosts and operating systems, not a platform-specific fallback.

Particles and ordered point clouds also lower static [`effects.trail`](trails.md) through fixed
Canvas2D strokes behind their sampled heads. The browser evaluates history from the requested frame
time only; it retains no wall-clock state and does not use GPU instancing or a physics solver.

[`pathReveal`](path-reveals.md) is available in browser and in a narrower fixed GPU path subset:
one validated stroked path can draw a normalized start/end window. Native does not approximate this
geometry; capability matching refuses `shape.path.reveal` before a native frame is rendered.

The capability catalog carries the same distinction. Native is the one named
block-glyph preview exception. GPU text admission requires manifest-font provenance,
runtime font-load and fallback evidence, complex-shaping fixtures, and the corresponding
capability features; it refuses text that cannot meet that separate contract.

## GPU scene lane

Purpose: strict hardware-WebGPU scene preview and FFmpeg frame production. Select a PNG preview with
`preview --lane gpu`, Debug `motion.preview.frame` with `lane: "gpu"`, or SDK
`preview({ lane: "gpu" })`; select final delivery with `frameLane: "gpu"`. Motion admits a trusted
Chromium executable and a hardware WebGPU adapter at execution time. A missing/software adapter,
device loss, cancellation, timeout, resource limit, or unsupported scene is a typed refusal: it
never falls back to browser or CPU pixels. This source description is not evidence that the current
machine has passed that admission, and it makes no throughput claim.

The shared static compiler admits bounded MotionIR scenes: manifest-bound text/captions, primitive
and fixed-subset path shapes, images, active video, ordinary points/particles/trails, masks and
static mattes, fixed effects, groups, camera/depth, fixed 3D/environment passes, and fixed
Motion-owned materials.

The separate **contained PNG base-color PBR direct-final subset** is not a general GPU capability
card or preview route. A `motion.scene3d.gltf.import` package qualifies only when its glTF 2.0
static triangles have embedded/GLB buffers, an sRGB PNG base-color texture with opaque linear
base-color/metallic/roughness/emissive factors, exact `TEXCOORD_0`, copied hash-bound PNG bytes (max 16 primitives/textures, 16 MiB decoded each, 48 MiB GPU, 4 MiB readback), and an immutable canonical
1280x720 scene. It then uses the separately fingerprinted PBR Browser session and streams straight
to FFmpeg with one direct final. Browser preview, Native, segmented/resume, JPEG, external URIs,
samplers, extensions/compression, skins, and animation refuse before fallback. The route is source
tested only here; it makes no hardware adapter, installed-host, or cross-device pixel claim.

Group ownership and local timing are authored through the bounded [Groups and local timelines](groups-and-local-timelines.md)
contract. Capability matching still decides whether a given renderer lane can realize that composition.

V25-B1 accepted implementation admits active video to the GPU **preview** only through a
host-owned provider; the package, CLI/Debug arguments, and browser page cannot select decoder,
scratch, or provider controls. The host snapshots each admitted package-local source once and
accepts only one zero-origin, non-attached CFR video stream with unambiguous PTS/frame-count
duration facts. Core quantizes the root playhead once to an integer microsecond, then owns the
trim, loop, group-local, visibility, and scalar playback-rate mapping. The provider may select the
corresponding CFR stream frame, but it must bind that selection, immutable-source hash,
decode-contract hash, decoded-RGBA hash, and Core request fingerprint before its pixels can draw.

The retained provider is deliberately small: its completed decoded-frame LRU is capped at 32
entries / 128 MiB, one decode is serialized and deduplicated for concurrent requests, and an
in-flight raw-RGBA frame may never exceed 64 MiB. It reserves each dynamic texture slot once for
the session and replaces only its exact verified RGBA pixels, so forward, backward, and random
scrubs do not allocate a new texture per request. The resulting GPU preview receipt contains
`output.gpuVideoPreview`: source and decoded-frame identities, the CFR selection, cache hit/miss /
eviction/deduplication and high-water facts, stable-texture metrics, and the explicit limitations
`audio-not-rasterized` / `final-not-attested`.

This is visual-only preview. It makes no audio, final-video staging, encoding, or mux claim, and
does not alter the existing GPU final delivery path described below. The qualified Linux RTX 5080 rig's native scrub
5080 accepted forward, backward, random, and repeated playheads with exact repeated pixels, one
retained dynamic texture, bounded cache and in-flight high water, zero late-allocation refusals,
and complete provider/GPU cleanup at runtime commit
`40b965bb69b02c2bcfc0b0972beaca2a07e4defa`.

Fixed rain, water, snow, and fog environments may use their authored 2..8-sample motion blur. The
GPU compiler lowers one exact-time environment draw per shutter sample, keeps scene and effect-mask
resources immutable, accumulates premultiplied samples in retained textures, and performs the
layer mask/effects/blend composite once. Admission still allows at most four authored environment
layers and separately bounds their actual sample work. Scene3D, materials, video, hybrid surfaces,
and compute particles remain outside this temporal path and fail closed instead of losing blur.

The fixed compute-particle route is not ordinary particle instancing. It accepts one normal-blend,
circular field at exactly 100,000..131,072 particles. The compatible v1 descriptor keeps one to
three radial/vortex sources and refuses effects, masks, and mattes. The closed v2 descriptor adds
one to four weighted origins; up to four ordered radial, vortex, flow, seeded-turbulence, finite
impact, or axis-plane-collision sources; a two-to-four-sample analytic trail; fixed flat/soft/glow
shading; and either one authored rect/rounded-rect mask or one static rect/ellipse/triangle
alpha/luma matte. It still requires normal blend and refuses a same-layer mask-plus-matte, wipe,
depth, temporal motion blur, arbitrary shader/formula, mesh or particle-particle collision, and
retained physics state. Package data never selects WGSL or workgroup shape. Both descriptors remain
pure functions of their seed and canonical `atMs`; smaller/ordinary particles remain Core
exact-time evaluation.

One isolated group may end with a governed local `motion.afterimage-stack@1.0.0` adjustment.
The package carries only the exact installed id/version and one to four bounded colour/offset
echoes; it cannot provide WGSL, JavaScript, native code, URLs, paths, browser flags, or resource
limits. Installation and revocation are explicit human-only Workbench operations. Motion owns the
fixed shader, one 160-byte uniform, one bind group, the existing group attachment pair, the resource
ceiling, and the opaque begin-use lease. Preview, streaming final, and segmented final each bind the
installed entry, normalized parameters, application sequence, resource high-water, cleanup, and
released lease into their evidence. Module plus active video, hybrid capture, or GPU reuse currently
refuses instead of opening a second execution/resource path.

Native Linux GPU-host qualification at runtime commit
`97dfc477843f8c50f8974fea5d3ee6fdea298771` rendered the reusable `Second Take` source through
RTX 5080 WebGPU and hardware FFmpeg. The module-on final was visibly different from its generated
module-off twin, retained the sharp source and later overlays, returned all module resources to zero,
and was byte-identical to a cold replay. This qualifies that fixed governed intrinsic; it does not
turn Motion packages into a general plugin or user-shader runtime.

One GPU final can additionally contain either one strict data-only package HTML surface or one
restricted-GLSL shader surface. Data-only HTML allows no script, active URL, interaction, temporal
CSS, embed/frame, or remote-origin behavior. Restricted GLSL is stable-read, validated, and rendered
as a single isolated legacy WebGL texture; WebGPU then applies the declared Motion transform, mask,
blend, effects, and surrounding composition. GLSL never becomes WebGPU package code. These hybrid
forms are final-video-only and mutually exclusive. They may use ordinary streaming or the governed
segmented path described below; neither form is a GPU preview fallback.

GPU final frames are straight raw RGBA and stream directly to FFmpeg, which remains responsible for
audio and container encoding. Tight mapped rows reuse the newly owned Node base64-decode buffer;
padded rows compact once; straight-alpha conversion mutates only that owned buffer. The readback
receipt records mapped/base64/decoded bytes, host allocations, compaction/alpha copies, and
observational host time. This is a bounded post-map accounting contract, not an end-to-end copy
count or zero-copy claim. The receipt also binds the adapter/runtime, static scene, resource
identities, decoded RGBA hashes, frame-plan sequence, and FFmpeg output. Durable segmented final
delivery is available for an admitted non-hybrid GPU scene or exactly one governed hybrid texture:
Motion derives and owns the checkpoint store, verifies a resume prefix, and never exposes segment
files, captured texture bytes, or concat control.

| Requested GPU fact | Result |
| --- | --- |
| Bounded static scene; fresh hardware adapter admission | One GPU PNG preview with frame-plan, adapter, and resource evidence. For admitted active video, it also carries `output.gpuVideoPreview` exact-time/source/RGBA/cache/texture evidence and its visual-only limitations. |
| Supported final scene | Straight raw-RGBA frames stream to FFmpeg; no substituted frame lane. |
| Human-installed governed afterimage module | One fixed Motion-owned group-local afterimage intrinsic with closed parameters, fresh begin-use lease, bounded resources, revocation, application ledger, and cleanup receipt; no package code or automatic install. |
| One data-only HTML source or one restricted GLSL source | Final-only governed hybrid capture, then GPU composition; never both and never package WebGPU code. |
| GPU segmented request | Supported for an admitted non-hybrid final or exactly one strict data-only HTML/web/canvas or isolated restricted-GLSL texture, with Motion-owned checkpoints and explicit resume. |
| Pre-render reuse/cache, idempotency reuse, materialized final, still/image-sequence final | Refused for GPU. A separately validated post-render identity can describe only the completed artifact. |

## Current SDR colour and alpha scope

Motion currently accepts its restricted CSS/hex authored-colour syntax as SDR
sRGB-encoded values. Unprofiled raster input is assumed to be sRGB; profile-bearing
image/video interpretation is not a portable Motion feature. Native PNG decode reads
raw 8-bit RGB(A) samples without ICC/gamma conversion. Browser image decoding,
filtering, blending, and internal alpha behaviour remain Chromium-managed.

The closed, source-generated [color pipeline contract](COLOR_PIPELINE.md) records the
explicit legacy compatibility intent and one exact `linear-srgb-sdr@1` final route. That
route is limited to a static opaque background plus bounded rectangles with normal
source-over. Each rectangle is either one canonical flat fill or an F2a static linear/radial
gradient with 2–16 canonical opaque stops interpolated in linear light; gradient keyframes and
every other shape/style remain refused. The route is rendered in a premultiplied linear-sRGB WebGPU target, explicitly encoded
to a straight-sRGB frame boundary, converted to limited BT.709 H.264 by the fixed
FFmpeg contract, and inverse-decoded for mandatory frame comparison before publication.
All other strict features, lanes, outputs, transports, audio, and fallbacks are refused.

Native frame PNGs expose straight RGBA and only premultiply temporarily for native
blur. Its normal and named blend modes work in encoded RGB; outside the exact strict
route Motion therefore makes no linear-light or cross-renderer blend/filter-parity claim. HDR, wide-gamut, ICC
profile conversion, OCIO, and user-selectable working spaces are unsupported.

### Fenced HDR10 implementation

The repository retains a narrow `internal/*` glTF PBR HDR10 implementation, but it
is not a public renderer lane or product capability. Its authenticated marker refuses
every generic final route before generic resource or output admission. It has no
declared Motion-document field, CLI command, Debug/MCP command, local SDK operation,
Action, integration capability, connector, or host route. Those internal subpaths are
implementation details, not supported API: no HDR/wide-gamut output, colour-management,
installed-build, or native-qualification claim follows. The public machine contracts
(`schemas/motion.schema.json`, `schemas/debug.json`, and `schemas/actions.json`) publish
no HDR operation or field.

For final media, FFmpeg converts full-range renderer RGB to limited-range SDR BT.709
and tags the delivered stream. When delivered-colour verification is enabled (the
default), `receipt.output.color.observed` contains the FFprobe tags actually read
from that artifact. It is delivery evidence, not proof that every frame-producing
lane shares a colour-managed working space.

## FFmpeg lane

Purpose: final media. The FFmpeg lane encodes, transcodes, muxes, and validates,
invoked with `shell:false` and validated input/output roots. Highlights, all real
behavior today:

- **Media inputs.** v0.2 final audio accepts only regular, non-symlink package-local **WAV, FLAC,
  MP3, Ogg (`.ogg`/`.oga`), or Opus** files under a canonical declared input root. Each is opened
  with FFmpeg's `file` protocol and its one fixed data-only demuxer. M4A/MP4/MOV and
  Matroska/WebM inputs, playlists, concat/reference files, parent escapes, and protocol-like input
  strings are typed-refused as `unsafe_input_path` before FFmpeg starts. Before any FFmpeg or
  FFprobe read, admitted audio and quality-delivery files are copied into one private,
  content-addressed snapshot. The copy is bounded at **16 GiB**, matching Motion's default
  attested-artifact limit: a supported large ProRes delivery can be quality-checked, while copy
  work and private staging remain finite. This is a deliberate v0.2 security compatibility
  boundary, not a statement about final-video output formats.
- **Output formats.** H.264/HEVC MP4 and VP9/AV1 WebM where the local capability
  probe permits them, GIF, JPEG/stills and PNG sequences, and alpha-capable
  exports (VP9-alpha WebM, ProRes 4444). ffprobe supplies validation metadata.
- **Per-source two-pass loudness normalization.** When an individual track opts in,
  Motion measures that decoded source before building the final command. A complete source
  measurement feeds that track's second apply pass (`loudnorm`); when source measurement is
  unavailable Motion falls back to single-pass and records which track-level route ran. This is
  separate from the document master below.
- **Document master bus.** A package may declare bounded final-program gain, fade-in/out, and
  `loudness` controls under `motion.audio.master`. Master fades must fit the document duration;
  a master without resolved audio or a final-video audio preset is refused. A declared master
  loudness target is realized once after the mix with fixed **single-pass** `loudnorm` (not
  two-pass measured normalization or broadcast mastering), then measured again from the delivered
  muxed file. The final receipt records `output.audio.master.controls`, the applied
  `loudnessRealization`, delivered `readback`, and `loudnessConformance: "passed"` when a loudness
  target is declared; volume/fade-only masters do not trigger a redundant analysis pass. An incomplete
  readback or target miss fails finalization. If that failure aborts an unpublished output stage,
  both materialized and streamed final delivery retain the typed failure but remove the deleted
  output's path, hash, and artifact evidence from their result or receipt.
- **Matched crossfades and envelope production.** `motion.audio.crossfade.set` only applies a
  linear or equal-power fade to two already-exactly-overlapping local audio sources; it never
  moves clips. `motion.procedural.audio-envelope.produce` decodes only a trusted local, untrimmed,
  non-looping, playback-rate-1 WAV, FLAC, MP3, Ogg, or Opus audio layer into bounded mixed-channel
  RMS samples for existing data-only audio-envelope nodes. It rejects video/reference-bearing
  containers, unresolved, muted, retimed, looped, and trimmed sources rather than approximating
  their timing. Debug, MCP, and local-SDK invocation uses the caller-bound governed decoder; its
  `resources` evidence is included in the result and receipt only when that runner actually reports
  it (the source and sample hashes remain the content proof).
- **Sidechain ducking.** A ducking track can duck a bed against trigger layers,
  with the trigger layer ids resolved to concrete FFmpeg input indices.
- **GIF palette.** GIF export uses a generated palette so the lightweight
  animation preset stays legible.
- **Hardware encoding, probe-gated.** Hardware encoders (NVENC / VideoToolbox /
  QSV / AMF) are selected only after a per-machine probe proves the candidate
  actually initializes; on any hardware-encode failure the encode retries the
  software encoder and the receipt records the fallback and the reason. A machine
  with no acceleration renders in software and says so.

### Audio-master verification matrix

| Check | Required proof |
| --- | --- |
| Master data | Package validation accepts only bounded master fields; fades do not exceed document duration. |
| No-audio refusal | Materialized and streamed final planning refuse a declared master with no resolved local audio or an audio-less preset. |
| Crossfade | The edit receipt proves the exact overlapping layer ids, duration, curve, and unchanged timing. |
| Envelope | The producer receipt binds source-asset hash, source layer, sample interval/count, and sample hash; the saved package is reloaded. |
| Final loudness | The final render receipt proves the single-pass realization and delivered-file integrated LUFS, true peak, LRA, and passed target conformance. |

Motion resolves `ffmpeg`/`ffprobe` from `PATH` by default; set
`SHELLX_MOTION_FFMPEG` / `SHELLX_MOTION_FFPROBE` to pin explicit executables (on
Windows, Motion also checks user-local ShellX-family tool folders for a shared
FFmpeg install).

**Chromium is the third external tool, and it is needed by the DEFAULT lane.**
`render` rasterizes frames in a real Chrome/Chromium unless you pass
`--frame-lane native`, and Motion does not ship a browser — the dependency is
`playwright-core`, which deliberately downloads none. Motion looks, in order,
at `SHELLX_MOTION_BROWSER`, then Playwright's browser cache (highest build
number first: `PLAYWRIGHT_BROWSERS_PATH`, `~/.cache/ms-playwright`,
`~/Library/Caches/ms-playwright`, `%LOCALAPPDATA%\ms-playwright`), then
well-known system installs. Unlike the codec tools it is never resolved from
`PATH`, so a browser in an unusual location needs the override:

```bash
# Get one Motion is guaranteed to find (no elevation, installs into the cache above).
npx playwright-core install chromium

# Or point Motion at a copy you already have.
export SHELLX_MOTION_BROWSER=/opt/google/chrome/chrome
```

Two rules about that search are worth knowing before you hit them, because both
are refusals rather than fallbacks:

- **`SHELLX_MOTION_BROWSER` is a pin, not a hint.** It must be an ABSOLUTE path,
  and if it names something Motion cannot use, Motion stops there — it will not
  quietly launch a different browser. `doctor` reports `chromium` as `broken`
  with `source: "override"` and names the value it rejected, so a typo shows up
  as a typo instead of as a render against the wrong binary.
- **Motion only takes a browser out of a cache path it can attribute to you.**
  The cache root, every `chromium-<build>`/layout directory, and the executable
  leaf have to be canonical (not symlinks), owned by your account or root, and
  not group/world-writable; Motion rechecks the selected cache path before it
  probes or launches Chromium. A malformed build name is also skipped. This
  matters for the common CI/Docker pattern of pointing `PLAYWRIGHT_BROWSERS_PATH`
  at a shared cache: what Motion finds there gets EXECUTED, including by the
  read-only `doctor` pre-flight. When a cache is skipped, `doctor` says which
  component was rejected and why, next to the "no browser found" line.

  A Playwright install made under `umask 0002` commonly leaves its cache,
  `chromium-<build>`, and `chrome-linux64` directories group-writable. This is
  not a browser fallback: Motion refuses that cache even when its owning group
  happens to have the same name as your account. Inspect the exact component
  named by `doctor`, then, as the cache owner, remove group/other write from
  each component it names and rerun `doctor`; do not change ownership, relax an
  ancestor, or set `SHELLX_MOTION_BROWSER` merely to bypass the refusal.

**Ask before you render.** `shellx-motion doctor --json` and the
`motion.platform.requirements` debug/MCP command return the SAME object — one
shared readiness result, not two descriptions of one:

- `ok` says the probe ran. `satisfied` says the machine is ready. A missing
  binary is a successful report, not a failed command.
- Each tool carries `status` (`ready` / `missing` / `broken` / `unverified`),
  its version, how it was resolved (`source`: `path` / `override` /
  `shellx-family`), what it is needed for, its override variable and
  per-platform install commands. All three tools are probed by running them, so
  a Chromium that is present but cannot start — the usual shape on a minimal
  Linux container missing its shared libraries — reports `broken`, not `ready`.
- `capacity` reports the same stable adaptive RSS/point tier used by the local governor and both
  frame lanes, so a host can show whether a dense point package fits before starting it.
- Pass an `operation` (`preview.frame`, `render.final`, `quality.check`; CLI
  `--operation`) to scope the answer to what you are about to attempt. FFmpeg,
  FFprobe and Chromium are modelled separately, so a machine that can encode but
  cannot read the encode back reports exactly that instead of one red light.
- **`satisfied` is about the DEFAULT invocation.** Some tools are needed only by
  the route an operation takes with no extra arguments, and `render.final` is
  one: it needs FFmpeg whatever happens, and Chromium only for the default
  browser frame lane. A machine with FFmpeg but no browser therefore reports
  `satisfied: false` with `blockedBy: ["chromium"]` — because a plain `render`
  *will* fail there — alongside:

  ```jsonc
  { "operation": "render.final",
    "satisfied": false,            // the default route is blocked
    "blockedBy": ["chromium"],
    "possible": true,              // but the machine can still render
    "alternative": {
      "flag": "--frame-lane native",
      "avoids": ["chromium"],
      "packageDependent": true,    // may still refuse for a given package
      "tradeoff": "…" } }
  ```

  Read `possible: false` as "install something"; `possible: true` with an
  `alternative` as "not the default way — here is the way". `packageDependent`
  is the honest caveat on the native route: it has no font rasterizer, so a
  delivery render refuses (`native_text_not_deliverable`) any package whose text
  is lowercase or names a font family. Offer it as something to try, not a
  guaranteed one-click fix.

**Encoder provenance.** Every final FFmpeg receipt records `output.tools.ffmpeg`
— and `output.tools.ffprobe` once a quality check has read the media back — with
the tool's bounded version line and how it was resolved. The executable is
recorded as a bare command name, never an absolute path, so a receipt stays
shareable evidence.

## Streamed final video

Ordinary file-video final renders use a bounded streamed handoff: one rendered
frame is accepted by the encoder before the next is produced. CLI `render`,
Debug/MCP `motion.render.final`, local SDK `render`, and direct rendered-media
connectors adopt that default through the high-level
`@shellx-motion/renderer-ffmpeg` `renderStreamingFinal(input)` API. It accepts a
loaded Motion package, a chosen browser or native frame lane,
final-video/output/audio/quality inputs, and local job/tool controls. A successful
`shellx-motion/receipt@1` puts the transport evidence at
`receipt.output.frameTransport`; its typed frame-lane, frame-count, retention,
producer, and encoder-handoff evidence identifies the streamed delivery and
attests `retainedFrameCount: 0`. The result also carries the FFmpeg command that
actually ran.

The intentionally lower-level browser and native producers each accept an optional
closed-open canonical `range` (`startFrameIndex`, `endFrameIndexExclusive`). It renders
only that interval but emits the original global frame indices and timestamps—there is
no hidden rendering of preceding frames. Browser producer `frameCount` is the selected
range length and its metrics/evidence also name `timelineFrameCount` and the complete
range. Native preserves its existing required `frameCount` as the full canonical timeline
count (it must still equal `ceil(durationMs / 1000 * fps)`); its optional `range` is the
non-breaking selector, with the same range evidence. Both reject non-safe, empty, or
out-of-timeline ranges before they open a session or create scratch, apply the global
frame budget before selection, and retain one PNG only while awaiting the sink. Omitting
`range` remains the full-timeline behavior. These are producer APIs: public segmented delivery
does not expose those ranges, a store path, segment artifacts, or concat controls.

The public pure companions are `planFinalVideoFrameTransport(facts)`, which
returns the closed `delivery` / `reason` decision, and
`planStreamingFinalCommand(input)` is its dry-run companion: it validates the
static command without probing a tool, admitting a job, creating a producer, or
changing the filesystem. A surface result or dry-run exposes `frameTransport`
only as that two-field planner decision; it is not the full receipt evidence.
For CLI, Debug/MCP, and the local SDK, materialisation is selected before
execution for explicit `keepFrames`, a captured browser workflow, exact-source
quality comparison, a streaming quality-capacity refusal, or an injected test
renderer. PNG stills and image sequences are outside this planner. A streamed attempt never silently
falls back to materialized frames after it fails. Direct
connectors expose no retention switch or hidden frame directory; when planning
requires materialization, they return typed pre-execution failure evidence
instead.

The completed receipt keeps that distinction: a streamed final video has the
full bounded evidence at `receipt.output.frameTransport`. A materialized final
video instead records the two-field decision at
`receipt.output.frameTransportPlan`, alongside `resourcePreflight`; it does not
claim streamed producer or encoder-handoff evidence.

## Opt-in attested render reuse

Blocking Debug/MCP `motion.render.final` has one opt-in reuse field:
`reuseAttested: true` (CLI: `shellx-motion debug render-final --reuse-attested`).
It is deliberately not a general cache API: there is no caller cache root, key,
descriptor path, or receipt selector. Motion derives a v2 key from the resolved
file-producing render plan, exact output-relative identity, bounded full-package
bytes, optional workflow bytes, and the quality-manifest bytes plus the ordered
hashes of every declared baseline. Its package scan rejects symlinks and changes
while reading, and is capped at 4,096 files / 512 MiB; workflow, the manifest,
and each quality baseline are capped at 4 MiB. Reuse permits at most 64 quality
baselines, each a direct regular non-symlink file inside the manifest's canonical
directory; missing, symlinked, escaping, or oversized baselines are refused
before lookup. A request outside those bounds is refused for reuse while ordinary
rendering remains available.

The destination must be outside the package root. Reuse records and receipts
live under that output root, and a caller-supplied `receiptsRoot` must be inside
it. This prevents cache reuse from becoming a way to browse another output tree.
The public v2 descriptor is not producer authority: every stored entry also has
a root-bound HMAC producer proof issued with a host-held key. The installed
server retains that key in its private per-user Motion access directory; a
co-writer that can recompute public media, receipt, and descriptor hashes still
cannot mint a usable hit. A missing proof or a proof from another host authority
fails closed. On a verified hit Motion rechecks the current package, selected static lane and
typography contracts, descriptor/receipt identity, root-relative output path,
artifact bytes, and that producer proof. It writes a fresh, actor-attributed `render.reuse` receipt
that links the source `render.final` receipt and original tool provenance. It
does **not** start Chromium or FFmpeg, and therefore does not claim either tool
is currently available or that media was freshly rendered.

Only file-producing still/GIF/final-video presets are eligible. `dryRun`,
`png-sequence`, `keepFrames`, `motion.job.submit`, batch rendering, and the
legacy `shellx-motion render` route remain outside this feature. Missing output
and descriptor permits a normal render followed by verified descriptor
publication. A changed input derives a new key. A malformed descriptor, changed
artifact/receipt, output without its matching descriptor, or a symlink/root
mismatch fails closed as `cache_integrity_failed`; Motion never silently
overwrites or rerenders that destination. Concurrent fills return `cache_busy`
until the root-local lock is released; stale locks are never broken
automatically.

### Observe exact reuse without rendering

Debug/MCP `motion.render.cache.plan` (CLI: `shellx-motion debug render-cache-plan`) is the compact,
non-mutating answer to “would this exact v2 reuse entry be usable now?”. It accepts only
`packageRoot`, `outputPath`, the render identity selectors (`preset`, `frameLane`, `atMs`,
`minUniqueFrameHashes`), and trusted `workflowPath` / `qualityManifestPath` inputs. It accepts no
cache root, cache key, descriptor path, receipt root or selector, artifact path, idempotency key,
or inline workflow. It is `render_motion` despite `mutates: false`: observing a caller-selected
output root is deliberately not available to the broader `read_motion` tier. It uses the same
opaque host producer authority as execution and never treats public hashes alone as a hit. It registers no MCP
resource, URI template, prompt auto-execution route, or subscription surface.

The bounded, path-free `shellx-motion/render-cache-plan@1` result is at most 4 KiB canonical UTF-8.
It returns the identity digest and input categories, closed checks, the source descriptor id and
render-receipt/artifact hashes only for a host-authenticated verified hit, and no receipt, artifact, descriptor, lock,
or absolute path. A **hit** means the v2 verifier has proved the descriptor, source receipt, and
artifact against the current exact identity. A **miss** means only that the entry is absent or its
otherwise-safe output root is not materialized. Unsupported, unsafe, integrity, existing-output,
and busy states are typed **refusals**, never optimistic misses.

`observedAt` is an observation timestamp, not a lease or render authorization. The planner creates
no directory, lock, descriptor, receipt, artifact, or browser/FFmpeg process, and it does not
resolve script provenance authority. Its `missOnlyChecks` names the producer/tool readiness,
`script_provenance_resolution`, quality execution, publication, and post-render recheck work that
only a real miss can perform. `motion.render.final` does not accept a plan result and rechecks all
identity, static admission, output-root, descriptor, and exclusive-lock facts before a hit or fill.

For intentional lower-level integrations, the producer roots are also public:
`@shellx-motion/renderer-browser` exports
`createBrowserStreamingFrameProducer`, and
`@shellx-motion/renderer-native` exports `produceNativeFrameStream` plus their
typed refusal/evidence types. They are one-frame producer APIs, not alternate
final-render commands; the FFmpeg streaming foundation and encode policy remain
private implementation details. Public terminal evidence never retains frame,
PNG, or render-result arrays, and removes terminal-frame output paths.

Browser containment is cooperative and conservative: the browser producer
reports the Node-observed Chromium process-tree evidence it can observe, but it
does not claim exact browser-only RSS or that Chromium is contained by FFmpeg.
FFmpeg process containment and Chromium session containment are separate
boundaries.

## Durable segmented final video

For a long, restartable final video, opt in with the closed selector
`segmented: { segmentFrames, resume? }` on Debug/MCP `motion.render.final`, the
local SDK render request, or `motion.job.submit`. The CLI equivalent is
`render … --segment-frames <positive integer> [--resume-segments]`. The public
renderer API is `renderSegmentedFinal(input)`. It accepts a loaded package and
this selector, never a segment directory, segment file, concat list, or raw
range producer.

Motion derives one checkpoint store from the absolute output path, reserves it
with an exclusive sibling lock, and never breaks a retained lock automatically.
Each FFV1 checkpoint carries canonical range, frame-hash, package-fingerprint,
producer/script-execution verdict, and FFprobe readback proof. The immutable store
plan binds the current host-owned verdict before create or resume, so a completed
prefix cannot be reused under changed script authority. A completed run verifies concat and output readback,
publishes with a no-clobber hard-link identity proof, and removes exact owned
intermediates. An interrupted run retains only verified checkpoints; set
`resume: true` / `--resume-segments` to reopen them explicitly. The successful
receipt's `output.frameTransport` declares
`delivery: "resumable-ffv1-segments"`, the plan fingerprint, bounded segment
facts, prefix/new-work counts, complete producer warnings/evidence (including the
verified resume prefix), quality facts, and cleanup outcome. Browser-backed success
also places the same canonical verdict at `output.scriptExecution`.

Segmented delivery currently supports only `mp4-h264` and `webm-vp9-alpha`.
It refuses captured browser workflows, unresolved active scripts, exact-source
quality manifests, motion-density quality, `keepFrames`/`framesDir`, and
attested-reuse selection rather than silently changing contracts. Its typed job
errors distinguish a busy store, invalid checkpoint/publication proof, source
change, unsupported contract, and retryable incomplete delivery. Coordinator
jobs propagate cancellation into the same admitted FFmpeg and producer work; a
cancelled job settles as `cancelled`, not as a completed video.

For `frameLane: "gpu"`, segmented delivery creates and revalidates the GPU browser/runtime identity
inside the admitted job before the store opens. A non-hybrid scene follows the existing retained
GPU path. A hybrid scene may contain exactly one strict data-only HTML/web/canvas source or one
isolated restricted-GLSL source. Motion freezes source bytes, browser executable/version and runtime
policy, exact Core integer-microsecond capture requests, texture dimensions, capture-plan identity,
and the expected range schedule before opening the store. Each range must publish its exact ordered
pixel ledger and cleanup evidence; source/runtime/policy/range changes, missing cleanup, a second
hybrid source, scripts, remote input, or time-capable HTML refuse before checkpoint publication.

The accepted native V25-B2 film uses the restricted-GLSL branch on the qualified Linux RTX 5080 rig. An interrupted
four-range render resumed its verified prefix and matched a cold replay in all 360 frame hashes,
frame-plan hashes, aggregate capture identities, and final MP4 bytes at runtime commit
`77faf57440bc4b7d2f203028664ae1da3995acc0`. This is not cross-host performance evidence, and
the strict HTML aliases have source/integration rather than native visual qualification.

Stills and image sequences keep their distinct output paths. Ordinary streaming
and segmented delivery are separate modes: ordinary streaming has no durable
checkpoint/resume workflow, while segmented delivery never silently falls back
to materialized frames or ordinary streaming.

`pnpm renderer:benchmark:matrix` is a renderer/producer throughput harness. It
keeps the cold/warm browser-session coverage (including cache hits) and adds
one-frame-at-a-time streamed browser/native workloads; its extended native 60-second case
also samples this Node process's RSS. It does not invoke FFmpeg, write a final
video receipt, measure a browser-only or process-tree RSS, or make a GPU claim.
Use final-render integration tests and their receipts for those separate claims.

## Choosing a lane

`--lane` does **not** mean the same thing in `preview` and `render`. Read this
before scripting either one.

| Surface | Option | Accepts | Default | What it selects |
|---|---|---|---|---|
| CLI `preview` | `--lane` | `native`, `browser`, `gpu` | `native` | The frame renderer that draws the PNG. `gpu` is the strict bounded scene preview and never a fallback. |
| CLI `render` | `--lane` | `native`, `ffmpeg` | `ffmpeg` | The output stage. |
| CLI `render` | `--frame-lane` | `native`, `browser`, `gpu` | `browser` | The frame renderer feeding FFmpeg. GPU is strict raw-RGBA video delivery, not a fallback. |
| `motion.render.final` | `frameLane` | `native`, `browser`, `gpu` | `browser` | The typed frame renderer for still, sequence, or FFmpeg delivery. GPU accepts only its strict final-video subset. |

Anything else is rejected: `preview --lane ffmpeg` fails with `unsupported_lane`,
and so does `render --lane browser`. To render final media from browser-drawn
frames — the common case for rich scenes — the browser choice is `--frame-lane`,
not `--lane`.

The debug/HTTP/MCP command `motion.render.final` accepts `frameLane: "browser"`,
`"native"`, or `"gpu"`. Native is an explicit bounded renderer choice for still,
sequence, and FFmpeg delivery frames: unsupported layers or non-deliverable native
text return a typed refusal instead of falling back to the browser. Browser workflows
still require `frameLane: "browser"`. GPU is direct/segmented FFmpeg video only and
refuses browser workflows, materialized frames, cache/reuse, idempotency reuse, and
still or image-sequence delivery.

`render --lane native` is also not a video path: it writes **one** PNG still at
`--at-ms` (default 0) through the native preview renderer.

```bash
# Native preview frame (default) — no browser, no codec.
shellx-motion preview /path/to/package --out .scratch/previews

# Browser-drawn preview frame.
shellx-motion preview /path/to/package --lane browser --out .scratch/previews

# Strict bounded WebGPU scene PNG preview. Refuses unsupported content; never falls back.
shellx-motion preview /path/to/gpu-scene-package --lane gpu --out .scratch/previews --at-ms 500

# Final media, browser-drawn frames (the default frame lane).
shellx-motion render /path/to/package --lane ffmpeg --out .scratch/out.mp4

# Strict raw-RGBA GPU final video. It refuses instead of switching frame lanes.
shellx-motion render /path/to/gpu-scene-package --lane ffmpeg --frame-lane gpu --out .scratch/gpu-out.mp4

# Final media, native-drawn frames — no browser needed.
shellx-motion render /path/to/package --lane ffmpeg --frame-lane native \
  --out .scratch/out.mp4

# One native PNG still, not a video.
shellx-motion render /path/to/package --lane native --at-ms 1500 \
  --out .scratch/still.png
```

Every lane produces a receipt naming the lane it used, so a native preview and a
browser render are never confused as equivalent evidence. Where that receipt goes
differs by command — see [Receipts and trust](receipts-and-trust.md).

## Motion and easing

Animation is keyframes with easing. Beyond the standard easing modes, Motion
provides **spring** dynamics and reusable **transition/typography presets** so
enter/exit and property motion stay consistent across a pack. Spatial position
paths are a typed, data-only extension over aligned `transform.x`/`transform.y`
keyframes: temporal easing controls progress along a segment while independent
spatial handles (`linear`, `smooth`, `broken`, `auto`) control its cubic
geometry. These are declared data, not expressions or code.

The seven named [transition presets](transition-presets.md) are discoverable through
`motion.timeline.transition.presets` and apply through one atomic package revision with
`motion.timeline.transition.preset.apply`.

## Resource safety

Final frame-sequence renders fail before touching the filesystem if they exceed
36,000 frames or 80 billion pixel-frames. These are local resource-safety limits,
not quality limits — split an unusually long or high-resolution motion into
bounded jobs rather than letting scratch disk grow without bound.

### The memory ceiling a rich browser render actually meets first

Long before either of those limits, a browser-lane render meets the job
governor's adaptive **resident-memory ceiling**: `maxProcessTreeRssBytes`. Motion reserves the
larger of 4 GiB or 20% of physical RAM, divides the remaining physical pool across
`maxConcurrentJobs`, and rounds down to 256 MiB. A calibrated 6 GiB/job floor is admitted only when
physical RAM can preserve that reserve across every concurrent job; currently free RAM can raise
the ceiling above the floor. This avoids collapsing healthy macOS hosts to 512 MiB when the OS
reports reclaimable cache as used memory. The adaptive result is clamped to 512 MiB … 64 GiB;
**6 GiB is also the fallback when host facts are unavailable**. The trusted
`SHELLX_MOTION_MAX_JOB_RSS_BYTES` override remains authoritative (64 MiB … 1024 GiB). When the
browser runtime exposes no stable Chromium root PID, the receipt records
`cooperative-browser-session`: the governor samples the hosting Node process tree as a conservative
fallback, not an exact per-job Chromium-tree measurement. Encoder overlap may be included in that
scope. Crossing the admitted ceiling aborts the job with `job_rss_limit_exceeded`. Through the CLI, the
failure is written to stdout as a structured JSON failure envelope (`ok: false`
with `error.code: "job_rss_limit_exceeded"`) and the process exits non-zero.

WebGL `environment` layers (rain / water / snow / fog), `effects.motionBlur`
supersampling, and browser-lane particle work are real, but a full-length delivery
render at 1080p is where their cost is paid. The narrower native seeded-particle
path is CPU rasterization; it does not make WebGL, GPU, or physics-field claims. A
render launches Chromium once and reuses a pooled context and page for the entire
sequence, so **peak memory grows with the frame count**, not just with the
complexity of one frame.

`doctor --json` and `motion.platform.requirements` expose that exact process-wide capacity snapshot.
The same snapshot selects point-cloud tiers: portable 8,192; elevated 16,384; dense 32,768; maximum
65,536 points/layer. State-record and canonical-payload limits scale with the tier. A 64 GiB host
with 48 GiB free, 16 logical CPUs, and the default two concurrent jobs resolves about 17.5 GiB/job
and the maximum point tier. A weaker host refuses an oversized package before browser launch or
native raster allocation; it never silently truncates the cloud.

Measured on one host (WSL2, Chromium 151, 1920×1080, 30 fps, reading
`resources.peakProcessTreeRssBytes` from the returned receipt) — the absolute
numbers are that machine's, the shape is the transferable part:

| Scene | Frames | Peak process-tree RSS |
|---|---|---|
| text + shapes, no WebGL | 120 | 1.15 GiB |
| one rain environment + 3-sample motion blur | 180 | 2.83 GiB |
| the same package extended to 15 s | 450 | 4.40 GiB |
| rain + snow, motion blur removed | 450 | 2.65 GiB |
| rain + snow with 3-sample motion blur | 450 | 5.07 GiB |
| the 15 s rain package at `quality: "preview"` | 450 | 4.03 GiB |

So a 15-second 1080p30 piece with two environment layers and motion blur sits at
roughly 84% of the default ceiling with nothing left for a third environment or a
longer cut. Reduce the frame count per job first (render in segments and
concatenate) — it is the only lever measured to move peak memory proportionally.
Removing `effects.motionBlur.samples` is the next largest. Lowering
`environment.quality` from `cinematic` to `preview` halves the shader's effective
depth layers and is recorded in the receipt, but moved peak memory only ~8% in the
measurement above, so do not rely on it to rescue a render. Raising the ceiling is
a host-operator decision; note that `maxConcurrentJobs` defaults to 2, so two jobs
can each reach it on the same machine.

Every render receipt carries `resources.peakProcessTreeRssBytes` next to
`resources.policy.maxProcessTreeRssBytes`. Render a short prefix, read the ratio,
and scale it against the length you need rather than guessing.

### Materialised-sequence preflight

Before a CLI, Debug/MCP, or local-SDK final render takes a materialized exception
path, Core evaluates the same materialised-sequence preflight. The streamed default
does not allocate the full frame-request array, retained browser results, or browser
frame-cache entries modeled by this gate. The preflight preserves the absolute
36,000-frame and 80-billion-pixel-frame ceilings and, for browser delivery, compares
a conservative calibrated RSS upper envelope with the resolved admission budget
(80% of the trusted process-tree RSS ceiling by default). The model retains the measured browser/session
floor for short sequences and derives visible-layer overhead from recorded high-watermarks.
Above the two-environment, three-sample reference, it also applies a conservative
upper factor inferred from measured environment and blur behavior; it never discounts
a simpler package. `render --dry-run` and
`motion.render.final` with `dryRun: true` run that exact gate and return the same
typed `render_resource_preflight_exceeded` refusal as execution, before frames,
output directories, or encoders are created.

Dry-run output exposes `resourcePreflight`; final-render receipts expose
`output.resourcePreflight`. Both name the resolved RSS ceiling/admission budget and
source, the estimate and its calibration, the static ceilings, and the
materialisation cardinality. A host can configure the existing trusted
`SHELLX_MOTION_MAX_JOB_RSS_BYTES` ceiling; it may set the stricter trusted
`SHELLX_MOTION_MAX_MATERIALIZED_SEQUENCE_BYTES` cap, but cannot override the
static ceilings. This is an admission guard for the materialised exception paths:
they produce their bounded sequence before invoking the encoder.

## The job model, as it actually behaves

**Compatibility render calls block; the persistent local coordinator also supports
submission.** `motion.render.final`, the CLI `render` command, and legacy SDK
`render()` return a completed result. A long-lived Debug API/MCP or local SDK host
calls `motion.job.submit` (or `submitRender()`), which returns a durable `jobId`
before expensive work starts. Coordinator submission deliberately admits **only** an ordinary
streamed final-video FFmpeg render. It refuses workflow capture (inline or by path), quality
manifests, retained frames, dry runs, still/image-sequence presets, and every other
materialisation selector; use blocking `motion.render.final` for those compatibility paths. For
the admitted route, the coordinator owns the worker AbortSignal, so `motion.job.cancel` reaches
the producer and encoder process tree. Its acknowledgement sets `cancelRequested`; terminal
`cancelled` is written only after the worker has actually settled.

Coordinator submission and controls require an authenticated owner principal. A direct local SDK
or direct HTTP coordinator host configures a trusted `callerId` in its host context, never in an
untrusted request body. MCP and WebSocket clients instead receive a server-minted connection
principal. A non-coordinator compatibility render may remain unattributed when no caller identity
is configured, but it cannot gain coordinator controls from that fallback.

- **Live jobs** — `$XDG_RUNTIME_DIR/shellx-motion/job-leases` (`%LOCALAPPDATA%`
  on Windows, or a per-user temp path). Overridable with
  `SHELLX_MOTION_LEASE_ROOT`.
- **Finished jobs** — `.../job-records`, overridable with
  `SHELLX_MOTION_JOB_RECORD_ROOT`, retained for 7 days or 1000 jobs, whichever
  binds first.
- **Coordinator events** — `.../job-events`, under
  `SHELLX_MOTION_JOB_COORDINATOR_ROOT` when set, otherwise
  `$XDG_RUNTIME_DIR/shellx-motion/job-events` (or `.scratch/job-events` without an
  XDG runtime). Each job has an atomic ordered JSON event snapshot.

Live leases and terminal records are generic best-effort reporting: a compatibility render may
finish even if that reporting storage later degrades. Coordinator submission is stricter: Motion
does **not** start an accepted coordinator worker until its `submitted` event (and a retry's
`retry_submitted` event) is durable. If later event persistence fails, event reads fail closed; a
cancellation still signals the owned worker but returns typed persistence failure rather than a
false acknowledgement.

A job reports `lifecycle` `pending` → `running` → `ended`, an `outcome` of
`succeeded` / `failed` / `cancelled` / `skipped` once ended, and `pollAfterMs`
while it is still live — when `pollAfterMs` is absent, stop polling. One render is
one job: the internal operations it leases capacity for are never reported
separately. `job_unknown`, `job_expired` and `job_not_visible` describe the
*query*, never the job. If you omit `jobId`, Motion mints one and returns it on the
result envelope — enough to look the job up afterwards, but not to watch it while
it runs, so **for a progress UI, always supply your own**. See
[host-integration.md](host-integration.md) for the full contract.

The local SDK exposes `submitRender()` for that same streamed-only lifecycle. Its handle provides
`id`, `status()`, `events()`, `cancel()`, and `retry()` and must not claim terminal cancellation
while a worker is still running. Supply `jobId` for a reconnecting progress client; Motion mints
one only when it is safe to learn the id from the submission response. Its request type
intentionally excludes workflow, quality, retained-frame, and dry-run fields; legacy `render()`
remains the blocking result convenience for callers that need a materialized compatibility path.

The `motion.render.*` lifecycle commands are a different thing: **views over
receipt files**, not over processes. A receipt exists only once its render has
finished writing evidence, so these cannot see a queued or running render — use
`motion.job.*` for anything live, and these for the historical or batch view:

These receipt-root operations currently require Motion's Linux-only stable-reader capability.
With a `receiptsRoot`, macOS and Windows return `capability_unavailable` before reading or writing
receipt state; `motion.job.*` remains the portable route for live progress.

- `motion.render.status` and `motion.render.queue` read a `receiptsRoot`
  directory and summarize the render receipts found there
  (`packages/debug-api/src/domains/render-lifecycle-read.ts`). `progress` is
  `completed / total` counted from the child-job statuses recorded inside a
  **batch** receipt; a single render is 1/1 (or 0/1 while `not_run`). It is a
  count of finished work, not a live percentage. Point them at a directory with
  no receipts and they honestly report zero jobs.
- `motion.render.cancel` and `motion.render.retry` remain historical receipt
  annotations. They never signal a process or create a new worker; use the
  coordinator controls for live work.

### Concurrency is bounded per machine, not per process

Expensive work (encodes, browser sessions, native renders, batches) passes through
one admission controller with a concurrency cap, a queue depth, a wall-clock
deadline and a resident-memory ceiling. That cap is **machine-wide for one user**:
every Motion process — a Cut agent, a Design Studio agent, a CLI invocation — takes
a lease from a shared per-user directory before it starts, so three callers under a
cap of two get two concurrent jobs and the third waits, rather than each getting
its own cap and the memory ceiling multiplying by the number of callers.

Practical consequences for a caller:

- A render may sit waiting for capacity another process holds. That wait counts
  against the same queue deadline, and exhausting it reports `job_queue_timeout`,
  which is retryable.
- `SHELLX_MOTION_LEASE_ROOT` overrides where leases live. The default is
  `$XDG_RUNTIME_DIR/shellx-motion/job-leases` (`%LOCALAPPDATA%` on Windows).
- Leases are reclaimed when the holding process dies or stops refreshing for 30
  seconds, so a crashed render cannot permanently consume machine capacity.
- Coordination **degrades rather than fails**. If the lease directory cannot be
  created or read, Motion still renders, bounded only within each process, and
  says so: the governor snapshot reports `machineWide: false`.
- Scope is per-user. Two different OS users on one machine do not see each other's
  leases and can still overcommit the hardware between them.

**Visibility is per-owner even though scheduling is global.** Each job records the
caller that created it, and a caller sees only its own work: an agent embedded in
Cut cannot enumerate Design Studio's jobs, even though both compete for the same
machine capacity. Capacity is a property of the machine; evidence is a property of
the requester. Asking about a job that belongs to someone else reports
`job_not_visible`, deliberately distinct from `job_unknown` — an agent told
"unknown" about work that exists would conclude Motion lost it. An operator surface
can pass an explicit all-owners scope, which is auditable rather than implicit.

For compatibility renders, set the identity with `--caller-id` (CLI), `RunCliOptions.callerId`, or
trusted renderer-host options; without one that non-coordinator work is recorded as `unattributed`.
Coordinator `motion.job.*` access is stricter: direct SDK/HTTP hosts need a trusted context
`callerId`, while MCP/WebSocket requests use the server-minted connection principal. The identity is
what `motion.job.get` and `motion.job.list` answer as: a caller cannot name someone else's
`callerId`, and `scope: "all"` is refused unless the host explicitly granted it
(`context.crossCallerJobScope`, or `SHELLX_MOTION_JOB_CROSS_CALLER_SCOPE=1` for the CLI). An embedded
agent cannot grant itself that scope. See [host-integration.md](host-integration.md).

**Coordinator-owned streamed final-video work has a cross-request cancel verb.**
`motion.job.cancel` is served by the same persistent local coordinator that submitted the render.
It aborts the worker signal, which propagates into the streamed producer and FFmpeg process tree.
A cancelled terminal record is written only after execution settles. Materialized compatibility
paths are intentionally not accepted by the coordinator, so no accepted job can claim that signal
coverage without having it.

**Durable evidence is not a durable callback.** A terminal record and its valid event snapshot can
be read after the submitting process restarts, subject to the configured retention and storage
remaining available. The replay callback and live AbortController are process/session-owned, so a
restart cannot revive or retry that render automatically; `motion.job.retry` then returns its typed
`job_not_retryable` result. Submit a new run explicitly when the host has restarted.
A one-shot CLI render is still owned by its CLI process and is stopped with its
signal; legacy `motion.render.cancel` remains receipt bookkeeping.

**Interrupting a running render does work**, through a different path. The CLI
supplies an abort signal wired to SIGINT and SIGTERM, and both the frame loops and
the FFmpeg child honour it. A `runCli` caller can pass its own `signal` instead.

What you get when a render is cancelled:

```jsonc
{ "ok": false, "command": "render", "cancelled": true,
  "error": { "code": "render_cancelled", "message": "..." } }
```

`ok` is false because the artifact was not produced; `cancelled: true` says why, so
an agent can tell "stopped on request" from "failed" without reading prose. **Do
not auto-retry a cancelled render** — that overrides an explicit instruction from
whoever stopped it. The CLI exits 130, the conventional status for SIGINT, so a
wrapping script can make the same distinction.

Motion disables Playwright's default signal handling to make this work. Those
defaults call `process.exit(130)` the instant a signal arrives, which killed the
host before a cancelled render could tear down and report anything — Ctrl-C
produced no output at all. Motion still closes the browser on abort; it just does
so on its own terms.
