/** Render execution and its deliberately non-authorising v2 reuse observation. */
import type { MotionAction } from "./catalog.js";

export const RENDER_CACHE_PLAN_ACTIONS: MotionAction[] = [
  {
    id: "motion.render.final",
    aliases: [
      "render mp4", "export video", "final render", "render this lower third as mp4", "export png sequence frames",
      "render image sequence", "export frame sequence", "png sequence export", "export current frame as png still",
      "export still frame", "render png frame", "jpeg frame export", "export jpg frame",
      "render final mp4 with a quality manifest", "render with quality manifest", "quality manifest render",
    ],
    permission: "render_motion",
    mutates: true,
    calls: ["motion.render.final", "motion.render.status", "motion.receipts.read"],
    verify: [
      "Render receipt includes output file hash, codec, duration, and dimensions.",
      "Image-sequence render receipts include output frame directory, frame pattern, frame count, and PNG codec facts.",
      "Still-frame render receipts include output image path, timestamp, codec, and image artifact evidence.",
      "Quality manifests gate final renders; attested reuse requires receipt-linked source evidence, and a verified hit needs no current browser or FFmpeg run.",
      "Render status returns queue-style job state and progress derived from host receipts.",
    ],
    surfaces: ["preview", "receipts", "prompt"],
  },
  {
    id: "motion.render.cache.plan",
    aliases: [
      "plan attested render reuse", "check render cache reuse", "will this render reuse", "check exact render cache hit",
      "inspect render reuse before rendering", "attested render cache plan",
    ],
    permission: "render_motion",
    mutates: false,
    calls: ["motion.render.cache.plan"],
    verify: [
      "Plan reports only a verified v2 entry as a hit; absent or unmaterialized output roots are misses, and unsafe, busy, unsupported, or integrity states are refusals.",
      "The observation creates no root, lock, descriptor, receipt, artifact, or render authorization; final render rechecks identity, admission, and lock facts.",
    ],
    surfaces: ["preview", "prompt"],
  },
];
