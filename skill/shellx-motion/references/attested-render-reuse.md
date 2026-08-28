# Opt-in attested render reuse

Use the blocking Debug/MCP route only when the exact output path is intentionally stable:

```bash
shellx-motion debug render-final --tier render_motion --trusted-local-tier \
  --package /path/to/package --out /path/to/output.png --preset png-frame --reuse-attested
```

This is `motion.render.final` with `reuseAttested: true`, not ordinary `render` or a job/batch
selector. Motion derives its v2 key from the resolved plan, exact output-relative identity,
bounded current package/workflow/quality bytes, and engine version. Do not supply a cache root,
key, descriptor path, or receipt selector.

Every declared quality baseline is included by ordered hash. It must be a direct regular
non-symlink file inside the manifest's canonical directory. At most 64 baselines are read; each
workflow, manifest, or baseline input is capped at 4 MiB. Missing, symlinked, escaping, or
oversized inputs refuse reuse before lookup; ordinary rendering remains available without the
option.

A verified hit performs current static package/capability checks and writes a fresh `render.reuse`
receipt linked to the source render evidence. It preserves that receipt's recorded tool provenance,
but does not claim Chromium or FFmpeg is currently available because neither producer starts on a
hit. It also verifies a root-bound HMAC producer proof made with a host-held key; descriptor,
receipt, and media hashes that an output-root co-writer can recompute are not enough. The installed
server retains this key privately across restarts. Missing or foreign producer proof refuses the
entry. `dryRun`, `keepFrames`, and `png-sequence` are refused; jobs, batch rendering, legacy CLI
`render`, and legacy SDK descriptor reuse do not adopt this option. Existing output without its
exact descriptor, a bad descriptor, or a busy root-local fill lock fails closed rather than
overwriting or rerendering.
