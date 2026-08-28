/**
 * Status assertions shared by the required render smokes.
 *
 * Role: a render smoke has to answer one question — "did this host actually deliver the media it
 * was asked for?" — and the honest answer has three parts, not one. This module holds all three so
 * that five smokes cannot drift into five different opinions about what success looks like.
 *
 * Four required smokes once asserted
 * `receipt.status === "passed"` and one asserted the job state `"queued"`. Both are obsolete
 * vocabulary. Real renders produced real media and correctly-warned receipts, and the gates called
 * them failures. The temptation is to widen the accepted set to `passed|warning` and move on — that
 * would make the gate accept a receipt that warns about anything at all, including a warning that
 * says the output is wrong. So acceptance here is built from three independent facts:
 *
 *   1. **The receipt status maps to a succeeded job.** Not a hand-written `passed|warning` list —
 *      `jobOutcomeForReceiptStatus()` is generated from `schemas/job-status.json`, which is the only
 *      place the mapping is authored (`docs/public/JOB_STATUS.md`, "Job status is not receipt status").
 *      A status the contract does not map, or maps to anything but `succeeded`, fails here.
 *   2. **The job record agrees.** Receipt status and job outcome are deliberately different axes,
 *      so a smoke that reads only the receipt has checked one of them. `assertJobSucceeded()` reads
 *      the per-user job store back through `shellx-motion job get`, from the same process boundary a
 *      host would use.
 *   3. **The warning is a warning we expected.** A warned success is accepted only when the receipt
 *      names the advisory the smoke predicted (a font fallback, a static-motion measurement). An
 *      unexplained `warning` — one carrying no recognised advisory — is not a success this gate will
 *      sign, because "some warning happened" is exactly the state that hides a real regression.
 *
 * Dependencies: `packages/core/src/index` for the generated contract, `packages/cli/src/main` for
 * the job query. Primary callers: `scripts/render-mp4-smoke.ts`, `render-webm-smoke.ts`,
 * `render-caption-smoke.ts`, `render-gif-smoke.ts`, `render-job-lifecycle-smoke.ts`, and — since the
 *  class sweep — every `scripts/connector-*-smoke.ts`, `connector-*-real-apply.ts` and
 * `source-storyboard-cut-smoke.ts`. The connector lane carries one advisory the render lane does not
 * (see {@link NATIVE_CASE_FOLD_ADVISORY}), because a connector previews on the native lane before it
 * renders; the acceptance RULE is identical, and is authored here once on purpose.
 */
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { actionableReceiptWarnings, jobOutcomeForReceiptStatus, projectJobState, JOB_STATES } from "../packages/core/src/index";
import { runCli } from "../packages/cli/src/main";

/**
 * The browser frame lane could not use the font the package asked for.
 *
 * Honest and expected on any host without the package's font family installed, which includes every
 * clean CI runner. It is a warning precisely because the delivered text is not the text that was
 * specified — the artifact exists, but one property of it is not what was asked for.
 */
export const FONT_FALLBACK_ADVISORY = /^Browser renderer used a font fallback for text layer .+\.$/;

/**
 * The measured render holds still for a large share of its duration.
 *
 * Intrinsic to the keyframed lower-third fixture (a lower third animates in and then sits), so it is
 * present on every host regardless of installed fonts, and it is the advisory that keeps the MP4,
 * WebM and caption smokes in `warning` even where the fonts do resolve.
 */
export const MOTION_DENSITY_ADVISORY = /^Rendered motion is static for /;

/**
 * FFmpeg's palette generator emitted one or more adjacent duplicate entries while building a GIF
 * palette.
 *
 * FFmpeg logs this at warning level, so Motion deliberately retains it on the render receipt and
 * keeps that receipt at status `warning`. It is not a render failure, though: `palettegen` logs the
 * message while writing its 16×16 palette and then supplies that palette to `paletteuse`. The GIF
 * smoke independently verifies the delivered GIF signature, dimensions, and decoded quality frame.
 *
 * This is an admission only for the browser GIF smoke's known encoder observation. The pattern is
 * anchored to the normalized `Parsed_palettegen` entry, exact `Duped color` wording, and one or
 * more eight-digit ARGB colours. It does not admit another filter's warning, changed prose, or a
 * diagnostic appended to the same entry.
 */
const GIF_PALETTEGEN_DUPLICATE_COLOUR_ENTRY = String.raw`\[Parsed_palettegen_\d+ @ \[address\]\] Duped color: [0-9A-F]{8}`;
export const GIF_PALETTEGEN_DUPLICATE_COLOUR_ADVISORY = new RegExp(
  `^(?:${GIF_PALETTEGEN_DUPLICATE_COLOUR_ENTRY})(?: ${GIF_PALETTEGEN_DUPLICATE_COLOUR_ENTRY})*$`
);

/**
 * The native frame lane drew lowercase text with its uppercase block-glyph set.
 *
 * The native rasterizer has no font engine — it owns a fixed repertoire of uppercase block glyphs
 * (`packages/renderer-native/src/native-glyphs.ts`), so lowercase input is folded to uppercase and
 * the emitted frame says something the package did not ask for. `packages/renderer-native/src/index.ts`
 * raises it per layer, naming the layer and the exact characters it folded, and the connector
 * receipt aggregates it up from the native preview pass.
 *
 * It is the connector analogue of {@link FONT_FALLBACK_ADVISORY}: honest, expected on any connector
 * whose preview lane is (or resolves to) `native`, and a real statement that one property of the
 * delivered pixels is not the property that was specified. It is NOT a licence to accept `warning`
 * generally — the text-delivery gate escalates the same condition to a hard
 * `native_text_not_deliverable` failure whenever the native lane is asked to DELIVER the text rather
 * than preview it, and that failure must still fail.
 *
 * Anchored end-to-end on the emitting template rather than matched loosely, so a future warning that
 * merely mentions block glyphs (unsupported-character fallback, an ignored font family) does not
 * silently inherit this acceptance.
 */
export const NATIVE_CASE_FOLD_ADVISORY =
  /^Native renderer case-folded lowercase text to uppercase block glyphs on layer .+: .+\.$/;

/**
 * The rendered frame sequence never changes from first frame to last.
 *
 * The coarse companion to {@link MOTION_DENSITY_ADVISORY}: the density measurement reports WHERE a
 * partially-static piece stops moving, this one fires when nothing moves at all. Legitimate and
 * expected for a fixture that is a still card by design — the audio gate renders a static lower
 * third precisely so the thing under test is the muxed audio, not the picture — and a real warning
 * everywhere else, which is why a smoke has to declare it rather than inherit it.
 *
 * Anchored end-to-end on the emitting sentence so a future warning that merely mentions a static
 * sequence does not silently inherit this acceptance.
 */
export const STATIC_SEQUENCE_ADVISORY =
  /^Rendered frame sequence is static; verify this is intentional before using it as product output\.$/;

/** A receipt read out of a CLI result — only the fields these assertions need. */
export interface SmokeReceiptFacts {
  status: string;
  warnings: string[];
}

export interface WarnedSuccessOptions {
  /** Names the render in assertion messages, e.g. "MP4 render". */
  label: string;
  /**
   * Advisories this render is expected to raise when it warns.
   *
   * At least one must match, or the warned status is rejected. Pass an empty array only for a render
   * that must never warn — then use {@link assertWarningFreeSuccess} instead, which says so directly.
   */
  expectedAdvisories: readonly RegExp[];
}

export interface WarnedSuccessEvidence {
  /** The receipt status that was accepted, verbatim. */
  status: string;
  /** The job outcome the contract maps that status onto. Always `succeeded` once this returns. */
  outcome: string;
  /** Every warning the receipt carried, so the smoke's output shows what was accepted and why. */
  warnings: string[];
  /** The warnings that matched an expected advisory. Empty only when the status was `passed`. */
  matchedAdvisories: string[];
}

/**
 * Accept a render receipt as a success under the canonical contract.
 *
 * Accepts `passed` and, for a receipt that warns, only a `warning` **every one of whose actionable
 * warnings** names a declared advisory. Rejects `failed`, `not_run`, and any status the generated
 * contract does not map — including a future status added without updating the contract.
 *
 * "Every", not "at least one", and the difference matters. `at-least-one` was the rule until
 * , and it meant an UNEXPECTED warning rode through unexamined whenever an expected one
 * happened to be present too — which is exactly the shape of the case this gate must never shrug at:
 * a delivered file that lacks the colour its preset promised, arriving on the same receipt as a
 * routine font-fallback advisory. A smoke that accepted that would be signing for an artifact whose
 * colour is wrong.
 *
 * "Actionable" is the same set the receipt status itself is derived from — everything that is not
 * FFmpeg's own component chatter (`actionableReceiptWarnings` in `@shellx-motion/core`). Deriving it
 * from the same predicate is the point: the warnings that made this receipt a `warning` are exactly
 * the warnings this gate demands an explanation for, so the two can never drift apart.
 */
export function assertReceiptSucceeded(receipt: unknown, options: WarnedSuccessOptions): WarnedSuccessEvidence {
  const facts = readReceiptFacts(receipt, options.label);
  const outcome = jobOutcomeForReceiptStatus(facts.status);
  assert.equal(
    outcome,
    "succeeded",
    `${options.label} receipt status ${JSON.stringify(facts.status)} does not map to a succeeded job under `
      + `schemas/job-status.json (mapped to ${JSON.stringify(outcome ?? null)}).`
  );

  if (facts.status !== "warning") {
    return { status: facts.status, outcome: "succeeded", warnings: facts.warnings, matchedAdvisories: [] };
  }

  // A warned success has to name what it warned about. Accepting `warning` without checking the
  // text would let any future regression that emits any warning ride through this gate.
  assert(
    facts.warnings.length > 0,
    `${options.label} receipt claims status "warning" with an empty warnings array; a warned success must carry its warning.`
  );
  const matchedAdvisories = facts.warnings.filter((warning) => options.expectedAdvisories.some((pattern) => pattern.test(warning)));
  assert(
    matchedAdvisories.length > 0,
    `${options.label} receipt warned, but none of its warnings match an advisory this smoke expects.\n`
      + `Expected one of: ${options.expectedAdvisories.map((pattern) => pattern.source).join(" | ")}\n`
      + `Got: ${JSON.stringify(facts.warnings, null, 2)}`
  );
  const unexplained = actionableReceiptWarnings(facts.warnings)
    .filter((warning) => !options.expectedAdvisories.some((pattern) => pattern.test(warning)));
  assert.deepEqual(
    unexplained,
    [],
    `${options.label} receipt carries a warning this smoke does not declare, alongside ones it does.\n`
      + `An advisory this gate has not been told to expect is a regression until someone says otherwise — `
      + `add an ANCHORED pattern for it here if it is legitimate, and never a broad one.\n`
      + `Unexplained: ${JSON.stringify(unexplained, null, 2)}\n`
      + `Declared: ${options.expectedAdvisories.map((pattern) => pattern.source).join(" | ")}`
  );
  return { status: facts.status, outcome: "succeeded", warnings: facts.warnings, matchedAdvisories };
}

/**
 * Accept a render receipt only as an unwarned `passed`.
 *
 * For the lane/fixture combination that is expected to have nothing to warn about, so the suite
 * keeps one exact-`passed` proof rather than relying entirely on the widened acceptance above.
 *
 * `warnings` is deliberately NOT required to be empty, and that is still true under the unified
 * status rule : the ffmpeg lane appends the encoder's own surviving stderr lines to the
 * receipt, and FFmpeg's routine component output is CHATTER, which
 * `receiptStatusForWarnings` in `@shellx-motion/core` does not escalate on. So a `passed` receipt
 * can still carry `[libx264 @ [address]] …` statistics — and can no longer carry anything Motion
 * itself flagged. Asserting the status is the claim that matters; the warnings are reported.
 */
export function assertWarningFreeSuccess(receipt: unknown, label: string): WarnedSuccessEvidence {
  const facts = readReceiptFacts(receipt, label);
  assert.equal(
    facts.status,
    "passed",
    `${label} receipt must be an unwarned success; got ${JSON.stringify(facts.status)} with `
      + `${JSON.stringify(facts.warnings, null, 2)}`
  );
  return { status: "passed", outcome: "succeeded", warnings: facts.warnings, matchedAdvisories: [] };
}

/**
 * Read the media the render claims to have delivered, and prove it is really there.
 *
 * The contract's own warning applies to a smoke as much as to an agent: "a non-empty artifacts array
 * does not imply success: a failed encode can leave a truncated file behind". So the bytes are read,
 * not just stat'd, and a floor is enforced — an empty or near-empty container is not media.
 */
export async function readDeliveredMedia(path: string, label: string, minBytes = 1024): Promise<Buffer> {
  const stats = await stat(path);
  assert(stats.isFile(), `${label} output ${path} is not a file.`);
  assert(
    stats.size >= minBytes,
    `${label} output ${path} is ${stats.size} bytes, below the ${minBytes}-byte floor for real media.`
  );
  const bytes = await readFile(path);
  assert.equal(bytes.length, stats.size, `${label} output ${path} changed size while being read.`);
  return bytes;
}

/**
 * Ids for one smoke run.
 *
 * The counter is not decoration: a smoke that mints two jobs (the GIF gate renders on two frame
 * lanes) can call this twice inside the same millisecond, and two renders sharing one job id share
 * one lease file — whichever finishes first deletes the other's, and the second `job get` reads a
 * record that does not describe the render it is being asked about.
 */
let smokeJobSequence = 0;
export function smokeJobIdentity(smoke: string): { jobId: string; callerId: string } {
  smokeJobSequence += 1;
  return {
    // 1..128 chars of letters, digits, dot, underscore, colon or hyphen — the CLI's own rule.
    jobId: `shellx-motion-smoke:${smoke}:${process.pid}-${Date.now()}-${smokeJobSequence}`,
    callerId: `shellx-motion-smoke:${smoke}`
  };
}

export interface SmokeJobRecord {
  lifecycle: string;
  outcome: string;
  state: string;
  warnings: string[];
  durationMs?: number;
  receiptPath?: string;
}

/**
 * Read the job back the way a host would, and assert it ended succeeded.
 *
 * This is the half of the proof the receipt cannot give. `shellx-motion job get` answers from the
 * per-user job store rather than from the render's return value, so it is evidence that the run was
 * recorded as a success and not merely reported as one.
 */
export async function assertJobSucceeded(jobId: string, callerId: string, label: string): Promise<SmokeJobRecord> {
  const result = await runCli(["job", "get", jobId, "--caller-id", callerId]);
  assert(result.ok, `${label} job ${jobId} could not be read: ${JSON.stringify(result, null, 2)}`);
  const job = readRecord(result.job, `${label} job record`);
  const lifecycle = readString(job.lifecycle, `${label} job.lifecycle`);
  const outcome = readString(job.outcome, `${label} job.outcome`);
  const state = readString(job.state, `${label} job.state`);

  assert.equal(lifecycle, "ended", `${label} job ${jobId} did not end; lifecycle is ${JSON.stringify(lifecycle)}.`);
  assert.equal(outcome, "succeeded", `${label} job ${jobId} ended with outcome ${JSON.stringify(outcome)}.`);
  // `state` is a generated projection of the two authored axes, never authored itself. Deriving the
  // expectation rather than restating "succeeded" means a projection bug cannot pass unnoticed.
  assert.equal(
    state,
    projectJobState("ended", "succeeded"),
    `${label} job ${jobId} state ${JSON.stringify(state)} is not the contract's projection of ended+succeeded.`
  );
  assertContractJobState(state, `${label} job.state`);

  return {
    lifecycle,
    outcome,
    state,
    warnings: readStringArray(job.warnings),
    ...(typeof job.durationMs === "number" ? { durationMs: job.durationMs } : {}),
    ...(typeof job.receiptPath === "string" ? { receiptPath: job.receiptPath } : {})
  };
}

/**
 * Assert a word is one the job-status contract actually defines.
 *
 * The lifecycle smoke used to expect `"queued"` — a word that has never existed in the contract and
 * that no engine surface returns. Checking membership against the generated `JOB_STATES` means the
 * next such word fails on the spot instead of after a real render is blamed for it.
 */
export function assertContractJobState(state: string, label: string): void {
  assert(
    (JOB_STATES as readonly string[]).includes(state),
    `${label} is ${JSON.stringify(state)}, which is not a job state in schemas/job-status.json `
      + `(${JOB_STATES.join(", ")}).`
  );
}

function readReceiptFacts(receipt: unknown, label: string): SmokeReceiptFacts {
  const record = readRecord(receipt, `${label} receipt`);
  return {
    status: readString(record.status, `${label} receipt.status`),
    warnings: readStringArray(record.warnings)
  };
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  assert(
    typeof value === "object" && value !== null && !Array.isArray(value),
    `expected ${label} to be an object, got ${Array.isArray(value) ? "array" : typeof value}`
  );
  return value as Record<string, unknown>;
}

function readString(value: unknown, label: string): string {
  assert(typeof value === "string" && value.length > 0, `expected ${label} to be a non-empty string, got ${JSON.stringify(value)}`);
  return value;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}
