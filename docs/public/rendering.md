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

There are three lanes. They are honest about what each one does today.

## Native lane

Purpose: fast local preview and render for ShellX-native primitives — text,
shapes, images, simple video clips, captions, lower thirds, CTA cards, with
keyframes, easing, opacity, transforms, and simple masks. It needs no browser and
no external codec, which makes it the reliable default for quick preview.

**In progress: text rendering.** The native lane currently draws text with a
built-in 5×7 bitmap glyph path. It is deterministic and fast, but it is not a real
shaping/kerning text stack, so complex typography and full Unicode (including
Latvian diacritics) are not native-lane accurate yet. Replacing the bitmap path
with a real shaped/kerned text stack (with fonts packaged as content-addressed
assets) is an active engine bet. Until it lands, features that need real
typography, gradients on shapes, cameras, film treatment, particles, 3D, shaders,
and environments **fail closed** on the native lane to the browser lane rather
than rendering something subtly wrong.

## Browser lane

Purpose: render rich HTML/CSS/SVG/canvas/WebGL scenes and captured pages with full
typography and layout determinism. This is the honest renderer whenever browser
layout is the truth of the composition: design-to-video, Design Studio page/frame
animation, SVG/CSS animation, and captured websites.

The browser lane runs generated or package HTML in a bounded Playwright Chromium
session. It is deterministic by construction: animations are disabled during
capture, the caret is hidden, device scale is fixed, and frames are captured on a
fixed clock. It is also network-denied by default — see
[Security model](security-model.md). Most rich features (gradients, cameras,
depth, motion blur, film grain/vignette, particles, restricted shaders, fixed 3D
scenes, and rain/water/snow/fog environments) render here and, where needed, feed
their sampled frames to the FFmpeg lane for final encoding.

## FFmpeg lane

Purpose: final media. The FFmpeg lane encodes, transcodes, muxes, and validates,
invoked with `shell:false` and validated input/output roots. Highlights, all real
behavior today:

- **Output formats.** H.264/HEVC MP4 and VP9/AV1 WebM where the local capability
  probe permits them, GIF, JPEG/stills and PNG sequences, and alpha-capable
  exports (VP9-alpha WebM, ProRes 4444). ffprobe supplies validation metadata.
- **Two-pass loudness normalization.** Audio is normalized to EBU R128 targets. A
  measured first pass feeds a second apply pass (`loudnorm`); when a measured pass
  is unavailable Motion falls back to single-pass loudnorm and records which was
  used.
- **Sidechain ducking.** A ducking track can duck a bed against trigger layers,
  with the trigger layer ids resolved to concrete FFmpeg input indices.
- **GIF palette.** GIF export uses a generated palette so the lightweight
  animation preset stays legible.
- **Hardware encoding, probe-gated.** Hardware encoders (NVENC / VideoToolbox /
  QSV / AMF) are selected only after a per-machine probe proves the candidate
  actually initializes; on any hardware-encode failure the encode retries the
  software encoder and the receipt records the fallback and the reason. A machine
  with no acceleration renders in software and says so.

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
- **Motion only takes a browser out of a cache directory it can attribute to
  you.** A cache root, and each `chromium-<build>` directory inside it, has to be
  owned by your account or by root and not writable by other users; a
  `chromium-<build>` entry that is a symlink out of the cache is skipped, as is
  any name that is not `chromium-` followed by a build number. This matters for
  the common CI/Docker pattern of pointing `PLAYWRIGHT_BROWSERS_PATH` at a
  world-writable shared cache: what Motion finds there gets EXECUTED, including
  by the read-only `doctor` pre-flight, so a directory anyone can write to is not
  a browser source. When a cache is skipped for this reason `doctor` says which
  one and why, next to the "no browser found" line.

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

## Choosing a lane

`--lane` does **not** mean the same thing in `preview` and `render`. Read this
before scripting either one.

| Surface | Option | Accepts | Default | What it selects |
|---|---|---|---|---|
| CLI `preview` | `--lane` | `native`, `browser` | `native` | The frame renderer that draws the PNG. |
| CLI `render` | `--lane` | `native`, `ffmpeg` | `ffmpeg` | The output stage. |
| CLI `render` | `--frame-lane` | `native`, `browser` | `browser` | The frame renderer feeding FFmpeg. |
| `motion.render.final` | `frameLane` | `browser` **only** | `browser` | The frame renderer feeding FFmpeg. |

Anything else is rejected: `preview --lane ffmpeg` fails with `unsupported_lane`,
and so does `render --lane browser`. To render final media from browser-drawn
frames — the common case for rich scenes — the browser choice is `--frame-lane`,
not `--lane`.

Note the last row: the debug/HTTP/MCP command `motion.render.final` accepts only
`frameLane: "browser"` and rejects `"native"` with `invalid_args` (the `frameLane`
guard in `packages/debug-api/src/domains/render-final.ts`). Native-frame final
media is a CLI-only path today. An agent on the loopback transport that needs to
avoid Chromium has no `motion.render.final` route to it.

`render --lane native` is also not a video path: it writes **one** PNG still at
`--at-ms` (default 0) through the native preview renderer.

```bash
# Native preview frame (default) — no browser, no codec.
shellx-motion preview /path/to/package --out .scratch/previews

# Browser-drawn preview frame.
shellx-motion preview /path/to/package --lane browser --out .scratch/previews

# Final media, browser-drawn frames (the default frame lane).
shellx-motion render /path/to/package --lane ffmpeg --out .scratch/out.mp4

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

## Resource safety

Final frame-sequence renders fail before touching the filesystem if they exceed
36,000 frames or 80 billion pixel-frames. These are local resource-safety limits,
not quality limits — split an unusually long or high-resolution motion into
bounded jobs rather than letting scratch disk grow without bound.

### The memory ceiling a rich browser render actually meets first

Long before either of those limits, a browser-lane render meets the job
governor's **resident-memory ceiling**: `maxProcessTreeRssBytes`, default **6
GiB** (`SHELLX_MOTION_MAX_JOB_RSS_BYTES`, clamped to 64 MiB … 1024 GiB). It is a
per-job ceiling, sampled once a second over the whole Chromium process tree.
Crossing it aborts the job with `job_rss_limit_exceeded` — and through the CLI
that error is not wrapped in the usual `{"ok": false, …}` envelope: the process
exits non-zero with a stack trace.

WebGL `environment` layers (rain / water / snow / fog), `effects.motionBlur`
supersampling and particles are advertised as browser-lane features and they are
real, but a full-length delivery render at 1080p is where their cost is paid. A
render launches Chromium once and reuses a pooled context and page for the entire
sequence, so **peak memory grows with the frame count**, not just with the
complexity of one frame.

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

## The job model, as it actually behaves

**The render call blocks; the job is observable from another process.** Those are
two separate facts and both are true. `motion.render.final`,
`motion.render.batch`, the `render` CLI command, and the local SDK's render all
block until the encode finishes and then return the finished receipt — there is no
async submit, and no progress callback. But the work is registered before it
starts, so a *different* process can watch it: name the job (`--job-id` on the
CLI, `jobId` on the Debug API) and query `motion.job.get` / `motion.job.list`.
Run the render on a background thread or a child process and poll from your UI
thread; the job stores are files under the user's runtime directory, which is why
a separate process can read them.

- **Live jobs** — `$XDG_RUNTIME_DIR/shellx-motion/job-leases` (`%LOCALAPPDATA%`
  on Windows, or a per-user temp path). Overridable with
  `SHELLX_MOTION_LEASE_ROOT`.
- **Finished jobs** — `.../job-records`, overridable with
  `SHELLX_MOTION_JOB_RECORD_ROOT`, retained for 7 days or 1000 jobs, whichever
  binds first.
- Both are best-effort: if the directory cannot be written, rendering still works
  and reporting degrades.

A job reports `lifecycle` `pending` → `running` → `ended`, an `outcome` of
`succeeded` / `failed` / `cancelled` / `skipped` once ended, and `pollAfterMs`
while it is still live — when `pollAfterMs` is absent, stop polling. One render is
one job: the internal operations it leases capacity for are never reported
separately. `job_unknown`, `job_expired` and `job_not_visible` describe the
*query*, never the job. If you omit `jobId`, Motion mints one and returns it on the
result envelope — enough to look the job up afterwards, but not to watch it while
it runs, so **for a progress UI, always supply your own**. See
[host-integration.md](host-integration.md) for the full contract.

The **local SDK is the exception**: it accepts no `jobId` and names the job *after*
the fact — `jobId` is the completed receipt's id — so its `state` is `"succeeded"`
on the success path and an exception otherwise; `"queued"`/`"running"` are declared
in the type but a local SDK render cannot return them (the two hardcoded
`state: "succeeded"` returns in `packages/sdk/src/local.ts`). Use the Debug API or
the CLI when you need a live job.

The `motion.render.*` lifecycle commands are a different thing: **views over
receipt files**, not over processes. A receipt exists only once its render has
finished writing evidence, so these cannot see a queued or running render — use
`motion.job.*` for anything live, and these for the historical or batch view:

- `motion.render.status` and `motion.render.queue` read a `receiptsRoot`
  directory and summarize the render receipts found there
  (`packages/debug-api/src/domains/render-lifecycle-read.ts`). `progress` is
  `completed / total` counted from the child-job statuses recorded inside a
  **batch** receipt; a single render is 1/1 (or 0/1 while `not_run`). It is a
  count of finished work, not a live percentage. Point them at a directory with
  no receipts and they honestly report zero jobs.
- `motion.render.cancel` writes a `render.cancel` receipt naming the target
  receipt, after which the status/queue views report that target as `cancelled`.
  It does not signal, kill, or otherwise touch a process (the `cancel()` helper
  in `packages/debug-api/src/domains/render-lifecycle-write.ts`).
- `motion.render.retry` writes a `render.retry` receipt with
  `status: "not_run"` / `state: "pending"`. It is a recorded re-run *request*; no
  component consumes it to start a render. Re-run the render command yourself.

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

Set the identity with `--caller-id` (CLI), `RunCliOptions.callerId`, or `MotionDebugContext.callerId`;
without one the job is recorded as `unattributed` and shares a bucket with every other caller that
said nothing. The identity is what `motion.job.get` and `motion.job.list` answer as: a caller cannot
name someone else's `callerId`, and `scope: "all"` is refused unless the host explicitly granted it
(`context.crossCallerJobScope`, or `SHELLX_MOTION_JOB_CROSS_CALLER_SCOPE=1` for the CLI). An embedded
agent cannot grant itself that scope. See [host-integration.md](host-integration.md).

**There is no cross-process cancel verb.** There is no `motion.job.cancel`, and the receipt-based
`motion.render.cancel` has no in-flight render to target — a receipt exists only once the render has
finished, so that command remains bookkeeping over completed jobs. A host that must stop a running
render stops the process it started.

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
