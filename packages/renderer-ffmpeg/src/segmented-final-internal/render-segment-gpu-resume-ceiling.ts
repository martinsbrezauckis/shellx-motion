const MIN_GPU_RSS_BYTES = 64 * 1024 * 1024;

/**
 * A durable GPU prefix binds the containment ceiling used by every range.
 * An untrusted resume manifest may only lower the freshly admitted governor
 * ceiling; it can never grant itself more memory than the current process.
 */
export function gpuResumeContainmentCeiling(manifest: unknown, currentCeiling: number): number {
  const stored = nestedNumber(manifest, ["producer", "identity", "hostVerdict", "containment", "maxProcessTreeRssBytes"]);
  if (!Number.isSafeInteger(stored) || stored < MIN_GPU_RSS_BYTES || stored > currentCeiling) {
    throw new Error("Segmented GPU resume containment ceiling is invalid or exceeds the current host governor allowance.");
  }
  return stored;
}

function nestedNumber(value: unknown, path: readonly string[]): number {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return Number.NaN;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "number" ? current : Number.NaN;
}
