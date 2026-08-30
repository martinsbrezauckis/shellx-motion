/**
 * Closed parser for the two functional Motion easing forms.
 *
 * This deliberately does not use a shared regular expression. Easing appears in
 * package validation, Debug arguments, and both render lanes, so an ambiguous
 * pattern here would put the same hostile string on every one of those paths.
 * The parser rejects over-limit input before inspecting its grammar and advances
 * each code unit at most once.
 */

/** Maximum UTF-16 code units in a functional easing string. */
export const MAX_MOTION_EASING_CODE_UNITS = 256;
/** Maximum code units in one cubic-bezier numeric token. */
export const MAX_MOTION_EASING_NUMERIC_TOKEN_CODE_UNITS = 32;
/** `steps()` has a decimal integer count, bounded independently of cubic values. */
export const MAX_MOTION_EASING_STEP_COUNT_DIGITS = 9;

const NUMBER_PATTERN = String.raw`[-+]?(?:(?:[0-9]{1,16}(?:\.[0-9]{0,7})?)|(?:\.[0-9]{1,22}))(?:[eE][-+]?[0-9]{1,5})?`;
const SPACE_PATTERN = String.raw`\s*`;
const CUBIC_BEZIER_NAME = String.raw`[cC][uU][bB][iI][cC]-[bB][eE][zZ][iI][eE][rR]`;
const STEPS_NAME = String.raw`[sS][tT][eE][pP][sS]`;
const STEP_POSITION = String.raw`(?:[sS][tT][aA][rR][tT]|[eE][nN][dD]|[jJ][uU][mM][pP]-[sS][tT][aA][rR][tT]|[jJ][uU][mM][pP]-[eE][nN][dD])`;

/**
 * The generated JSON Schema / Debug metadata grammar for functional strings.
 * Named easings and spring objects are represented by their own alternatives.
 */
// `(?![\s\S])` is ECMAScript's strict end-of-input assertion; unlike `$`, it
// cannot accept immediately before one final line terminator.
export const MOTION_FUNCTIONAL_EASING_PATTERN = String.raw`^(?:${CUBIC_BEZIER_NAME}\(${SPACE_PATTERN}${NUMBER_PATTERN}${SPACE_PATTERN},${SPACE_PATTERN}${NUMBER_PATTERN}${SPACE_PATTERN},${SPACE_PATTERN}${NUMBER_PATTERN}${SPACE_PATTERN},${SPACE_PATTERN}${NUMBER_PATTERN}${SPACE_PATTERN}\)|${STEPS_NAME}\(${SPACE_PATTERN}[1-9][0-9]{0,${MAX_MOTION_EASING_STEP_COUNT_DIGITS - 1}}${SPACE_PATTERN}(?:,${SPACE_PATTERN}${STEP_POSITION}${SPACE_PATTERN})?\))(?![\s\S])`;

export interface MotionStepsEasing {
  steps: number;
  position: "start" | "end";
}

/** Parse the CSS-compatible cubic-bezier form, including Y overshoot. */
export function parseCubicBezierEasing(easing: string | undefined): [number, number, number, number] | null {
  const parser = FunctionalEasingParser.from(easing);
  if (!parser || !parser.consumeWord("cubic-bezier") || !parser.consume("(")) return null;
  const values: number[] = [];
  for (let index = 0; index < 4; index += 1) {
    parser.skipWhitespace();
    const value = parser.readNumber();
    if (value === null) return null;
    values.push(value);
    parser.skipWhitespace();
    if (index < 3) {
      if (!parser.consume(",")) return null;
    }
  }
  if (!parser.consume(")") || !parser.atEnd()) return null;
  const [x1, y1, x2, y2] = values as [number, number, number, number];
  // CSS permits overshoot on Y controls. Only X controls define the monotonic
  // time axis and must remain in the closed unit interval.
  return x1 >= 0 && x1 <= 1 && x2 >= 0 && x2 <= 1 ? [x1, y1, x2, y2] : null;
}

/** Parse the legacy-compatible `steps(count, position?)` form. */
export function parseStepsEasing(easing: string | undefined): MotionStepsEasing | null {
  const parser = FunctionalEasingParser.from(easing);
  if (!parser || !parser.consumeWord("steps") || !parser.consume("(")) return null;
  parser.skipWhitespace();
  const steps = parser.readStepCount();
  if (steps === null) return null;
  parser.skipWhitespace();
  let position: MotionStepsEasing["position"] = "end";
  if (parser.consume(",")) {
    parser.skipWhitespace();
    const rawPosition = parser.readStepPosition();
    if (!rawPosition) return null;
    position = rawPosition;
    parser.skipWhitespace();
  }
  return parser.consume(")") && parser.atEnd() ? { steps, position } : null;
}

/** True when a string is one bounded functional Motion easing form. */
export function isSupportedFunctionalEasing(easing: string): boolean {
  return parseCubicBezierEasing(easing) !== null || parseStepsEasing(easing) !== null;
}

class FunctionalEasingParser {
  private offset = 0;

  private constructor(private readonly source: string) {}

  static from(value: string | undefined): FunctionalEasingParser | null {
    if (!value || value.length > MAX_MOTION_EASING_CODE_UNITS) return null;
    return new FunctionalEasingParser(value);
  }

  atEnd(): boolean {
    return this.offset === this.source.length;
  }

  consume(value: string): boolean {
    if (!this.source.startsWith(value, this.offset)) return false;
    this.offset += value.length;
    return true;
  }

  consumeWord(word: string): boolean {
    if (this.offset + word.length > this.source.length) return false;
    for (let index = 0; index < word.length; index += 1) {
      if (!sameAsciiCaseInsensitive(this.source.charCodeAt(this.offset + index), word.charCodeAt(index))) return false;
    }
    this.offset += word.length;
    return true;
  }

  skipWhitespace(): void {
    while (this.offset < this.source.length && isEcmaWhitespace(this.source.charCodeAt(this.offset))) this.offset += 1;
  }

  readNumber(): number | null {
    const start = this.offset;
    const sign = this.source.charCodeAt(this.offset);
    if (sign === 43 || sign === 45) this.offset += 1;

    const first = this.source.charCodeAt(this.offset);
    if (first === 46) {
      this.offset += 1;
      if (!this.consumeDigits(1, 22)) return null;
    } else {
      if (!this.consumeDigits(1, 16)) return null;
      if (this.source.charCodeAt(this.offset) === 46) {
        this.offset += 1;
        if (!this.consumeDigits(0, 7)) return null;
      }
    }

    const exponent = this.source.charCodeAt(this.offset);
    if (exponent === 69 || exponent === 101) {
      this.offset += 1;
      const exponentSign = this.source.charCodeAt(this.offset);
      if (exponentSign === 43 || exponentSign === 45) this.offset += 1;
      if (!this.consumeDigits(1, 5)) return null;
    }

    const token = this.source.slice(start, this.offset);
    if (token.length > MAX_MOTION_EASING_NUMERIC_TOKEN_CODE_UNITS) return null;
    const value = Number(token);
    return Number.isFinite(value) ? value : null;
  }

  readStepCount(): number | null {
    const first = this.source.charCodeAt(this.offset);
    if (first < 49 || first > 57) return null;
    const start = this.offset;
    this.offset += 1;
    if (!this.consumeDigits(0, MAX_MOTION_EASING_STEP_COUNT_DIGITS - 1)) return null;
    const steps = Number(this.source.slice(start, this.offset));
    return Number.isSafeInteger(steps) && steps >= 1 ? steps : null;
  }

  readStepPosition(): MotionStepsEasing["position"] | null {
    if (this.consumeWord("start") || this.consumeWord("jump-start")) return "start";
    if (this.consumeWord("end") || this.consumeWord("jump-end")) return "end";
    return null;
  }

  private consumeDigits(minimum: number, maximum: number): boolean {
    let count = 0;
    while (isAsciiDigit(this.source.charCodeAt(this.offset))) {
      if (count === maximum) return false;
      this.offset += 1;
      count += 1;
    }
    return count >= minimum;
  }
}

function isAsciiDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function sameAsciiCaseInsensitive(actual: number, expected: number): boolean {
  if (actual === expected) return true;
  const actualLower = actual >= 65 && actual <= 90 ? actual + 32 : actual;
  const expectedLower = expected >= 65 && expected <= 90 ? expected + 32 : expected;
  return actualLower === expectedLower;
}

/** ECMAScript's whitespace and line-terminator code units; no regex is needed. */
function isEcmaWhitespace(code: number): boolean {
  return (code >= 9 && code <= 13)
    || code === 32 || code === 160 || code === 5760 || code === 8232 || code === 8233
    || code === 8239 || code === 8287 || code === 12288 || code === 65279
    || (code >= 8192 && code <= 8202);
}
