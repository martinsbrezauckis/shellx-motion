/** Typed public contracts for the bounded document audio master and crossfade edits. */
import type { MotionDebugCommandMetadata } from "./command-registry.js";
import { argsSchema, editReceipt, PACKAGE_EDIT } from "./command-metadata-shared.js";

const EDIT = ["packageRoot", "outDir"];

// This is intentionally a closed JSON-shaped record, not a generic object with a prose
// description. The same bounds are checked by Core and by MCP before dispatch, so a client can
// discover every accepted master control without being invited to send renderer filters or scripts.
const MASTER_LOUDNESS = {
  type: "object" as const,
  required: ["integratedLufs", "toleranceLufs", "maxTruePeakDbtp"],
  properties: {
    integratedLufs: { type: "number" as const, minimum: -70, maximum: -5, description: "Fixed single-pass post-mix loudnorm integrated target in LUFS." },
    toleranceLufs: { type: "number" as const, minimum: 0, maximum: 24, description: "Maximum absolute delivered integrated-loudness deviation in LU." },
    maxTruePeakDbtp: { type: "number" as const, minimum: -9, maximum: 0, description: "Maximum delivered true peak in dBTP." },
    maxLoudnessRangeLu: { type: "number" as const, minimum: 1, maximum: 50, description: "Optional maximum delivered loudness range in LU; it also becomes the fixed loudnorm LRA target." },
  },
  additionalProperties: false,
  description: "Closed delivered-program loudness target. It is realized once after mixing with deterministic fixed-control single-pass loudnorm, then checked from the final output; it is not two-pass broadcast mastering."
};

const MASTER = {
  type: "object" as const,
  properties: {
    volume: { type: "number" as const, minimum: 0, maximum: 4, description: "Final mixed-program gain multiplier." },
    fadeInMs: { type: "number" as const, minimum: 0, description: "Document-master fade-in duration in milliseconds; Core refuses values longer than the document." },
    fadeOutMs: { type: "number" as const, minimum: 0, description: "Document-master fade-out duration in milliseconds; Core refuses values longer than the document." },
    fadeCurve: { type: "string" as const, enum: ["linear", "equal-power"], description: "Curve shared by document-master fades." },
    loudness: MASTER_LOUDNESS,
  },
  additionalProperties: false,
  description: "Bounded document master object: gain, fades, and an optional post-mix loudness target. It accepts no scripts, filter graphs, plugins, or external sources."
};

export const AUDIO_COMMAND_METADATA = {
  "motion.audio.master.set": {
    argsSchema: argsSchema(EDIT, {
      ...PACKAGE_EDIT,
      master: MASTER,
      clear: { type: "boolean", description: "Remove the document master instead of setting master. Cannot be combined with master." }
    }),
    expectedReceipts: editReceipt("audio.master.set")
  },
  "motion.audio.crossfade.set": {
    argsSchema: argsSchema([...EDIT, "fromLayerId", "toLayerId", "durationMs"], {
      ...PACKAGE_EDIT,
      fromLayerId: { type: "string", aliases: ["fromLayer"], description: "Outgoing audio or video-with-audio layer id." },
      toLayerId: { type: "string", aliases: ["toLayer"], description: "Incoming audio or video-with-audio layer id." },
      durationMs: { type: "number", exclusiveMinimum: 0, description: "Positive overlap length in milliseconds. It must exactly align the outgoing end with the incoming start; this command never moves layers." },
      curve: { type: "string", enum: ["linear", "equal-power"], default: "equal-power", description: "Matched fade curve applied to both layers." }
    }),
    expectedReceipts: editReceipt("audio.crossfade.set")
  },
  "motion.procedural.audio-envelope.produce": {
    argsSchema: argsSchema(["packageRoot", "outDir", "sourceLayerId", "envelopeId"], {
      ...PACKAGE_EDIT,
      sourceLayerId: { type: "string", aliases: ["sourceLayer"], description: "Self-contained local audio layer to decode (WAV, FLAC, MP3, Ogg, or Opus). The v0.2 producer refuses video containers, trims, loops, and playback-rate changes it cannot read back exactly." },
      envelopeId: { type: "string", aliases: ["id"], description: "Stable id for the data-only procedural envelope." },
      sampleEveryMs: { type: "number", minimum: 16, maximum: 1000, default: 50, description: "Decoded RMS sampling window in milliseconds. The command refuses output over the existing 4096-sample graph budget." },
      channel: { type: "string", enum: ["mix"], default: "mix", description: "v0.2 decodes one bounded mixed-channel RMS envelope; separate left/right channels remain a future extension." }
    }),
    expectedReceipts: editReceipt("procedural.audio-envelope.produce")
  }
} satisfies MotionDebugCommandMetadata;
