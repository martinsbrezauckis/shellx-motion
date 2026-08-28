import { canonicalJsonSha256, compareCodeUnits } from "@shellx-motion/core";
import {
  MAX_CREATIVE_ASSETS,
  MAX_CREATIVE_CONTRACT_BYTES,
  MAX_CREATIVE_CONTRACT_DEPTH,
  MAX_CREATIVE_CONTRACT_NODES,
  MAX_CREATIVE_RECORD_FIELDS,
  type AssetRecord,
  type CreativeActor,
  type CreativeAssetAvailability,
  type CreativeAssetBinding,
  type CreativeAssetKind,
  type CreativeAssetOriginKind,
  type CreativeAssetRightsStatus,
  type CreativeCompileIssue,
  type CreativeIdentity,
  type CreativeRunStatus,
  type CreativeFindingSeverity,
  type CreativeReviewOutcome,
  type ShotAssetSlot,
} from "./creative-contract-types";

const ID_HEX_LENGTH = 32;
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,127}$/;

/** Descriptor-first bounded snapshot. Semantic readers receive only this owned data copy. */
export function snapshotCreativeContractData(value: unknown): unknown {
  return snapshot(value, { active: new WeakSet<object>(), nodes: 0, keys: 0, bytes: 0 }, 0);
}

function snapshot(value: unknown, state: { active: WeakSet<object>; nodes: number; keys: number; bytes: number }, depth: number): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    state.bytes += Buffer.byteLength(value, "utf8");
    if (state.bytes > MAX_CREATIVE_CONTRACT_BYTES) throw new Error(`Creative contracts exceed the ${MAX_CREATIVE_CONTRACT_BYTES}-byte limit.`);
    return value;
  }
  if (typeof value !== "object") throw new Error("Creative contracts must contain only JSON data.");
  if (depth > MAX_CREATIVE_CONTRACT_DEPTH) throw new Error(`Creative contracts exceed the ${MAX_CREATIVE_CONTRACT_DEPTH}-level nesting limit.`);
  if (state.active.has(value)) throw new Error("Creative contracts must not contain cycles.");
  let array: boolean, keys: readonly PropertyKey[];
  try { array = Array.isArray(value); keys = Reflect.ownKeys(value); } catch { throw new Error("Creative contract data reflection failed."); }
  const keyLimit = array ? MAX_CREATIVE_ASSETS + 1 : MAX_CREATIVE_RECORD_FIELDS;
  if (keys.length > keyLimit) throw new Error(`Creative contract data exceeds the ${keyLimit}-field ${array ? "array" : "record"} limit.`);
  if (state.keys + keys.length > MAX_CREATIVE_CONTRACT_NODES * MAX_CREATIVE_RECORD_FIELDS) throw new Error("Creative contract data exceeds its aggregate field limit.");
  let prototype: object | null;
  try { prototype = Object.getPrototypeOf(value); } catch { throw new Error("Creative contract data reflection failed."); }
  if (prototype !== (array ? Array.prototype : Object.prototype) && prototype !== null) throw new Error("Creative contracts must contain only plain data objects and arrays.");
  if (keys.some((key) => typeof key !== "string")) throw new Error("Creative contracts must not contain symbol fields.");
  if (state.nodes >= MAX_CREATIVE_CONTRACT_NODES) throw new Error(`Creative contracts exceed the ${MAX_CREATIVE_CONTRACT_NODES}-node limit.`);
  state.active.add(value); state.nodes += 1; state.keys += keys.length;
  try { return array ? snapshotArray(value, keys, state, depth) : snapshotRecord(value, keys, state, depth); }
  finally { state.active.delete(value); }
}

function snapshotRecord(value: object, keys: readonly PropertyKey[], state: Parameters<typeof snapshot>[1], depth: number): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptorOf(value, key);
    if (!("value" in descriptor) || !descriptor.enumerable) throw new Error(`Creative contract data.${String(key)} must be an enumerable data field.`);
    Object.defineProperty(result, key, { value: snapshot(descriptor.value, state, depth + 1), enumerable: true, configurable: true, writable: true });
  }
  return result;
}

function snapshotArray(value: object, keys: readonly PropertyKey[], state: Parameters<typeof snapshot>[1], depth: number): unknown[] {
  const length = descriptorOf(value, "length");
  if (!("value" in length) || length.enumerable || !Number.isSafeInteger(length.value) || length.value < 0 || length.value > MAX_CREATIVE_ASSETS || keys.length !== length.value + 1 || !keys.includes("length")) throw new Error(`Creative contract arrays must be dense and contain at most ${MAX_CREATIVE_ASSETS} entries.`);
  const result: unknown[] = [];
  for (let index = 0; index < length.value; index += 1) {
    const key = String(index); if (!keys.includes(key)) throw new Error("Creative contract arrays must be dense and contain no extension fields.");
    const descriptor = descriptorOf(value, key);
    if (!("value" in descriptor) || !descriptor.enumerable) throw new Error(`Creative contract data.${key} must be an enumerable data field.`);
    Object.defineProperty(result, index, { value: snapshot(descriptor.value, state, depth + 1), enumerable: true, configurable: true, writable: true });
  }
  return result;
}

function descriptorOf(value: object, key: PropertyKey): PropertyDescriptor {
  try { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor) throw new Error("missing"); return descriptor; }
  catch { throw new Error("Creative contract data reflection failed."); }
}

export function exactRecord(value: unknown, required: readonly string[], optional: readonly string[], label: string): Record<string, unknown> {
  const record = plainRecord(value, label), allowed = new Set([...required, ...optional]);
  const unexpected = Object.keys(record).find((key) => !allowed.has(key));
  if (unexpected) throw new Error(`${label} has unknown field '${unexpected}'.`);
  const missing = required.find((key) => !Object.hasOwn(record, key));
  if (missing) throw new Error(`${label} requires ${missing}.`);
  return record;
}

export function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a plain object.`);
  return value as Record<string, unknown>;
}

export function exactArray(value: unknown, label: string, maximum: number, minimum: number): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) throw new Error(`${label} must contain ${minimum}..${maximum} entries.`);
  return value;
}

export function readIdentity(value: unknown, label: string, prefix: string): CreativeIdentity {
  const record = exactRecord(value, ["id", "sha256"], [], label);
  const hash = sha256(record.sha256, `${label}.sha256`), id = boundedString(record.id, `${label}.id`, 80);
  if (!new RegExp(`^${prefix}_[a-f0-9]{${ID_HEX_LENGTH}}$`).test(id)) throw new Error(`${label}.id must be a canonical ${prefix} id.`);
  return freeze({ id, sha256: hash });
}

export function readActor(value: unknown, label: string): CreativeActor {
  const record = exactRecord(value, ["kind", "id"], [], label);
  if (record.kind !== "human" && record.kind !== "ai" && record.kind !== "policy") throw new Error(`${label}.kind must be human, ai, or policy.`);
  return freeze({ kind: record.kind, id: safeId(record.id, `${label}.id`) });
}

export function boundedString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0 || value.length > maximum) throw new Error(`${label} must be a trimmed non-empty string of at most ${maximum} characters.`);
  return value;
}
export function safeId(value: unknown, label: string): string {
  const id = boundedString(value, label, 64);
  if (!SAFE_ID.test(id)) throw new Error(`${label} must be a safe 1..64 character id.`);
  return id;
}
export function assetId(value: unknown, label: string): string {
  const id = boundedString(value, label, 80);
  if (!/^asset_[a-f0-9]{32}$/.test(id)) throw new Error(`${label} must be a canonical asset id.`);
  return id;
}
export function sha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${label} must be a lowercase sha256 hash.`);
  return value;
}
export function mediaType(value: unknown, label: string): string {
  const result = boundedString(value, label, 160);
  if (!MIME.test(result)) throw new Error(`${label} must be a lowercase media type.`);
  return result;
}
export function isoTime(value: unknown, label: string): string {
  const result = boundedString(value, label, 40), parsed = Date.parse(result);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== result) throw new Error(`${label} must be a canonical ISO-8601 UTC timestamp.`);
  return result;
}
export function positiveInteger(value: unknown, label: string, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`${label} must be a safe integer in 1..${maximum}.`);
  return value;
}
export function safeUs(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer microsecond.`);
  return value;
}
export function unit(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${label} must be a finite number in [0,1].`);
  return Object.is(value, -0) ? 0 : value;
}
export function stringArray(value: unknown, label: string, minimum: number, maximum: number, itemMax: number, unique = false): readonly string[] {
  const entries = exactArray(value, label, maximum, minimum).map((entry, index) => boundedString(entry, `${label}[${index}]`, itemMax));
  if (unique && new Set(entries).size !== entries.length) throw new Error(`${label} must not repeat values.`);
  return freeze(entries);
}
export function sortedSafeIds(value: unknown, label: string, maximum: number): readonly string[] {
  const entries = exactArray(value, label, maximum, 0).map((entry, index) => safeId(entry, `${label}[${index}]`));
  if (!strictlySorted(entries)) throw new Error(`${label} must be strict code-unit ascending and unique.`);
  return freeze(entries);
}
export function sortedAssetIds(value: unknown, label: string, maximum: number): readonly string[] {
  const entries = exactArray(value, label, maximum, 0).map((entry, index) => assetId(entry, `${label}[${index}]`));
  if (!strictlySorted(entries)) throw new Error(`${label} must be strict code-unit ascending and unique.`);
  return freeze(entries);
}
export function sortedOrigins(value: unknown, label: string): readonly CreativeAssetOriginKind[] {
  const entries = exactArray(value, label, 4, 1).map((entry, index) => assetOrigin(entry, `${label}[${index}]`));
  if (!strictlySorted(entries)) throw new Error(`${label} must be strict code-unit ascending and unique.`);
  return freeze(entries);
}
export function assetKind(value: unknown, label: string): CreativeAssetKind {
  if (value !== "image" && value !== "video" && value !== "audio" && value !== "font" && value !== "vector" && value !== "data") throw new Error(`${label} must be image, video, audio, font, vector, or data.`);
  return value;
}
export function assetOrigin(value: unknown, label: string): CreativeAssetOriginKind {
  if (value !== "user-provided" && value !== "generated" && value !== "licensed" && value !== "package-local") throw new Error(`${label} must be user-provided, generated, licensed, or package-local.`);
  return value;
}
export function assetRights(value: unknown, label: string): CreativeAssetRightsStatus {
  if (value !== "asserted" && value !== "cleared" && value !== "restricted" && value !== "unknown") throw new Error(`${label} must be asserted, cleared, restricted, or unknown.`);
  return value;
}
export function assetAvailability(value: unknown, label: string): CreativeAssetAvailability {
  if (value !== "available" && value !== "revoked") throw new Error(`${label} must be available or revoked.`);
  return value;
}
export function creativeRunStatus(value: unknown, label: string): CreativeRunStatus {
  if (value !== "planned" && value !== "revision_required" && value !== "accepted" && value !== "rejected" && value !== "cancelled") throw new Error(`${label} must be planned, revision_required, accepted, rejected, or cancelled.`);
  return value;
}
export function reviewOutcome(value: unknown, label: string): CreativeReviewOutcome {
  if (value !== "accepted" && value !== "changes_requested" && value !== "rejected") throw new Error(`${label} must be accepted, changes_requested, or rejected.`);
  return value;
}
export function findingSeverity(value: unknown, label: string): CreativeFindingSeverity {
  if (value !== "info" && value !== "warning" && value !== "error") throw new Error(`${label} must be info, warning, or error.`);
  return value;
}
export function rightsSatisfy(minimum: ShotAssetSlot["minimumRights"], status: CreativeAssetRightsStatus): boolean {
  return minimum === "cleared" ? status === "cleared" : status === "asserted" || status === "cleared";
}
export function strictlySorted(values: readonly string[]): boolean { return values.every((value, index) => index === 0 || compareCodeUnits(values[index - 1]!, value) < 0); }
export function slotKey(shotId: string, slotId: string): string { return `${shotId}\u0000${slotId}`; }
export function bindingKey(binding: CreativeAssetBinding): string { return slotKey(binding.shotId, binding.slotId); }
export function issue(path: string, code: string, message: string): CreativeCompileIssue { return freeze({ path, code, message }); }
export function identity(value: Pick<CreativeIdentity, "id" | "sha256">): CreativeIdentity { return freeze({ id: value.id, sha256: value.sha256 }); }
export function sameIdentity(left: CreativeIdentity, right: CreativeIdentity): boolean { return left.id === right.id && left.sha256 === right.sha256; }
export function sealRecord(prefix: string, payload: Record<string, unknown>): unknown {
  const hash = canonicalJsonSha256(payload);
  return freeze({ ...payload, id: `${prefix}_${hash.slice(0, ID_HEX_LENGTH)}`, sha256: hash });
}
export function verifySealedRecord(prefix: string, value: Record<string, unknown>, payload: Record<string, unknown>): unknown {
  const sealed = sealRecord(prefix, payload) as CreativeIdentity;
  if (value.id !== sealed.id || value.sha256 !== sealed.sha256) throw new Error(`${prefix} canonical id or sha256 is stale.`);
  return sealed;
}
export function sealAssetRecord(payload: Omit<AssetRecord, "id" | "sha256">): AssetRecord {
  const hash = canonicalJsonSha256(payload), id = `asset_${payload.contentSha256.slice(0, ID_HEX_LENGTH)}`;
  return freeze({ ...payload, id, sha256: hash }) as AssetRecord;
}
export function freeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value as Record<string, unknown>)) freeze(entry);
  return Object.freeze(value);
}
