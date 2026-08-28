export interface LottieShapeSiblingSummary {
  localTransform: Record<string, unknown> | undefined;
  geometry: Record<string, unknown>[];
  gradientFillCount: number;
  solidFillCount: number;
}

/** Compute the facts shared by every shape-item diagnostic in one sibling pass. */
export function summarizeLottieShapeSiblings(records: Record<string, unknown>[]): LottieShapeSiblingSummary {
  let localTransform: Record<string, unknown> | undefined;
  const geometry: Record<string, unknown>[] = [];
  let gradientFillCount = 0;
  let solidFillCount = 0;
  for (const candidate of records) {
    const type = typeof candidate.ty === "string" ? candidate.ty : undefined;
    if (type === "tr" && !localTransform) localTransform = candidate;
    if (type === "sh" || type === "rc" || type === "el") geometry.push(candidate);
    if (type === "gf") gradientFillCount += 1;
    if (type === "fl") solidFillCount += 1;
  }
  return { localTransform, geometry, gradientFillCount, solidFillCount };
}
