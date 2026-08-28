/** Project support evidence into a portable form without filesystem locators. */

/**
 * Support bundles cross a handoff boundary. Keep their useful receipt facts while deliberately
 * omitting filesystem locator fields and rewriting path-bearing diagnostics from host-owned input.
 * The authenticated immediate response retains its local paths separately after publication.
 */
export function shareableSupportReceiptSummary(value: Record<string, unknown>): Record<string, unknown> {
  return projectShareableFields(value, ["id", "operation", "status", "packageId", "lane", "createdAt", "warnings"]);
}

export function shareablePlatformReceiptSummary(value: Record<string, unknown>): Record<string, unknown> {
  return projectShareableFields(value, ["schema", "status", "dryRun", "commandCount", "failedCommandCount", "requiredFailedCommandCount", "receiptCount"]);
}

export function projectShareableValue(value: unknown): unknown {
  if (typeof value === "string") return redactHostPaths(value);
  if (Array.isArray(value)) return value.map(projectShareableValue);
  if (typeof value !== "object" || value === null) return value;
  const projected: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (pathBearingKey(key) || redactHostPaths(key) !== key) continue;
    projected[key] = projectShareableValue(nested);
  }
  return projected;
}

function projectShareableFields(value: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const field of fields) {
    if (Object.hasOwn(value, field)) projected[field] = projectShareableValue(value[field]);
  }
  return projected;
}

function pathBearingKey(key: string): boolean {
  return key === "path" || key === "paths" || /(?:path|root|directory|dir)$/iu.test(key);
}

function redactHostPaths(value: string): string {
  // Redact an absolute marker through the end of its diagnostic line so whitespace cannot expose
  // a suffix from a host path containing spaces, quotes, or diagnostic punctuation.
  return value
    .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\r\n]*/gu, "<redacted-host-path>")
    .replace(/(^|[^A-Za-z0-9._~\\/-])~(?:[A-Za-z0-9._-]+)?[\\/][^\r\n]*/gu, "$1<redacted-host-path>")
    .replace(/(^|[^A-Za-z0-9._~\\/-])\\[^\r\n]*/gu, "$1<redacted-host-path>")
    .replace(/(^|[^A-Za-z0-9._~\/-])\/[^\r\n]*/gu, "$1<redacted-host-path>");
}
