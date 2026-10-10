import { parseMotionJobEvidence, type MotionJobEvidence } from "./job-evidence";
import { sameMotionJobRecordWarnings } from "./job-record-contract";

/**
 * Accept optional terminal evidence only when its compact warning mirror is parser-readable and
 * exactly matches the canonical record warning projection.
 */
export function canonicalMotionJobTerminalEvidence(
  value: MotionJobEvidence | undefined,
  warnings: readonly string[]
): MotionJobEvidence | undefined {
  if (!value) return undefined;
  try {
    const evidence = parseMotionJobEvidence(value);
    return sameMotionJobRecordWarnings(evidence.warnings, warnings) ? evidence : undefined;
  } catch {
    return undefined;
  }
}
