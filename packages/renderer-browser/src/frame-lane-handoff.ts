/**
 * What the browser FRAME lane deliberately does not draw, kept apart from what went wrong.
 *
 * Role: a Motion render is two lanes. The browser lane draws frames; the ffmpeg lane encodes them
 * and muxes audio. An audio layer therefore reaches the frame lane, is correctly not drawn, and is
 * handled downstream — that is the design, not a defect. The frame renderer nonetheless recorded it
 * as an ordinary receipt warning, and because a frame receipt's status is derived from
 * `warnings.length`, a completely successful audio render came out as `status: "warning"`. The
 * `audio-launch` product-pack family failed its release proof on exactly that (the success-status invariant:
 * "status should describe the final deliverable, not an expected division of work between lanes").
 *
 * So this module splits the two things the layer walk can discover:
 *   - `warnings` — the lane could not do something it was supposed to do. Derives status, as before.
 *   - `audioHandoff` — the lane skipped work another lane owns. Structured evidence, never status.
 *
 * The handoff is EVIDENCE, not an assurance: it records that the frame lane passed the layer on. Who
 * checks that the downstream lane actually delivered it is the delivery lane's job — the CLI's
 * `FrameLaneWarnings` resolves this claim against the final receipt's `output.audio` and warns for
 * real when a package's audio reached no deliverable at all.
 *
 * Dependencies: `@shellx-motion/core` for the single definition of "audio-only concern a visual
 * frame lane may ignore" (`isAudioOnlyFrameLaneUnsupported` — the same predicate the browser lane's
 * capability gate and the pipeline resolver use, so there is no second list). Primary caller:
 * the generated-composition layer walk in `index.ts`.
 */
import { isAudioOnlyFrameLaneUnsupported, type MotionLayer } from "@shellx-motion/core";

/** One layer the frame lane passed to the delivery lane instead of drawing. */
export interface FrameLaneAudioHandoffLayer {
  id: string;
  type: string;
}

/**
 * Frame-lane evidence that audio layers were intentionally left to the delivery lane.
 *
 * `status: "handled_downstream"` is the regression's own vocabulary for this state, and it is a literal
 * so a consumer can branch on it without string matching.
 */
export interface FrameLaneAudioHandoff {
  status: "handled_downstream";
  /** The lane that owns the work. Only ffmpeg muxes audio today. */
  handledBy: "ffmpeg";
  layers: FrameLaneAudioHandoffLayer[];
}

/**
 * Collector threaded through the generated-layer walk in place of a bare `string[]`.
 *
 * The type is the point: a caller cannot accidentally push an advisory into the array that derives
 * status, because reaching that array requires naming `warnings` explicitly.
 */
export interface FrameLaneNotes {
  /** Genuine frame-lane defects. These derive the frame receipt's status. */
  warnings: string[];
  /** Audio layers passed downstream, deduplicated by layer id, in first-seen order. */
  audioHandoffLayers: FrameLaneAudioHandoffLayer[];
}

export function createFrameLaneNotes(): FrameLaneNotes {
  return { warnings: [], audioHandoffLayers: [] };
}

/**
 * Record a layer the generated renderer produced no HTML for.
 *
 * Audio-only layer types are a handoff; anything else is a real gap the author must know about. The
 * classification uses the core predicate rather than a local `type === "audio"` test so widening
 * what a frame lane may ignore stays a single edit in `capabilities.ts`.
 *
 * Called once per layer per rendered sample, and motion blur renders a layer several times per
 * frame, so handoff layers are deduplicated by id.
 *
 * @param notes Collector for this composition.
 * @param layer The layer no generated renderer claimed.
 */
export function noteUnrenderedLayer(notes: FrameLaneNotes, layer: MotionLayer): void {
  if (isAudioOnlyFrameLaneUnsupported(`layer.type:${layer.type}`)) {
    if (!notes.audioHandoffLayers.some((entry) => entry.id === layer.id)) {
      notes.audioHandoffLayers.push({ id: layer.id, type: layer.type });
    }
    return;
  }
  const warning = `Browser generated renderer skipped unsupported ${layer.type} layer ${layer.id}.`;
  if (!notes.warnings.includes(warning)) notes.warnings.push(warning);
}

/** The receipt-shaped handoff evidence, or undefined when the composition had no audio layers. */
export function frameLaneAudioHandoff(notes: FrameLaneNotes): FrameLaneAudioHandoff | undefined {
  if (notes.audioHandoffLayers.length === 0) return undefined;
  return { status: "handled_downstream", handledBy: "ffmpeg", layers: notes.audioHandoffLayers };
}
