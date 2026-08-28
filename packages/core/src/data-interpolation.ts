import { compareCodeUnits } from "./canonical-json";
import {
  MAX_MOTION_INTERPOLATED_DOCUMENT_BYTES,
  MAX_MOTION_INTERPOLATED_STRING_BYTES
} from "./data-file-load";
import { assertBoundedMotionInterpolatedString } from "./data-resource-bounds";

/** Interpolate a JSON-shaped value while charging every synthesized string before allocation. */
export function interpolateMotionDataJson(value: unknown, row: Record<string, unknown>, rowId: string, path: string): unknown {
  return interpolateMotionDataJsonWithBudget(value, row, rowId, path, new MotionDataInterpolationBudget(rowId));
}

function interpolateMotionDataJsonWithBudget(
  value: unknown,
  row: Record<string, unknown>,
  rowId: string,
  path: string,
  budget: MotionDataInterpolationBudget
): unknown {
  if (typeof value === "string") return interpolateMotionDataValue(value, row, rowId, path, budget);
  if (Array.isArray(value)) {
    budget.reserveContainer(path);
    const output: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) budget.reserveSeparator(path);
      output.push(interpolateMotionDataJsonWithBudget(value[index], row, rowId, `${path}[${index}]`, budget));
    }
    return output;
  }
  const record = readRecord(value);
  if (!record) {
    budget.reserveRetainedJsonValue(value, path);
    return value;
  }
  budget.reserveContainer(path);
  const output: Record<string, unknown> = {};
  let index = 0;
  for (const key of Object.keys(record)) {
    if (index > 0) budget.reserveSeparator(path);
    budget.reserveObjectKey(key, `${path}.${key}`);
    output[key] = interpolateMotionDataJsonWithBudget(record[key], row, rowId, `${path}.${key}`, budget);
    index += 1;
  }
  return output;
}

export function interpolateMotionDataString(value: string, row: Record<string, unknown>, rowId: string, path: string): string {
  return interpolateMotionDataStringWithBudget(value, row, rowId, path);
}

function interpolateMotionDataStringWithBudget(
  value: string,
  row: Record<string, unknown>,
  rowId: string,
  path: string,
  budget?: MotionDataInterpolationBudget
): string {
  const pattern = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;
  const parts: string[] = [];
  let bytes = 0;
  let cursor = 0;
  const append = (part: string): void => {
    bytes += Buffer.byteLength(part, "utf8");
    if (bytes > MAX_MOTION_INTERPOLATED_STRING_BYTES) {
      throw new Error(`Motion data row ${rowId} interpolation ${path} exceeds the ${MAX_MOTION_INTERPOLATED_STRING_BYTES}-byte string limit.`);
    }
    parts.push(part);
  };
  for (let match = pattern.exec(value); match; match = pattern.exec(value)) {
    append(value.slice(cursor, match.index));
    const replacement = readRowValue(row, match[1]);
    if (replacement !== undefined && replacement !== null) {
      const text = typeof replacement === "string" ? replacement : JSON.stringify(replacement);
      if (typeof text === "string") append(text);
    }
    cursor = match.index + match[0].length;
  }
  append(value.slice(cursor));
  const output = parts.join("");
  assertBoundedMotionInterpolatedString(output, rowId, path);
  // A synthesized string is independently capped at 64 KiB, so joining it cannot
  // recreate aggregate amplification. Charge its exact JSON representation before
  // the caller retains it in the surrounding document. Measuring the completed
  // string also avoids falsely overcharging surrogate pairs split by a token.
  budget?.reserveRetainedJsonValue(output, path);
  return output;
}

function interpolateMotionDataValue(
  value: string,
  row: Record<string, unknown>,
  rowId: string,
  path: string,
  budget: MotionDataInterpolationBudget
): unknown {
  const wholeToken = /^\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}$/.exec(value);
  if (!wholeToken) return interpolateMotionDataStringWithBudget(value, row, rowId, path, budget);
  const replacement = readRowValue(row, wholeToken[1]);
  if (replacement === undefined || replacement === null) {
    budget.reserveRetainedJsonValue("", path);
    return "";
  }
  if (typeof replacement === "string") assertBoundedMotionInterpolatedString(replacement, rowId, path);
  budget.reserveRetainedJsonValue(replacement, path);
  return replacement;
}

class MotionDataInterpolationBudget {
  private bytes = 0;

  constructor(private readonly rowId: string) {}

  reserveContainer(path: string): void { this.reserve(2, path); }
  reserveSeparator(path: string): void { this.reserve(1, path); }

  reserveObjectKey(key: string, path: string): void {
    this.reserve(Buffer.byteLength(JSON.stringify(key), "utf8") + 1, path);
  }

  reserveRetainedJsonValue(value: unknown, path: string): void {
    if (typeof value === "string") {
      this.reserve(Buffer.byteLength(JSON.stringify(value), "utf8"), path);
      return;
    }
    if (value === null) return this.reserve(4, path);
    if (typeof value === "boolean") return this.reserve(value ? 4 : 5, path);
    if (typeof value === "number") {
      return this.reserve(Buffer.byteLength(Number.isFinite(value) ? JSON.stringify(value) : "null", "utf8"), path);
    }
    if (value === undefined || typeof value === "function" || typeof value === "symbol") {
      return this.reserve(4, path);
    }
    if (typeof value === "bigint") throw new Error(`Motion data row ${this.rowId} interpolation ${path} contains a bigint and cannot be serialized.`);
    if (Array.isArray(value)) {
      this.reserveContainer(path);
      for (let index = 0; index < value.length; index += 1) {
        if (index > 0) this.reserveSeparator(path);
        this.reserveRetainedJsonValue(value[index], `${path}[${index}]`);
      }
      return;
    }
    const record = readRecord(value);
    if (!record) throw new Error(`Motion data row ${this.rowId} interpolation ${path} contains an unsupported value.`);
    this.reserveContainer(path);
    let index = 0;
    for (const key of Object.keys(record)) {
      const child = record[key];
      if (child === undefined || typeof child === "function" || typeof child === "symbol") continue;
      if (index > 0) this.reserveSeparator(path);
      this.reserveObjectKey(key, `${path}.${key}`);
      this.reserveRetainedJsonValue(child, `${path}.${key}`);
      index += 1;
    }
  }

  private reserve(bytes: number, path: string): void {
    if (this.bytes + bytes > MAX_MOTION_INTERPOLATED_DOCUMENT_BYTES) {
      throw new Error(`Motion data row ${this.rowId} interpolated document exceeds the ${MAX_MOTION_INTERPOLATED_DOCUMENT_BYTES}-byte limit before serialization or expansion allocation at ${path}.`);
    }
    this.bytes += bytes;
  }
}

function readRowValue(row: Record<string, unknown>, key: string): unknown {
  if (Object.prototype.hasOwnProperty.call(row, key)) return resolveLocalizedRowValue(row, key, row[key]);
  let current: unknown = row;
  for (const segment of key.split(".")) {
    const record = readRecord(current);
    if (!record || !Object.prototype.hasOwnProperty.call(record, segment)) return readFlatLocalizedRowValue(row, key);
    current = record[segment];
  }
  return resolveLocalizedRowValue(row, key, current);
}

function resolveLocalizedRowValue(row: Record<string, unknown>, key: string, value: unknown): unknown {
  if (!key.startsWith("strings.")) return value;
  const record = readRecord(value);
  return record ? selectLocalizedValue(row, record) ?? value : value;
}

function readFlatLocalizedRowValue(row: Record<string, unknown>, key: string): unknown {
  if (!key.startsWith("strings.")) return undefined;
  const locale = readRowLocale(row);
  for (const suffix of localizedSuffixes(locale)) {
    const flatKey = `${key}.${suffix}`;
    if (Object.prototype.hasOwnProperty.call(row, flatKey)) return row[flatKey];
  }
  const prefix = `${key}.`;
  const fallbackKey = Object.keys(row).filter((candidate) => candidate.startsWith(prefix) && typeof row[candidate] === "string").sort(compareCodeUnits)[0];
  return fallbackKey ? row[fallbackKey] : undefined;
}

function selectLocalizedValue(row: Record<string, unknown>, values: Record<string, unknown>): unknown {
  for (const suffix of localizedSuffixes(readRowLocale(row))) {
    if (Object.prototype.hasOwnProperty.call(values, suffix)) return values[suffix];
  }
  const fallbackKey = Object.keys(values).filter((candidate) => typeof values[candidate] === "string").sort(compareCodeUnits)[0];
  return fallbackKey ? values[fallbackKey] : undefined;
}

function localizedSuffixes(locale: string | undefined): string[] { return locale ? [locale, "default", "en"] : ["default", "en"]; }

function readRowLocale(row: Record<string, unknown>): string | undefined {
  const locale = row.locale;
  return typeof locale === "string" && locale.trim() ? locale.trim() : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
