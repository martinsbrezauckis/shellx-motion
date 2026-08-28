/** IO-free staging plan for an already validated provider delivery. */

import { renderDeliveryAnchorDeliveryBindingSha256 } from "./render-delivery-identity";
import { describeMotionRenderDelivery } from "./render-delivery-validate";
import {
  MOTION_RENDER_DELIVERY_IMPORT_PLAN_SCHEMA,
  type MotionRenderDelivery,
  type MotionRenderDeliveryImportPlan,
  type RenderDeliveryImportPlanningResult,
  type RenderDeliveryIssue,
} from "./render-delivery-types";

/**
 * Process-local source locations. They are intentionally available only to the private import
 * boundary: a package plan, package record, or receipt must never serialize these values.
 */
export interface RenderDeliveryEphemeralFrameSource { readonly index: number; readonly providerLocalPath: string; }
export interface RenderDeliveryEphemeralAnchorSource { readonly providerLocalPath: string; }

export type RenderDeliveryImportRequestDescription =
  | {
    readonly ok: true;
    readonly delivery: MotionRenderDelivery;
    readonly fingerprint: string;
    readonly plan: MotionRenderDeliveryImportPlan;
    readonly sources: {
      readonly beauty: readonly RenderDeliveryEphemeralFrameSource[];
      readonly anchors?: RenderDeliveryEphemeralAnchorSource;
    };
  }
  | { readonly ok: false; readonly issues: readonly RenderDeliveryIssue[] };

/**
 * Validate source availability and return package-local destination names. Source locations are
 * deliberately consumed as an input-only witness and are never included in the returned plan.
 */
export function planMotionRenderDeliveryImport(value: unknown): RenderDeliveryImportPlanningResult {
  const described = describeMotionRenderDeliveryImportRequest(value);
  return described.ok ? { ok: true, plan: described.plan } : { ok: false, issues: described.issues };
}

/**
 * Private descriptor-first request reader. The returned source locations are process-local
 * witnesses for the later host adapter; callers must retain only `plan` in durable state.
 */
export function describeMotionRenderDeliveryImportRequest(value: unknown): RenderDeliveryImportRequestDescription {
  const issues: RenderDeliveryIssue[] = [];
  const root = record(value, "$", ["delivery", "sources"], issues);
  if (!root) return requestFailure(issues);
  const described = describeMotionRenderDelivery(root.delivery);
  if (!described.ok) return { ok: false, issues: described.issues };
  const sources = record(root.sources, "$.sources", ["beauty"], issues, ["anchors"]);
  const expectedFrames = described.delivery.passes[0]!.kind === "beauty" ? described.delivery.passes[0]!.frames : [];
  const beautySources = sources && denseArray(sources.beauty, "$.sources.beauty", expectedFrames.length, issues);
  if (beautySources) validateBeautySources(beautySources, expectedFrames.length, issues);
  if (described.delivery.anchors) {
    if (!sources || !("anchors" in sources)) issue("$.sources.anchors", "required", "is required when anchors are delivered", issues);
    else validateAnchorSource(sources.anchors, issues);
  } else if (sources && "anchors" in sources) issue("$.sources.anchors", "unexpected", "must be omitted when anchors are not delivered", issues);
  if (issues.length > 0) return requestFailure(issues);

  const plan = deriveMotionRenderDeliveryImportPlan(described.delivery, described.fingerprint);
  const orderedSources = {
    beauty: expectedFrames.map((frame) => {
      const source = beautySources!.find((candidate) => (candidate as { index: number }).index === frame.index) as Record<string, unknown>;
      return { index: frame.index, providerLocalPath: source.providerLocalPath as string };
    }),
    ...(described.delivery.anchors ? { anchors: { providerLocalPath: (sources!.anchors as Record<string, unknown>).providerLocalPath as string } } : {}),
  };
  return freeze({
    ok: true as const,
    delivery: described.delivery,
    fingerprint: described.fingerprint,
    plan,
    sources: orderedSources,
  });
}

/**
 * Construct the one deterministic, path-free package import plan for an already validated
 * delivery and its canonical fingerprint. The receipt verifier shares this constructor so a
 * receipt cannot choose alternative provider, timing, beauty, or anchor plan facts.
 */
export function deriveMotionRenderDeliveryImportPlan(
  delivery: MotionRenderDelivery,
  deliveryFingerprint: string,
): MotionRenderDeliveryImportPlan {
  const expectedFrames = delivery.passes[0]!.kind === "beauty" ? delivery.passes[0]!.frames : [];
  const prefix = `assets/provider-delivery/${deliveryFingerprint}`;
  const beauty = expectedFrames.map((frame) => ({ role: "beauty" as const, frameIndex: frame.index, sha256: frame.sha256, packagePath: `${prefix}/beauty/${String(frame.index).padStart(6, "0")}.png` }));
  return {
    schema: MOTION_RENDER_DELIVERY_IMPORT_PLAN_SCHEMA,
    deliveryFingerprint,
    provider: { id: delivery.provider.id, version: delivery.provider.version },
    timing: { rate: delivery.rate, schedule: delivery.schedule, scheduleSha256: delivery.identity.scheduleSha256, frameCount: expectedFrames.length },
    assets: {
      beauty,
      ...(delivery.anchors ? {
        anchors: {
          role: "anchors" as const,
          sha256: delivery.anchors.sha256,
          packagePath: `${prefix}/anchors.json`,
          schema: delivery.anchors.schema,
          deliveryBindingSha256: renderDeliveryAnchorDeliveryBindingSha256(delivery),
          frameCount: delivery.anchors.frameCount,
          convention: delivery.anchors.convention,
        },
      } : {}),
    },
  };
}

function validateBeautySources(value: unknown[], expected: number, issues: RenderDeliveryIssue[]): void {
  if (value.length !== expected) issue("$.sources.beauty", "frame-count", "must exactly match delivered beauty frames", issues);
  const seen = new Set<number>();
  for (let index = 0; index < value.length; index += 1) {
    const source = record(value[index], `$.sources.beauty[${index}]`, ["index", "providerLocalPath"], issues);
    if (!source) continue;
    if (!Number.isSafeInteger(source.index) || (source.index as number) < 0 || (source.index as number) >= expected) issue(`$.sources.beauty[${index}].index`, "index", "must name a delivered frame", issues);
    else if (seen.has(source.index as number)) issue(`$.sources.beauty[${index}].index`, "duplicate", "must be unique", issues);
    else seen.add(source.index as number);
    location(source.providerLocalPath, `$.sources.beauty[${index}].providerLocalPath`, issues);
  }
  for (let index = 0; index < expected; index += 1) if (!seen.has(index)) issue("$.sources.beauty", "missing", `is missing frame ${index}`, issues);
}

function validateAnchorSource(value: unknown, issues: RenderDeliveryIssue[]): void {
  const source = record(value, "$.sources.anchors", ["providerLocalPath"], issues);
  if (source) location(source.providerLocalPath, "$.sources.anchors.providerLocalPath", issues);
}

function location(value: unknown, path: string, issues: RenderDeliveryIssue[]): void { if (typeof value !== "string" || value.length < 1 || value.length > 4_096) issue(path, "location", "must be a bounded source location", issues); }
function record(value: unknown, path: string, required: readonly string[], issues: RenderDeliveryIssue[], optional: readonly string[] = []): Record<string, unknown> | undefined {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value) || !plainObject(value)) { issue(path, "object", "must be a plain data object", issues); return undefined; }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.getOwnPropertySymbols(value).length > 0 || Object.values(descriptors).some((descriptor) => !descriptor.enumerable || !("value" in descriptor))) { issue(path, "reflection", "must contain enumerable data fields only", issues); return undefined; }
    const allowed = new Set([...required, ...optional]);
    for (const key of Object.keys(value)) if (!allowed.has(key)) { issue(`${path}.${key}`, "unknown", "is not admitted", issues); return undefined; }
    for (const key of required) if (!Object.prototype.hasOwnProperty.call(descriptors, key)) { issue(`${path}.${key}`, "required", "is required", issues); return undefined; }
    return value as Record<string, unknown>;
  } catch { issue(path, "reflection", "must permit safe descriptor inspection", issues); return undefined; }
}
function denseArray(value: unknown, path: string, maximum: number, issues: RenderDeliveryIssue[]): unknown[] | undefined {
  try {
    if (!Array.isArray(value)) { issue(path, "array", "must be an array", issues); return undefined; }
    if (Object.getPrototypeOf(value) !== Array.prototype) { issue(path, "prototype", "must use the standard array prototype", issues); return undefined; }
    if (!Number.isSafeInteger(value.length) || value.length > maximum) { issue(path, "cap", `must contain at most ${maximum} entries`, issues); return undefined; }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors).filter((key) => key !== "length");
    if (Object.getOwnPropertySymbols(value).length > 0 || keys.length !== value.length || keys.some((key, index) => key !== String(index)) || keys.some((key) => !descriptors[key]!.enumerable || !("value" in descriptors[key]!))) { issue(path, "reflection", "must be a dense data array without extra fields", issues); return undefined; }
    return value;
  } catch { issue(path, "reflection", "must permit safe descriptor inspection", issues); return undefined; }
}
function plainObject(value: object): boolean { const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null; }
function issue(path: string, code: string, message: string, issues: RenderDeliveryIssue[]): void { issues.push({ path, code, message }); }
function requestFailure(issues: RenderDeliveryIssue[]): RenderDeliveryImportRequestDescription { return { ok: false, issues: Object.freeze([...issues]) }; }
function freeze<T>(value: T): T { if (value && typeof value === "object") { Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) freeze(child); } return value; }
