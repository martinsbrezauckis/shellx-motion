# Receipts and trust

Receipts are the point of ShellX Motion. Every preview, render, import, export,
and batch run produces one — but **where it lands, and whether it lands on disk
at all, differs by command**. `validate` writes one only when a governed receipt
destination is available. Read the destination
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

### Final-render package lineage

Every ordinary `render.final` receipt binds the exact stable package documents used for that render
in `inputHashes.manifestSha256` and `inputHashes.motionSha256`. Motion derives those hashes from
bounded, non-symlink package files before rendering and rechecks the same lineage before releasing
the receipt; changing the package while the render runs refuses the receipt rather than attaching
new bytes to old output. A glTF-lowered package additionally binds its preserved source,
normalized source, and lowering-receipt hashes. SDK artifact handles carry the matching
`shellx-motion/package-render-lineage@1` record, and cache/Cut handoffs require an exact match. This
is source-revision evidence, not a claim that the whole package directory was atomically snapshotted
or that a preview-only receipt became a final-delivery receipt.

### Portable review and support bundles

A portable review bundle retains the admitted package and receipt directory identities and takes
filesystem receipts through a Core-bound stable snapshot: an approved root-relative path, digest,
byte length, and opened-file identity. Core reopens and verifies the snapshot itself, uses its
private receipt copy while composing the bundle, and rechecks the exact roots, receipt, and package
identities immediately before publication. A changed, replaced, or mismatched input refuses
publication rather than producing a bundle from mixed evidence.

Each copied review artifact records `producerIdentity`. It is `producer_verified` only when the
receipt-provided producer SHA-256, and any producer byte length when provided, match the digest and length
observed while streaming the portable copy. Older or otherwise digest-unbound artifacts remain
`unattested`; their observed digest and length are still recorded, but they are not renderer-bound
evidence. A producer mismatch or a source mutation during copying refuses publication.

With `motion.support.bundle` and a package root, the package summary and support receipt use one
loader-owned document-hash snapshot. Motion reloads the package documents immediately before it
publishes; a changed document returns `source_changed` and leaves no support bundle published.

### Typography evidence

For browser-drawn generated MotionIR text, `output.typography` records Chromium as
the authority, the requested/resolved family, direction/language, canvas-metric
fallback evidence, and whether every active text layer is backed by a
manifest-declared font asset. Its `fontAssets` records the checked, embedded font-byte
SHA-256 values. A successful `attestation: "verified"` additionally means the browser
font readiness gate completed; it is not a claim that an arbitrary host font was used
or that another machine will produce identical glyph pixels. It is a font
provenance/loading/fallback attestation, not a standalone complex-script or glyph-
coverage conformance certificate.

For browser HTML/web/canvas capture, receipt typography is explicitly
`attestation: "unverified"` with an `html-web-canvas` scope and warning. The page
may still render normally, but Motion will not invent text/fallback coverage that
arbitrary script can hide. A package that requests the `maxFontFallbacks` quality
attestation therefore refuses before final rendering with
`browser_html_typography_unverified`; unbound generated MotionIR families refuse
with `browser_motion_typography_unverified`.

### Approved-agent-entry script evidence

Every browser-frame receipt, and every browser-backed aggregate preview/final receipt, has
`output.scriptExecution`. Data-only packages
record `detectedClass: "data-only"` and `activeMode: "data-only"`. The narrow
approved script route records `detectedClass: "active-content"`, the requested
and active modes, resolver version, whole-package snapshot SHA-256, each executed
source path/hash/byte count, and a non-secret `attestationId`. A value being
present is evidence to inspect, not a bearer credential and not permission for a
different package or host.

For a multi-frame preview, materialized sequence, or streamed final, one host-bound browser session
resolves one immutable package snapshot and every observed frame must carry the same verdict; missing
or conflicting evidence fails the operation. This field scopes only the browser package snapshot used
to produce pixels. It does not attest FFmpeg audio inputs, encoder reads, or every other final-render
input; those retain their own hashes, artifacts, tool identities, and receipt evidence.

`motion.package.script.author` writes its receipt to the configured private host
authority store, not inside the package: a package-local receipt would change the
attested bytes. Its public result carries the receipt id and inline evidence but never the private
host receipt path. Its result states the important limit explicitly: approved-agent-entry
provenance attests a host-approved local entry and its bytes; it does **not** prove
semantic correctness, review, or human authorship. Revocation, copy/extraction,
package/source mutation, unsafe host-state tampering, and unresolved provenance
produce no active-mode receipt because execution is refused before Chromium starts.

### Document audio-master evidence

When a package declares `motion.audio.master`, a final-video receipt records the persisted bounded
controls at `output.audio.master.controls`. A declared loudness target also records the actual
fixed post-mix realization (`single-pass-loudnorm`) and the final-mux integrated LUFS, true peak,
and LRA readback. Only `loudnessConformance: "passed"` makes the delivered file a successful
target-conforming output. A miss or incomplete readback returns a failed render: the materialized
route writes a failed receipt with the same readback and `loudnessConformance: "failed"`, while
streamed final delivery returns that matching bounded evidence under
`partialOutput.audioMaster`. The media artifact is observable but never represented as accepted
delivery. This is deterministic single-pass delivery control, not two-pass/broadcast mastering.

### Streamed final-video transport

The surface result and dry-run expose `frameTransport` as the two-field
`delivery` / `reason` planner decision; that is not full receipt evidence. For
an ordinary streamed file-video final render, the completed receipt instead
places the typed bounded evidence at `receipt.output.frameTransport`. It records
the chosen frame lane and frame count, `retainedFrameCount: 0`, and producer and
encoder-handoff evidence. A completed materialized final render records only
the two-field decision at `receipt.output.frameTransportPlan`, alongside
`resourcePreflight`. Read the applicable record with the normal output hash,
quality result, and tool provenance: it proves the completed operation's
transport. A durable segmented final receipt instead identifies
`delivery: "resumable-ffv1-segments"` and records the derived-store intent,
plan fingerprint, verified checkpoint/prefix facts, concat proof, and cleanup
outcome without exposing a storage or segment-artifact path.

For a governed GPU hybrid segmented final, the immutable transport identity additionally binds the
frozen source/browser/runtime policy, exact Core capture plan, and one dynamic-texture contract.
Each retained range contributes its ordered request/resource/pixel-ledger hash and cleanup result.
The completed receipt exposes only the aggregate range/capture counts and ordered aggregate hashes;
it does not misrepresent the first range's local ledger or cleanup record as session-wide evidence.

For a browser streamed final, the bounded producer evidence includes one
path-sanitized terminal frame. Its `output.typography` is terminal-frame evidence,
while the producer's stable input-hash union includes manifest-bound font bytes; it
does not claim whole-timeline typography coverage. Materialized final delivery instead
adds `output.typography` with `schema:
"shellx-motion/browser-typography-delivery@1"`, bounded unioned scopes/layers/font
hashes, and explicit `coverage`. Only `coverage: "all-rasterized-frames"` supports a
whole-delivery claim; `partial` is fail-closed as `attestation: "unverified"`.

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
| `preview` | Beside the frame, in the `--out` directory: `<packageId>-{native,browser,gpu}-preview.receipt.json`. GPU preview receipts additionally bind the bounded frame plan, verified adapter fingerprint, and governed resource evidence. |
| `capture-browser` | A new, closed `--out` directory bundle: primary frame, capture receipt, and any requested trace/recording leaves publish together. `--catalog` is a separate post-capture observer; a catalog failure reports `captureCommitted: true` and does not invalidate the matching receipt/frame bundle. |

| GPU preview/final outcome | Receipt/artifact truth |
| --- | --- |
| Hardware PNG still succeeds | `lane: "gpu"`, `operation: "preview.gpu.frame"`, PNG SHA-256, `inputHashes.gpu-frame-plan`, adapter fingerprint, and resource-admission evidence are present. |
| Active-video GPU preview succeeds | In addition to the GPU PNG facts, `output.gpuVideoPreview` has schema `shellx-motion/gpu-preview-video-evidence@1`, scope `preview-visual-only`, Core playhead/source microseconds, immutable-source and decoded-RGBA hashes, decode-contract/request fingerprints, CFR selection, cache telemetry (32 entries / 128 MiB, <=64 MiB in-flight), and stable dynamic-texture metrics. Its limitations are `audio-not-rasterized` and `final-not-attested`: do not read this as final staging, encoder/mux, audio, or native-acceptance evidence. |
| Unsupported package feature | Typed refusal before browser launch; no rendered artifact or substituted CPU/browser receipt is claimed. |
| Cancel/timeout/device loss | Typed failure and governed resource evidence when admission began; the GPU session is closed and no fallback artifact is claimed. |
| GPU final succeeds | The FFmpeg final receipt binds raw-RGBA producer evidence, static scene/resource identities, adapter fingerprint, decoded-frame hashes, and frame-plan sequence. A GPU post-render identity, when present, describes that completed verified artifact only; it is not pre-render cache or reuse authority. |
| `html-snippet-import`/`-export`, `otio-import`/`-export`, `package-archive`/`-extract`, `review-html-bundle` | Beside the artifact `--out` names. Where `--out` is a directory the receipt goes inside it (`html-snippet-export.receipt.json`); where `--out` is a file the receipt is a sibling (`<out>.receipt.json`). Each of these commands returns its `receiptPath` — use it rather than guessing. |
| CLI `render` | Beside the delivered artifact with a deterministic output-specific identity: `<output-file>.receipt.json`. Where `--out` is a file (`mp4-h264`, `png-frame`) the receipt is a sibling of that file; where `--out` is a directory (`png-sequence`) the receipt goes inside it as `<output-directory>.receipt.json`. Different output paths for one package therefore retain distinct no-clobber receipt evidence. The path is also returned as `receiptPath` in the envelope — prefer reading it there over reconstructing it. A CLI render that fails its quality manifest still writes this receipt, because that is when the evidence matters most; it records primary publication as aborted and omits the deleted still/video stage from available artifacts. |
| Debug API / MCP `motion.render.final` | Returns the receipt inline. It persists the same receipt only when the caller or server supplies a governed `receiptsRoot`; the file is `<receiptsRoot>/<receiptId>.receipt.json` and `receiptPath` is returned. Without that root there is no receipt file, including for a failed quality-manifest result. |
| SDK `render` (`@shellx-motion/sdk/local`) | `<artifactRoot>/.shellx-motion/receipts/<receiptId>.receipt.json`, plus an artifact handle under `.shellx-motion/artifacts/`. Override with `receiptsRoot`. |
| `motion.render.cancel` / `.retry` | On Linux, the `receiptsRoot` you passed, beside the target receipt. macOS and Windows return `capability_unavailable` before receipt-state access. |
| `validate`, `motion.package.validate`, SDK `validate` | A passed or failed `package.validate` receipt is written to a governed `receiptsRoot`: CLI requires explicit `--receipts-root`; Debug API/MCP uses its configured host root or a caller root fenced inside it; SDK accepts `receiptsRoot` or its embedding host's configured root. The root must be outside the package, so validation never creates a package-local `receipts/` directory. Without a governed root, the validation result is envelope-only. The verdict uses one loaded package object; document hashes are read afterward, so they attest those bytes and do not claim an atomic filesystem snapshot. If loading fails, `inputHashScope` is `resolved_package_root_identity_only`: its hash binds the resolved location, not unreadable package bytes. |

Analysis lifecycles (for example tracking) write their own receipted artifacts
under the package (`analysis/...`).

The practical rule: read `receiptId` / `receiptPath` from the envelope when they
are there, and persist the inline `receipt` object yourself when they are not.
Do not assume a `receipts/` directory appeared under the package you rendered —
CLI `render` writes its receipt beside the **output**, never back into the source
package. Debug `motion.render.final` instead follows its governed `receiptsRoot`
contract described above.

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

On Linux, the CLI or loopback server can list and read receipts directly through Motion's
descriptor-relative stable-reader capability. macOS and Windows return `capability_unavailable`
before receipt-state access:

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

The identity-stable retained-receipt reader is currently Linux-only. On macOS and Windows these
commands, receipt-backed prompt/render controls, transcripts, and platform-verification summaries
return `capability_unavailable` instead of presenting an empty store as complete evidence. Motion
does not follow a weaker path-based fallback. Raw prompt retention is likewise refused before a
prompt receipt is written when the host cannot enforce the declared read-time purge deadline.

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
