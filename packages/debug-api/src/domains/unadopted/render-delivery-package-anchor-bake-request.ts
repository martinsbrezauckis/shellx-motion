/** Descriptor-first private input reader shared by B2 planning and B3 materialization. */

import { MAX_RENDER_DELIVERY_ANCHOR_COORDINATE_Q1024 } from "@shellx-motion/core/internal/render-delivery-source";

export const MOTION_RENDER_DELIVERY_ANCHOR_KEYFRAME_INTENT_REQUEST_SCHEMA = "shellx-motion/render-delivery-anchor-keyframe-intent-request/v1" as const;
const SHA256 = /^[a-f0-9]{64}$/;

export interface RenderDeliveryAnchorKeyframeIntentRequest {
  readonly schema: typeof MOTION_RENDER_DELIVERY_ANCHOR_KEYFRAME_INTENT_REQUEST_SCHEMA;
  readonly inspectionFingerprint: string;
  readonly receiptFingerprint: string;
  readonly mappings: readonly RenderDeliveryAnchorKeyframeIntentMapping[];
}

export interface RenderDeliveryAnchorKeyframeIntentMapping {
  readonly anchorId: number;
  readonly targetLayerId: string;
  /** Local target point from the layer top-left; planned top-left is provider screen anchor minus this offset. */
  readonly localTargetAnchorOffsetQ1024: { readonly xQ1024: number; readonly yQ1024: number };
}

/**
 * Rejects oversize arrays before enumerating array keys or reading an element. The returned value
 * is plain detached data and never serves as package, plan, or execution authority.
 */
export function readRenderDeliveryAnchorKeyframeIntentRequest(value: unknown): RenderDeliveryAnchorKeyframeIntentRequest {
  const root = dataObject(value, "Provider-anchor keyframe request");
  const mappingsDescriptor = dataDescriptor(root, "mappings", "Provider-anchor keyframe request");
  const mappingsValue = mappingsDescriptor.value;
  if (!Array.isArray(mappingsValue) || Object.getPrototypeOf(mappingsValue) !== Array.prototype) {
    throw new Error("Provider-anchor keyframe request mappings must be a plain array.");
  }
  const length = dataDescriptor(mappingsValue, "length", "Provider-anchor keyframe mappings", false).value;
  if (!Number.isSafeInteger(length) || length < 1 || length > 16) {
    throw new Error("Provider-anchor keyframe request requires 1..16 mappings.");
  }
  exactKeys(root, ["schema", "inspectionFingerprint", "receiptFingerprint", "mappings"], "Provider-anchor keyframe request");
  const schema = dataDescriptor(root, "schema", "Provider-anchor keyframe request").value;
  const inspectionFingerprint = dataDescriptor(root, "inspectionFingerprint", "Provider-anchor keyframe request").value;
  const receiptFingerprint = dataDescriptor(root, "receiptFingerprint", "Provider-anchor keyframe request").value;
  if (schema !== MOTION_RENDER_DELIVERY_ANCHOR_KEYFRAME_INTENT_REQUEST_SCHEMA || !hash(inspectionFingerprint) || !hash(receiptFingerprint)) {
    throw new Error("Provider-anchor keyframe request has an invalid schema or fingerprint.");
  }
  exactDenseArray(mappingsValue, length, "Provider-anchor keyframe mappings");
  const mappings = Array.from({ length }, (_item, index) => readMapping(dataDescriptor(mappingsValue, String(index), "Provider-anchor keyframe mappings").value, index));
  for (let index = 1; index < mappings.length; index += 1) if (mappings[index - 1]!.anchorId >= mappings[index]!.anchorId) {
    throw new Error("Provider-anchor keyframe mappings must be strict ascending unique numeric anchor IDs.");
  }
  if (new Set(mappings.map((mapping) => mapping.targetLayerId)).size !== mappings.length) throw new Error("Provider-anchor keyframe mappings cannot reuse a target layer.");
  return { schema: MOTION_RENDER_DELIVERY_ANCHOR_KEYFRAME_INTENT_REQUEST_SCHEMA, inspectionFingerprint, receiptFingerprint, mappings };
}

function readMapping(value: unknown, index: number): RenderDeliveryAnchorKeyframeIntentMapping {
  const label = `Provider-anchor mapping ${index}`, record = dataObject(value, label);
  exactKeys(record, ["anchorId", "targetLayerId", "localTargetAnchorOffsetQ1024"], label);
  const anchorId = dataDescriptor(record, "anchorId", label).value;
  const targetLayerId = dataDescriptor(record, "targetLayerId", label).value;
  if (typeof anchorId !== "number" || !Number.isSafeInteger(anchorId) || anchorId <= 0 || typeof targetLayerId !== "string" || targetLayerId.length === 0 || targetLayerId.length > 64) {
    throw new Error(`Provider-anchor mapping ${index} has an invalid anchor or target ID.`);
  }
  const offsetLabel = `Provider-anchor mapping ${index} local target anchor`;
  const offset = dataObject(dataDescriptor(record, "localTargetAnchorOffsetQ1024", label).value, offsetLabel);
  exactKeys(offset, ["xQ1024", "yQ1024"], offsetLabel);
  const xQ1024 = dataDescriptor(offset, "xQ1024", offsetLabel).value;
  const yQ1024 = dataDescriptor(offset, "yQ1024", offsetLabel).value;
  if (typeof xQ1024 !== "number" || typeof yQ1024 !== "number") {
    throw new Error(`Provider-anchor mapping ${index} local target anchor coordinates must be numbers.`);
  }
  for (const [axis, coordinate] of [["xQ1024", xQ1024], ["yQ1024", yQ1024]] as const) if (!Number.isSafeInteger(coordinate) || Math.abs(coordinate) > MAX_RENDER_DELIVERY_ANCHOR_COORDINATE_Q1024) {
    throw new Error(`Provider-anchor mapping ${index} local target anchor ${axis} is outside the admitted Q1024 range.`);
  }
  return { anchorId, targetLayerId, localTargetAnchorOffsetQ1024: { xQ1024, yQ1024 } };
}

function dataObject(value: unknown, label: string): object {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`${label} must be a plain object.`);
  return value;
}
function dataDescriptor(value: object, key: string, label: string, requireEnumerable = true): PropertyDescriptor & { value: unknown } {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor) || (requireEnumerable && !descriptor.enumerable)) throw new Error(`${label}.${key} must be an enumerable data field.`);
  return descriptor as PropertyDescriptor & { value: unknown };
}
function exactKeys(value: object, required: readonly string[], label: string): void {
  const keys = Reflect.ownKeys(value);
  if (keys.length !== required.length || keys.some((key) => typeof key !== "string" || !required.includes(key)) || required.some((key) => !keys.includes(key))) {
    throw new Error(`${label} has an unsupported field.`);
  }
}
function exactDenseArray(value: unknown[], length: number, label: string): void {
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1 || !keys.includes("length") || keys.some((key) => key !== "length" && (typeof key !== "string" || !/^\d+$/.test(key))) || Array.from({ length }, (_item, index) => !keys.includes(String(index))).some(Boolean)) {
    throw new Error(`${label} must be dense with no extension fields.`);
  }
}
function hash(value: unknown): value is string { return typeof value === "string" && SHA256.test(value); }
