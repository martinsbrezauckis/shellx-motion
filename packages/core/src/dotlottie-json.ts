export function parseBoundedJsonObject(text: string, label: string): Record<string, unknown> {
  assertBoundedDotLottieJsonText(text, label);
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

const DOTLOTTIE_JSON_MAX_NODES = 20_000;
const DOTLOTTIE_JSON_MAX_DEPTH = 32;
const DOTLOTTIE_JSON_MAX_STRING_BYTES = 256 * 1024;
const DOTLOTTIE_JSON_MAX_ARRAY_ITEMS = 1_000;
const DOTLOTTIE_JSON_MAX_OBJECT_FIELDS = 1_000;
const FORBIDDEN_DOTLOTTIE_OBJECT_KEYS = new Set(["__proto__", "prototype", "constructor"]);

type DotLottieJsonContainerFrame =
  | { kind: "array"; items: number; state: "valueOrEnd" | "commaOrEnd" }
  | { kind: "object"; fields: number; state: "keyOrEnd" | "colon" | "value" | "commaOrEnd" };

/**
 * Count the parsed-tree shape before JSON.parse expands untrusted dotLottie
 * manifest, theme, and state-machine metadata. Grammar validation remains
 * owned by JSON.parse after this bounded lexical admission.
 */
function assertBoundedDotLottieJsonText(sourceText: string, label: string): void {
  const stack: DotLottieJsonContainerFrame[] = [];
  let index = 0;
  let nodes = 0;

  const value = (): void => {
    if (stack.length > DOTLOTTIE_JSON_MAX_DEPTH) {
      throw new Error(`${label} exceeds the depth-${DOTLOTTIE_JSON_MAX_DEPTH} limit.`);
    }
    const parent = stack.at(-1);
    if (parent?.kind === "array" && parent.state === "valueOrEnd") {
      parent.items += 1;
      if (parent.items > DOTLOTTIE_JSON_MAX_ARRAY_ITEMS) {
        throw new Error(`${label} contains an oversized array.`);
      }
      parent.state = "commaOrEnd";
    } else if (parent?.kind === "object" && parent.state === "value") {
      parent.state = "commaOrEnd";
    }
    nodes += 1;
    if (nodes > DOTLOTTIE_JSON_MAX_NODES) {
      throw new Error(`${label} exceeds the ${DOTLOTTIE_JSON_MAX_NODES}-node limit.`);
    }
  };

  const key = (name: string): void => {
    const parent = stack.at(-1);
    if (parent?.kind !== "object" || parent.state !== "keyOrEnd") return;
    parent.fields += 1;
    if (parent.fields > DOTLOTTIE_JSON_MAX_OBJECT_FIELDS) {
      throw new Error(`${label} contains an oversized object.`);
    }
    if (FORBIDDEN_DOTLOTTIE_OBJECT_KEYS.has(name)) {
      throw new Error(`${label} contains forbidden key ${name}.`);
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
      const parent = stack.at(-1);
      const scanned = scanDotLottieJsonString(sourceText, index, label, parent?.kind === "object" && parent.state === "keyOrEnd");
      index = scanned.end;
      if (scanned.key !== undefined) key(scanned.key);
      else value();
      continue;
    }
    if (code === 0x7b || code === 0x5b) {
      value();
      stack.push(code === 0x7b
        ? { kind: "object", fields: 0, state: "keyOrEnd" }
        : { kind: "array", items: 0, state: "valueOrEnd" });
      index += 1;
      continue;
    }
    if (code === 0x7d || code === 0x5d) {
      const parent = stack.at(-1);
      if ((code === 0x7d && parent?.kind === "object") || (code === 0x5d && parent?.kind === "array")) {
        stack.pop();
      }
      index += 1;
      continue;
    }
    if (code === 0x3a) {
      const parent = stack.at(-1);
      if (parent?.kind === "object" && parent.state === "colon") parent.state = "value";
      index += 1;
      continue;
    }
    if (code === 0x2c) {
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

function scanDotLottieJsonString(
  sourceText: string,
  start: number,
  label: string,
  collectKey: boolean
): { end: number; key?: string } {
  let index = start + 1;
  let bytes = 0;
  let key = "";
  let pendingHighSurrogate: number | undefined;

  const appendCodeUnit = (code: number): void => {
    if (pendingHighSurrogate !== undefined) {
      if (code >= 0xdc00 && code <= 0xdfff) {
        bytes += 4;
        pendingHighSurrogate = undefined;
        if (collectKey) key += String.fromCharCode(code);
        return;
      }
      bytes += 3;
      pendingHighSurrogate = undefined;
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      pendingHighSurrogate = code;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 3;
    } else if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else {
      bytes += 3;
    }
    if (collectKey) key += String.fromCharCode(code);
  };

  const assertStringLimit = (): void => {
    if (bytes > DOTLOTTIE_JSON_MAX_STRING_BYTES) {
      throw new Error(`${label} contains an oversized string.`);
    }
  };

  while (index < sourceText.length) {
    const code = sourceText.charCodeAt(index);
    if (code === 0x22) {
      if (pendingHighSurrogate !== undefined) bytes += 3;
      assertStringLimit();
      return { end: index + 1, ...(collectKey ? { key } : {}) };
    }
    if (code === 0x5c) {
      const escape = sourceText.charCodeAt(index + 1);
      if (escape === 0x75) {
        const hex = sourceText.slice(index + 2, index + 6);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) appendCodeUnit(Number.parseInt(hex, 16));
        index += 6;
      } else {
        const decoded = decodeDotLottieJsonSimpleEscape(escape);
        if (decoded !== undefined) appendCodeUnit(decoded);
        index += 2;
      }
    } else {
      appendCodeUnit(code);
      index += 1;
    }
    assertStringLimit();
  }
  if (pendingHighSurrogate !== undefined) bytes += 3;
  assertStringLimit();
  return { end: index, ...(collectKey ? { key } : {}) };
}

function decodeDotLottieJsonSimpleEscape(code: number): number | undefined {
  switch (code) {
    case 0x22: return 0x22;
    case 0x5c: return 0x5c;
    case 0x2f: return 0x2f;
    case 0x62: return 0x08;
    case 0x66: return 0x0c;
    case 0x6e: return 0x0a;
    case 0x72: return 0x0d;
    case 0x74: return 0x09;
    default: return undefined;
  }
}

function isJsonWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

function isJsonDelimiter(code: number): boolean {
  return isJsonWhitespace(code) || code === 0x2c || code === 0x5d || code === 0x7d;
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
