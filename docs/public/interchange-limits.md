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

The limits constrain resource use and path authority. They do not attest that content is safe,
lossless, human-reviewed, or renderer-supported; inspect the resulting receipts and capability
findings before handoff.
