/** SDK admission and response validation for the compact path-free render-cache plan. */
import { canonicalJson } from "./cache.js";
import type { MotionSdkRenderCachePlanRequest, MotionSdkRenderCachePlanResponse } from "./render-cache-plan-types.js";

const INPUT_FIELDS = new Set([
  "packageRoot", "outputPath", "preset", "frameLane", "atMs", "minUniqueFrameHashes", "workflowPath", "qualityManifestPath",
]);
const SHA256 = /^[a-f0-9]{64}$/;
const CHECKED = new Set(["static_admission", "identity_inputs", "output_root", "entry_presence", "attestation"]);
const MISS_ONLY_CHECKS = [
  "output_root_materialization", "exclusive_fill_lock", "producer_and_tool_readiness", "script_provenance_resolution",
  "quality_execution", "receipt_artifact_descriptor_publication", "post_render_input_recheck",
];
const HIT_REASONS = new Set(["verified_attested_entry"]);
const MISS_REASONS = new Set(["entry_absent", "output_root_unmaterialized"]);
const REFUSED_REASONS = new Set([
  "unsupported_request", "static_admission_refused", "untrusted_external_input", "input_fingerprint_unavailable",
  "unsafe_output_root", "output_exists_without_entry", "descriptor_or_artifact_unverified", "fill_busy",
]);

export function renderCachePlanRequestError(value: Record<string, unknown>): string {
  const record = ownDataRecord(value);
  if (!record || Object.keys(record).some((key) => !INPUT_FIELDS.has(key))) return "SDK renderCachePlan contains an unsupported field.";
  for (const key of ["packageRoot", "outputPath", "preset"] as const) {
    if (!boundedString(record[key], key === "preset" ? 64 : 4_096, key === "preset" ? 128 : 4_096)) {
      return `SDK renderCachePlan requires bounded ${key}.`;
    }
  }
  for (const key of ["workflowPath", "qualityManifestPath"] as const) {
    if (record[key] !== undefined && !boundedString(record[key], 4_096, 4_096)) return `SDK renderCachePlan ${key} must be bounded.`;
  }
  if (record.frameLane !== undefined && record.frameLane !== "browser" && record.frameLane !== "native") return "SDK renderCachePlan frameLane must be browser or native; GPU post-render identity is evidence only and never authorizes cache planning or reuse.";
  if (record.atMs !== undefined && (!Number.isFinite(record.atMs) || Number(record.atMs) < 0 || Number(record.atMs) > Number.MAX_SAFE_INTEGER)) return "SDK renderCachePlan atMs must be a non-negative safe timestamp.";
  if (record.minUniqueFrameHashes !== undefined && (!Number.isSafeInteger(record.minUniqueFrameHashes) || Number(record.minUniqueFrameHashes) < 1)) {
    return "SDK renderCachePlan minUniqueFrameHashes must be a positive safe integer.";
  }
  return "";
}

/** Reject any output field that could turn a path-free observation into a path disclosure. */
export function validRenderCachePlanOutput(value: unknown): value is MotionSdkRenderCachePlanResponse {
  const record = plainRecord(value);
  if (!record || !exactFields(record, ["schema", "observedAt", "authorization", "decision", "checked", "missOnlyChecks", "warnings"], ["identity", "source"])) return false;
  if (record.schema !== "shellx-motion/render-cache-plan@1" || record.authorization !== "none" || !iso(record.observedAt)
    || !checked(record.checked) || !sameStrings(record.missOnlyChecks, MISS_ONLY_CHECKS) || !Array.isArray(record.warnings) || record.warnings.length !== 0) return false;
  const decision = plainRecord(record.decision);
  if (!decision || !exactFields(decision, ["kind", "reason"]) || !validDecision(decision)) return false;
  if (record.identity !== undefined && !validIdentity(record.identity)) return false;
  if (record.source !== undefined && !validSource(record.source)) return false;
  return (decision.kind === "hit") === (record.source !== undefined) && withinResponseBudget(record);
}

function validIdentity(value: unknown): boolean {
  const record = plainRecord(value);
  return Boolean(record && exactFields(record, ["digest", "inputCategories"]) && typeof record.digest === "string" && SHA256.test(record.digest)
    && Array.isArray(record.inputCategories) && record.inputCategories.length >= 2 && record.inputCategories.length <= 4
    && record.inputCategories.every((entry) => ["package_bytes", "resolved_render_plan", "workflow_file_bytes", "quality_manifest_and_baselines"].includes(entry)));
}

function validSource(value: unknown): boolean {
  const record = plainRecord(value);
  const receipt = record ? plainRecord(record.receipt) : null;
  const artifact = record ? plainRecord(record.artifact) : null;
  return Boolean(record && exactFields(record, ["descriptorId", "receipt", "artifact"])
    && typeof record.descriptorId === "string" && /^render-reuse-[a-f0-9]{24}$/.test(record.descriptorId)
    && receipt && exactFields(receipt, ["role", "status", "sha256"]) && receipt.role === "render"
    && (receipt.status === "passed" || receipt.status === "warning") && typeof receipt.sha256 === "string" && SHA256.test(receipt.sha256)
    && artifact && exactFields(artifact, ["sha256"]) && typeof artifact.sha256 === "string" && SHA256.test(artifact.sha256));
}

function validDecision(value: Record<string, unknown>): boolean {
  return typeof value.reason === "string" && (
    value.kind === "hit" && HIT_REASONS.has(value.reason)
    || value.kind === "miss" && MISS_REASONS.has(value.reason)
    || value.kind === "refused" && REFUSED_REASONS.has(value.reason)
  );
}

function exactFields(record: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(record, key)) && Object.keys(record).every((key) => allowed.has(key));
}

function boundedString(value: unknown, maxScalars: number, maxUtf8Bytes: number): value is string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) return false;
  const scalars = scalarLength(value);
  return scalars !== null && scalars <= maxScalars && new TextEncoder().encode(value).byteLength <= maxUtf8Bytes;
}

function scalarLength(value: string): number | null {
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low < 0xdc00 || low > 0xdfff) return null;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return null;
    count += 1;
  }
  return count;
}

function iso(value: unknown): boolean { return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value)); }
function checked(value: unknown): value is string[] { return Array.isArray(value) && value.length <= 5 && value.every((entry) => typeof entry === "string" && CHECKED.has(entry)); }
function sameStrings(value: unknown, expected: string[]): boolean { return Array.isArray(value) && value.length === expected.length && value.every((entry, index) => entry === expected[index]); }
function plainRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null || Object.getOwnPropertySymbols(value).length) return null;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => "value" in descriptor && descriptor.enumerable)
    ? value as Record<string, unknown>
    : null;
}

function ownDataRecord(value: Record<string, unknown>): Record<string, unknown> | null {
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null || Object.getOwnPropertySymbols(value).length) return null;
  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
    result[key] = descriptor.value;
  }
  return result;
}

function withinResponseBudget(value: Record<string, unknown>): boolean {
  try {
    return new TextEncoder().encode(canonicalJson(value)).byteLength <= 4_096;
  } catch {
    return false;
  }
}

export function renderCachePlanDebugArgs(input: MotionSdkRenderCachePlanRequest): Record<string, unknown> {
  return {
    packageRoot: input.packageRoot,
    outputPath: input.outputPath,
    preset: input.preset,
    ...(input.frameLane ? { frameLane: input.frameLane } : {}),
    ...(input.atMs !== undefined ? { atMs: input.atMs } : {}),
    ...(input.minUniqueFrameHashes !== undefined ? { minUniqueFrameHashes: input.minUniqueFrameHashes } : {}),
    ...(input.workflowPath ? { workflowPath: input.workflowPath } : {}),
    ...(input.qualityManifestPath ? { qualityManifestPath: input.qualityManifestPath } : {}),
  };
}
