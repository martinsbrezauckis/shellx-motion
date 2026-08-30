/**
 * Shared bounded projection for text supplied by another process or provider.
 *
 * The raw UTF-8 prefix is always capped before secret, control, bidi, or path
 * processing. That order is intentional: redacting a multi-megabyte diagnostic
 * is still attacker-controlled work even when the returned field is small.
 */

/** No diagnostic caller may raise a raw scan above this hard ceiling. */
/**
 * Largest raw diagnostic any Motion boundary is allowed to inspect. Individual
 * endpoints use substantially smaller limits, but this ceiling prevents an
 * option or a future caller from quietly restoring unbounded work.
 */
export const MAX_UNTRUSTED_DIAGNOSTIC_RAW_BYTES = 1024 * 1024;
/** No diagnostic caller may raise a returned field above this hard ceiling. */
export const MAX_UNTRUSTED_DIAGNOSTIC_PUBLIC_BYTES = 64 * 1024;

export interface BoundedUtf8Text {
  value: string;
  truncated: boolean;
}

export interface UntrustedDiagnosticOptions {
  rawMaxBytes: number;
  publicMaxBytes: number;
  /** Normalize surviving whitespace for one-line report fields. */
  collapseWhitespace?: boolean;
  /** The supplied value was already clipped by a caller before this projection. */
  sourceTruncated?: boolean;
}

/**
 * Take a valid UTF-8 prefix without allocating an encoded copy of untrusted
 * text. Unpaired surrogates count as their UTF-8 replacement character.
 */
export function takeUtf8Prefix(value: string, maxBytes: number): BoundedUtf8Text {
  const cap = boundedByteCap(maxBytes, MAX_UNTRUSTED_DIAGNOSTIC_RAW_BYTES);
  let index = 0;
  let bytes = 0;
  while (index < value.length) {
    const width = utf8WidthAt(value, index);
    if (bytes + width.bytes > cap) return { value: value.slice(0, index), truncated: true };
    bytes += width.bytes;
    index += width.codeUnits;
  }
  return { value, truncated: false };
}

/** Take a valid UTF-8 suffix for bounded process-output retention. */
export function takeUtf8Suffix(value: string, maxBytes: number): BoundedUtf8Text {
  const cap = boundedByteCap(maxBytes, MAX_UNTRUSTED_DIAGNOSTIC_RAW_BYTES);
  let index = value.length;
  let bytes = 0;
  while (index > 0) {
    const width = utf8WidthBefore(value, index);
    if (bytes + width.bytes > cap) return { value: value.slice(index), truncated: true };
    bytes += width.bytes;
    index -= width.codeUnits;
  }
  return { value, truncated: false };
}

/** True when a string exceeds a strict UTF-8 cap, without scanning past it. */
export function exceedsUtf8Bytes(value: string, maxBytes: number): boolean {
  return takeUtf8Prefix(value, maxBytes).truncated;
}

/**
 * Produce a bounded display-safe diagnostic. The output contains no secrets,
 * terminal controls/bidi controls, or absolute POSIX/Windows paths.
 */
export function sanitizeUntrustedDiagnostic(value: string, options: UntrustedDiagnosticOptions): string {
  const rawMaxBytes = boundedByteCap(options.rawMaxBytes, MAX_UNTRUSTED_DIAGNOSTIC_RAW_BYTES);
  const publicMaxBytes = boundedByteCap(options.publicMaxBytes, MAX_UNTRUSTED_DIAGNOSTIC_PUBLIC_BYTES);
  const raw = takeUtf8Prefix(value, rawMaxBytes);
  // Controls can split a token. Remove them before recognizing secrets so a
  // later projection cannot splice an otherwise unrecognized credential back together.
  const controlsRemoved = stripDiagnosticControls(raw.value);
  const redacted = redactDiagnosticSecrets(controlsRemoved, raw.truncated || options.sourceTruncated === true);
  const pathsRedacted = redactAbsoluteDiagnosticPaths(redacted);
  const normalized = options.collapseWhitespace ? collapseWhitespace(pathsRedacted) : pathsRedacted;
  const publicValue = takeUtf8Prefix(normalized, publicMaxBytes);
  return raw.truncated || options.sourceTruncated || publicValue.truncated
    ? withTruncationMarker(publicValue.value, publicMaxBytes)
    : publicValue.value;
}

/** Remove terminal escape, control, bidi, and format characters in one pass. */
export function stripDiagnosticControls(value: string): string {
  const output: string[] = [];
  for (let index = 0; index < value.length;) {
    const code = value.charCodeAt(index);
    if (code === 27) {
      index = skipAnsiEscape(value, index);
      continue;
    }
    if (isDiagnosticControl(code)) {
      index += 1;
      continue;
    }
    output.push(value[index]);
    index += 1;
  }
  return output.join("");
}

function redactDiagnosticSecrets(value: string, truncatedAtEnd: boolean): string {
  const output: string[] = [];
  for (let index = 0; index < value.length;) {
    const bare = readBareToken(value, index, truncatedAtEnd);
    if (bare) {
      output.push("[redacted]");
      index = bare;
      continue;
    }
    const bearer = readBearerToken(value, index, truncatedAtEnd);
    if (bearer) {
      output.push(value.slice(index, bearer.valueStart), "[redacted]");
      index = bearer.end;
      continue;
    }
    const assignment = isSensitiveAssignmentStart(value, index)
      ? readSensitiveAssignment(value, index, truncatedAtEnd)
      : null;
    if (assignment) {
      output.push(value.slice(index, assignment.valueStart), "[redacted]", assignment.quote);
      index = assignment.end;
      continue;
    }
    const identifierEnd = identifierRunEnd(value, index);
    if (identifierEnd > index) {
      output.push(value.slice(index, identifierEnd));
      index = identifierEnd;
      continue;
    }
    output.push(value[index]);
    index += 1;
  }
  return output.join("");
}

function isSensitiveAssignmentStart(value: string, start: number): boolean {
  const code = value.charCodeAt(start);
  if (code === 34 || code === 39) return isIdentifierStart(value.charCodeAt(start + 1));
  return isIdentifierStart(code) && (start === 0 || !isIdentifierCharacter(value.charCodeAt(start - 1)));
}

function identifierRunEnd(value: string, start: number): number {
  if (!isIdentifierStart(value.charCodeAt(start))) return start;
  let end = start + 1;
  while (isIdentifierCharacter(value.charCodeAt(end))) end += 1;
  return end;
}

function readSensitiveAssignment(value: string, start: number, truncatedAtEnd: boolean): { valueStart: number; end: number; quote: string } | null {
  const keyStart = value[start] === '"' || value[start] === "'" ? start + 1 : start;
  if (!isIdentifierStart(value.charCodeAt(keyStart))) return null;
  let keyEnd = keyStart + 1;
  while (isIdentifierCharacter(value.charCodeAt(keyEnd))) keyEnd += 1;
  const key = value.slice(keyStart, keyEnd);
  if (!looksSensitiveKey(key)) return null;
  let cursor = value[start] === '"' || value[start] === "'" ? keyEnd + 1 : keyEnd;
  cursor = skipWhitespace(value, cursor);
  if (value[cursor] !== "=" && value[cursor] !== ":") return null;
  cursor = skipWhitespace(value, cursor + 1);
  const quote = value[cursor] === '"' || value[cursor] === "'" ? value[cursor] : "";
  const valueStart = quote ? cursor + 1 : cursor;
  // The shared projection may be applied at more than one outward boundary.
  // Treat its own marker as opaque so a second pass cannot append a stray `]`.
  if (!quote && value.startsWith("[redacted]", valueStart)) {
    return { valueStart, end: valueStart + "[redacted]".length, quote: "" };
  }
  if (!quote && key.toLowerCase() === "authorization" && matchesAsciiWord(value, valueStart, "bearer")) {
    const tokenStart = skipWhitespace(value, valueStart + 6);
    if (tokenStart > valueStart + 6) {
      let tokenEnd = tokenStart;
      while (isBearerCharacter(value.charCodeAt(tokenEnd))) tokenEnd += 1;
      if (tokenEnd > tokenStart) return { valueStart: tokenStart, end: tokenEnd, quote: "" };
    }
  }
  let end = valueStart;
  while (end < value.length && !isSecretValueDelimiter(value.charCodeAt(end), quote)) end += 1;
  if (end === valueStart && !(truncatedAtEnd && end === value.length)) return null;
  return { valueStart, end: quote && value[end] === quote ? end + 1 : end, quote };
}

function readBearerToken(value: string, start: number, truncatedAtEnd: boolean): { valueStart: number; end: number } | null {
  if (!matchesAsciiWord(value, start, "bearer")) return null;
  const before = start === 0 ? 0 : value.charCodeAt(start - 1);
  if (before && isIdentifierCharacter(before)) return null;
  let valueStart = skipWhitespace(value, start + 6);
  if (valueStart === start + 6) return null;
  let end = valueStart;
  while (isBearerCharacter(value.charCodeAt(end))) end += 1;
  const length = end - valueStart;
  return length >= 12 || (truncatedAtEnd && end === value.length && length > 0)
    ? { valueStart, end }
    : null;
}

function readBareToken(value: string, start: number, truncatedAtEnd: boolean): number | null {
  if (start > 0 && isIdentifierCharacter(value.charCodeAt(start - 1))) return null;
  const prefixes = ["sk-proj-", "sk-ant-", "sk-", "ghp_", "gho_", "ghu_", "ghs_", "ghr_", "npm_", "xoxb-", "xoxa-", "xoxp-", "xoxr-", "xoxs-"];
  const prefix = prefixes.find((candidate) => matchesAsciiWord(value, start, candidate));
  if (!prefix) return null;
  let end = start + prefix.length;
  while (isBareTokenCharacter(value.charCodeAt(end))) end += 1;
  const tailLength = end - (start + prefix.length);
  return tailLength >= 20 || (truncatedAtEnd && end === value.length && tailLength > 0) ? end : null;
}

function redactAbsoluteDiagnosticPaths(value: string): string {
  const output: string[] = [];
  for (let index = 0; index < value.length;) {
    const end = absolutePathEnd(value, index);
    if (end === null) {
      output.push(value[index]);
      index += 1;
      continue;
    }
    output.push("<path>");
    index = end;
  }
  return output.join("");
}

function absolutePathEnd(value: string, start: number): number | null {
  const current = value.charCodeAt(start);
  const windows = isAsciiLetter(current) && value.charCodeAt(start + 1) === 58 && isPathSeparator(value.charCodeAt(start + 2));
  const posix = current === 47;
  const unc = current === 92 && value.charCodeAt(start + 1) === 92;
  if (!windows && !posix && !unc) return null;
  let end = start + (windows ? 3 : unc ? 2 : 1);
  while (end < value.length && !isPathDelimiter(value.charCodeAt(end))) end += 1;
  return end > start + (windows ? 3 : unc ? 2 : 1) || posix ? end : null;
}

function skipAnsiEscape(value: string, start: number): number {
  const next = value.charCodeAt(start + 1);
  if (next === 91) { // CSI: ESC [ params intermediates final
    let index = start + 2;
    while (index < value.length) {
      const code = value.charCodeAt(index++);
      if (code >= 64 && code <= 126) break;
    }
    return index;
  }
  if (next === 93) { // OSC: ESC ] ... BEL or ESC \
    let index = start + 2;
    while (index < value.length) {
      if (value.charCodeAt(index) === 7) return index + 1;
      if (value.charCodeAt(index) === 27 && value.charCodeAt(index + 1) === 92) return index + 2;
      index += 1;
    }
    return index;
  }
  return Math.min(value.length, start + 2);
}

function withTruncationMarker(value: string, maxBytes: number): string {
  const marker = "…";
  const markerBytes = 3;
  if (maxBytes < markerBytes) return takeUtf8Prefix(marker, maxBytes).value;
  return `${takeUtf8Prefix(value, maxBytes - markerBytes).value}${marker}`;
}

function collapseWhitespace(value: string): string {
  let output = "";
  let whitespace = false;
  for (let index = 0; index < value.length; index += 1) {
    if (isWhitespace(value.charCodeAt(index))) {
      whitespace = output.length > 0;
      continue;
    }
    if (whitespace) output += " ";
    output += value[index];
    whitespace = false;
  }
  return output.trim();
}

function boundedByteCap(value: number, maximum: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, maximum) : 0;
}

function utf8WidthAt(value: string, index: number): { bytes: number; codeUnits: number } {
  const code = value.charCodeAt(index);
  if (code >= 0xd800 && code <= 0xdbff && isLowSurrogate(value.charCodeAt(index + 1))) return { bytes: 4, codeUnits: 2 };
  return { bytes: code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3, codeUnits: 1 };
}

function utf8WidthBefore(value: string, end: number): { bytes: number; codeUnits: number } {
  const code = value.charCodeAt(end - 1);
  if (isLowSurrogate(code) && end >= 2) {
    const prior = value.charCodeAt(end - 2);
    if (prior >= 0xd800 && prior <= 0xdbff) return { bytes: 4, codeUnits: 2 };
  }
  return { bytes: code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3, codeUnits: 1 };
}

function isLowSurrogate(code: number): boolean { return code >= 0xdc00 && code <= 0xdfff; }
function isAsciiLetter(code: number): boolean { return (code >= 65 && code <= 90) || (code >= 97 && code <= 122); }
function isIdentifierStart(code: number): boolean { return isAsciiLetter(code) || code === 95; }
function isIdentifierCharacter(code: number): boolean { return isIdentifierStart(code) || (code >= 48 && code <= 57) || code === 45; }
function isBearerCharacter(code: number): boolean { return isIdentifierCharacter(code) || code === 46 || code === 126 || code === 43 || code === 47 || code === 61; }
function isBareTokenCharacter(code: number): boolean { return isIdentifierCharacter(code); }
function isPathSeparator(code: number): boolean { return code === 47 || code === 92; }
function isPathDelimiter(code: number): boolean { return isWhitespace(code) || code === 34 || code === 39 || code === 60 || code === 62; }
function isSecretValueDelimiter(code: number, quote: string): boolean { return quote ? code === quote.charCodeAt(0) : isWhitespace(code) || code === 44 || code === 125 || code === 93 || code === 34 || code === 39; }
function isWhitespace(code: number): boolean { return code === 32 || (code >= 9 && code <= 13); }

function looksSensitiveKey(value: string): boolean {
  const lower = value.toLowerCase();
  return lower.includes("secret") || lower.includes("token") || lower.includes("key") || lower.includes("password") || lower.includes("authorization") || lower.includes("cookie");
}

function matchesAsciiWord(value: string, start: number, word: string): boolean {
  if (start + word.length > value.length) return false;
  for (let index = 0; index < word.length; index += 1) {
    const actual = value.charCodeAt(start + index);
    const expected = word.charCodeAt(index);
    const lower = actual >= 65 && actual <= 90 ? actual + 32 : actual;
    if (lower !== expected) return false;
  }
  return true;
}

function skipWhitespace(value: string, index: number): number {
  while (isWhitespace(value.charCodeAt(index))) index += 1;
  return index;
}

function isDiagnosticControl(code: number): boolean {
  return (code >= 0 && code <= 31) || (code >= 127 && code <= 159)
    || code === 0x061c
    || (code >= 0x200b && code <= 0x200f) || code === 0x2028 || code === 0x2029
    || (code >= 0x202a && code <= 0x202e) || (code >= 0x2060 && code <= 0x2064)
    || (code >= 0x2066 && code <= 0x2069) || code === 0xfeff;
}
