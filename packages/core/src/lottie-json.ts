/** Shared bounded parser for full Lottie documents (not small container metadata). */
export function parseBoundedLottieJson(sourceText: string): Record<string, unknown> {
  if (Buffer.byteLength(sourceText, "utf8") > 16 * 1024 * 1024) {
    throw new Error("Invalid Lottie source: JSON exceeds the 16 MiB diagnostic limit.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(sourceText);
  } catch {
    throw new Error("Invalid Lottie source: expected valid JSON.");
  }
  const stack: Array<{ value: unknown; depth: number }> = [{ value: parsed, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > 100_000) throw new Error("Invalid Lottie source: JSON exceeds the 100000-node limit.");
    if (current.depth > 64) throw new Error("Invalid Lottie source: JSON exceeds the depth-64 limit.");
    if (typeof current.value === "string" && Buffer.byteLength(current.value, "utf8") > 1024 * 1024) {
      throw new Error("Invalid Lottie source: string exceeds the 1 MiB limit.");
    }
    if (Array.isArray(current.value)) {
      if (current.value.length > 20_000) throw new Error("Invalid Lottie source: array exceeds the 20000-item limit.");
      for (const value of current.value) stack.push({ value, depth: current.depth + 1 });
      continue;
    }
    if (typeof current.value !== "object" || current.value === null) continue;
    const entries = Object.entries(current.value);
    if (entries.length > 1_000) throw new Error("Invalid Lottie source: object exceeds the 1000-field limit.");
    for (const [key, value] of entries) {
      if (key === "__proto__" || key === "prototype" || key === "constructor") {
        throw new Error(`Invalid Lottie source: forbidden object key ${key}.`);
      }
      stack.push({ value, depth: current.depth + 1 });
    }
  }
  const document = readLottieRecord(parsed);
  for (const [key, value] of [["w", document.w], ["h", document.h], ["fr", document.fr], ["ip", document.ip], ["op", document.op]] as const) {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Invalid Lottie source: ${key} must be a finite number.`);
  }
  if (!Array.isArray(document.layers)) throw new Error("Invalid Lottie source: layers must be an array.");
  return document;
}

export function readLottieRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}
