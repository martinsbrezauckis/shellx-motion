/**
 * Package JSON is attacker-controlled at every package ingress.  Count its
 * shape before JSON.parse allocates the parsed graph; byte caps alone do not
 * bound a punctuation-heavy document's heap use.
 *
 * This intentionally mirrors the bounded Lottie admission pattern while
 * keeping package limits and diagnostics local to the package trust boundary.
 */
export const PACKAGE_JSON_MAX_DEPTH = 64;
export const PACKAGE_JSON_MAX_STRUCTURAL_TOKENS = 2_000_000;
export const PACKAGE_JSON_MAX_VALUES = 1_000_000;
export const PACKAGE_JSON_MAX_STRING_BYTES = 1024 * 1024;
export const PACKAGE_JSON_MAX_KEY_BYTES = 1024;
export const PACKAGE_JSON_MAX_ARRAY_ITEMS = 131_072;
export const PACKAGE_JSON_MAX_OBJECT_FIELDS = 4_096;
export const PACKAGE_JSON_MAX_SCALAR_BYTES = 64 * 1024;

const FORBIDDEN_OBJECT_KEYS = new Set(["__proto__", "prototype", "constructor"]);

type JsonContainerFrame =
  | { kind: "array"; items: number; state: "valueOrEnd" | "commaOrEnd" }
  | { kind: "object"; fields: number; state: "keyOrEnd" | "colon" | "value" | "commaOrEnd" };

/**
 * Decode, structurally admit, then parse one package JSON file.  All package
 * paths call this exact gate so a host cannot accidentally retain an old,
 * byte-only admission route.
 */
export function parseBoundedPackageJsonBytes(bytes: Buffer, maxBytes: number, label: string): unknown {
  if (!Buffer.isBuffer(bytes) || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error(`${label} has an invalid JSON admission limit.`);
  }
  if (bytes.byteLength > maxBytes) {
    throw new Error(`${label} exceeds the ${maxBytes}-byte JSON limit.`);
  }

  let sourceText: string;
  try {
    sourceText = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} must be valid UTF-8 JSON.`);
  }

  assertBoundedPackageJsonText(sourceText, label);
  try {
    return JSON.parse(sourceText);
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

function assertBoundedPackageJsonText(sourceText: string, label: string): void {
  const stack: JsonContainerFrame[] = [];
  let index = 0;
  let structuralTokens = 0;
  let values = 0;

  const structural = (): void => {
    structuralTokens += 1;
    if (structuralTokens > PACKAGE_JSON_MAX_STRUCTURAL_TOKENS) {
      throw new Error(`${label} JSON exceeds the ${PACKAGE_JSON_MAX_STRUCTURAL_TOKENS}-token pre-parse structural limit.`);
    }
  };
  const value = (): void => {
    const parent = stack.at(-1);
    if (parent?.kind === "array" && parent.state === "valueOrEnd") {
      parent.items += 1;
      if (parent.items > PACKAGE_JSON_MAX_ARRAY_ITEMS) {
        throw new Error(`${label} JSON array exceeds the ${PACKAGE_JSON_MAX_ARRAY_ITEMS}-item pre-parse limit.`);
      }
      parent.state = "commaOrEnd";
    } else if (parent?.kind === "object" && parent.state === "value") {
      parent.state = "commaOrEnd";
    }
    values += 1;
    if (values > PACKAGE_JSON_MAX_VALUES) {
      throw new Error(`${label} JSON exceeds the ${PACKAGE_JSON_MAX_VALUES}-value pre-parse limit.`);
    }
  };
  const key = (name: string): void => {
    const parent = stack.at(-1);
    if (parent?.kind !== "object" || parent.state !== "keyOrEnd") return;
    parent.fields += 1;
    if (parent.fields > PACKAGE_JSON_MAX_OBJECT_FIELDS) {
      throw new Error(`${label} JSON object exceeds the ${PACKAGE_JSON_MAX_OBJECT_FIELDS}-field pre-parse limit.`);
    }
    if (FORBIDDEN_OBJECT_KEYS.has(name)) {
      throw new Error(`${label} JSON contains forbidden object key ${JSON.stringify(name)}.`);
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
      if (parent?.kind === "object" && parent.state === "keyOrEnd") {
        const scanned = scanBoundedJsonString(sourceText, index, PACKAGE_JSON_MAX_KEY_BYTES, label, "key", true);
        key(scanned.decoded ?? "");
        index = scanned.end;
      } else {
        index = scanBoundedJsonString(sourceText, index, PACKAGE_JSON_MAX_STRING_BYTES, label, "string", false).end;
        value();
      }
      continue;
    }
    if (code === 0x7b || code === 0x5b) {
      structural();
      value();
      if (stack.length + 1 > PACKAGE_JSON_MAX_DEPTH) {
        throw new Error(`${label} JSON exceeds the ${PACKAGE_JSON_MAX_DEPTH}-level pre-parse nesting limit.`);
      }
      stack.push(code === 0x7b
        ? { kind: "object", fields: 0, state: "keyOrEnd" }
        : { kind: "array", items: 0, state: "valueOrEnd" });
      index += 1;
      continue;
    }
    if (code === 0x7d || code === 0x5d) {
      structural();
      const parent = stack.at(-1);
      if ((code === 0x7d && parent?.kind === "object") || (code === 0x5d && parent?.kind === "array")) {
        stack.pop();
      }
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

    const end = scanBoundedJsonScalar(sourceText, index, label);
    value();
    index = end;
  }

  // JSON.parse owns grammar validation after this bounded lexical admission.
}

function scanBoundedJsonString(
  sourceText: string,
  start: number,
  maxBytes: number,
  label: string,
  kind: "key" | "string",
  collectDecoded: boolean
): { end: number; decoded?: string } {
  let index = start + 1;
  let bytes = 0;
  let decoded = "";
  while (index < sourceText.length) {
    const code = sourceText.charCodeAt(index);
    if (code === 0x22) return { end: index + 1, ...(collectDecoded ? { decoded } : {}) };
    if (code === 0x5c) {
      const escape = sourceText.charCodeAt(index + 1);
      if (escape === 0x75) {
        bytes += 6;
        if (collectDecoded) decoded += decodeUnicodeEscape(sourceText, index + 2);
        index += 6;
      } else {
        bytes += 2;
        if (collectDecoded) decoded += decodeSimpleEscape(escape);
        index += 2;
      }
    } else {
      const width = utf8CodePointWidth(sourceText, index);
      bytes += width.bytes;
      if (collectDecoded) decoded += sourceText.slice(index, index + width.codeUnits);
      index += width.codeUnits;
    }
    if (bytes > maxBytes) {
      throw new Error(`${label} JSON ${kind} exceeds the ${maxBytes}-byte pre-parse limit.`);
    }
  }
  return { end: index, ...(collectDecoded ? { decoded } : {}) };
}

function scanBoundedJsonScalar(sourceText: string, start: number, label: string): number {
  let index = start;
  let bytes = 0;
  while (index < sourceText.length && !isJsonDelimiter(sourceText.charCodeAt(index))) {
    const width = utf8CodePointWidth(sourceText, index);
    bytes += width.bytes;
    if (bytes > PACKAGE_JSON_MAX_SCALAR_BYTES) {
      throw new Error(`${label} JSON scalar exceeds the ${PACKAGE_JSON_MAX_SCALAR_BYTES}-byte pre-parse limit.`);
    }
    index += width.codeUnits;
  }
  return index;
}

function decodeUnicodeEscape(value: string, index: number): string {
  const hex = value.slice(index, index + 4);
  return /^[0-9a-fA-F]{4}$/.test(hex) ? String.fromCharCode(Number.parseInt(hex, 16)) : "";
}

function decodeSimpleEscape(code: number): string {
  switch (code) {
    case 0x22: return '"';
    case 0x5c: return "\\";
    case 0x2f: return "/";
    case 0x62: return "\b";
    case 0x66: return "\f";
    case 0x6e: return "\n";
    case 0x72: return "\r";
    case 0x74: return "\t";
    default: return "";
  }
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
