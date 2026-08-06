# Quickstart

ShellX Motion is a local-first, self-hosted motion-graphics and rendering engine
for Design Studio and ShellX Cut. A Motion project is a **package**: a folder of
data (`motion.json`, `assets/`, `data/`, `receipts/`, `manifest.json`).
Almost every layer type is pure data — shapes, text, keyframes, environments, particles, and
fixed 3D scenes declare what to draw and cannot execute anything, reach the network implicitly,
or raise host resource limits. The exception is deliberate: a `web`, `html`, or `canvas` layer
points at an HTML file inside the package and Motion loads it in Chromium **with JavaScript
enabled**, so a package containing one runs its own script when you render it. That code is
fenced — network denied by default, reads confined to the package — but it is code, so treat a
package from an untrusted source the way you would treat any downloaded script. See
[security-model.md](security-model.md).

This page gets you from an empty shell to an unlocked local Workbench or a verified package render.

## Install expectations

There are two ways to run Motion:

- **From the workspace (source checkout).** Motion is a pnpm workspace. Run
  `pnpm install --frozen-lockfile` once at the repository root. Every command
  below is then available through the CLI package. In the source tree the CLI is
  invoked as `pnpm --filter @shellx-motion/cli run cli --`. Nothing puts a Motion
  binary on your `PATH` there, and `packages/cli/dist/main.js` will not run either
  — the workspace `exports` point at TypeScript source by design.
- **From an installed build.** Installing the packed `@shellx-motion/cli` package
  puts its single `bin` on your `PATH` as `shellx-motion`, and the commands below
  are identical with `shellx-motion` substituted for the `pnpm --filter ...` prefix.

The rest of this page uses the source-tree form. Swap in `shellx-motion` if you
are on an installed build. There is no `motion` binary in either form; dotted
names such as `motion.render.final` are Debug API / MCP command ids, not shell
commands.

Rendering to final media (MP4/WebM/GIF/stills) needs **FFmpeg** and **FFprobe**.
Motion resolves them from `PATH` by default; you can also point
`SHELLX_MOTION_FFMPEG` and `SHELLX_MOTION_FFPROBE` at explicit executables. The
browser lane needs a Chromium available through Playwright. The native lane needs
neither.

## Start Motion

```bash
pnpm start
```

This is the normal human entry point. It creates or reuses one private local access key, starts the
engine with local create/edit/render access, and opens an already-unlocked Workbench. Use
**Connections** to add Motion to an agent, copy a generic MCP command, or copy the Debug API address
and key. Remote publishing remains unavailable. See [Connect an agent](connections.md).

## Five commands: validate, inspect, preview, render, verify

```bash
# 1. Validate a package (schema, asset containment, manifest).
pnpm --filter @shellx-motion/cli run cli -- validate fixtures/packages/lower-third

# 2. Inspect its timeline and identity before touching it.
pnpm --filter @shellx-motion/cli run cli -- inspect fixtures/packages/lower-third

# 3. Render a preview frame (a real PNG) at a timestamp.
pnpm --filter @shellx-motion/cli run cli -- preview fixtures/packages/lower-third \
  --out .scratch/previews

# 4. Render the package to final media.
pnpm --filter @shellx-motion/cli run cli -- render fixtures/packages/lower-third \
  --lane ffmpeg --out .scratch/quickstart/lower-third.mp4

# 5. Read the delivered media back and run the quality checks.
pnpm --filter @shellx-motion/cli run cli -- quality-check \
  .scratch/quickstart/lower-third.mp4
```

Never treat a command's success envelope as proof that anything valid happened.
Confirm the package and motion identity, the validation result, the output hash,
the preview/render timestamp, and the receipt — its id, reported path, and inline
object. That evidence, not
the exit code, is what a render actually produced. See
[Receipts and trust](receipts-and-trust.md).

## Where outputs and receipts land

- **Rendered media and preview frames** are written to the `--out` path you give
  each command. The examples above use `.scratch/` for scratch output; nothing is
  written back into the source package unless you point `--out` there.
- **Receipts** land in three different places depending on the command, and one
  command emits none at all:
  - Package-producing automation and `render-batch` put the receipt inside the package they created, at
    `<--out package>/receipts/`.
  - `preview` and `capture-browser` write the receipt beside the frame, in the
    `--out` directory.
  - `render` returns the receipt inline **and writes it beside the delivered
    artifact** as `<packageId>-render.receipt.json`. For an image-sequence output,
    the receipt is written inside the output directory. Prefer the returned
    `receiptPath` over reconstructing either location.
  - `validate` emits **no** receipt and creates no `receipts/` directory; step 1
    above returns its result in the envelope only.

  A receipt records input hashes, the renderer lane, output hashes, warnings, and
  pass/fail gates — it is the trust record for the operation, not a log. See
  [Receipts and trust](receipts-and-trust.md) for the full destination table.

Step 4's `render` uses the default `--frame-lane browser`, so it needs Chromium.
Add `--frame-lane native` to encode from native-drawn frames instead. Note that
`--lane` and `--frame-lane` mean different things — see
[Rendering lanes](rendering.md#choosing-a-lane) before scripting either.

## The Engine Room workbench

Motion ships a local standalone workbench (the "Engine Room") served by the loopback debug server.
It drives the same package, preview, timeline, render, queue, and receipt contracts as Design Studio and
Cut — it does not keep a second project model. Start it through the human launcher:

```bash
pnpm start
```

Human users select packages, receipt folders, quality manifests, and render destinations through
native **Browse** actions. Agent automation can separately declare trusted reference collections
with repeated `--template-root` flags. A catalog request alone never widens the file boundary,
because an agent-supplied path is not the same thing as host launch configuration.

Start Motion opens a one-use launch URL, clears that value from the browser address, and exchanges it
for the persistent per-user key. Ordinary Workbench URLs still show the manual Connect field when no
session is present. The **Connections** page exposes one-click agent setup and copyable local MCP and
Debug API details without writing the key into agent configuration.

The Engine Room includes this documentation viewer, a receipts history built from
the `motion.receipts.*` commands, a **reveal in file manager** action on receipt
cards (so artifacts an agent created are easy to find on disk), and a shared update status. The CLI
checks the official release channel at startup and every 30 minutes; **Check now** refreshes the same
cached result. No project content or telemetry is sent, and agent discovery reports the same status
the About page shows. See [Agent integration](agent-integration.md) for the transports and
[Security model](security-model.md) for the loopback and capability guarantees.
