/** Shared bounded geometry contract for imported shapes and editable path masks. */
const MAX_PATH_BYTES = 1024 * 1024;
const MAX_PATH_TOKENS = 100_000;
const MAX_ABSOLUTE_COORDINATE = 1_000_000_000;

export interface MotionPathViewBox {
  x: number;
  y: number;
  width: number;
  height: number;
  normalized: string;
}

/**
 * Consumes the complete SVG path token stream and rejects malformed, oversized,
 * non-finite, or unsupported geometry before it reaches a renderer.
 */
export function validateMotionPathData(value: unknown, label = "Motion path"): string {
  if (typeof value !== "string" || value.trim().length === 0 || Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES) {
    throw new Error(`${label} has missing or oversized path data.`);
  }
  const residue = value.replace(/[AaCcHhLlMmQqSsTtVvZz]/g, "")
    .replace(/[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?/g, "")
    .replace(/[\s,]/g, "");
  if (residue) throw new Error(`${label} contains unsupported path syntax.`);
  if (!/[Mm]/.test(value) || !/[0-9]/.test(value)) throw new Error(`${label} requires a move command and numeric geometry.`);
  const tokens = value.match(/[AaCcHhLlMmQqSsTtVvZz]|[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?/g) ?? [];
  if (tokens.length > MAX_PATH_TOKENS) throw new Error(`${label} exceeds the ${MAX_PATH_TOKENS}-token limit.`);
  const arity: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
  let index = 0;
  let command = "";
  let drewSegment = false;
  while (index < tokens.length) {
    if (/^[A-Za-z]$/.test(tokens[index])) {
      command = tokens[index];
      index += 1;
      if (command.toUpperCase() === "Z") {
        command = "";
        continue;
      }
    }
    if (!command) throw new Error(`${label} contains parameters without a command.`);
    const required = arity[command.toUpperCase()];
    if (required === undefined || index + required > tokens.length) throw new Error(`${label} contains an incomplete ${command} command.`);
    const params = tokens.slice(index, index + required);
    const numbers = params.map(Number);
    if (params.some((token) => /^[A-Za-z]$/.test(token))
      || numbers.some((number) => !Number.isFinite(number) || Math.abs(number) > MAX_ABSOLUTE_COORDINATE)) {
      throw new Error(`${label} contains invalid ${command} parameters.`);
    }
    if (command.toUpperCase() === "A" && (!isArcFlag(params[3]) || !isArcFlag(params[4]) || numbers[0] < 0 || numbers[1] < 0)) {
      throw new Error(`${label} contains invalid arc radii or flags.`);
    }
    if (command.toUpperCase() !== "M") drewSegment = true;
    index += required;
    if (command === "M") command = "L";
    if (command === "m") command = "l";
  }
  if (!drewSegment) throw new Error(`${label} requires at least one drawing segment.`);
  return value.trim();
}

/** Parses a local-coordinate viewBox used to normalize path geometry. */
export function parseMotionPathViewBox(value: unknown, label = "Motion path viewBox"): MotionPathViewBox {
  if (typeof value !== "string" || value.length > 256) throw new Error(`${label} must contain four bounded numbers.`);
  const values = value.trim().split(/[\s,]+/).map(Number);
  if (values.length !== 4
    || values.some((number) => !Number.isFinite(number) || Math.abs(number) > MAX_ABSOLUTE_COORDINATE)
    || values[2] <= 0
    || values[3] <= 0) {
    throw new Error(`${label} must contain finite x/y and positive width/height.`);
  }
  const [x, y, width, height] = values;
  return { x, y, width, height, normalized: values.map(formatPathNumber).join(" ") };
}

function isArcFlag(value: string): boolean {
  return value === "0" || value === "1";
}

function formatPathNumber(value: number): string {
  return Number(value.toFixed(4)).toString();
}
