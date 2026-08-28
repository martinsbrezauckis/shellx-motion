/** Strict data-only input reader for the non-mutating v2 render-cache observation. */
import type { AttestedRenderReuseIdentityRequest } from "./attested-render-reuse-identity.js";

export const MAX_RENDER_CACHE_PLAN_PATH_SCALARS = 4_096;
export const MAX_RENDER_CACHE_PLAN_PATH_UTF8_BYTES = 4_096;
export const MAX_RENDER_CACHE_PLAN_AT_MS = Number.MAX_SAFE_INTEGER;
const MAX_RENDER_CACHE_PLAN_TOKEN_SCALARS = 64;
const MAX_RENDER_CACHE_PLAN_TOKEN_UTF8_BYTES = 128;

const FIELDS = new Set([
  "packageRoot", "outputPath", "preset", "frameLane", "atMs", "minUniqueFrameHashes",
  "workflowPath", "qualityManifestPath",
]);

export interface RenderCachePlanInput extends AttestedRenderReuseIdentityRequest {
  preset: string;
  frameLane: "browser" | "native";
}

export type RenderCachePlanInputRead =
  | { ok: true; value: RenderCachePlanInput }
  | { ok: false; message: string };

/**
 * This does not use the ordinary permissive Debug arg helpers. The cache digest must never be
 * derived by invoking caller accessors or accepting an inherited/unknown field the schema hides.
 */
export function readRenderCachePlanInput(args: unknown): RenderCachePlanInputRead {
  const record = ownPlainDataRecord(args);
  if (!record) return invalid();
  const packageRoot = requiredPath(record, "packageRoot");
  const outputPath = requiredPath(record, "outputPath");
  const preset = optionalString(record, "preset", "mp4-h264", MAX_RENDER_CACHE_PLAN_TOKEN_SCALARS, MAX_RENDER_CACHE_PLAN_TOKEN_UTF8_BYTES);
  const frameLane = optionalString(record, "frameLane", "browser", MAX_RENDER_CACHE_PLAN_TOKEN_SCALARS, MAX_RENDER_CACHE_PLAN_TOKEN_UTF8_BYTES);
  const workflowPath = optionalPath(record, "workflowPath");
  const qualityManifestPath = optionalPath(record, "qualityManifestPath");
  const atMs = optionalNonNegativeNumber(record, "atMs");
  const minUniqueFrameHashes = optionalPositiveSafeInteger(record, "minUniqueFrameHashes");
  if (!packageRoot || !outputPath || !preset || !frameLane || (frameLane !== "browser" && frameLane !== "native") || workflowPath === false
    || qualityManifestPath === false || atMs === false || minUniqueFrameHashes === false) return invalid();
  return {
    ok: true,
    value: {
      packageRoot,
      outputPath,
      preset,
      frameLane: frameLane as "browser" | "native",
      ...(workflowPath ? { workflowPath } : {}),
      ...(qualityManifestPath ? { qualityManifestPath } : {}),
      ...(typeof atMs === "number" ? { atMs } : {}),
      ...(typeof minUniqueFrameHashes === "number" ? { minUniqueFrameHashes } : {}),
    },
  };
}

function ownPlainDataRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const record: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !FIELDS.has(key)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
    record[key] = descriptor.value;
  }
  return record;
}

function requiredPath(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return boundedString(value, MAX_RENDER_CACHE_PLAN_PATH_SCALARS, MAX_RENDER_CACHE_PLAN_PATH_UTF8_BYTES);
}

function optionalPath(record: Record<string, unknown>, key: string): string | false | null {
  if (!(key in record) || record[key] === undefined) return null;
  return boundedString(record[key], MAX_RENDER_CACHE_PLAN_PATH_SCALARS, MAX_RENDER_CACHE_PLAN_PATH_UTF8_BYTES) ?? false;
}

function optionalString(record: Record<string, unknown>, key: string, fallback: string, maxScalars: number, maxUtf8Bytes: number): string | null {
  if (!(key in record) || record[key] === undefined) return fallback;
  return boundedString(record[key], maxScalars, maxUtf8Bytes);
}

function optionalNonNegativeNumber(record: Record<string, unknown>, key: string): number | false | null {
  if (!(key in record) || record[key] === undefined) return null;
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_RENDER_CACHE_PLAN_AT_MS ? value : false;
}

function optionalPositiveSafeInteger(record: Record<string, unknown>, key: string): number | false | null {
  if (!(key in record) || record[key] === undefined) return null;
  const value = record[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : false;
}

function boundedString(value: unknown, maxScalars: number, maxUtf8Bytes: number): string | null {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) return null;
  const scalarCount = unicodeScalarLength(value);
  return scalarCount !== null && scalarCount <= maxScalars && Buffer.byteLength(value, "utf8") <= maxUtf8Bytes ? value : null;
}

function unicodeScalarLength(value: string): number | null {
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low < 0xdc00 || low > 0xdfff) return null;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return null;
    }
    count += 1;
  }
  return count;
}

function invalid(): RenderCachePlanInputRead {
  return { ok: false, message: "motion.render.cache.plan requires a bounded data-only request." };
}
