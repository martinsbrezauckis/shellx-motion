/**
 * The ONE rule that decides what a receipt `status` is a claim about.
 *
 * Role: three surfaces emit receipts — the preview frame lanes, the final render lane, and the
 * connectors that aggregate both for a ShellX Cut handoff — and until this module existed each
 * answered "does a warning make this a `warning`?" differently:
 *
 *   - preview (`previewReceiptStatus`) escalated on ANY non-empty `warnings` array;
 *   - final render receipts escalated on NOTHING in `warnings` — only frame-lane severity moved
 *     them — so a `passed` receipt could carry an encoder complaint;
 *   - connectors escalated on any warning that was not recognised FFmpeg component chatter.
 *
 * A render receipt must not say `passed`
 * while the connector receipt aggregating the SAME `MOTION_DENSITY` advisory said `warning`, and the
 * native GIF lane returned `passed` carrying a palettegen advisory. Nothing was false in either
 * receipt, but a consumer reading `status` and a consumer reading `warnings.length` reached opposite
 * conclusions about one artifact — and two gates covering one render needed different expectations.
 *
 * THE RULE, in one place:
 *
 *   failed                  -> "failed"
 *   any ACTIONABLE warning  -> "warning"
 *   otherwise               -> "passed"
 *
 * "Actionable" is every warning that is not FFmpeg's own routine component output. That carve-out is
 * not a softening of the rule: FFmpeg narrates its own components on a completely successful encode
 * ("Duped color: FFDCDDE0" from palettegen, muxing statistics), and escalating on that would make
 * every GIF and every faststart MP4 a warned render forever — warning fatigue, which is how a real
 * warning stops being read. The carve-out is STRUCTURAL (a component prefix), so it can only ever
 * swallow lines FFmpeg itself emitted through its logging API, never a statement Motion made.
 *
 * WHAT CHANGED FOR EACH SURFACE:
 *   - preview: slightly MORE permissive — chatter no longer escalates. In practice no preview lane
 *     shells out to FFmpeg, so no preview warning has ever had the chatter shape; the change is a
 *     consistency fix, not a relaxation of anything that fires today.
 *   - final render: MORE strict — an actionable warning now escalates instead of riding silently on
 *     a `passed` receipt.
 *   - connector: unchanged. It already implemented this rule; it now imports it instead of owning it.
 *
 * Dependencies: `./types` for the receipt status vocabulary. Primary callers:
 * `./receipts` (`previewReceiptStatus`, `createRenderReceipt`),
 * `packages/connectors/src/artifacts.ts` (`connectorReceiptStatus`),
 * `packages/cli/src/frame-lane-warnings.ts` (re-derives after it merges frame warnings in).
 */
import type { OperationReceipt } from "./types";

/**
 * The three statuses this rule can produce.
 *
 * `not_run` is deliberately absent: it describes an operation that never happened, which no count of
 * warnings can establish or contradict. Callers that may hold it use
 * {@link escalateReceiptStatusForWarnings}, which passes it through untouched.
 */
export type ReceiptWarningStatus = Extract<OperationReceipt["status"], "passed" | "warning" | "failed">;

/**
 * Whether a warning is FFmpeg's own component chatter rather than something the caller must act on.
 *
 * Two shapes, both anchored at the start of the warning:
 *   - `frame=  123 fps=...` — the progress line, which FFmpeg writes on every encode;
 *   - `[<component> @ <instance>] ...` — anything logged through FFmpeg's component logging API.
 *
 * The instance alternative accepts a hex pointer (`0x641500efbe80`, and the bare `641500efbe80` a
 * Windows build prints) AND the literal `[address]`, because `summarizeSuccessfulEncodeStderr`
 * normalises the run-varying pointer before the warning reaches a receipt — the address changes
 * every run, which made two renders of the same package produce receipts differing only in noise.
 *
 * Missing that normalised form is not cosmetic: this predicate decides `passed` vs `warning`, so a
 * normalised diagnostic that stops matching here silently escalates a clean export. That is exactly
 * what happened when normalisation was introduced, and it is why the two must be changed together.
 *
 * @param warning One entry from a receipt's `warnings` array.
 * @returns True when the line is FFmpeg narrating itself, false for anything Motion said.
 */
export function isEncoderChatterWarning(warning: string): boolean {
  const text = warning.trim();
  return /^frame=\s*\d+/i.test(text) || /^\[[^\]]+ @ (?:\[address\]|(?:0x)?[0-9a-f]+)\]/i.test(text);
}

/**
 * The subset of `warnings` a reader has to act on — everything that is not encoder chatter.
 *
 * Exposed alongside the status rule so a surface that wants to SHOW why it escalated does not have
 * to re-implement the filter and drift from it.
 *
 * @param warnings A receipt's warnings, in receipt order.
 * @returns The actionable warnings, in the same order.
 */
export function actionableReceiptWarnings(warnings: readonly string[]): string[] {
  return warnings.filter((warning) => !isEncoderChatterWarning(warning));
}

/**
 * Decide a receipt status from a failure flag and the warnings the operation produced.
 *
 * This is the canonical rule. Every surface that emits a receipt status derives it from here.
 *
 * @param input.failed Whether the operation itself failed. Wins over every warning consideration.
 * @param input.warnings The warnings the operation produced.
 * @returns `failed`, `warning`, or `passed` under the rule documented on this module.
 */
export function receiptStatusForWarnings(input: { failed?: boolean; warnings: readonly string[] }): ReceiptWarningStatus {
  if (input.failed) return "failed";
  return actionableReceiptWarnings(input.warnings).length > 0 ? "warning" : "passed";
}

/**
 * Apply the rule to a status a caller has ALREADY decided, escalating only.
 *
 * A caller that already concluded `failed`, `warning` or `not_run` keeps its conclusion — warnings
 * can never soften a verdict, and a count of warnings cannot turn "this never ran" into "this
 * passed". Only a `passed` claim is re-examined against its own warnings, which is the case that
 * produces a contradiction: a receipt asserting success while carrying something the caller must act on.
 *
 * @param status The status the emitting surface decided.
 * @param warnings The warnings that will ship on the same receipt.
 * @returns `status`, or `warning` when a `passed` claim carries an actionable warning.
 */
export function escalateReceiptStatusForWarnings(
  status: OperationReceipt["status"],
  warnings: readonly string[]
): OperationReceipt["status"] {
  if (status !== "passed") return status;
  return receiptStatusForWarnings({ warnings });
}
