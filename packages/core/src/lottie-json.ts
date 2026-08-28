/** Shared bounded parser for full Lottie documents (not small container metadata). */
export function parseBoundedLottieJson(sourceText: string): Record<string, unknown> {
  assertBoundedLottieJsonText(sourceText);
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

const MAX_LOTTIE_JSON_BYTES = 16 * 1024 * 1024;
// This is deliberately above the punctuation required by the retained 100,000-node parsed-tree
// contract, so lexical admission does not narrow previously valid Lottie documents.
const MAX_LOTTIE_JSON_STRUCTURAL_TOKENS = 300_000;
const MAX_LOTTIE_JSON_DEPTH = 64;
const MAX_LOTTIE_JSON_STRING_BYTES = 1024 * 1024;
const MAX_LOTTIE_JSON_NODES = 100_000;
const MAX_LOTTIE_JSON_ARRAY_ITEMS = 20_000;
const MAX_LOTTIE_JSON_OBJECT_FIELDS = 1_000;

type JsonContainerFrame =
  | { kind: "array"; items: number; state: "valueOrEnd" | "commaOrEnd" }
  | { kind: "object"; items: number; state: "keyOrEnd" | "colon" | "value" | "commaOrEnd" };

/**
 * Refuse high-cardinality JSON lexically before JSON.parse builds its expanded
 * object graph. This intentionally remains core-local: Lottie import is not
 * coupled to the OTIO adapter's admission implementation.
 */
function assertBoundedLottieJsonText(sourceText: string): void {
  if (Buffer.byteLength(sourceText, "utf8") > MAX_LOTTIE_JSON_BYTES) {
    throw new Error("Invalid Lottie source: JSON exceeds the 16 MiB diagnostic limit.");
  }

  const stack: JsonContainerFrame[] = [];
  let index = 0;
  let structuralTokens = 0;
  let nodes = 0;

  const structural = (): void => {
    structuralTokens += 1;
    if (structuralTokens > MAX_LOTTIE_JSON_STRUCTURAL_TOKENS) {
      throw new Error(`Invalid Lottie source: JSON exceeds the ${MAX_LOTTIE_JSON_STRUCTURAL_TOKENS}-token pre-parse structural limit.`);
    }
  };
  const value = (): void => {
    const parent = stack.at(-1);
    if (parent?.kind === "array" && parent.state === "valueOrEnd") {
      parent.items += 1;
      if (parent.items > MAX_LOTTIE_JSON_ARRAY_ITEMS) {
        throw new Error(`Invalid Lottie source: array exceeds the ${MAX_LOTTIE_JSON_ARRAY_ITEMS}-item pre-parse limit.`);
      }
      parent.state = "commaOrEnd";
    } else if (parent?.kind === "object" && parent.state === "value") {
      parent.state = "commaOrEnd";
    }
    nodes += 1;
    if (nodes > MAX_LOTTIE_JSON_NODES) {
      throw new Error(`Invalid Lottie source: JSON exceeds the ${MAX_LOTTIE_JSON_NODES}-node pre-parse structural limit.`);
    }
  };
  const key = (): void => {
    const parent = stack.at(-1);
    if (parent?.kind !== "object" || parent.state !== "keyOrEnd") return;
    parent.items += 1;
    if (parent.items > MAX_LOTTIE_JSON_OBJECT_FIELDS) {
      throw new Error(`Invalid Lottie source: object exceeds the ${MAX_LOTTIE_JSON_OBJECT_FIELDS}-field pre-parse limit.`);
    }
    parent.state = "colon";
  };

  while (index < sourceText.length) {
    const code = sourceText.charCodeAt(index);
    if (isJsonWhitespace(code)) {
      index += 1;
      continue;
    }
    if (code === 0x22) {
      index = scanBoundedJsonString(sourceText, index);
      const parent = stack.at(-1);
      if (parent?.kind === "object" && parent.state === "keyOrEnd") key();
      else value();
      continue;
    }
    if (code === 0x7b || code === 0x5b) {
      structural();
      value();
      // A root container has depth zero, matching the post-parse walk below.
      if (stack.length > MAX_LOTTIE_JSON_DEPTH) {
        throw new Error(`Invalid Lottie source: JSON exceeds the depth-${MAX_LOTTIE_JSON_DEPTH} pre-parse limit.`);
      }
      stack.push(code === 0x7b
        ? { kind: "object", items: 0, state: "keyOrEnd" }
        : { kind: "array", items: 0, state: "valueOrEnd" });
      index += 1;
      continue;
    }
    if (code === 0x7d || code === 0x5d) {
      structural();
      const parent = stack.at(-1);
      if ((code === 0x7d && parent?.kind === "object") || (code === 0x5d && parent?.kind === "array")) stack.pop();
      index += 1;
      continue;
    }
    if (code === 0x3a) {
      structural();
      const parent = stack.at(-1);
      if (parent?.kind === "object" && parent.state === "colon") parent.state = "value";
      index += 1;
      continue;
    }
    if (code === 0x2c) {
      structural();
      const parent = stack.at(-1);
      if (parent?.kind === "array") parent.state = "valueOrEnd";
      else if (parent?.kind === "object") parent.state = "keyOrEnd";
      index += 1;
      continue;
    }

    value();
    index += 1;
    while (index < sourceText.length && !isJsonDelimiter(sourceText.charCodeAt(index))) index += 1;
  }
}

/** Count encoded JSON string bytes in one pass; encoded bytes bound decoded UTF-8 bytes. */
function scanBoundedJsonString(sourceText: string, start: number): number {
  let index = start + 1;
  let bytes = 0;
  while (index < sourceText.length) {
    const code = sourceText.charCodeAt(index);
    if (code === 0x22) return index + 1;
    if (code === 0x5c) {
      const escaped = sourceText.charCodeAt(index + 1);
      bytes += escaped === 0x75 ? 6 : 2;
      index += escaped === 0x75 ? 6 : 2;
    } else {
      const width = utf8CodePointWidth(sourceText, index);
      bytes += width.bytes;
      index += width.codeUnits;
    }
    if (bytes > MAX_LOTTIE_JSON_STRING_BYTES) {
      throw new Error("Invalid Lottie source: string exceeds the 1 MiB pre-parse limit.");
    }
  }
  return index;
}

function utf8CodePointWidth(value: string, index: number): { bytes: number; codeUnits: number } {
  const code = value.charCodeAt(index);
  if (code < 0x80) return { bytes: 1, codeUnits: 1 };
  if (code < 0x800) return { bytes: 2, codeUnits: 1 };
  if (code >= 0xd800 && code <= 0xdbff) {
    const next = value.charCodeAt(index + 1);
    if (next >= 0xdc00 && next <= 0xdfff) return { bytes: 4, codeUnits: 2 };
  }
  return { bytes: 3, codeUnits: 1 };
}

function isJsonWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

function isJsonDelimiter(code: number): boolean {
  return isJsonWhitespace(code) || code === 0x2c || code === 0x5d || code === 0x7d;
}

export function readLottieRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}
