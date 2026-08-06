# Platform readiness — asking the machine what it can do

Motion depends on external programs it does not ship. This is how an agent finds out what is
missing BEFORE authoring, instead of after a render fails. Referenced from `SKILL.md`.

Motion shells out to **FFmpeg** to encode and **FFprobe** to read the encode back. It ships
neither. Ask FIRST — one call, one answer, the same object from the CLI and from MCP:

```bash
shellx-motion doctor --json                      # whole machine
shellx-motion doctor --operation render.final    # just what you are about to do
```
```jsonc
// MCP: motion_platform_requirements { "operation": "render.final" }
{ "ok": true,                 // the PROBE ran — never "the machine is ready"
  "result": { "satisfied": false,
    "operation": { "operation": "render.final", "satisfied": false, "possible": true, "blockedBy": ["chromium"],
                   "alternative": { "flag": "--frame-lane native", "avoids": ["chromium"], "packageDependent": true } },
    "platform": { "tools": [ { "tool": "ffmpeg", "status": "ready", "version": "ffmpeg version 6.1.1 …" },
                             { "tool": "chromium", "status": "missing", "problem": "…", "installOptions": [ … ] } ],
                  "operations": [ { "operation": "quality.check", "satisfied": false, "possible": false, "blockedBy": ["ffprobe"] }, … ] } } }
```

Read it correctly and you can tell a user something useful instead of "broken":

- `ok` = the probe ran; a missing binary is a **successful report**, not a failed command.
  `satisfied` = it runs the way you are about to invoke it; `possible` = it runs at all by some
  route. `!satisfied && possible` means "not the default way" and `alternative` names the flag.
- An `alternative` marked `packageDependent` is available but not universal: `--frame-lane native`
  has no font rasterizer and refuses text packages (`native_text_not_deliverable`). Offer, never promise.
- `status` is `ready` / `missing` / `broken` / `unverified`. Offer `installOptions` for `missing`;
  for `broken` the program exists and reinstalling is usually wrong — read `detail`.
- Scope by operation. `preview.frame` needs nothing external by default; `render.final` needs FFmpeg plus Chromium for its default frame lane,
  `quality.check` needs FFprobe. Without FFmpeg, preview frames and all authoring still work; say
  that, do not report the engine as down.

A render that fails this way reports `ffmpeg_not_configured` with the same guidance and the raw
error in `detail`.
