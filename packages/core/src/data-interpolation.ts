import { compareCodeUnits } from "./canonical-json";
import { MAX_MOTION_INTERPOLATED_STRING_BYTES } from "./data-file-load";
import { assertBoundedMotionInterpolatedString } from "./data-resource-bounds";

/** Interpolate a JSON-shaped value while charging every synthesized string before allocation. */
export function interpolateMotionDataJson(value: unknown, row: Record<string, unknown>, rowId: string, path: string): unknown {
  if (typeof value === "string") return interpolateMotionDataValue(value, row, rowId, path);
  if (Array.isArray(value)) return value.map((entry, index) => interpolateMotionDataJson(entry, row, rowId, `${path}[${index}]`));
  const record = readRecord(value);
  return record ? Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, interpolateMotionDataJson(entry, row, rowId, `${path}.${key}`)])) : value;
}

export function interpolateMotionDataString(value: string, row: Record<string, unknown>, rowId: string, path: string): string {
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
  return output;
}

function interpolateMotionDataValue(value: string, row: Record<string, unknown>, rowId: string, path: string): unknown {
  const wholeToken = /^\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}$/.exec(value);
  if (!wholeToken) return interpolateMotionDataString(value, row, rowId, path);
  const replacement = readRowValue(row, wholeToken[1]);
  if (replacement === undefined || replacement === null) return "";
  if (typeof replacement === "string") assertBoundedMotionInterpolatedString(replacement, rowId, path);
  return replacement;
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
  return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : null;
}
