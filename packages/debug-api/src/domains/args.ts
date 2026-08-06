import { isSpringEasing, validateSpringEasing, type MotionEasing, type MotionSpringEasing } from "@shellx-motion/core";

export function objectArg(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/**
 * Read an easing argument that may be a string easing (named / cubic-bezier /
 * steps / spring preset alias) or a data-level spring easing object
 * (`{ type: "spring", stiffness, damping, mass?, initialVelocity? }`).
 *
 * @returns
 *  - `null` when the key is absent,
 *  - `false` when present but malformed (empty string, or an invalid spring),
 *  - the string as-is (support of string forms is left to `isSupportedEasing`), or
 *  - a canonical spring object (fixed key order, unknown keys dropped) so what is
 *    stored in MotionIR and hashed into receipts is stable.
 */
export function easingArg(args: unknown, key: string): MotionEasing | false | null {
  const record = objectArg(args);
  if (!record || !Object.hasOwn(record, key)) return null;
  const value = record[key];
  // Treat a present-but-undefined/null value as absent — CLI arg objects always
  // carry the `easing` key, set to undefined when `--easing` is omitted.
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value.length > 0 ? value : false;
  if (isSpringEasing(value)) {
    if (validateSpringEasing(value) !== null) return false;
    const spring = value as MotionSpringEasing;
    return {
      type: "spring",
      stiffness: spring.stiffness,
      damping: spring.damping,
      ...(spring.mass !== undefined ? { mass: spring.mass } : {}),
      ...(spring.initialVelocity !== undefined ? { initialVelocity: spring.initialVelocity } : {})
    };
  }
  return false;
}

export function recordArg(args: unknown, key: string): Record<string, unknown> | null {
  const record = objectArg(args);
  return record && Object.hasOwn(record, key) ? objectArg(record[key]) : null;
}

export function stringArg(args: unknown, key: string): string | null {
  const record = objectArg(args);
  if (!record || !Object.hasOwn(record, key)) return null;
  return typeof record[key] === "string" ? record[key] : null;
}

export function nonNegativeNumberArg(args: unknown, key: string): number | false | null {
  const record = objectArg(args);
  if (!record || !Object.hasOwn(record, key)) return null;
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : false;
}

export function finiteNumberArg(args: unknown, key: string): number | false | null {
  const record = objectArg(args);
  if (!record || !Object.hasOwn(record, key)) return null;
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : false;
}

export function nonNegativeIntegerArg(args: unknown, key: string): number | false | null {
  const value = nonNegativeNumberArg(args, key);
  return typeof value === "number" && !Number.isInteger(value) ? false : value;
}

export function booleanArg(args: unknown, key: string): boolean | null {
  const record = objectArg(args);
  if (!record || !Object.hasOwn(record, key)) return null;
  return typeof record[key] === "boolean" ? record[key] : null;
}

export function positiveNumberArg(args: unknown, key: string): number | false | null {
  const record = objectArg(args);
  if (!record || !Object.hasOwn(record, key)) return null;
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : false;
}

export function stringArrayArg(args: unknown, key: string): string[] | null {
  const record = objectArg(args);
  if (!record || !Object.hasOwn(record, key)) return null;
  const value = record[key];
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? [...value] : null;
}

export function positiveIntegerArg(args: unknown, key: string): number | false | null {
  const record = objectArg(args);
  if (!record || !Object.hasOwn(record, key)) return null;
  const value = record[key];
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : false;
}

export function scalarRecordArg(args: unknown, key: string): Record<string, string | number | boolean | null> | null {
  const record = objectArg(args);
  if (!record || !Object.hasOwn(record, key)) return null;
  const value = objectArg(record[key]);
  if (!value) return null;
  const scalars: Record<string, string | number | boolean | null> = {};
  for (const [entryKey, entry] of Object.entries(value)) {
    if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean" || entry === null) scalars[entryKey] = entry;
  }
  return scalars;
}
