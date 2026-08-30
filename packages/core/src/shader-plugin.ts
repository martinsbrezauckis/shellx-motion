export const RESTRICTED_SHADER_SCHEMA = "shellx-motion/shader-plugin@1" as const;
export const RESTRICTED_SHADER_LANGUAGE = "glsl-es-100-expression" as const;
export const MAX_RESTRICTED_SHADER_BYTES = 16 * 1024;
export const MAX_RESTRICTED_SHADER_EXPRESSION_CHARS = 4096;
export const MAX_RESTRICTED_SHADER_TOKENS = 256;
export const MAX_RESTRICTED_SHADER_NESTING = 32;
export const MAX_RESTRICTED_SHADER_UNIFORMS = 16;

const RESERVED_UNIFORMS = new Set(["u_time", "u_seed", "u_resolution"]);
const ALLOWED_IDENTIFIERS = new Set([
  "uv", "u_time", "u_seed", "u_resolution",
  "float", "vec2", "vec3", "vec4", "mat2",
  "sin", "cos", "tan", "asin", "acos", "atan",
  "abs", "sign", "floor", "ceil", "fract", "min", "max", "clamp", "mix",
  "step", "smoothstep", "length", "distance", "dot", "normalize", "reflect",
  "refract", "pow", "exp", "exp2", "log", "log2", "sqrt", "inversesqrt", "mod"
]);

export interface RestrictedShaderValidationResult {
  ok: boolean;
  expression?: string;
  errors: string[];
}

/**
 * Validates the executable shader subset before Chromium sees it. The contract
 * permits one expression-only function and intentionally excludes control flow,
 * helper functions, memory access, textures, preprocessor directives, and host
 * declarations so runtime cost stays bounded and deterministic.
 */
export function validateRestrictedFragmentShader(
  source: string,
  uniformNames: string[] = []
): RestrictedShaderValidationResult {
  const errors: string[] = [];
  if (new TextEncoder().encode(source).byteLength > MAX_RESTRICTED_SHADER_BYTES) {
    return { ok: false, errors: [`shader source exceeds ${MAX_RESTRICTED_SHADER_BYTES} bytes`] };
  }
  if (source.includes("\0")) errors.push("shader source contains a null byte");
  if (/#[A-Za-z]/.test(source)) errors.push("preprocessor directives are not allowed");
  if (/\/\*|\/\//.test(source)) errors.push("shader comments are not allowed");
  if (/\b(?:for|while|do|discard|uniform|attribute|varying|sampler\w*|void|main)\b/.test(source)) {
    errors.push("control flow, host declarations, samplers, discard, and main are not allowed");
  }
  const wrappedExpression = readMotionMainExpression(source);
  if (wrappedExpression === null) {
    errors.push("shader must contain exactly `vec4 motionMain(vec2 uv) { return <expression>; }`");
    return { ok: false, errors: [...new Set(errors)] };
  }
  const expression = wrappedExpression.trim();
  if (expression.length === 0 || expression.length > MAX_RESTRICTED_SHADER_EXPRESSION_CHARS) {
    errors.push(`shader expression must contain 1-${MAX_RESTRICTED_SHADER_EXPRESSION_CHARS} characters`);
  }
  if (/[{};\[\]]/.test(expression)) errors.push("shader expression contains a forbidden statement or array token");
  if (!/^[\w\s.,+\-*/()?:<>=!&|]+$/.test(expression)) errors.push("shader expression contains a forbidden character");
  if (/[?:]/.test(expression)) errors.push("conditional expressions are not allowed");
  if (/\+\+|--|[+\-*/]=|(?<![=!<>])=(?!=)/.test(expression)) errors.push("mutation operators are not allowed");

  const allowedUniforms = new Set(uniformNames);
  for (const uniformName of allowedUniforms) {
    if (!isSafeShaderUniformName(uniformName)) errors.push(`invalid shader uniform name: ${uniformName}`);
  }
  if (allowedUniforms.size > MAX_RESTRICTED_SHADER_UNIFORMS) {
    errors.push(`shader declares more than ${MAX_RESTRICTED_SHADER_UNIFORMS} custom uniforms`);
  }

  const withoutNumbers = expression
    .replace(/(?<![A-Za-z_])(?:\d+\.\d*|\.\d+|\d+)(?:e[+-]?\d+)?(?![A-Za-z_])/gi, " ")
    .replace(/\.[xyzwrgba]{1,4}\b/g, "");
  const identifiers = withoutNumbers.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  if (identifiers.length > MAX_RESTRICTED_SHADER_TOKENS) {
    errors.push(`shader expression exceeds ${MAX_RESTRICTED_SHADER_TOKENS} identifier tokens`);
  }
  for (const identifier of identifiers) {
    if (!ALLOWED_IDENTIFIERS.has(identifier) && !allowedUniforms.has(identifier)) {
      errors.push(`shader identifier is not allowed: ${identifier}`);
    }
  }

  let nesting = 0;
  let maximumNesting = 0;
  for (const character of expression) {
    if (character === "(") maximumNesting = Math.max(maximumNesting, ++nesting);
    if (character === ")") nesting -= 1;
    if (nesting < 0) break;
  }
  if (nesting !== 0) errors.push("shader expression has unbalanced parentheses");
  if (maximumNesting > MAX_RESTRICTED_SHADER_NESTING) {
    errors.push(`shader expression nesting exceeds ${MAX_RESTRICTED_SHADER_NESTING}`);
  }
  return errors.length > 0
    ? { ok: false, errors: [...new Set(errors)] }
    : { ok: true, expression, errors: [] };
}

/** Deterministic wrapper reader; expression validation remains below this closed structural cut. */
function readMotionMainExpression(source: string): string | null {
  let index = skipWhitespace(source, 0);
  index = readToken(source, index, "vec4");
  if (index < 0) return null;
  index = readRequiredWhitespace(source, index);
  if (index < 0) return null;
  index = readToken(source, index, "motionMain");
  if (index < 0) return null;
  index = skipWhitespace(source, index);
  index = readCharacter(source, index, "(");
  if (index < 0) return null;
  index = skipWhitespace(source, index);
  index = readToken(source, index, "vec2");
  if (index < 0) return null;
  index = readRequiredWhitespace(source, index);
  if (index < 0) return null;
  index = readToken(source, index, "uv");
  if (index < 0) return null;
  index = skipWhitespace(source, index);
  index = readCharacter(source, index, ")");
  if (index < 0) return null;
  index = skipWhitespace(source, index);
  index = readCharacter(source, index, "{");
  if (index < 0) return null;
  index = skipWhitespace(source, index);
  index = readToken(source, index, "return");
  if (index < 0) return null;
  index = readRequiredWhitespace(source, index);
  if (index < 0) return null;
  const expressionStart = index;
  let end = skipWhitespaceBackward(source, source.length);
  if (end <= expressionStart || source[end - 1] !== "}") return null;
  end = skipWhitespaceBackward(source, end - 1);
  if (end <= expressionStart || source[end - 1] !== ";") return null;
  return source.slice(expressionStart, end - 1);
}

function readToken(source: string, index: number, token: string): number {
  if (!source.startsWith(token, index)) return -1;
  const end = index + token.length;
  return isIdentifierCharacter(source[end]) ? -1 : end;
}

function readCharacter(source: string, index: number, expected: string): number {
  return source[index] === expected ? index + 1 : -1;
}

function readRequiredWhitespace(source: string, index: number): number {
  const end = skipWhitespace(source, index);
  return end > index ? end : -1;
}

function skipWhitespace(source: string, index: number): number {
  while (index < source.length && source[index]!.trim() === "") index += 1;
  return index;
}

function skipWhitespaceBackward(source: string, index: number): number {
  while (index > 0 && source[index - 1]!.trim() === "") index -= 1;
  return index;
}

function isIdentifierCharacter(value: string | undefined): boolean {
  return value !== undefined && ((value >= "A" && value <= "Z") || (value >= "a" && value <= "z") || (value >= "0" && value <= "9") || value === "_");
}

export function compileRestrictedFragmentShader(source: string, uniformNames: string[] = []): string {
  const validation = validateRestrictedFragmentShader(source, uniformNames);
  if (!validation.ok || !validation.expression) {
    throw new Error(`Restricted shader validation failed: ${validation.errors.join("; ")}`);
  }
  const customUniforms = [...new Set(uniformNames)].sort().map((name) => `uniform float ${name};`).join("\n");
  return [
    "precision highp float;",
    "uniform vec2 u_resolution;",
    "uniform float u_time;",
    "uniform float u_seed;",
    customUniforms,
    source,
    "void main() {",
    "  vec2 uv = gl_FragCoord.xy / u_resolution;",
    "  gl_FragColor = clamp(motionMain(uv), 0.0, 1.0);",
    "}"
  ].filter(Boolean).join("\n");
}

export function isSafeShaderUniformName(value: string): boolean {
  return /^u_[A-Za-z][A-Za-z0-9_]{0,30}$/.test(value) && !RESERVED_UNIFORMS.has(value);
}
