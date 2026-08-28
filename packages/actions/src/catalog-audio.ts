/** Agent actions for document-master, crossfade, and bounded audio-envelope authoring. */
import type { MotionAction } from "./catalog.js";

export const AUDIO_ACTIONS: MotionAction[] = [
  {
    id: "motion.audio.master.set",
    aliases: [
      "set document audio master",
      "set final mix loudness target",
      "set master gain and fade",
      "clear document audio master",
      "verify final program loudness"
    ],
    permission: "edit_motion",
    mutates: true,
    calls: ["motion.state", "motion.audio.master.set", "motion.render.final", "motion.receipts.read"],
    verify: ["The edit receipt records the prior and persisted bounded master. A final-video receipt records the exact master controls, single-pass loudnorm realization when requested, and delivered-program loudness readback; a target miss writes a failed nonconforming-artifact receipt, never a successful delivery. Absent resolved audio is refused."],
    surfaces: ["timeline", "receipts", "prompt"]
  },
  {
    id: "motion.audio.crossfade.set",
    aliases: [
      "crossfade two audio clips",
      "equal power crossfade",
      "match outgoing and incoming audio fades",
      "set layer audio crossfade"
    ],
    permission: "edit_motion",
    mutates: true,
    calls: ["motion.state", "motion.audio.crossfade.set", "motion.timeline.inspect", "motion.receipts.read"],
    verify: ["The receipt records both layer ids, duration, curve, and changed paths. The command refuses non-overlapping, locked, or non-audio layer pairs and never shifts layer timing."],
    surfaces: ["timeline", "receipts", "prompt"]
  },
  {
    id: "motion.procedural.audio-envelope.produce",
    aliases: [
      "produce audio envelope",
      "analyze audio amplitude for procedural animation",
      "generate RMS envelope from audio layer",
      "audio reactive procedural samples"
    ],
    permission: "edit_motion",
    mutates: true,
    calls: ["motion.procedural.audio-envelope.produce", "motion.procedural.inspect", "motion.receipts.read"],
    verify: ["The receipt binds the local source asset hash, source layer, sampling interval, bounded sample count, and sample hash. When the caller-bound governed decoder reports it, the result and receipt carry its genuine local-job resource evidence; injected runners that supply none make no such claim. v0.2 refuses remote, muted/unresolved, trimmed, looping, or retimed sources rather than approximating them."],
    surfaces: ["timeline", "receipts", "prompt"]
  }
];
