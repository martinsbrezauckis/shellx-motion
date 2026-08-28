# Render output and frame ownership

Use this reference before choosing an output path, retrying a render, or asking Motion to retain
source frames. A path option and retention intent are different contracts.

## Final-video transport

Ordinary FFmpeg file-video renders stream one frame at a time and do not create a PNG sequence.
`keepFrames` / `--keep-frames` is the only retention request. It is valid only for final-video
FFmpeg delivery; native stills, PNG stills, and PNG sequences typed-refuse it. A `framesDir` /
`--frames-dir` value alone is only a materialized-scratch location and does not change the planner.

The planner selects materialization before execution for explicit frame retention, a captured
browser workflow, exact-source quality comparison, streaming quality-capacity refusal, or an
injected frame renderer. A failed streamed attempt never silently falls back to materialization.

## Ownership by surface

| Surface | Streamed default | Materialized frame location | Retention and cleanup |
|---|---|---|---|
| CLI `render --lane ffmpeg` | Does not touch `--frames-dir`. | Frames use `<frames-root>/<packageId>`; a caller-supplied root therefore is not itself the frame directory. | Without `--keep-frames`, Motion removes the exact guarded package frame directory on every terminal path. With it, the result exposes `frames` and leaves the PNGs. |
| Debug API / MCP `motion.render.final` | Does not touch `framesDir`. | A supplied `framesDir` is the exact frame directory; otherwise Motion uses `<scratchRoot>/<packageId>`. | Without `keepFrames: true`, the guarded directory is transient and no frame path or frame receipt is returned. With it, the result exposes `{ frames: { dir, count }, frameReceipt }`. |
| Local SDK `render` | Uses the same Debug streamed default and returns no frame path. | The SDK owns a directory inside its artifact-root scratch area; callers do not supply `framesDir`. | `keepFrames: true` returns validated `{ dir, count }`. Cached success is reusable for such a request only while that retained directory still exists and matches. |
| Direct rendered-media connectors | Use the streamed adapter and a same-directory staging file, then publish the verified file atomically. | They do not create, inspect, retain, or clean a `frames/` tree. | A planner result that requires materialization is a typed pre-execution connector failure; there is no hidden fallback. Failed staging is removed without deleting the requested final path. |

Every final file, still, and PNG sequence uses one root-scoped exclusive publication reservation:
renderers receive a private same-filesystem stage, Motion hashes and reads it back, and then
publishes without clobbering a caller's existing path. Before every create, delete, link, or rename,
Motion pins the canonical non-symlink parent route by device/inode and revalidates it; on POSIX it
also refuses an unrelated-owner or non-sticky group/world-writable ancestor. The private stage and
a forced pre-existing file are identity-bound, so a replacement is refused instead of becoming
receipt evidence or a deletion target. On Windows, Motion also inspects the raw DACL and refuses a
route where an unrelated principal can write, rename, delete, create children, or rewrite ownership.
Exact nested closed-tree inventory publication currently requires Linux descriptor-relative opens;
macOS and Windows fail closed until they have equivalent native descriptor/ACL proof. Stills and PNG
sequences remain outside the final-video transport planner; this publication rule is independent of
frame retention.

The internal resumable segmented-final transport keeps its checkpoint store as Motion-private
control state. A new render atomically creates that store and never adopts a deterministic sibling
that was pre-seeded; resume accepts only the same private store. Motion retains and rechecks the
output route and store identity before each FFmpeg/FFprobe operation and before publication. It
rehashes the exact staging inode after final readback, so a substituted stage is refused, the public
output remains absent, and the previously verified segment checkpoint stays available to an exact
resume.

## Safe reuse and refusal rules

Motion refuses to destroy a caller-named deliverable:

| Target | Rule | Refusal |
|---|---|---|
| Directory output (`png-sequence`, template outputs, preview) | Must be absent; Motion stages an exact closed file inventory and never recursively replaces a caller directory. | `derived_output_exists`, `derived_output_busy`, `derived_output_unsafe_parent`, or `derived_output_stage_invalid` |
| File output (MP4, WebM, GIF, still image) | Must not exist unless that CLI command's explicit `--force` policy applies. A directory at a file path is never recursively replaced. | `derived_output_exists`, `derived_output_busy`, `derived_output_unsafe_parent`, or `derived_output_stage_invalid` |
| CLI materialized package frame directory | May be absent or empty. A non-empty caller-supplied directory is preserved unless `--force` is explicit. | `output_dir_not_empty` or `output_path_unsafe_parent` |
| Debug materialized `framesDir` | May be absent or empty. Debug has no force argument; non-empty or unsafe paths are refused. | `invalid_args` or `output_path_unsafe_parent` |
| Connector workspace and final artifact | Connector-owned output subdirectories must pass their existing empty/absent guards; final publication refuses an existing destination. An unrelated `frames/` directory is not connector-owned. | `output_dir_not_empty`, `output_path_exists`, or a failed connector receipt |

Motion may recursively remove only the exact admitted frame directory after its guard proves the
parent topology and current leaf identity; it never compensates for a changed route with rollback
or another deletion. It must not clean a caller's broader frame root, package root, connector
workspace, or unrelated sibling. A relative Debug `framesDir` resolves against the server process,
so trusted hosts should pass an absolute path when materialization is intentional.

## Evidence to read

A surface result or dry run exposes only the two-field planner decision at `frameTransport`.
Successful streamed receipts carry bounded execution evidence at
`receipt.output.frameTransport`, including zero retained frames. Materialized receipts carry the
two-field decision at `receipt.output.frameTransportPlan` and the materialized resource preflight;
only an explicit retention request makes a returned frame path durable evidence.
