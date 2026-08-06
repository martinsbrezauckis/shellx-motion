/**
 * receipt-tool-provenance.ts — the ONE place a render receipt learns which external tool read its
 * output back.
 *
 * ROLE
 * ----
 * `docs/public/rendering.md` promises that every final FFmpeg receipt records `output.tools.ffmpeg`
 * and, "once a quality check has read the media back", `output.tools.ffprobe`. The encoder half is
 * written by renderer-ffmpeg at encode time, because the encoder is known when the file is written.
 * The FFprobe half cannot be: nothing has read the file yet. It is therefore stamped afterwards, by
 * whichever surface actually ran the readback.
 *
 * Before this module only ONE surface did it. `shellx-motion render --quality-manifest` recorded
 * FFprobe; the identical render driven through `motion.render.final` on the debug/MCP transport (and
 * therefore through the local SDK, which dispatches that same command) recorded only the quality
 * manifest's hash and pass/fail. An agent and a human ran the same render and got receipts carrying
 * different evidence, while the published contract promised one (the tool-provenance invariant). Two copies of
 * a five-line rule is how that happened, so there is now one copy and every surface calls it.
 *
 * THE HONESTY RULE
 * ----------------
 * Provenance is a claim about work that happened. This module records FFprobe only when BOTH hold:
 *
 *   1. FFprobe actually contributed to THIS receipt — the caller states that, because only the
 *      caller knows whether its readback path shelled out to FFprobe. A `png-frame` quality manifest
 *      on the debug transport is answered by a pure PNG reader and never spawns FFprobe, so a
 *      receipt from that path must not name it.
 *   2. The identity probe answered. An unverified tool is left out rather than named without a
 *      version — a receipt that says "ffprobe" with no build is weaker than one that says nothing,
 *      because it reads as evidence while carrying none.
 *
 * A caller that violates (1) cannot be caught by this module, which is why `contributed` is a
 * required, explicitly-named field rather than an optional flag defaulting to true.
 *
 * ADDITIVE BY CONSTRUCTION
 * ------------------------
 * The write merges into `output.tools` and touches nothing else on the receipt: no field is
 * renamed, removed, reordered or restructured. ShellX Cut consumes these receipts against Motion's
 * current shape, so a receipt that gained `output.tools.ffprobe` must still satisfy every consumer
 * pinned to the shape without it.
 *
 * DEPENDENCIES / CALLERS
 * ----------------------
 * Depends on `@shellx-motion/core` (the receipt type) and `@shellx-motion/renderer-ffmpeg` (the
 * shared tool probe and its redacted identity projection). Primary callers: the CLI render command
 * (`packages/cli/src/main.ts`), the debug/MCP `motion.render.final` handler
 * (`packages/debug-api/src/index.ts`), and — transitively, because it dispatches that command and
 * returns the receipt unchanged — the local SDK render path (`packages/sdk/src/local.ts`).
 */
import type { OperationReceipt } from "@shellx-motion/core";
import {
  motionToolIdentity,
  probeMotionTool,
  type FfmpegRunner,
  type MotionToolIdentity,
  type MotionToolName,
  type MotionToolProbeResult
} from "@shellx-motion/renderer-ffmpeg";

/** Why a receipt did not gain a tool identity. Returned rather than thrown: absent provenance is a
 * legitimate outcome, not an error, and a caller that wants to warn needs to know which case it hit. */
export type ReceiptToolProvenanceSkipReason =
  /** The tool played no part in producing this receipt (e.g. a render with no quality manifest). */
  | "not_contributed"
  /** The tool contributed but its identity probe did not answer (`missing` / `broken`). */
  | "probe_unavailable"
  /** The receipt carries no `output.tools` block to merge into (a non-FFmpeg lane's receipt). */
  | "no_tools_block";

/** What {@link recordReceiptFfprobeProvenance} did. `recorded` is the only field a caller must read. */
export type ReceiptToolProvenanceOutcome =
  | { recorded: true; identity: MotionToolIdentity }
  | { recorded: false; reason: ReceiptToolProvenanceSkipReason };

export interface ReceiptFfprobeProvenanceInput {
  /**
   * Did FFprobe actually read this render's output back? Supplied by the caller because only the
   * caller's readback path knows. False leaves the receipt untouched.
   */
  contributed: boolean;
  /**
   * The SAME runner the surface renders and probes media with, so the identity recorded is the
   * identity of the executable that did the work — a host with a bundled or injected FFprobe would
   * otherwise stamp the machine's PATH build into evidence for a readback it never performed.
   */
  runner?: FfmpegRunner;
  /** Test seam. Production probes the resolved FFprobe with {@link probeMotionTool}. */
  probe?: (tool: MotionToolName, runner?: FfmpegRunner) => Promise<MotionToolProbeResult>;
}

/**
 * Merge one external tool's identity into a receipt's `output.tools`, in place.
 *
 * Merging rather than replacing so the encoder entry renderer-ffmpeg already wrote survives, and
 * returning a boolean rather than throwing so a lane whose receipt has no tools block (still frame,
 * PNG sequence) is a quiet no-op instead of a crash on an unrelated render.
 *
 * @param receipt Delivered render receipt. Mutated in place, matching the other receipt enrichers.
 * @param tool Which tool's slot to write.
 * @param identity Redacted identity from a probe that answered.
 * @returns True when the receipt gained the identity; false when it carries no `output.tools`.
 */
export function applyReceiptToolIdentity(
  receipt: OperationReceipt,
  tool: MotionToolName,
  identity: MotionToolIdentity
): boolean {
  const output = plainRecord(receipt.output);
  if (!output) return false;
  const tools = plainRecord(output.tools);
  if (!tools) return false;
  receipt.output = { ...output, tools: { ...tools, [tool]: identity } };
  return true;
}

/**
 * Record FFprobe's identity on a render receipt, if and only if it earned a place there.
 *
 * The probe is spawned HERE rather than at render entry so the cost is paid only on the path where
 * FFprobe actually contributed: a render with no quality manifest never runs it and must not claim
 * it. A probe failure is not propagated — the render succeeded, and losing an evidence field is not
 * a reason to fail it — but it is reported in the outcome so a caller may warn.
 *
 * @param receipt Delivered render receipt. Mutated in place when provenance is recorded.
 * @param input Whether FFprobe contributed, plus the runner/probe seams.
 * @returns Whether the identity was recorded, and if not, why.
 */
export async function recordReceiptFfprobeProvenance(
  receipt: OperationReceipt,
  input: ReceiptFfprobeProvenanceInput
): Promise<ReceiptToolProvenanceOutcome> {
  if (!input.contributed) return { recorded: false, reason: "not_contributed" };
  const probe = input.probe ?? probeMotionTool;
  const result = await probe("ffprobe", input.runner);
  if (result.status !== "ready") return { recorded: false, reason: "probe_unavailable" };
  const identity = motionToolIdentity(result);
  if (!applyReceiptToolIdentity(receipt, "ffprobe", identity)) {
    return { recorded: false, reason: "no_tools_block" };
  }
  return { recorded: true, identity };
}

/** Narrow to a plain JSON object, the only shape a receipt's `output`/`tools` may take. */
function plainRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
