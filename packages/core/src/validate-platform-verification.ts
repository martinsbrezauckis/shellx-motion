type ValidationError = { path: string; message: string };

/** Completeness fields shared by private receipt discovery and release aggregation. */
export function validatePlatformVerificationEvidenceFields(
  receipt: Record<string, unknown>,
  errors: ValidationError[],
): void {
  validateToolchain(receipt.toolchain, errors);
  validateCommandSummary(receipt.commandSummary, errors);
}

function validateToolchain(value: unknown, errors: ValidationError[]): void {
  const path = "/toolchain";
  const record = readRecord(value);
  if (!record) {
    if (value !== undefined) errors.push({ path, message: "must be an object" });
    return;
  }
  requireFields(record, path, ["status", "exact", "bundledCodecs"], errors);
  if ("status" in record && !nonEmptyString(record.status)) {
    errors.push({ path: `${path}/status`, message: "must be a non-empty string" });
  }
  for (const field of ["exact", "bundledCodecs"]) {
    if (field in record && typeof record[field] !== "boolean") {
      errors.push({ path: `${path}/${field}`, message: "must be a boolean" });
    }
  }
}

function validateCommandSummary(value: unknown, errors: ValidationError[]): void {
  const path = "/commandSummary";
  const record = readRecord(value);
  if (!record) {
    if (value !== undefined) errors.push({ path, message: "must be an object" });
    return;
  }
  requireFields(record, path, ["total", "passed", "failed", "skipped", "skippedByKind"], errors);
  for (const field of ["total", "passed", "failed", "skipped"]) {
    if (field in record && !nonNegativeInteger(record[field])) {
      errors.push({ path: `${path}/${field}`, message: "must be a non-negative integer" });
    }
  }
  if (!("skippedByKind" in record)) return;
  const counts = readRecord(record.skippedByKind);
  if (!counts) {
    errors.push({ path: `${path}/skippedByKind`, message: "must be an object" });
    return;
  }
  for (const [kind, count] of Object.entries(counts)) {
    if (!nonNegativeInteger(count)) errors.push({ path: `${path}/skippedByKind/${kind}`, message: "must be a non-negative integer" });
  }
}

function requireFields(record: Record<string, unknown>, path: string, fields: string[], errors: ValidationError[]): void {
  for (const field of fields) if (!(field in record)) errors.push({ path: `${path}/${field}`, message: "required" });
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function nonNegativeInteger(value: unknown): boolean {
  return Number.isInteger(value) && (value as number) >= 0;
}
