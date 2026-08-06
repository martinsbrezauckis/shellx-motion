# Receipts and trust

Receipts are the point of ShellX Motion. Every preview, render, import, export,
and batch run produces one — but **where it lands, and whether it lands on disk
at all, differs by command**, and `validate` produces none. Read the destination
table below before you go looking for a file. Receipts are **not** marketing logs
— they are the trust contract that lets a human or another ShellX app believe
that a rendered file corresponds exactly to the package, controls, and lane that
were requested. This page explains what a receipt attests, where receipts live,
how to read one, and why an agent's word is never enough.

> **Invoking the CLI.** Shell commands on this page are written as `shellx-motion <command>` — the
> single `bin` the `@shellx-motion/cli` package publishes. From a ShellX Motion source checkout, run
> them as `pnpm --filter @shellx-motion/cli run cli -- <command>` instead. There is no `motion` binary
> in either form; dotted names such as `motion.render.final` are Debug API / MCP command ids, not
> shell commands. See [Quickstart](quickstart.md).

## What a receipt attests

A receipt binds an operation to its real inputs and outputs. The core fields are:

- **Identity** — the operation id, package id, source app, and schema versions.
- **Input hashes** — content hashes of the inputs that determined the result.
  This covers the package data and its referenced assets; audio bytes and font
  assets are hashed as those input paths are completed (some input-hash coverage
  is still being filled in — see the honesty note below).
- **Lane and runtime** — which renderer lane produced the output (native,
  browser, or ffmpeg) and the runtime/tool versions involved.
- **Encoder identity** — for final media, the encoder that actually ran, whether
  it was a hardware or software encoder, and the reason a given encoder was chosen
  or a fallback occurred (see below).
- **Outputs** — output file paths and hashes, dimensions, fps, duration, and
  codec/container.
- **Quality gates** — the validation checks that ran and their pass/fail status,
  plus warnings, unsupported features, and explicit fallbacks.
- **Job metadata** — for a batch receipt, the per-row child jobs and their
  statuses, which is what the status/queue views count as progress. Cancel and
  retry references appear once a `render.cancel` / `render.retry` control receipt
  has been written beside the target. A receipt is written when work finishes, so
  none of *this* describes a job that is still running — for live state, query
  `motion.job.get` / `motion.job.list` instead, and see
  [Rendering lanes](rendering.md#the-job-model-as-it-actually-behaves).

The receipt schema is `shellx-motion/receipt@1` (`schemas/receipt.schema.json`).

A receipt is evidence about one completed operation. If you want to know what is happening
with work *right now* — is it queued, running, finished, stopped — that is a different axis;
see [JOB_STATUS.md](JOB_STATUS.md). A receipt's `status` and a job's `outcome` are
deliberately not the same vocabulary.

### Encoder identity, honestly

Motion does not trust the FFmpeg encoder list. For hardware (GPU/fixed-function)
encoding, each compiled candidate is asked to actually initialize on a tiny probe
job; an encoder is treated as usable only if it initializes. When a render performs
that hardware probe, its receipt's `encoderProbe` records `hardwareAvailable`, the
`compiledHardwareEncoders`, the `usableHardwareEncoders`, the
`failedHardwareEncoders` (each with a short, host-path-redacted reason), and the
`selectedHardwareEncoder`. If a hardware encode fails mid-run, Motion retries the
software encoder and records the fallback. A machine with no hardware acceleration
passes with `hardwareAvailable: false`, so software rendering is stated as such
rather than misreported as GPU support. A render that deliberately forces software
(or does not run the probe) simply reports its software `encoder` without an
`encoderProbe` block.

## Where receipts live

Which file a receipt lands in depends on what the command produces. Nothing is
written back into the **source** package.

| Command | Receipt destination |
|---|---|
| `template apply`, `template media-replace`, `render-batch` | `<--out package>/receipts/` — these produce a package, and the receipt goes inside the package they wrote. |
| `preview`, `capture-browser` | Beside the frame, in the `--out` directory: `<packageId>-{native,browser}-preview.receipt.json`. |
| `html-snippet-import`/`-export`, `otio-import`/`-export`, `package-archive`/`-extract`, `review-html-bundle` | Beside the artifact `--out` names. Where `--out` is a directory the receipt goes inside it (`html-snippet-export.receipt.json`); where `--out` is a file the receipt is a sibling (`<out>.receipt.json`). Each of these commands returns its `receiptPath` — use it rather than guessing. |
| `render`, `motion.render.final` | Beside the delivered artifact: `<packageId>-render.receipt.json`. Where `--out` is a file (`mp4-h264`, `png-frame`) the receipt is a sibling of that file; where `--out` is a directory (`png-sequence`) the receipt goes inside it. The path is also returned as `receiptPath` in the envelope — prefer reading it there over reconstructing it. A render that fails its quality manifest still writes its receipt, because that is when the evidence matters most. |
| SDK `render` (`@shellx-motion/sdk/local`) | `<artifactRoot>/.shellx-motion/receipts/<receiptId>.receipt.json`, plus an artifact handle under `.shellx-motion/artifacts/`. Override with `receiptsRoot`. |
| `motion.render.cancel` / `.retry` | The `receiptsRoot` you passed, beside the target receipt. |
| `validate` | **None.** `validate` returns its result in the JSON envelope only; it emits no receipt and creates no `receipts/` directory (`validateCommand` in `packages/cli/src/main.ts`). |

Analysis lifecycles (for example tracking) write their own receipted artifacts
under the package (`analysis/...`).

The practical rule: read `receiptId` / `receiptPath` from the envelope when they
are there, and persist the inline `receipt` object yourself when they are not.
Do not assume a `receipts/` directory appeared under the package you rendered —
`render` writes its receipt beside the **output**, never back into the source
package.

Rendered-media handoffs additionally carry an **artifact handle**
(`shellx-motion/artifact-handle@1`): a descriptor with the canonical root-relative
media path, byte length, SHA-256, package and motion identity, operation hash,
preset, media type, and the render/connector receipt attestations. The shared
verifier resolves the trusted root, rejects path and symlink escapes, streams the
bytes under a size cap, checks media magic bytes, detects a swapped file or
receipt, and requires the render receipt to bind the same artifact path, hash,
preset, and operation. Handle files are staged exclusively and published
atomically, so a handoff cannot silently point at different bytes than the ones
the receipt describes.

## How to read a receipt

After any operation, verify the receipt rather than the exit code:

1. **Confirm identity.** The package id and motion id match the package you
   operated on; the operation id is the one you invoked.
2. **Confirm inputs.** The input hashes match the package/assets you intended.
3. **Confirm the lane.** The `lane` is the one you asked for (a native preview and
   a browser render are different evidence).
4. **Confirm outputs.** The output hash, dimensions, fps, duration, and container
   are what you expected; the file exists at the recorded path.
5. **Confirm the gates.** The quality/validation status is `passed`, and read any
   warnings, unsupported-feature notes, and fallbacks — a `warning` or `not_run`
   status is not a `passed` status.

From the CLI or the loopback server you can list and read receipts directly:

```bash
# List receipts under a package's receipts root.
shellx-motion debug receipts-list --receipts-root /path/to/package/receipts

# Read one receipt by id (or by an in-root path).
shellx-motion debug receipts-read --receipts-root /path/to/package/receipts \
  --receipt-id <receipt-id>
```

These map to the `motion.receipts.list` and `motion.receipts.read` debug commands
(both `read_motion` tier). The Engine Room workbench builds its receipts history
from exactly these commands, and its receipt cards can **reveal** an artifact's
containing folder in your OS file manager — useful when an agent produced a file
you now need to find on disk.

## Why agent claims never satisfy a gate

ShellX Motion is agent-first, and that makes evidence non-negotiable. An agent can
describe what it did, but only the host owns the proof: the package diff, the
preview/render output, the host-captured screenshot, and the receipt. A command
that returns `ok: true` with no observable state change, output file, screenshot
difference, or receipt is a bug, not a success. When a quality gate fails, the
honest path is a proposal-only revision plan and a re-render — never lowering the
gate to make the run pass.

Image evidence comes from `motion.preview.frame` / `preview`, which write a real PNG and a
receipt. `motion.screenshot` was removed for exactly this reason: it reported `ok: true` for a
request it could not verify.

## Honesty note (in-progress)

Receipt coverage is deliberately explicit about its own gaps. Some input-hash
coverage is still being completed — for example image-asset hashing in native
preview receipts and audio-byte hashing in ffmpeg render receipts are being filled
in as part of the ongoing evidence pass. Where a receipt cannot yet attest
something, it says so rather than implying coverage it does not have. Treat a
receipt as the current, honest state of the evidence, and read its warnings.
