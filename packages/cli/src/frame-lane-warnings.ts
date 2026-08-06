/**
 * Carrying frame-lane warnings into the render receipt that an agent actually reads.
 *
 * Role: a render is two stages — a frame lane draws frames, then a delivery lane encodes them.
 * Each frame carries its own receipt, but only the delivered artifact's receipt is persisted and
 * returned. Anything the frame lane warned about therefore has to be folded forward, or it is
 * lost the moment the frames are encoded away.
 *
 * The defect this closes: a run whose frame receipts said `status:"warning"` with two font-fallback
 * warnings produced a final receipt saying `status:"passed"` with none of them. An agent reading
 * that receipt would conclude the render used the fonts it asked for. It did not.
 *
 * Two things matter here beyond simple copying:
 * - **Every** frame contributes, not just the last one. The previous code kept only the final
 *   frame's receipt, so a warning on frame 1 of 270 vanished silently.
 * - Status escalates but never de-escalates. A warning must not turn a `failed` render into a
 *   `warning` one.
 *
 * It also RESOLVES the frame lane's audio handoff (the success-status invariant). A visual frame lane does
 * not draw audio layers; ffmpeg muxes them afterwards. The browser lane used to record that as an
 * ordinary warning, which made a completely successful audio render report `status: "warning"` and
 * failed the `audio-launch` product-pack proof. It is now structured evidence
 * (`output.audioHandoff`) that says only "this lane passed the layer on" — a claim, not a delivery.
 * This class checks the claim against the artifact that was actually produced:
 *   - the delivery carries audio (`output.audio`) -> the handoff is confirmed and recorded as
 *     `resolution: "muxed"`. No warning, no status change: the deliverable has the audio.
 *   - the delivery carries none (a still frame, an image sequence, a preset with no audio codec)
 *     -> the audio reached NO deliverable, which is a genuine warning and does escalate status.
 * Status therefore describes the final deliverable, which is what the regression asked for, without
 * assuming the downstream lane succeeded.
 *
 * Dependencies: `@shellx-motion/core` for the receipt type. Primary caller: `renderCommand` in
 * `packages/cli/src/main.ts`, once per delivery lane.
 */
import { escalateReceiptStatusForWarnings, type OperationReceipt } from "@shellx-motion/core";

/** Ordered by severity, so escalation is a max() over this scale. */
const STATUS_SEVERITY: Record<OperationReceipt["status"], number> = {
  not_run: 0,
  passed: 1,
  warning: 2,
  failed: 3
};

/** A layer the frame lane reported passing to the delivery lane. */
interface HandoffLayer {
  id: string;
  type: string;
}

/**
 * Frame-lane audio handoff as it is recorded on the DELIVERED receipt, once resolved.
 *
 * `resolution` is the part the frame lane could not know: whether the artifact that was finally
 * produced actually carries the audio it handed off.
 */
export interface ResolvedAudioHandoff {
  status: "handled_downstream";
  handledBy: "ffmpeg";
  layers: HandoffLayer[];
  /** "muxed" when the delivered receipt carries audio evidence; "not_delivered" when it does not. */
  resolution: "muxed" | "not_delivered";
}

/**
 * Accumulates warnings across every frame a render draws.
 *
 * Kept as a class rather than an array so the frame loops cannot accidentally overwrite earlier
 * frames' warnings the way the previous `lastFrameReceipt` assignment did.
 */
export class FrameLaneWarnings {
  private readonly warnings: string[] = [];
  private readonly seen = new Set<string>();
  private readonly handoffLayers: HandoffLayer[] = [];
  private severity = 0;

  /**
   * Fold one frame receipt in. Accepts `unknown` because frame receipts arrive from three
   * different renderer packages with no single shared type at this call site.
   */
  observe(frameReceipt: unknown): void {
    const record = readRecord(frameReceipt);
    if (!record) return;
    for (const warning of readStringArray(record.warnings)) {
      if (this.seen.has(warning)) continue;
      this.seen.add(warning);
      this.warnings.push(warning);
    }
    for (const layer of readHandoffLayers(record.output)) {
      if (this.handoffLayers.some((entry) => entry.id === layer.id)) continue;
      this.handoffLayers.push(layer);
    }
    const status = record.status;
    if (typeof status === "string" && status in STATUS_SEVERITY) {
      this.severity = Math.max(this.severity, STATUS_SEVERITY[status as OperationReceipt["status"]]);
    }
  }

  /** Distinct frame-lane warnings, in the order they were first seen. */
  list(): string[] {
    return [...this.warnings];
  }

  /** Audio layers the frame lane handed downstream, deduplicated, in first-seen order. */
  audioHandoffLayers(): HandoffLayer[] {
    return [...this.handoffLayers];
  }

  /**
   * Merge what the frames reported into the delivered artifact's receipt, in place.
   *
   * Frame warnings are prepended: they describe what was drawn, which is what a reader is
   * looking for, whereas encoder chatter describes how it was packaged.
   */
  applyTo(receipt: OperationReceipt): void {
    const undelivered = this.handoffLayers.length > 0 && !deliveryCarriesAudio(receipt.output);
    // The handoff is recorded on the delivered receipt either way — an verifier can see which
    // layers the frame lane never drew, and whether they made it into the artifact.
    if (this.handoffLayers.length > 0 && receipt.output && typeof receipt.output === "object" && !Array.isArray(receipt.output)) {
      const resolved: ResolvedAudioHandoff = {
        status: "handled_downstream",
        handledBy: "ffmpeg",
        layers: this.audioHandoffLayers(),
        resolution: undelivered ? "not_delivered" : "muxed"
      };
      (receipt.output as Record<string, unknown>).audioHandoff = resolved;
    }
    // A handoff that reached no deliverable IS a defect: the author asked for audio and the
    // artifact has none. This is the one case where the handoff derives status.
    const undeliveredWarnings = undelivered
      ? [`Audio ${this.handoffLayers.length === 1 ? "layer" : "layers"} ${this.handoffLayers.map((layer) => layer.id).join(", ")} `
        + "were not drawn by the frame lane and the delivered artifact carries no audio track; this output is silent."]
      : [];
    if (this.warnings.length === 0 && undeliveredWarnings.length === 0 && this.severity < STATUS_SEVERITY.warning) return;
    const existing = receipt.warnings ?? [];
    const merged: string[] = [];
    const seen = new Set<string>();
    for (const warning of [...this.warnings, ...undeliveredWarnings, ...existing]) {
      if (seen.has(warning)) continue;
      seen.add(warning);
      merged.push(warning);
    }
    receipt.warnings = merged;
    // Escalate only. A frame-lane warning must never soften a failed delivery.
    const severity = Math.max(this.severity, undeliveredWarnings.length > 0 ? STATUS_SEVERITY.warning : 0);
    const current = STATUS_SEVERITY[receipt.status] ?? 0;
    if (severity > current && receipt.status !== "failed") {
      receipt.status = severity === STATUS_SEVERITY.failed ? "failed" : "warning";
    }
    // This method ADDS warnings to a receipt whose status was already decided at construction, so
    // the shared rule is re-applied over the merged array — otherwise the one place that can put an
    // actionable warning onto an already-`passed` receipt would be the one place the rule does not
    // reach. Escalate-only by construction; `escalateReceiptStatusForWarnings` leaves anything that
    // is not `passed` exactly as the lines above left it.
    receipt.status = escalateReceiptStatusForWarnings(receipt.status, receipt.warnings);
  }
}

/**
 * Whether the delivered artifact actually carries audio.
 *
 * `output.audio` is written by the ffmpeg lane only when the preset has an audio codec AND audio
 * inputs were staged, so its presence is evidence of a real muxed track rather than an intention.
 */
function deliveryCarriesAudio(output: unknown): boolean {
  const record = readRecord(output);
  return Boolean(record && readRecord(record.audio));
}

/** Read `output.audioHandoff.layers` from a frame receipt, tolerating any other shape. */
function readHandoffLayers(output: unknown): HandoffLayer[] {
  const handoff = readRecord(readRecord(output)?.audioHandoff);
  if (!handoff || handoff.status !== "handled_downstream" || !Array.isArray(handoff.layers)) return [];
  return handoff.layers.flatMap((entry) => {
    const layer = readRecord(entry);
    return layer && typeof layer.id === "string" && typeof layer.type === "string"
      ? [{ id: layer.id, type: layer.type }]
      : [];
  });
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}
