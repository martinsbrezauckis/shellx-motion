/**
 * General authored-colour bound. The code-unit check is the allocation guard before normalization;
 * the byte check keeps the public UTF-8 contract identical on every runtime.
 */
export const MAX_MOTION_COLOR_STRING_LENGTH = 128;

export type MotionColorFunctionName = "rgb" | "rgba" | "hsl" | "hsla";

export type ParsedMotionColorString =
  | Readonly<{ kind: "hex"; value: string; digits: string; alphaIsZero: boolean }>
  | Readonly<{ kind: "keyword"; value: string; keyword: string; alphaIsZero: boolean; currentColor: boolean }>
  | Readonly<{
    kind: "functional";
    value: string;
    functionName: MotionColorFunctionName;
    body: string;
    alphaToken: string | null;
    alphaIsZero: boolean;
  }>;

/**
 * Parse the declared legacy Motion CSS subset without handing an attacker-controlled body to a
 * repeated regular expression. This validates the established syntax envelope, not full CSS
 * component semantics: renderer-specific lowerers may accept a narrower numeric subset.
 */
export function parseMotionColorString(value: unknown): ParsedMotionColorString | null {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_MOTION_COLOR_STRING_LENGTH) return null;
  if (new TextEncoder().encode(value).byteLength > MAX_MOTION_COLOR_STRING_LENGTH) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_MOTION_COLOR_STRING_LENGTH) return null;

  const hex = parseHexDigits(trimmed);
  if (hex) {
    const alphaDigits = hex.length === 4 ? hex.slice(3) : hex.length === 8 ? hex.slice(6) : "";
    return Object.freeze({ kind: "hex", value: trimmed, digits: hex, alphaIsZero: alphaDigits.length > 0 && allZeroes(alphaDigits) });
  }

  const lower = trimmed.toLowerCase();
  if (lower === "transparent" || lower === "currentcolor" || SUPPORTED_NAMED_COLORS.has(lower)) {
    return Object.freeze({
      kind: "keyword",
      value: trimmed,
      keyword: lower,
      alphaIsZero: lower === "transparent",
      currentColor: lower === "currentcolor",
    });
  }

  const open = trimmed.indexOf("(");
  if (open < 1 || trimmed.at(-1) !== ")" || trimmed.indexOf("(", open + 1) !== -1) return null;
  const functionName = trimmed.slice(0, open).toLowerCase();
  if (!isMotionColorFunctionName(functionName)) return null;
  const body = trimmed.slice(open + 1, -1);
  if (!body || !legacyFunctionalBody(body)) return null;
  const alphaToken = functionalAlphaToken(body);
  return Object.freeze({
    kind: "functional",
    value: trimmed,
    functionName,
    body,
    alphaToken,
    alphaIsZero: alphaToken !== null && isLegacyZeroAlphaToken(alphaToken),
  });
}

export function isSupportedMotionColorString(value: unknown): boolean {
  return parseMotionColorString(value) !== null;
}

export function isSupportedHexColorString(value: string): boolean {
  return parseMotionColorString(value)?.kind === "hex";
}

/** Whether an authored colour is an explicit visible stroke colour. */
export function isVisibleMotionColorString(value: unknown): boolean {
  const parsed = parseMotionColorString(value);
  return parsed !== null && !(parsed.kind === "keyword" && parsed.currentColor) && !parsed.alphaIsZero;
}

/** Parse the canonical unsigned decimal token used by the strict GPU rgb/rgba subset. */
export function parseCanonicalMotionCssNumber(value: string): { value: number; percentage: boolean } | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const percentage = trimmed.at(-1) === "%";
  const number = percentage ? trimmed.slice(0, -1) : trimmed;
  if (!number) return null;
  let index = 0;
  if (number[index] === "0") {
    index += 1;
    if (isAsciiDigit(number[index])) return null;
  } else if (isNonZeroAsciiDigit(number[index])) {
    index += 1;
    while (isAsciiDigit(number[index])) index += 1;
  } else {
    return null;
  }
  if (number[index] === ".") {
    index += 1;
    const decimalStart = index;
    while (isAsciiDigit(number[index])) index += 1;
    if (index === decimalStart) return null;
  }
  if (index !== number.length) return null;
  const parsed = Number(number);
  return Number.isFinite(parsed) ? { value: parsed, percentage } : null;
}

/**
 * Every colour name Motion's renderers resolve.
 *
 * Exported, and deliberately not private, because a refusal has to be able to NAME them: CSS has
 * 148 named colours and Motion resolves 22 of them, so "midnightblue" is a reasonable guess that
 * this engine cannot draw. A message that says "unsupported colour" without the list leaves the
 * caller guessing which of the two vocabularies it is being held to.
 */
export const SUPPORTED_MOTION_COLOR_NAMES: readonly string[] = Object.freeze([
  "black", "white", "red", "green", "blue", "navy", "yellow", "cyan", "aqua", "magenta", "fuchsia",
  "gray", "grey", "silver", "maroon", "purple", "olive", "lime", "teal", "orange", "pink", "brown"
]);

const SUPPORTED_NAMED_COLORS = new Set(SUPPORTED_MOTION_COLOR_NAMES);

/** The colour forms this engine accepts, as one sentence a refusal can end with. */
export function supportedMotionColorAdvice(): string {
  return "hex (#rgb, #rgba, #rrggbb, #rrggbbaa), rgb()/rgba()/hsl()/hsla(), transparent, currentColor, "
    + `or one of these names: ${SUPPORTED_MOTION_COLOR_NAMES.join(", ")}`;
}

function parseHexDigits(value: string): string | null {
  if (value[0] !== "#" || ![4, 5, 7, 9].includes(value.length)) return null;
  for (let index = 1; index < value.length; index += 1) if (!isAsciiHex(value[index])) return null;
  return value.slice(1);
}

function legacyFunctionalBody(value: string): boolean {
  for (const character of value) {
    if (isAsciiDigit(character) || character === "-" || character === "." || character === "%" || character === "," || character === "/" || character.trim() === "") continue;
    return false;
  }
  return true;
}

function functionalAlphaToken(body: string): string | null {
  const slash = body.lastIndexOf("/");
  if (slash !== -1) return body.slice(slash + 1).trim();
  let commas = 0;
  let lastComma = -1;
  for (let index = 0; index < body.length; index += 1) if (body[index] === ",") { commas += 1; lastComma = index; }
  return commas === 3 ? body.slice(lastComma + 1).trim() : null;
}

function isLegacyZeroAlphaToken(value: string): boolean {
  let index = 0;
  if (value[index] === "+" || value[index] === "-") index += 1;
  while (value[index] === "0") index += 1;
  if (value[index] === ".") {
    index += 1;
    while (value[index] === "0") index += 1;
  }
  if (value[index] === "%") index += 1;
  return index === value.length;
}

function isMotionColorFunctionName(value: string): value is MotionColorFunctionName {
  return value === "rgb" || value === "rgba" || value === "hsl" || value === "hsla";
}

function allZeroes(value: string): boolean {
  for (const character of value) if (character !== "0") return false;
  return true;
}

function isAsciiDigit(value: string | undefined): boolean { return value !== undefined && value >= "0" && value <= "9"; }
function isNonZeroAsciiDigit(value: string | undefined): boolean { return value !== undefined && value >= "1" && value <= "9"; }
function isAsciiHex(value: string | undefined): boolean {
  return isAsciiDigit(value) || (value !== undefined && ((value >= "a" && value <= "f") || (value >= "A" && value <= "F")));
}
