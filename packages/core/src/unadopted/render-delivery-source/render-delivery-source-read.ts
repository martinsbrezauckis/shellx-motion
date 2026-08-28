import { isAbsolute, relative, resolve, sep } from "node:path";
import { decodePngRgba, MAX_MOTION_PNG_FRAME_DIMENSION, MAX_MOTION_PNG_FRAME_PIXELS } from "../../png-rgba-decode";
import { parseMotionRenderDeliveryAnchorPayload } from "./render-delivery-anchor-payload";
import {
  RenderDeliverySourceAdmissionError,
  type RenderDeliverySourceAdmissionErrorCode,
  type VerifiedAnchorSource,
  type VerifiedBeautySource,
} from "./render-delivery-source-support";
import { BoundedResourceBudget, preflightBoundedStableFile, readBoundedStableFile, type StableFileIdentity } from "../../stable-file-read";
import type { RenderDeliveryEphemeralAnchorSource, RenderDeliveryEphemeralFrameSource } from "./render-delivery-import-plan";
import type {
  MotionRenderDelivery,
  MotionRenderDeliveryImportPlan,
  RenderDeliveryAnchorStagedAsset,
  RenderDeliveryBeautyPass,
  RenderDeliveryFrameIdentity,
} from "./render-delivery-types";

export interface ExpectedBeautySource {
  readonly frame: RenderDeliveryFrameIdentity;
  readonly packagePath: string;
  readonly pass: RenderDeliveryBeautyPass;
}

interface PreflightedBeautySource {
  readonly source: RenderDeliveryEphemeralFrameSource;
  readonly expected: ExpectedBeautySource;
  readonly identity: StableFileIdentity;
}

interface PreflightedAnchorSource {
  readonly source: RenderDeliveryEphemeralAnchorSource;
  readonly expected: RenderDeliveryAnchorStagedAsset;
  readonly identity: StableFileIdentity;
}

export function expectedBeautySources(
  delivery: MotionRenderDelivery,
  plan: MotionRenderDeliveryImportPlan,
): readonly ExpectedBeautySource[] {
  const pass = delivery.passes[0];
  if (!pass || pass.kind !== "beauty" || plan.assets.beauty.length !== pass.frames.length || plan.timing.frameCount !== pass.frames.length) {
    throw new RenderDeliverySourceAdmissionError("delivery_not_admitted");
  }
  return pass.frames.map((frame, index) => {
    const asset = plan.assets.beauty[index];
    if (!asset || asset.role !== "beauty" || asset.frameIndex !== frame.index || asset.sha256 !== frame.sha256) {
      throw new RenderDeliverySourceAdmissionError("delivery_not_admitted");
    }
    return freeze({ frame, packagePath: asset.packagePath, pass });
  });
}

export function expectedAnchorSource(
  delivery: MotionRenderDelivery,
  plan: MotionRenderDeliveryImportPlan,
): RenderDeliveryAnchorStagedAsset | undefined {
  if (!delivery.anchors) {
    if (plan.assets.anchors) throw new RenderDeliverySourceAdmissionError("delivery_not_admitted");
    return undefined;
  }
  const expected = plan.assets.anchors;
  if (!expected || expected.role !== "anchors" || expected.sha256 !== delivery.anchors.sha256
    || expected.schema !== delivery.anchors.schema || expected.frameCount !== delivery.anchors.frameCount
    || expected.convention !== delivery.anchors.convention || expected.frameCount !== delivery.schedule.length) {
    throw new RenderDeliverySourceAdmissionError("delivery_not_admitted");
  }
  return expected;
}

/** Reserve every stable source before the first byte-buffer allocation. */
export async function preflightBeautySequence(
  sources: readonly RenderDeliveryEphemeralFrameSource[],
  root: string,
  expected: readonly ExpectedBeautySource[],
  budget: BoundedResourceBudget,
): Promise<readonly PreflightedBeautySource[]> {
  if (sources.length !== expected.length) throw new RenderDeliverySourceAdmissionError("delivery_not_admitted");
  const preflighted: PreflightedBeautySource[] = [];
  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index]!;
    const expectedFrame = expected[index]!;
    if (source.index !== expectedFrame.frame.index) throw new RenderDeliverySourceAdmissionError("delivery_not_admitted");
    const path = resolve(source.providerLocalPath);
    if (!isLexicallyInside(root, path)) throw new RenderDeliverySourceAdmissionError("source_identity");
    try {
      const preflight = await preflightBoundedStableFile(path, {
        label: "Provider delivery beauty frame",
        maxBytes: budget.limits.maxFileBytes,
        withinRoot: root,
        requireSingleLink: true,
        captureIdentity: true,
      });
      if (!preflight.identity) throw new RenderDeliverySourceAdmissionError("source_identity");
      budget.reserve(path, preflight.byteLength, root);
      preflighted.push(freeze({ source, expected: expectedFrame, identity: preflight.identity }));
    } catch (error) {
      if (error instanceof RenderDeliverySourceAdmissionError) throw error;
      throw new RenderDeliverySourceAdmissionError(isBudgetFailure(error) ? "source_bounds" : "source_identity");
    }
  }
  return freeze(preflighted);
}

/** Reserve the one opaque anchor file with the beauty sequence before any source byte allocation. */
export async function preflightAnchorSource(
  source: RenderDeliveryEphemeralAnchorSource,
  root: string,
  expected: RenderDeliveryAnchorStagedAsset,
  budget: BoundedResourceBudget,
  maxBytes: number,
): Promise<PreflightedAnchorSource> {
  const path = resolve(source.providerLocalPath);
  if (!isLexicallyInside(root, path)) throw new RenderDeliverySourceAdmissionError("source_identity");
  try {
    const preflight = await preflightBoundedStableFile(path, {
      label: "Provider delivery anchor payload",
      maxBytes,
      withinRoot: root,
      requireSingleLink: true,
      captureIdentity: true,
    });
    if (!preflight.identity) throw new RenderDeliverySourceAdmissionError("source_identity");
    budget.reserve(path, preflight.byteLength, root);
    return freeze({ source, expected, identity: preflight.identity });
  } catch (error) {
    if (error instanceof RenderDeliverySourceAdmissionError) throw error;
    throw new RenderDeliverySourceAdmissionError(isBudgetFailure(error) ? "source_bounds" : "source_identity");
  }
}

/** The opened handle must match its preflight identity before allocating its byte buffer. */
export async function readPreflightedBeautySequence(
  preflighted: readonly PreflightedBeautySource[],
  root: string,
  budget: BoundedResourceBudget,
): Promise<readonly VerifiedBeautySource[]> {
  const facts: VerifiedBeautySource[] = [];
  let actualTotal = 0;
  for (const reserved of preflighted) {
    const { source, expected: expectedFrame } = reserved;
    const file = await readBoundedStableFile(source.providerLocalPath, {
      label: "Provider delivery beauty frame",
      maxBytes: budget.limits.maxFileBytes,
      withinRoot: root,
      requireSingleLink: true,
      captureIdentity: true,
      expectedIdentity: reserved.identity,
    });
    if (!file.identity) throw new RenderDeliverySourceAdmissionError("source_identity");
    if (file.sha256 !== expectedFrame.frame.sha256) throw new RenderDeliverySourceAdmissionError("source_hash");
    actualTotal += file.byteLength;
    if (actualTotal > budget.limits.maxAggregateBytes) throw new RenderDeliverySourceAdmissionError("source_bounds");
    assertC5ABeautyPng(file.bytes, expectedFrame.pass);
    facts.push(freeze({
      fact: freeze({
        role: "beauty" as const,
        frameIndex: expectedFrame.frame.index,
        packagePath: expectedFrame.packagePath,
        sha256: file.sha256,
        byteLength: file.byteLength,
      }),
      identity: file.identity,
    }));
  }
  return freeze(facts);
}

/** Reopen the preflighted raw UTF-8 payload, then bind its exact closed numeric ABI to delivery. */
export async function readPreflightedAnchorSource(
  preflighted: PreflightedAnchorSource,
  root: string,
  delivery: MotionRenderDelivery,
  maxBytes: number,
): Promise<VerifiedAnchorSource> {
  let file: Awaited<ReturnType<typeof readBoundedStableFile>>;
  try {
    file = await readBoundedStableFile(preflighted.source.providerLocalPath, {
      label: "Provider delivery anchor payload",
      maxBytes,
      withinRoot: root,
      requireSingleLink: true,
      captureIdentity: true,
      expectedIdentity: preflighted.identity,
    });
  } catch (error) {
    if (error instanceof RenderDeliverySourceAdmissionError) throw error;
    throw new RenderDeliverySourceAdmissionError(isBudgetFailure(error) ? "source_bounds" : "source_identity");
  }
  if (!file.identity) throw new RenderDeliverySourceAdmissionError("source_identity");
  if (file.sha256 !== preflighted.expected.sha256) throw new RenderDeliverySourceAdmissionError("source_hash");
  try {
    const payload = parseMotionRenderDeliveryAnchorPayload(file.bytes, delivery);
    if (payload.schema !== preflighted.expected.schema || payload.deliveryBindingSha256 !== preflighted.expected.deliveryBindingSha256
      || payload.coordinateConvention !== preflighted.expected.convention) {
      throw new Error("anchor descriptor does not match parsed payload");
    }
    return freeze({
      fact: freeze({
        role: "anchors" as const,
        packagePath: preflighted.expected.packagePath,
        sha256: file.sha256,
        byteLength: file.byteLength,
        schema: payload.schema,
        deliveryBindingSha256: payload.deliveryBindingSha256,
        frameCount: preflighted.expected.frameCount,
        convention: payload.coordinateConvention,
      }),
      identity: file.identity,
    });
  } catch {
    throw new RenderDeliverySourceAdmissionError("source_anchor_payload");
  }
}

/** v1 accepts 8K descriptors; C5A explicitly narrows to the existing 4K bounded PNG decoder. */
export function assertC5ABeautyDecoderBounds(delivery: MotionRenderDelivery): void {
  const pass = delivery.passes[0];
  if (!pass || pass.kind !== "beauty" || pass.width > MAX_MOTION_PNG_FRAME_DIMENSION || pass.height > MAX_MOTION_PNG_FRAME_DIMENSION
    || pass.width * pass.height > MAX_MOTION_PNG_FRAME_PIXELS) {
    throw new RenderDeliverySourceAdmissionError("source_png");
  }
}

export function classifySourceFailure(error: unknown): RenderDeliverySourceAdmissionErrorCode {
  if (error instanceof RenderDeliverySourceAdmissionError) return error.code;
  return isBudgetFailure(error) ? "source_bounds" : "source_identity";
}

function assertC5ABeautyPng(bytes: Buffer, pass: RenderDeliveryBeautyPass): void {
  try {
    const decoded = decodePngRgba(bytes, { maxRgbaByteLength: MAX_MOTION_PNG_FRAME_PIXELS * 4 });
    if (decoded.width !== pass.width || decoded.height !== pass.height) throw new Error("declared dimensions differ");
  } catch {
    throw new RenderDeliverySourceAdmissionError("source_png");
  }
}

function isBudgetFailure(error: unknown): boolean {
  return error instanceof Error && /byte|file limit|path exceeds|aggregate|depth/i.test(error.message);
}

function isLexicallyInside(root: string, path: string): boolean {
  const relation = relative(root, path);
  return relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  }
  return value;
}
