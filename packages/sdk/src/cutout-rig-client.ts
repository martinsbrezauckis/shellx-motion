/** Runtime guards for the bounded, sampled cutout-rig bake operation. */
import { parseCutoutRig } from "@shellx-motion/core";
import type { MotionSdkError, MotionSdkOperation } from "./types.js";
import type { MotionSdkCutoutRigBakeCadence } from "./cutout-rig-types.js";

const OPERATION = "cutoutRigBake" as const;

export function isCutoutRigOperation(operation: MotionSdkOperation): boolean {
  return operation === OPERATION;
}

export function validateCutoutRigRequest(
  operation: MotionSdkOperation,
  input: Record<string, unknown>,
): MotionSdkError | null {
  if (!isCutoutRigOperation(operation)) return null;
  if (!safeId(input.sourceLayerId)) return invalid("SDK cutoutRigBake requires a safe sourceLayerId.");
  try {
    parseCutoutRig(input.rig);
  } catch (error) {
    return invalid(`SDK cutoutRigBake rig is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  return null;
}

export function validateCutoutRigOutput(
  operation: MotionSdkOperation,
  output: Record<string, unknown>,
  requestInput: unknown,
): MotionSdkError | null {
  if (!isCutoutRigOperation(operation)) return null;
  const request = plainRecord(requestInput);
  const outputLayerIds = output.outputLayerIds;
  const changedPaths = output.changedPaths;
  const cadence = output.cadence;
  if (!request || output.packageRoot !== request.outDir || !validSource(output.source, request.sourceLayerId)
    || !validStringList(outputLayerIds, 1, 16, 128)
    || !validStringList(changedPaths, 1, 2, 128)
    || !validCadence(cadence)
    || !validReceipt(output.receipt, output.package)
    || !absolutePath(output.receiptPath)) {
    return invalidTransport("SDK cutoutRigBake output requires matching bounded source, layers, cadence, and receipt evidence.");
  }
  let rig;
  try {
    rig = parseCutoutRig(request.rig);
  } catch {
    return invalidTransport("SDK cutoutRigBake request rig could not be revalidated.");
  }
  const expectedIds = [...rig.nodes].sort((left, right) => left.stackIndex - right.stackIndex).map((node) => node.layerId);
  if (!sameStringList(outputLayerIds, expectedIds)
    || !sameStringList(changedPaths, changedPaths.includes("/tracks") ? ["/layers", "/tracks"] : ["/layers"])
    || cadence.sampleEveryFrames !== rig.sampleEveryFrames) {
    return invalidTransport("SDK cutoutRigBake output does not match the requested rig's stack order or cadence.");
  }
  return null;
}

function validSource(value: unknown, sourceLayerId: unknown): boolean {
  const source = plainRecord(value);
  return Boolean(source
    && source.layerId === sourceLayerId
    && safeId(source.layerId)
    && typeof source.assetRef === "string" && source.assetRef.startsWith("assets/")
    && positiveInteger(source.width) && positiveInteger(source.height)
    && sha256(source.sha256)
    && validStaticTransform(source.staticTransform, source.width, source.height));
}

function validStaticTransform(value: unknown, width: unknown, height: unknown): boolean {
  const transform = plainRecord(value);
  return Boolean(transform
    && finiteCoordinate(transform.x) && finiteCoordinate(transform.y) && transform.width === width && transform.height === height
    && finite(transform.scale) && Number(transform.scale) >= 0.001 && Number(transform.scale) <= 100
    && finiteCoordinate(transform.rotation) && finiteCoordinate(transform.originX) && finiteCoordinate(transform.originY));
}

function validCadence(value: unknown): value is MotionSdkCutoutRigBakeCadence {
  const cadence = plainRecord(value);
  const window = cadence && plainRecord(cadence.activeWindow);
  return Boolean(cadence && window
    && positiveInteger(cadence.sampleEveryFrames) && Number(cadence.sampleEveryFrames) <= 16
    && positiveInteger(cadence.observedFrameCount) && positiveInteger(cadence.bakedSampleCount)
    && Number(cadence.bakedSampleCount) <= 256 && Number(cadence.bakedSampleCount) <= Number(cadence.observedFrameCount)
    && finite(cadence.firstSampleMs) && finite(cadence.lastSampleMs)
    && cadence.firstSampleMs <= cadence.lastSampleMs
    && finite(window.startMs) && finite(window.endMsExclusive) && window.startMs < window.endMsExclusive
    && cadence.firstSampleMs >= window.startMs && cadence.lastSampleMs < window.endMsExclusive
    && cadence.approximation === "ordinary linear transform tracks between sampled renderer frames");
}

function validReceipt(value: unknown, packageValue: unknown): boolean {
  const receipt = plainRecord(value);
  const pkg = plainRecord(packageValue);
  return Boolean(receipt && pkg
    && receipt.schema === "shellx-motion/receipt@1"
    && receipt.operation === "timeline.cutout.rig.bake"
    && receipt.status === "passed"
    && typeof receipt.id === "string" && receipt.id.length > 0
    && receipt.packageId === pkg.packageId
    && absolutePath(receipt.path)
    && sha256(receipt.sha256));
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null || Object.getOwnPropertySymbols(value).length > 0) return null;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => "value" in descriptor)
    ? value as Record<string, unknown>
    : null;
}

function validStringList(value: unknown, min: number, max: number, maxLength: number): value is string[] {
  return Array.isArray(value) && value.length >= min && value.length <= max
    && value.every((entry) => typeof entry === "string" && entry.length > 0 && entry.length <= maxLength);
}

function sameStringList(value: unknown, expected: string[]): boolean {
  return Array.isArray(value) && value.length === expected.length && value.every((entry, index) => entry === expected[index]);
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(value);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function finiteCoordinate(value: unknown): boolean {
  return finite(value) && Math.abs(Number(value)) <= 1_000_000;
}

function sha256(value: unknown): boolean {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function absolutePath(value: unknown): boolean {
  return typeof value === "string" && value.length > 1 && !value.includes("\0")
    && (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value));
}

function invalid(message: string): MotionSdkError {
  return { code: "invalid_request", message, retryable: false };
}

function invalidTransport(message: string): MotionSdkError {
  return { code: "invalid_transport_response", message, retryable: false };
}
