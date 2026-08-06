export function parseBoundedJsonObject(text: string, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label} must be valid JSON.`);
  }
  const record = readDotLottieRecord(value);
  if (!record) throw new Error(`${label} must be an object.`);
  validateSafeJsonTree(record, label);
  return record;
}

export function validateSafeJsonTree(root: Record<string, unknown>, label: string): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > 20_000) throw new Error(`${label} exceeds the 20000-node limit.`);
    if (current.depth > 32) throw new Error(`${label} exceeds the depth-32 limit.`);
    if (typeof current.value === "string" && Buffer.byteLength(current.value, "utf8") > 256 * 1024) {
      throw new Error(`${label} contains an oversized string.`);
    }
    if (Array.isArray(current.value)) {
      if (current.value.length > 1_000) throw new Error(`${label} contains an oversized array.`);
      for (const value of current.value) stack.push({ value, depth: current.depth + 1 });
      continue;
    }
    const record = readDotLottieRecord(current.value);
    if (!record) continue;
    const entries = Object.entries(record);
    if (entries.length > 1_000) throw new Error(`${label} contains an oversized object.`);
    for (const [key, value] of entries) {
      if (key === "__proto__" || key === "prototype" || key === "constructor") {
        throw new Error(`${label} contains forbidden key ${key}.`);
      }
      stack.push({ value, depth: current.depth + 1 });
    }
  }
}

export function decodeDotLottieUtf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error(`${label} must be valid UTF-8.`);
  }
}

export function readDotLottieRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}
