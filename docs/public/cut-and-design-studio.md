# Cut and Design Studio

ShellX Motion is compatibility-first. Motion packages must be readable by
Design Studio and ShellX Cut, and Motion owns validation, preview, rendering, receipts,
and connector output. This page covers the connector story — how Motion work
reaches Cut and Design Studio — and the environment variables that wire the hosts
together.

Design Studio's host identifier on the wire is `shellx-canvas` — the id predates the
product's current name and is kept for compatibility, so integration envelopes,
capability negotiation, and template `compatibleHosts` entries continue to match.

> **Invoking the CLI.** Shell commands on this page are written as `shellx-motion <command>` — the
> single `bin` the `@shellx-motion/cli` package publishes. From a ShellX Motion source checkout, run
> them as `pnpm --filter @shellx-motion/cli run cli -- <command>` instead. There is no `motion` binary
> in either form; dotted names such as `motion.render.final` are Debug API / MCP command ids, not
> shell commands. See [Quickstart](quickstart.md).

> **Integrating, or updating an existing integration?** Read
> **[host-integration.md](host-integration.md)** first. It lists what changed on Motion's side and
> what you have to change on yours — job state vocabulary, cancellation, receipts on disk,
> machine-wide concurrency, caller identity, stricter editable lowering, and the commands that were
> added and removed. It ends with a checklist.

## Connector discovery before execution

Use `runtime-probe`, `connector catalog`, and `connector describe <capability-id>` to inspect the
closed Motion connector contract before selecting a workflow. These commands are read-only and do
not read a package, access a provider/authentication state, use the network, render, write output,
or execute a connector. A source checkout and ordinary packed install both truthfully remain
unmanaged and distribution-unverified.

A pure Debug/MCP client uses `motion.connector.catalog` (MCP:
`motion_connector_catalog`) for the same canonical v2 catalog object. It does not need a
capability-specific describe call: the catalog contains all descriptor fingerprints, request-schema
ids, and closed request fields required to prepare generic submit.

The v2 catalog separates visibility from execution admission. P2A Template-to-Cut and P2B
Canvas/Script/Source-to-Cut are admitted to one generic persistent `connector-job@2` lifecycle and
remain Linux-only Browser-to-FFmpeg H.264 `rendered_media` routes with their existing restrictions.
Legacy Canvas bridge, Canvas-to-MP4 and Cut Generate-to-Cut descriptors remain named-CLI
compatibility routes; Canvas-to-MP4 and Cut Generate-to-Cut are Linux-only because their package
publication requires exact descriptor-relative closed-tree proof. Scene3D, C6 physics and C7 scene
orchestration still refuse Cut admission.

Cut and Design Studio integrate the generic route once: validate the versioned catalog, build the
closed request from descriptor fields, map host-issued opaque input/output handles through a trusted
caller-scoped resolver, then submit with `motion.connector.submit` and use the advertised
`motion.job.*` controls. They must not add a source branch for each capability id. When Motion adds
a render or orchestration operation that reuses the negotiated request, trust, lifecycle and output
classes, the new descriptor is enough for discovery and invocation. See
[Integrating a host with ShellX Motion](host-integration.md#self-describing-connector-discovery-and-generic-jobs)
for the exact admission and restart rules.

## Ownership split

- **Design Studio** is the precision authoring host. It opens path-free Motion sessions,
  presents the timeline, curves, spatial paths, and projected rich controls, and
  saves verified package revisions.
- **Motion** validates, previews, renders, hashes, writes receipts, and maps
  connector output.
- **Cut** is the editorial/link-lifecycle host. It discovers, previews, inserts,
  refreshes, relinks, rolls back, or detaches a linked Motion clip. Cut remains
  the deeper timeline/media editor; Motion does not replace its timeline, op-log,
  verification, or delivery.

## Connector modes into Cut

A Motion-to-Cut handoff picks one import mode. Request `auto` to let Motion choose
between editable lowering and rendered media; or request a specific mode:

- `rendered_media` — the safest path, live today: Motion renders the package and
  hands Cut linked rendered media with an artifact handle and connector receipts.
- `editable_lowering` — Motion lowers supported constructs into native Cut
  operations, but only where the result is **receiver-exact**. A Cut target
  declares which editable receiver it runs, and every lowered payload is checked
  against that receiver's exact accepted field set before this mode is chosen. A
  single unrecognised field — a blend mode, a skew, a font family, an audio
  control on a video layer — degrades the plan and is reported by name.
- `live_overlay` — preview/render Motion output as a timeline overlay clip.

Editable lowering is deliberately conservative. It is selected only for basic
text (color/font size) and basic rect/rounded-rect/ellipse/circle/line shapes with
supported paint and identity transforms; uniform opacity and `transform.x`/
`transform.y` tracks plus non-overlapping fade-in/out with one Cut-compatible
easing mode lower to native clip automation. Motion normalizes pixel positions
against the source document (including intentional off-screen values) and
preserves the document background as a bound native shape.

**What fails closed to rendered media** (with per-layer reasons): extra
typography/text boxes, scale/rotation keyframes, other keyframe targets,
fade/keyframe conflicts, overlapping fades, mixed or unsupported easing, other
transitions, timeline metadata, captions, images, portable video, effects, masks,
environments, shaders, particles, 3D, film/motion blur, tracking math, keying/
roto, compositing, and procedural effects. An explicit editable request that
cannot be honored **fails with per-layer feature reasons** rather than emitting a
plan Cut would approximate or reject later. Motion never pretends to natively edit
film math it has not fixture-proven as receiver-exact.

### Template-to-Cut and P2B Canvas, Script, and Source-to-Cut

- **Template-to-Cut (P2A).** On Linux, this accepted route is rendered-media only:
  it applies TemplateIR controls to an immutable admitted package snapshot, renders
  a real Browser preview and Browser-to-FFmpeg MP4, then assembles the package,
  media, artifact handle, Cut plan, and connector receipt in one private exact tree
  before one no-clobber publication. The template source is input evidence, never a
  delivered artifact. Use an absent or empty output directory; `--force`, dry runs,
  native preview, GPU/WebGL layer families (`shader`, `environment`, `scene3d`),
  audio, and active `web`/`html`/`canvas` scripts are refused in this slice. The
  route also refuses packages with empty directories or source file paths deeper than
  15 components. Current host admission is tighter than the P1 delivery reserve:
  256 tree entries, 16 MiB per input file, and 64 MiB aggregate; P2A separately
  reserves the P1 64 MiB leaf, 256 MiB aggregate, and 1,024-leaf final-tree limits.

  ```bash
  pnpm --filter @shellx-motion/cli run cli -- connector template-to-cut \
    fixtures/packages/editable-lower-third --out .scratch/connectors/template-to-cut \
    --cut-import-mode rendered_media --set "title=Dr. Mira Chen"
  ```

  Do not add `--dry-run-render`; accepted P2A delivery requires the real Browser
  render and its final media/handle/Cut-plan/receipt identities.

- **Canvas-to-Cut, Script-to-Cut, and Source-to-Cut (P2B).** These three routes
  are Linux-only accepted delivery. They require an absent or empty output
  directory and always create one real Browser-preview, Browser-to-FFmpeg H.264
  MP4 `rendered_media` handoff, its attested artifact handle, a Cut import plan,
  and receipts. Inputs from Canvas, a script, or imported source are evidence,
  not delivered artifacts (Source separately derives its review storyboard).
  They reject force, dry-run, editable/live/auto modes, native/GPU/frame-lane
  controls, non-MP4 presets, audio, and injected renderer/FFmpeg/clock fields.
  Script may include documented start, duration, and track placement. Its P2B
  JSON source is capped at 1 MiB before parsing, then normalized under the
  scripted-video string, template-variable, and generated-work limits documented
  in [Host interchange and archive limits](interchange-limits.md). Motion returns
  the plan; it does not apply anything to Cut.

- **Legacy Cut Generate-to-Cut (separate from atomic P2B Script-to-Cut).** Cut's
  Generate path emits `shellx-motion/scripted-video@1`;
  Motion compiles it into a package, renders browser-captured text/shape/caption
  frames into a real MP4, and Cut applies that rendered media through its own
  `media.import` + `edit.insert` operations. This compatibility route is Linux-only;
  macOS and Windows refuse before creating output state.

Cut exposes four rich cinematic families as `builtin.motion.*` Generate entries —
`cinematic-fog-title`, `editorial-liquid-surface`, `keyed-subject-promo`, and
`tracked-callout-overlay`. `cinematic-rain-launch` is **not** among them: it
declares `shellx-cut` compatibility in its manifest but has no Cut Generate entry
and uses a rendered-media-only static handoff contract. `template-pack:host-parity`
accounts for all five Cut-advertised templates, but only the four catalog entries
are Generate contracts. Route rain into Cut as rendered media instead; do not
interpret that proof as a Cut Generate/runtime claim.

For the four that are exposed: preview before insert, then open the linked
package in Design Studio for projected-control edits and one verified re-render.

## Design Studio → Motion → Cut rendered-media handoff

Design Studio creates Motion packages from selected frames, captured pages, brand kits,
and image-editor outputs. The frame-selection connector exports a Design Studio selection
into a Motion package and can create a real Browser-to-FFmpeg H.264 MP4 plus an
attested rendered-media Cut plan. Motion stops at that handoff — no Cut checkout
or Cut application is required in the loop:

```bash
shellx-motion connector canvas-to-cut \
  fixtures/canvas/shape-text-frame-selection.json \
  --out .scratch/connectors/canvas-story-hero
```

This P2B command is Linux-only and `--out` must be absent or empty.

## Environment variables

Two different consumers read these variables, and it matters which is which.

**Read by Motion itself** (this repository):

| Variable | Role |
|---|---|
| `SHELLX_MOTION_FFMPEG` / `SHELLX_MOTION_FFPROBE` | Explicit codec executables for the FFmpeg lane; otherwise resolved from `PATH`. |
| `SHELLX_MOTION_BROWSER` | Explicit Chrome/Chromium for the default browser frame lane. Must be an ABSOLUTE path, and it is a pin: set to something unusable, Motion reports `chromium` broken rather than launching a different browser. Never resolved from `PATH`; unset, Motion checks Playwright's browser cache (only canonical, non-symlink directory components and executable leaves owned by this user or root and not group/world-writable), then well-known system installs. |
| `SHELLX_MOTION_SCRATCH_ROOT` | Scratch root for governed render jobs (default `.scratch`). |
| `SHELLX_MOTION_DEBUG_TOKEN` | Pre-set capability for the loopback debug server, instead of the generated ephemeral token file. |

**Read by the host, not by Motion** — these are the ShellX Cut / Design Studio side of
the contract. Motion contains **no** resolver for them:

| Variable | Role |
|---|---|
| `SHELLX_MOTION_CLI` | Explicit path to the Motion CLI the host should invoke. The host resolver treats this as canonical and resolves it first. |
| `SHELLX_MOTION_BIN` | Legacy alias, still honored by the host resolver when `SHELLX_MOTION_CLI` is unset. |
| `SHELLX_MOTION_ROOT` | Motion checkout/install root. Used when no explicit CLI override is set — the host then falls back to `pnpm --filter @shellx-motion/cli run cli --` inside that root. |
| `SHELLX_MOTION_TIMEOUT_MS` | Per-invocation Motion CLI timeout (host-clamped). |

Where the boundary actually sits: `SHELLX_MOTION_CLI` has **zero** references
anywhere in this repository — no package reads it, no script emits it. The
"canonical, resolved first" ordering is behaviour of the Cut/Design Studio resolver and
must be verified there, not here. Motion produces import plans, artifacts, and
receipts; the host reads those outputs and applies them inside Cut.

## Verify the handoff, not the envelope

A connector plan is not proof. Real handoffs carry an artifact handle
(`shellx-motion/artifact-handle@1`) binding the media path, byte length, SHA-256,
package/motion identity, operation hash, and preset, plus render and connector
receipts. Dry-run plans use a separate non-applicable `plannedPath` shape and do
not attest real bytes. Confirm the receipts and the handle before treating a
handoff as done — see [Receipts and trust](receipts-and-trust.md).
