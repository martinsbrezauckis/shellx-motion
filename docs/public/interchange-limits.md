# Host interchange and archive limits

Motion treats Canvas, Cut connector, scripted-video, source Markdown, and OTIO files as bounded
host interchange, not as arbitrary local files. A request is refused before package publication if
it exceeds any of these limits:

| Limit | Host interchange | Package archive write |
| --- | ---: | ---: |
| One file | 16 MiB | 64 MiB |
| File count | 256 | 1,024 |
| Relative path depth | 16 components | 16 components |
| Aggregate admitted bytes | 64 MiB | 256 MiB |
| Simultaneous reads | 4 | 4 |

OTIO import applies a second structural budget before it clones tracks or builds diagnostics. The
pre-parse scan admits at most 50,000 structural tokens and 32 nesting levels. The parsed tree admits
at most 50,000 nodes, 100,000 aggregate object fields, 256 fields in one object, 10,000 items in one
array, and 8 MiB of aggregate UTF-8 object-key and string bytes. Timeline lowering then admits at
most 256 tracks, 4,096 children in one track, 10,000 children across the timeline, and 1,024 retained
lossiness findings. Exceeding any limit refuses the import before package publication.

## Lottie, dotLottie, and HTML/CSS lowering

Lottie JSON is bounded before `JSON.parse` builds its object graph: 16 MiB of source bytes,
300,000 structural tokens, depth 64, 100,000 values, 20,000 items in one array, 1,000 fields in one
object, and 1 MiB per string. `motion.lottie.import` refuses a source outside any of those limits
before it creates a package.

A dotLottie container has its own bounded ZIP contract: 32 MiB compressed, 64 MiB expanded,
16 MiB per entry, 256 entries, 512 UTF-8 bytes and four components per entry path, and a 200:1
maximum compression ratio. Multi-disk, ZIP64, encrypted, duplicate, unsafe-path, non-regular, and
inconsistent local/central-directory entries refuse. The selected animation is then subject to the
same Lottie JSON budget, plus at most 256 animation assets, 4,096 layers in one composition, 64
precomposition visits, 4,096 total discovery work items, and precomposition depth four. Referenced
bundled fonts are limited to 32. State machines are preserved as data and are never executed.

HTML snippet import admits at most 8 MiB of markup, 1,000 declared layers, and 256 MiB for one
package-relative media asset (512 MiB across its admitted media). Its parser permits at most 64
attributes and 64 CSS declarations for an element, 64,128 of each across the document, 64 KiB of
attribute/style string materialization for an element, and 8 MiB in aggregate. Lossiness output is
also bounded to 2,048 findings and 768 KiB of serialized finding/warning data. These are refusal
limits; they do not expand the supported HTML/CSS subset or make the lowering lossless.

## Canvas and scripted-video inputs

Canvas selection import admits at most 128 frames, 1,024 layers per frame, 4,096 layers in total,
1,024 image-editor outputs, 64 safe areas per frame, and 256 edit-stack entries for an output. It
returns at most 256 structured validation problems; once that cap is exceeded, the final entry is a
deterministic omission summary. Individual problem fields are capped at 4 KiB and the plain error
message at 64 KiB. The bounded diagnostic result is not a promise that every malformed field is
listed.

Scripted-video import admits 1–120 frames, each 100–60,000 ms, with a maximum total duration of
600,000 ms. Per frame it accepts at most 12 effects, 32 asset references, 24 source references, and
16 tags; the cross-frame maxima are 1,024 effects, 2,048 asset references, 2,048 source references,
and 1,024 tags. Before generating Motion data, it reserves at most 128 generated layers and 1,024
generated keyframes per frame, and 8,192 layers and 65,536 keyframes across the request. Inputs that
would exceed those projected limits refuse instead of partially lowering.

P2B Script-to-Cut applies a tighter 1 MiB source limit before it reads or parses file-backed JSON.
Every retained scripted-video string is limited to 16 KiB of UTF-8. `template.variables` is cloned
as JSON data only and is limited to 64 KiB, eight nested levels, 64 entries in one array or object,
and 512 values in total. Receipt hashing uses the normalized closed schema rather than ignored
caller fields, and package JSON is structurally measured against the 16 MiB interchange-file limit
before a complete serialized buffer is allocated.

Archive extraction remains streamed and additionally refuses an archive over 512 MiB, an expanded
package over 1 GiB, an entry over 256 MiB, more than 10,000 entries, a path deeper than 32
components, a path over 1,024 UTF-8 bytes, or JSON over 16 MiB. These are upper bounds, not host
configuration knobs exposed to an agent.

Every admitted source is a regular file opened with no-follow semantics and checked for a stable
identity before and after the read. Canvas assets are hashed from those admitted bytes, copied from
those same bytes into an exclusive no-follow destination, and then re-read and re-hashed before
they are considered published. Symlinked source parents, package parents, and destinations are
refused. Inline scripted-video content stays in memory; it is never first written to a caller's
`scriptPath`.

## Caller and executable identity

Batch resume reopens an existing output only under exclusive retained-output authority and the same
server-authenticated caller recorded in its prior batch receipt. A missing or unverifiable owner
fails with `capability_unavailable`; a different caller receives `job_not_visible`; both leave the
retained output unchanged. The caller identity is host context, never a batch command argument.

Generic connector reference fields remain opaque until the trusted host resolver receives the
authenticated caller identity for that exact resolution. The immutable connector binding retains
that owner, and an explicit retry uses the retained owner rather than a caller-nominated replacement.
The [Cut job integration specification](cut-job-integration-spec.md) defines the corresponding host
setup and retry lifecycle.

Receipt-derived `motion.render.status`, `motion.render.queue`, `motion.render.cancel`, and
`motion.render.retry` use that same host-authenticated caller boundary. New final and control
receipts retain their logical owner; reads and controls ignore another caller's receipts. Legacy
ownerless receipts fail closed unless the host explicitly grants the operator-level cross-caller
scope already used by `motion.job.*`.

On Windows, an agent executable must resolve to a canonical regular `.exe`, `.com`, `.cmd`, `.bat`,
or `.ps1` target from an absolute target or an absolute `PATH` entry. Motion revalidates that target
immediately before child execution. Script wrappers run through Motion's fixed, system-resolved
PowerShell shim with the declared arguments; its internal provider path and argument variables are
removed from the inherited child environment and synthesized only for that launch. A failed identity
check refuses the agent launch rather than falling back to an ambient shell or a changed executable.

The limits constrain resource use and path authority. They do not attest that content is safe,
lossless, human-reviewed, or renderer-supported; inspect the resulting receipts and capability
findings before handoff.
