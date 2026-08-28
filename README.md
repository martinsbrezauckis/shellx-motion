<img src="assets/brand/shellx-motion-icon.png" width="96" alt="ShellX Motion icon">

# ShellX Motion

**Render video from HTML, JSON, or Lottie — locally, driven by an AI agent.**

Motion converts **HTML to video**, **JSON to MP4**, and **Lottie to MP4**. Give it a design, a data
file, or an animation, and it renders finished video: MP4, WebM, GIF, or a PNG sequence.

It is built to be operated by an AI agent rather than by a person clicking a timeline. Its typed
Debug/MCP control plane and its documented CLI and SDK subsets run on your own machine. Rendering
and file operations are local, while agent-assisted authoring can send prompts and permitted
context to the external provider CLI you configure, under that provider's terms.

**[Overview and demo films](https://theshellx.com/motion)** · **[Manual](https://docs.theshellx.com/manual/motion/)** — every command, searchable, generated from this repository.

### What goes in, what comes out

| in | out |
|---|---|
| A **Motion package** — JSON describing layers, keyframes, text, shapes, gradients, masks, particles, environments, shaders | **MP4** (H.264/HEVC) · **WebM** (VP9/AV1) |
| **HTML + CSS** you already have — a design, a card, a chart (`html-snippet-import`) | **Alpha video** (VP9-alpha WebM, ProRes 4444) |
| **Lottie / dotLottie** from After Effects or a design tool (`lottie.import`) | **GIF**, **PNG/JPEG stills**, **PNG sequences** |
| **glTF / GLB** 3D scenes, **images**, **video footage**, **audio**, **captions** (SRT/VTT) | **OTIO timelines** and **HTML snippets** back out |
| **Data rows** — CSV/JSON driving a template, one render per row (`render-batch`) | A **receipt** beside every artifact: input hashes, lane, output hash, quality result |

FFmpeg encodes the frames; Motion decides what those frames contain — what is drawn, when, and how
it moves. That composition step is the part Motion adds.

**Typography has an explicit trust boundary.** Chromium is Motion's production text authority only
for generated MotionIR text that uses manifest-declared package font bytes; those bytes are
checked, hashed, embedded, loaded, and fallback-attested in the receipt. HTML, web, and canvas
layers remain useful but can draw arbitrary or dynamic text Motion cannot observe, so their
typography is marked unverified and cannot pass a `maxFontFallbacks` attestation. This does not
promise arbitrary host fonts or cross-host pixel parity. The native lane is intentionally limited
to block-glyph preview text and refuses non-deliverable text rather than silently switching lanes.


## Watch it move

Four capability demos, rendered by this engine from **pure data** — thousands of keyframed layers,
no executable code in any package. Posters link to the videos in
[`docs/public/media/`](docs/public/media/).

<table>
<tr>
<td width="50%"><a href="docs/public/media/swarm-animals.mp4"><img src="docs/public/media/swarm-animals-poster.png" alt="Point-swarm demo: ten animals drawn in coloured points, morphing into the ShellX Motion wordmark"></a></td>
<td width="50%"><a href="docs/public/media/light-cycle.mp4"><img src="docs/public/media/light-cycle-poster.png" alt="Light-cycle demo: neon trails racing across a dark grid"></a></td>
</tr>
<tr>
<td width="50%"><a href="docs/public/media/data-alive.mp4"><img src="docs/public/media/data-alive-poster.png" alt="Data-alive demo: broadcast-style animated data graphics"></a></td>
<td width="50%"><a href="docs/public/media/server-load.mp4"><img src="docs/public/media/server-load-poster.png" alt="Server-load demo: a live infrastructure dashboard rendered as motion graphics"></a></td>
</tr>
</table>

<sup>The swarm film is 4,201 <code>shape</code> layers — a package an agent generated, validated,
and rendered through the same commands any agent can call. Its point colours were sampled from
AI-generated illustrations at author time; every frame is Motion's own raster.</sup>

## Why this one

**Agent-native, not agent-bolted-on.** The surface matrix is deliberate, rather than a universal
parity claim:

| Surface | Current callable inventory |
|---|---|
| Debug API / HTTP / WebSocket / MCP | **300** typed commands; MCP exposes the full registry. |
| CLI | **234 direct CLI** `debug` routes, plus **7 semantic CLI equivalents** (`connector catalog`, `package-create`, `validate`, `doctor`, `doctor --probe-gpu`, `job get`, `job list`). **59 named Debug/MCP commands deliberately have no CLI route**: `motion.agent.snapshot`, `motion.connector.submit`, `motion.job.submit/events/cancel/retry`, `motion.keying.inspect/apply/remove`, `motion.roto.upsert/tracking.detach/remove`, `motion.package.script.author`, `motion.timeline.checkpoint-storyboard.create/inspect/revise/remove/archive/materialize/detach/behavior.resolve/behavior.detach/relation.resolve/relation.detach/relation-action.resolve/relation-action.detach/lifecycle.resolve/lifecycle.detach/geometry-morph.resolve/geometry-morph.detach/retained-trace.resolve/retained-trace.detach/retained-trace.preview/retained-trace.review.bind/preview/creative-review.bind/preview-quality.review`, `motion.timeline.relations.inspect/upsert/enabled.set/remove/detach/bake`, `motion.timeline.relation-actions.inspect/upsert/remove/apply`, `motion.timeline.scene3d-animation.inspect/track.upsert/track.remove/keyframe.upsert/keyframe.delete/keyframe.move`, and `motion.timeline.layout-gap-animation.inspect/track.upsert/track.remove/keyframe.upsert/keyframe.delete/keyframe.move`. |
| Local SDK | **35 dedicated local-SDK operations**, a typed subset rather than a generic Debug-command proxy. |
| Action discovery | **174 discoverable actions**. |

An agent asks *"what can I do about snow intensity?"* and gets a callable plan back, instead of
guessing at a GUI.

The static registry is the complete protocol inventory. Authority-bound tools remain discoverable
and fail closed with `capability_unavailable` when their trusted host service is absent; the host
cannot turn catalog or request data into authority.

**Local-first and self-hosted.** Your footage and brand assets stay in local, host-approved roots
unless you explicitly supply them to an external tool or network-enabled package surface. Agent
prompts may be sent to the configured provider CLI. The server binds loopback only; remote
publishing is not enabled.

**Declarative layers cannot run code — but `web` layers can.** Almost every layer type is pure
data: shapes, text, keyframes, environments, particles, and fixed 3D scenes declare what to draw and
cannot execute anything. Shaders are a validated GLSL-ES subset with no loops or branches.

The exception is deliberate and worth knowing before you render something a stranger gave you.
A `web`, `html`, or `canvas` layer points at an HTML file inside the package, and Motion loads it in
Chromium **with JavaScript enabled** — that is what makes design-to-video work. So a package
containing one of those layers runs its own script when you render it, exactly as opening that file
in a browser would.

That code is heavily fenced — network denied by default, no service workers, popups refused, reads
confined to the package — but it is code. **Treat a package from an untrusted source the way you
would treat any downloaded script.** Importing foreign HTML through `motion.html.snippet.import` is
the safe path: the importer strips `<script>` and reports it, rather than carrying it in.

**Permission tiers that actually bind.** Six of them, from `read_motion` up to `push_remote`. The
grant is a ceiling the host sets at launch; a caller may ask for less, never more.

**Receipts, not vibes.** Evidence-producing operations return their declared receipts, but
persistence is scoped: renders write beside their output when a receipt destination is known,
previews write under their output directory, and validation writes only to an explicit or
host-governed receipt root. Read-only discovery and state commands emit no receipt. When an agent
claims it rendered something, the render receipt is how you check.

**Two deterministic render lanes.** A browser lane and a fixture-proven fallback, with an explicit
capability probe that tells you what your machine can actually do *before* you ask it to — rather
than failing halfway through an encode. What a lane cannot represent is reported as an explicit
fallback or lossiness, never silently downgraded.

## What you get

| | |
|---|---|
| **12 public template families** | Fifteen source families exist; three remain withheld pending quality requalification. The public twelve cover cinematic titles, kinetic type, data and metric cards, tracked callouts, keyed promos, and launch bumpers, each held to a published [quality bar](docs/public/TEMPLATE_QUALITY_BAR.md). Full template catalog/plan/apply/media-replace routes are Debug/MCP and CLI; the SDK can generically validate, render, or edit a caller-selected template package, but has no dedicated template catalog, plan, apply, or media-replace API. Deliberately not a Workbench gallery. |
| **Full authoring surface** | Layers, tracks, scenes, captions, transitions, masks, mattes, effects, gradients, spatial paths, and easing curves. Grouped/precomposed Motion timelines are supported by the strict WebGPU lane with bounded local timelines and isolated compositing, direct scene preview, raw-RGBA FFmpeg final delivery, and durable segmented finals for non-hybrid scenes or exactly one governed hybrid texture; actual adapter readiness remains a live host fact. |
| **Real video output** | H.264/HEVC MP4 and VP9/AV1 WebM where your FFmpeg supports them, plus audio and captions |
| **A human Workbench** | A local browser UI over the same Debug API contracts the agents use — not a second, drifting project model |
| **Host connectors** | First-party integration with ShellX Cut and Design Studio, with plan/receipt provenance across the boundary |

### The template pack

<table>
<tr>
<td width="33%"><img src="templates/shellx-product-pack/cinematic-rain-launch/preview/poster.png" alt="Cinematic rain launch template: a night street scene with volumetric rain, wet reflections and lens atmosphere"></td>
<td width="33%"><img src="templates/shellx-product-pack/editorial-liquid-surface/preview/poster.png" alt="Editorial liquid surface template: a sunlit ocean horizon with refracted light and liquid motion"></td>
<td width="33%"><img src="templates/shellx-product-pack/product-metric-card/preview/poster.png" alt="Product metric card template: a dark dashboard with animated bar charts and progress meters"></td>
</tr>
</table>

<sup>Frames rendered by this repository from the templates in
<a href="templates/shellx-product-pack/"><code>templates/shellx-product-pack/</code></a>. Not mockups —
run <code>pnpm run template-pack:proof</code> to regenerate them yourself.</sup>

New here? [`docs/public/quickstart.md`](docs/public/quickstart.md) is the shortest real path.
**Handing this repository to an AI agent? Point it at [`AGENTS.md`](AGENTS.md)** — the start path,
the two invocation forms, and the traps, in one page. [`skill/shellx-motion/SKILL.md`](skill/shellx-motion/SKILL.md)
is the full operating contract. [`docs/public/RENDERING_SAMPLES.md`](docs/public/RENDERING_SAMPLES.md)
maps each public rendering family to checked packages or workflow evidence, and calls out the
families that are release-blocking, if any. [`docs/public/index.json`](docs/public/index.json) is the
machine-readable source index for the curated human Workbench documentation; agent-only reference
pages are intentionally excluded from that Workbench index.
Want the honest limits? [`docs/public/FEATURES.md`](docs/public/FEATURES.md) documents what exists
*and* what does not.

## Install

ShellX Motion ships as a **source release**: you get this tree, build it, and run it from here. There
is no npm install step and no prebuilt binary.

**Prerequisites**

| | version | why |
|---|---|---|
| Node.js | 24.x | tested on 24.14 (Linux) and 24.15 (Windows) |
| pnpm | 10.6 or newer, including 11.x | below 10.6 the workspace build-script declaration is not read |
| FFmpeg + FFprobe | tested on 6.1.1 and 8.1.2 | video render (`render`), and FFprobe for `quality-check` |
| Chrome / Chromium | any current build | the **default** frame lane (`render --frame-lane browser`) rasterizes in a real browser; `npx playwright-core install chromium` gets one |

None of these three ships with Motion. FFmpeg and FFprobe are only needed for rendering video and
reading it back; Chromium is needed by the frame lane `render` uses **by default**. Validation,
inspection and still previews (`preview`, which defaults to `--lane native`) work without any of them.

If you would rather not install a browser, `render --frame-lane native` encodes from natively-drawn
frames instead. That lane is narrow on purpose — it has no font rasterizer, so it refuses to deliver
any package whose text is lowercase or names a font family — so it suits text-free packages, not as
a general substitute.

The `doctor` command reports exactly which operations your machine can and cannot perform, per tool,
and distinguishes "cannot do this at all" from "cannot do it the default way, and here is the flag".

**Build**

```bash
pnpm install
pnpm build
```

**Test**

```bash
pnpm test
```

This is the public source-release test contract: it runs from the generated
export after installation and does not require Git metadata or the withheld
`templates/generators/` authoring tree. In the canonical implementation checkout,
maintainers additionally run `pnpm run test:implementation`; it retains the
Git-snapshot and generator gates and is intentionally not a public-release command.

**Start Motion**

```text
pnpm start -- \
  --authoring-input-root /absolute/path/to/packages \
  --authoring-output-root /absolute/path/to/revisions \
  --render-package-root /absolute/path/to/packages \
  --render-input-root /absolute/path/to/render-inputs \
  --render-output-root /absolute/path/to/renders
```

This is the normal human entry point. It creates one private per-user access key, publishes the live
loopback port for agent bridges, and opens an already-unlocked Workbench in the default browser. The
host-owned authoring roots bound package creation and copy-on-write revisions; the separate render
roots bound server/MCP package reads, external render inputs, and destinations. Omit a required root
class and that operation fails closed; a human Browse result can grant only its exact location for
the current session. Open **Connections** to add Motion to a supported agent or copy the command for
another MCP client. The same key protects Workbench, MCP, and the Debug API; it is not written into
agent configuration. Remote publishing is not enabled.

`pnpm install` must run esbuild's postinstall script — it places the platform binary that the
TypeScript runner needs. This repo declares that in `pnpm-workspace.yaml`, so it happens without
prompting. If you see `ERR_PNPM_IGNORED_BUILDS`, your pnpm is not reading that declaration; check you
are on 10.6 or newer.

**Invoking the CLI**

There are two invocation forms. Which one is correct depends only on where you are:

| where you are | how to run a command |
|---|---|
| **this source checkout** — the pnpm workspace you just built | `pnpm --filter @shellx-motion/cli run cli -- <command>` |
| **an installed build** — the packed `@shellx-motion/cli` package, installed into a project | `shellx-motion <command>` |

Inside the workspace nothing puts `shellx-motion` on your `PATH`, and running
`packages/cli/dist/main.js` directly fails as well: the workspace `exports` deliberately point at
TypeScript source so tests and smokes run without a build step, so the built output resolves back to
`.ts` files. `scripts/verify-install.mjs` documents this in full. Every example in this repository's
docs that is written as `shellx-motion <command>` takes the `pnpm --filter …` prefix instead when you
run it from here.

**POSIX checkout authority.** Motion's local validation and copy-on-write paths deliberately refuse
a source checkout or worktree that is group- or world-writable. A team-oriented `umask 0002` commonly
creates a fresh clone as `0775`; make the checkout private before `pnpm install` and before running
the validation examples below. Either clone under a private umask, or repair only the clone you just
created:

```bash
umask 0077
git clone https://github.com/martinsbrezauckis/shellx-motion.git shellx-motion

# For a clone already made with umask 0002:
chmod go-w shellx-motion
```

Keep each worktree root private as well. This is an authority requirement for local COW outputs, not
a request to relax shared-directory protection or to change ownership of parent directories.

On Windows, the equivalent check reads the checkout DACL and refuses a route where an unrelated
principal can modify descendants. Use a current-user-private checkout for validation; do not weaken
the check or recursively rewrite a shared workspace's permissions merely to make a command pass.

There is no `motion` binary in either form. The `@shellx-motion/cli` package publishes exactly one
`bin`, `shellx-motion` — that is the command surface. The debug server package separately publishes
`shellx-motion-debug-server`, `shellx-motion-workbench` and `shellx-motion-mcp`, which are the
server and MCP entry points rather than the CLI.
Dotted names such as `motion.render.final` are Debug API / MCP command ids, not shell commands.

**Verify the install**

```bash
pnpm --filter @shellx-motion/cli run cli -- doctor
pnpm --filter @shellx-motion/cli run cli -- validate fixtures/packages/lower-third
```

The first prints per-operation readiness. The second should answer `"ok": true` — if it does, the
engine can read a package, and the toolchain is sound.

`pnpm run build:verify` goes further, and is the only check that exercises the *installed* form: it
packs every package, installs the CLI tarball into a throwaway project, and runs `shellx-motion` there
through both the npm and pnpm bin shims. That is the artifact an npm consumer would actually receive —
`publishConfig` exports, the `bin` shebang, the `files` allowlist and `workspace:*` version rewriting
— and it cannot be exercised from inside the workspace, for the reason above.

`pnpm run docs:commands` runs every shell command in this README as written, so a command that does
not work here cannot stay documented here.

**Advanced server launch** (for hosts that need to choose a narrower grant):

```text
pnpm --filter @shellx-motion/debug-server run serve -- \
  --tier render_motion --trusted-local-tier \
  --render-package-root /absolute/path/to/packages \
  --render-input-root /absolute/path/to/render-inputs \
  --render-output-root /absolute/path/to/renders
```

It binds loopback only and prints a startup manifest with the URL, the workbench URL, and the
permission tier it granted. The grant is a ceiling: a request may ask for a lower or equal tier,
never a higher one. There are six tiers, in this order:

```text
read_motion < draft_motion < render_motion < edit_motion < write_local < push_remote
```

The three render-root flags are host policy, not caller data: package trees, external
rows/workflow/quality inputs, and final/batch destinations must remain inside their respective
roots. The loopback server refuses final/batch rendering when a required class is absent. A native
Workbench chooser can grant only the exact location a person selects for that session. Standalone
CLI render commands remain local-host operations and do not need these server flags.

**`write_local` ranks above `edit_motion`, not below it** — the intuitive reading is the wrong one,
and it costs you a session. `edit_motion` mutates a package that already exists
(`motion.timeline.layer.create`, `motion.timeline.keyframe.upsert`). `write_local` creates files
outside an existing package, so **making a new package needs `write_local`**: `motion.package.create`
sits there together with every importer, exporter, connector and archive command. Starting the server
at `--tier edit_motion` and then calling `motion.package.create` is refused, correctly — start it at
`--tier write_local` if the agent has to create packages.

Anything above the `read_motion` default requires `--trusted-local-tier`, deliberately. `push_remote`
is reserved, never automatic, and additionally requires `--allow-push-remote`.

The per-command tier is contract data, not prose: `schemas/debug.json` carries the `permission` of
every command, and `docs/public/DEBUG_API_COMMANDS.md` is generated from it. Read those before assuming.

## Agent entry points

Start with [`skill/shellx-motion/SKILL.md`](skill/shellx-motion/SKILL.md). Exact CLI calls, bounded
environment examples, permission tiers, verification rules, and connector ownership are in
[`skill/shellx-motion/references/cli.md`](skill/shellx-motion/references/cli.md). Then use
[`docs/public/RENDERING_SAMPLES.md`](docs/public/RENDERING_SAMPLES.md) to choose a checked package
or workflow without inferring support from a pre-baked example.

The machine-readable contracts are:

- `schemas/actions.json` for discoverable workflows;
- `schemas/debug.json` for callable debug commands and permission tiers;
- `schemas/motion.schema.json` and `schemas/package-manifest.schema.json` for package data;
- `schemas/cut-import-plan.schema.json` (`shellx-motion/cut-import-plan@1`) for the Cut connector
  plan, and `schemas/canvas-frame-selection.schema.json`
  (`shellx-motion/canvas-frame-selection@1`) for the Canvas frame-selection connector input.
- `schemas/canvas-bridge-package.schema.json`
  (`shellx-motion/canvas-bridge-package@1`) for the exported Canvas-to-Motion package envelope:
  manifest, Motion document, export receipt, and integration evidence. It composes the three
  referenced package schemas rather than duplicating them.

The bridge command writes a Canvas frame-selection document first; that file remains governed by
`canvas-frame-selection.schema.json`. Converting it into a Motion package produces the canonical
`canvas-bridge-package@1` envelope. The package writer retains an id-less in-process compatibility
path for callers predating this schema, but external hosts should only exchange the versioned
envelope.

Human-readable current-state references are:

- [`docs/public/FEATURES.md`](docs/public/FEATURES.md) for implemented capabilities and honest boundaries;
- [`docs/public/DEBUG_API.md`](docs/public/DEBUG_API.md) for transports, authentication, discovery, and calls;
- [`docs/public/DEBUG_API_COMMANDS.md`](docs/public/DEBUG_API_COMMANDS.md) for the complete schema-generated
  debug command, permission, and mutation index;
- [`docs/public/SBOM.md`](docs/public/SBOM.md) for the deterministic dependency inventory, its artifact
  policy, and its deliberate native/runtime limits.

Run `pnpm docs:check` with other local checks. It fails when the generated command reference no
longer matches `schemas/debug.json`; regenerate deliberately with `pnpm docs:debug-api`.

Use action discovery before mutation:

```bash
pnpm --filter @shellx-motion/cli run cli -- actions find "add a cinematic snow environment"
pnpm --filter @shellx-motion/cli run cli -- actions guide motion.timeline.layer.rich.set
pnpm --filter @shellx-motion/cli run cli -- actions plan "change snow intensity and preview it"
```

For the local standalone workbench, use the normal human launcher:

```text
pnpm start -- \
  --authoring-input-root /absolute/path/to/packages \
  --authoring-output-root /absolute/path/to/revisions \
  --render-package-root /absolute/path/to/packages \
  --render-input-root /absolute/path/to/render-inputs \
  --render-output-root /absolute/path/to/renders
```

It opens an already-unlocked Workbench. The **Connections** page shows one-click supported-agent
setup, copyable setup commands, the local MCP and Debug API addresses, and the single local access
key. The workbench uses the same package, preview, timeline, render, queue, and receipt Debug API
contracts as Design Studio/Cut; it does not maintain a second project model.

Verify every claimed host with the reusable ladder in
[`docs/public/PLATFORM_VERIFICATION.md`](docs/public/PLATFORM_VERIFICATION.md). Hosted/SaaS
execution is not part of the current product direction.

## License

Released under the [MIT License](LICENSE) — © 2026 Martins Brezauckis. See
[`LICENSE`](LICENSE) for the full text. Every workspace package carries the same
`"license": "MIT"` declaration; the repository-root `LICENSE` is the single authoritative copy.

MIT covers ShellX Motion's own code and assets. Third-party material redistributed in this
repository is recorded separately in [`NOTICE`](NOTICE) — currently the bundled Inter WOFF2 files
under the SIL Open Font License 1.1, shipped inside every package that renders with Inter. `NOTICE` also states the provenance of the generated,
synthetic, and rendered sample media, and the runtime boundary for FFmpeg, Chromium, and
`playwright-core` plus the pinned deterministic Rapier provider. Redistribute `NOTICE` alongside
`LICENSE`.
