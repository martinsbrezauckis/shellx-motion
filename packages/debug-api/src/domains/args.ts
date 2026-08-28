import { isSpringEasing, validateSpringEasing, type MotionEasing, type MotionSpringEasing } from "@shellx-motion/core";

export function objectArg(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/**
 * Read only an own data property. Debug arguments are plain data at the transport boundary, but
 * direct SDK and test callers can still supply accessors. A parser must not execute one merely to
 * decide whether an optional capability flag was requested.
 */
export function ownDataArg(args: unknown, key: string): { value: unknown } | null {
  const record = objectArg(args);
  if (!record) return null;
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor && "value" in descriptor ? { value: descriptor.value } : null;
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
  const entry = ownDataArg(args, key);
  if (!entry) return null;
  const { value } = entry;
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
  const entry = ownDataArg(args, key);
  return entry ? objectArg(entry.value) : null;
}

export function stringArg(args: unknown, key: string): string | null {
  const entry = ownDataArg(args, key);
  if (!entry) return null;
  const { value } = entry;
  return typeof value === "string" ? value : null;
}

export function nonNegativeNumberArg(args: unknown, key: string): number | false | null {
  const entry = ownDataArg(args, key);
  if (!entry) return null;
  const { value } = entry;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : false;
}

export function finiteNumberArg(args: unknown, key: string): number | false | null {
  const entry = ownDataArg(args, key);
  if (!entry) return null;
  const { value } = entry;
  return typeof value === "number" && Number.isFinite(value) ? value : false;
}

export function nonNegativeIntegerArg(args: unknown, key: string): number | false | null {
  const value = nonNegativeNumberArg(args, key);
  return typeof value === "number" && !Number.isInteger(value) ? false : value;
}

export function booleanArg(args: unknown, key: string): boolean | null {
  const entry = ownDataArg(args, key);
  if (!entry) return null;
  const { value } = entry;
  return typeof value === "boolean" ? value : null;
}

export function positiveNumberArg(args: unknown, key: string): number | false | null {
  const entry = ownDataArg(args, key);
  if (!entry) return null;
  const { value } = entry;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : false;
}

export function stringArrayArg(args: unknown, key: string): string[] | null {
  const entry = ownDataArg(args, key);
  if (!entry) return null;
  const { value } = entry;
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? [...value] : null;
}

export function positiveIntegerArg(args: unknown, key: string): number | false | null {
  const entry = ownDataArg(args, key);
  if (!entry) return null;
  const { value } = entry;
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : false;
}

export function scalarRecordArg(args: unknown, key: string): Record<string, string | number | boolean | null> | null {
  const entry = ownDataArg(args, key);
  const value = entry ? objectArg(entry.value) : null;
  if (!value) return null;
  const scalars: Record<string, string | number | boolean | null> = {};
  for (const [entryKey, entry] of Object.entries(value)) {
    if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean" || entry === null) scalars[entryKey] = entry;
  }
  return scalars;
}
