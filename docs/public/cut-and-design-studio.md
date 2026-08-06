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

### Template-to-Cut and Script-to-Cut

- **Template-to-Cut.** Apply TemplateIR controls, then emit either an editable Cut
  import plan (for the exact Cut-native basic subset) or a rendered-media plan.
  The rendered path applies controls, renders a real browser-frame MP4, verifies
  preview/final parity, and emits the Cut plan.
- **Script-to-Cut.** Cut's Generate path emits `shellx-motion/scripted-video@1`;
  Motion compiles it into a package, renders browser-captured text/shape/caption
  frames into a real MP4, and Cut applies that rendered media through its own
  `media.import` + `edit.insert` operations.

Cut exposes four rich cinematic families as `builtin.motion.*` Generate entries —
`cinematic-fog-title`, `editorial-liquid-surface`, `keyed-subject-promo`, and
`tracked-callout-overlay`. `cinematic-rain-launch` is **not** among them: it
declares `shellx-cut` compatibility in its manifest but has no Cut Generate entry
and is excluded from the `template-pack:host-parity` gate
(`RICH_HOST_FAMILIES` in `scripts/template-host-parity-gate.ts`). Route rain into
Cut as rendered media instead.

For the four that are exposed: preview before insert, then open the linked
package in Design Studio for projected-control edits and one verified re-render.

## Design Studio → Motion → MP4

Design Studio creates Motion packages from selected frames, captured pages, brand kits,
and image-editor outputs. The frame-selection connector exports a Design Studio selection
into a Motion package and can render an independent H.264 MP4 (with render and
connector receipts and resource-catalog wiring) from Motion alone — no Cut
required in the loop:

```bash
shellx-motion connector canvas-to-cut \
  fixtures/canvas/shape-text-frame-selection.json \
  --out .scratch/connectors/canvas-story-hero --dry-run-render
```

## Environment variables

Two different consumers read these variables, and it matters which is which.

**Read by Motion itself** (this repository):

| Variable | Role |
|---|---|
| `SHELLX_MOTION_FFMPEG` / `SHELLX_MOTION_FFPROBE` | Explicit codec executables for the FFmpeg lane; otherwise resolved from `PATH`. |
| `SHELLX_MOTION_BROWSER` | Explicit Chrome/Chromium for the default browser frame lane. Must be an ABSOLUTE path, and it is a pin: set to something unusable, Motion reports `chromium` broken rather than launching a different browser. Never resolved from `PATH`; unset, Motion checks Playwright's browser cache (only directories owned by this user or root and not writable by others), then well-known system installs. |
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
