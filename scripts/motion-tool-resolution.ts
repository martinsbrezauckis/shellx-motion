/**
 * Print how Motion will resolve its codec executables, as JSON on stdout.
 *
 * Role: the seam that lets a plain-JS script (`scripts/platform-verify.mjs`) ask the SAME resolver
 * the renderer uses instead of re-deriving the answer from PATH. Re-deriving it is exactly what put
 * a different FFmpeg in the release receipt than the one that rendered the media beside it: on a
 * Windows host with a ShellX-family bundled FFmpeg, `resolveMotionToolLocation` selects the bundled
 * binary while a PATH lookup selects whatever `where.exe` finds first.
 *
 * Emits `source` (override / shellx-family / path) and the executable string the renderer will
 * spawn. The caller probes that executable itself for version/hash, so nothing here needs to.
 *
 * Primary caller: `scripts/platform-verify.mjs` (`resolveMotionCodecTools`).
 */
import { resolveMotionToolLocation } from "../packages/renderer-ffmpeg/src/index";

process.stdout.write(`${JSON.stringify({
  ffmpeg: resolveMotionToolLocation("ffmpeg"),
  ffprobe: resolveMotionToolLocation("ffprobe")
})}\n`);
