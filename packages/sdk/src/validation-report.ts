/** Runtime guard for the public two-stage Motion validation result. */
export function validMotionValidationReport(value: unknown, plainRecord: (value: unknown) => Record<string, unknown> | null): boolean {
  const report = plainRecord(value);
  if (!report || report.contract !== "shellx-motion/motion-validation@1" || report.renderability !== "not_proven") return false;
  const structural = report.structural;
  const semantic = report.semantic;
  return (structural === "failed" && semantic === "not_run")
    || (structural === "passed" && (semantic === "failed" || semantic === "passed"));
}
