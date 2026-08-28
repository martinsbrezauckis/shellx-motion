/** Closed raw-data parser for C5B1 provider anchor payloads. No renderer, inspect, or bake route imports it. */

import { canonicalJson } from "../../canonical-json";
import { renderDeliveryAnchorDeliveryBindingSha256 } from "./render-delivery-identity";
import {
  MAX_RENDER_DELIVERY_ANCHORS,
  MAX_RENDER_DELIVERY_ANCHOR_COORDINATE_Q1024,
  MAX_RENDER_DELIVERY_ANCHOR_ID,
  MAX_RENDER_DELIVERY_ANCHOR_SAMPLES,
  MOTION_RENDER_DELIVERY_ANCHOR_CONVENTION,
  MOTION_RENDER_DELIVERY_ANCHOR_PAYLOAD_SCHEMA,
  type MotionRenderDelivery,
  type MotionRenderDeliveryAnchorPayload,
  type RenderDeliveryAnchorSample,
  type RenderDeliveryAnchorTrack,
} from "./render-delivery-types";

const SHA256 = /^[a-f0-9]{64}$/;

/** A raw provider file is accepted only in canonical UTF-8 JSON form so bytes, parse, and SHA agree. */
export function parseMotionRenderDeliveryAnchorPayload(
  bytes: Buffer,
  delivery: MotionRenderDelivery,
): MotionRenderDeliveryAnchorPayload {
  if (bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) fail();
  let text: string;
  let value: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (text.length === 0) fail();
    value = JSON.parse(text) as unknown;
  } catch { fail(); }
  const root = record(value, ["schema", "deliveryBindingSha256", "coordinateConvention", "anchors"]);
  literal(root.schema, MOTION_RENDER_DELIVERY_ANCHOR_PAYLOAD_SCHEMA);
  hash(root.deliveryBindingSha256);
  if (root.deliveryBindingSha256 !== renderDeliveryAnchorDeliveryBindingSha256(delivery)) fail();
  literal(root.coordinateConvention, MOTION_RENDER_DELIVERY_ANCHOR_CONVENTION);
  const anchors = denseArray(root.anchors, MAX_RENDER_DELIVERY_ANCHORS);
  if (anchors.length * delivery.schedule.length > MAX_RENDER_DELIVERY_ANCHOR_SAMPLES) fail();

  const parsed: RenderDeliveryAnchorTrack[] = [];
  let previousId = 0;
  for (let anchorIndex = 0; anchorIndex < anchors.length; anchorIndex += 1) {
    const anchor = record(anchors[anchorIndex], ["id", "samples"]);
    integer(anchor.id, 1, MAX_RENDER_DELIVERY_ANCHOR_ID);
    if (anchor.id <= previousId) fail();
    previousId = anchor.id;
    const samples = denseArray(anchor.samples, delivery.schedule.length);
    if (samples.length !== delivery.schedule.length) fail();
    const parsedSamples: RenderDeliveryAnchorSample[] = [];
    for (let frameIndex = 0; frameIndex < samples.length; frameIndex += 1) {
      const sample = parseSample(samples[frameIndex], frameIndex);
      parsedSamples.push(sample);
    }
    parsed.push({ id: anchor.id, samples: parsedSamples });
  }
  const payload = { schema: MOTION_RENDER_DELIVERY_ANCHOR_PAYLOAD_SCHEMA, deliveryBindingSha256: root.deliveryBindingSha256, coordinateConvention: MOTION_RENDER_DELIVERY_ANCHOR_CONVENTION, anchors: parsed };
  // Reject alternate textual spellings, BOMs, duplicate keys, whitespace tails, and equivalent-but-
  // differently ordered JSON before the provider bytes are copied into a package.
  if (Buffer.from(canonicalJson(payload), "utf8").compare(bytes) !== 0) fail();
  return freeze(payload);
}

function parseSample(value: unknown, expectedFrameIndex: number): RenderDeliveryAnchorSample {
  const base = record(value, ["frameIndex", "state"], ["xQ1024", "yQ1024"]);
  integer(base.frameIndex, expectedFrameIndex, expectedFrameIndex);
  if (base.state === "visible") {
    if (!("xQ1024" in base) || !("yQ1024" in base)) fail();
    integer(base.xQ1024, -MAX_RENDER_DELIVERY_ANCHOR_COORDINATE_Q1024, MAX_RENDER_DELIVERY_ANCHOR_COORDINATE_Q1024);
    integer(base.yQ1024, -MAX_RENDER_DELIVERY_ANCHOR_COORDINATE_Q1024, MAX_RENDER_DELIVERY_ANCHOR_COORDINATE_Q1024);
    return { frameIndex: base.frameIndex, state: "visible", xQ1024: base.xQ1024, yQ1024: base.yQ1024 };
  }
  if (base.state !== "not-visible" || "xQ1024" in base || "yQ1024" in base) fail();
  return { frameIndex: base.frameIndex, state: "not-visible" };
}

function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value) || !plainObject(value)) fail();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.getOwnPropertySymbols(value).length > 0 || Object.values(descriptors).some((descriptor) => !descriptor.enumerable || !("value" in descriptor))) fail();
    const allowed = new Set([...required, ...optional]);
    const keys = Object.keys(value);
    if (keys.some((key) => !allowed.has(key)) || required.some((key) => !Object.prototype.hasOwnProperty.call(descriptors, key))) fail();
    return value as Record<string, unknown>;
  } catch { fail(); }
}

function denseArray(value: unknown, maximum: number): unknown[] {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || !Number.isSafeInteger(value.length) || value.length > maximum) fail();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors).filter((key) => key !== "length");
    if (Object.getOwnPropertySymbols(value).length > 0 || keys.length !== value.length || keys.some((key, index) => key !== String(index)) || keys.some((key) => !descriptors[key]!.enumerable || !("value" in descriptors[key]!))) fail();
    return value;
  } catch { fail(); }
}

function literal(value: unknown, expected: string): asserts value is string { if (value !== expected) fail(); }
function hash(value: unknown): asserts value is string { if (typeof value !== "string" || !SHA256.test(value)) fail(); }
function integer(value: unknown, minimum: number, maximum: number): asserts value is number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) fail(); }
function plainObject(value: object): boolean { const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null; }
function fail(): never { throw new Error("Provider anchor payload is not admitted by motion.render-provider-anchor-payload/v1."); }
function freeze<T>(value: T): T { if (value && typeof value === "object") { Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) freeze(child); } return value; }
