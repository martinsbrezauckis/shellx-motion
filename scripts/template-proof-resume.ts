/**
 * Parse the one narrowly permitted recovery input for the moving-proof gate.
 * This is intentionally not a generic "resume any old evidence" facility:
 * it accepts only the known failed evidence shape from a fresh 12-family run.
 */
import assert from "node:assert/strict";

export const RETAINED_MOVING_PROOF_SCHEMA = "shellx-motion/template-moving-proof@1";

export function assertResumableTemplateProofEvidence(input: {
  evidence: unknown;
  selectedTemplateDirs: readonly string[];
  policySha256: string;
}): void {
  assert(isRecord(input.evidence), "Retained proof evidence must be a JSON object.");
  const evidence = input.evidence;
  assert(evidence.schema === RETAINED_MOVING_PROOF_SCHEMA, "Retained proof evidence has an unexpected schema.");
  assert(evidence.command === "template-pack:proof" && evidence.ok === false,
    "Retained proof evidence must be a failed template-pack proof, never a successful or unrelated run.");
  const profile = record(evidence.proofProfile, "Retained proof evidence is missing proofProfile.");
  assert(profile.fps === 8 && profile.preserveStoryDurations === true,
    "Retained proof evidence is not the certified 8 fps full-story profile.");
  assertArrayExactly(profile.selectedTemplateDirs, input.selectedTemplateDirs,
    "Retained proof evidence does not cover the exact current promoted catalog.");
  const policy = record(evidence.policy, "Retained proof evidence is missing policy identity.");
  assert(policy.sha256 === input.policySha256,
    "Retained proof evidence policy hash is stale or does not match the checked current policy.");
  const retention = record(evidence.retention, "Retained proof evidence is missing retention state.");
  assert(retention.state === "retained" && retention.reason === "failure_diagnostics",
    "Retained proof evidence was not preserved as failed diagnostics.");
  const failures = evidence.failures;
  assert(Array.isArray(failures), "Retained proof evidence failures are malformed.");
  if (isInitialFrameRootFailure(evidence, failures)) return;
  assertOverwrittenPreReadbackRecovery(evidence, failures, input.selectedTemplateDirs);
}

function isInitialFrameRootFailure(evidence: Record<string, unknown>, failures: unknown[]): boolean {
  if (failures.length !== 1 || evidence.failureCount !== 1) return false;
  const failure = record(failures[0], "Retained proof failure is malformed.");
  return failure.packageDirName === "product-metric-card" && failure.code === "proof_failed"
    && typeof failure.message === "string" && failure.message.includes("scandir");
}

/**
 * One recovery invocation predating the red-evidence sidecar wrote its
 * argument-validation result over evidence.json. The result is safe to resume
 * only when it is this exact pre-readback shape: all selected families failed
 * uniformly before a media readback could have started. Anything mixed, stale,
 * successful, partial, or differently failed remains a hard refusal.
 */
function assertOverwrittenPreReadbackRecovery(
  evidence: Record<string, unknown>,
  failures: unknown[],
  selectedTemplateDirs: readonly string[]
): void {
  const recovery = record(evidence.recovery, "Retained inspection accepts only the known pre-readback recovery evidence.");
  assert(recovery.mode === "retained_diagnostics_inspection"
    && typeof recovery.priorEvidenceSha256 === "string" && /^[a-f0-9]{64}$/.test(recovery.priorEvidenceSha256),
  "Retained inspection accepts only the known pre-readback recovery evidence.");
  assert(evidence.failureCount === selectedTemplateDirs.length && failures.length === selectedTemplateDirs.length
    && evidence.templateCount === 0 && evidence.renderedMp4Count === 0
    && Array.isArray(evidence.templates) && evidence.templates.length === 0,
  "Retained inspection refuses partial or mixed pre-readback recovery evidence.");
  for (const [index, value] of failures.entries()) {
    const failure = record(value, "Retained pre-readback failure is malformed.");
    assert(failure.packageDirName === selectedTemplateDirs[index] && failure.code === "quality_check_failed"
      && typeof failure.message === "string"
      && failure.message.includes("--min-psnr-db and --min-ssim require --baseline or --preview-package"),
    "Retained inspection refuses mixed or non-pre-readback recovery failures.");
  }
}

function record(value: unknown, message: string): Record<string, unknown> {
  assert(isRecord(value), message);
  return value;
}

function assertArrayExactly(value: unknown, expected: readonly string[], message: string): void {
  assert(Array.isArray(value) && value.length === expected.length && value.every((entry, index) => entry === expected[index]), message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
