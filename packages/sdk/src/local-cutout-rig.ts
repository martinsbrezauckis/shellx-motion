/** Local SDK adapter for the bounded cutout-rig author-time bake. */
import { loadMotionPackage, parseCutoutRig, type MotionPackage } from "@shellx-motion/core";
import type { MotionDebugCommand, MotionDebugContext, MotionDebugResult } from "@shellx-motion/debug-api";
import { resolve } from "node:path";
import type {
  MotionSdkCutoutRigBakeCadence,
  MotionSdkCutoutRigBakeRequest,
  MotionSdkCutoutRigBakeResponse,
  MotionSdkCutoutRigSourceIdentity,
  MotionSdkPackageIdentity,
} from "./types.js";
import { verifyPersistedReceipt } from "./local-receipt.js";
import { LocalMotionSdkError } from "./local-result.js";

interface LocalCutoutRigRuntime {
  executeDebug(command: MotionDebugCommand, args: Record<string, unknown>, tier: MotionDebugContext["tier"]): Promise<MotionDebugResult>;
  packageIdentity(pkg: MotionPackage): Promise<MotionSdkPackageIdentity>;
}

export function createLocalCutoutRigOperations(runtime: LocalCutoutRigRuntime) {
  return { bake: (input: MotionSdkCutoutRigBakeRequest) => bake(input, runtime) };
}

async function bake(
  input: MotionSdkCutoutRigBakeRequest,
  runtime: LocalCutoutRigRuntime,
): Promise<MotionSdkCutoutRigBakeResponse> {
  const request = inputRecord(input, ["packageRoot", "outDir", "sourceLayerId", "rig", "receiptsRoot", "createdBy"]);
  const packageRoot = resolve(pathField(request, "packageRoot"));
  const outDir = resolve(pathField(request, "outDir"));
  const sourceLayerId = idField(request, "sourceLayerId");
  const rig = parseCutoutRig(request.rig);
  const debug = await runtime.executeDebug("motion.timeline.cutout.rig.bake", {
    packageRoot,
    outDir,
    sourceLayerId,
    rig,
    ...optionalText(request, "receiptsRoot"),
    ...optionalText(request, "createdBy"),
  }, "edit_motion");
  const result = successfulResult(debug);
  if (resolve(pathField(result, "packageRoot")) !== outDir) throw new Error("Cutout rig bake output identity does not match the request.");
  if (typeof debug.receiptId !== "string" || !debug.receiptId) throw new Error("Cutout rig bake did not return a receipt id.");
  const pkg = await loadMotionPackage(outDir);
  const source = sourceIdentity(result.source, sourceLayerId);
  const outputLayerIds = outputIds(result.outputLayerIds, [...rig.nodes]
    .sort((left, right) => left.stackIndex - right.stackIndex)
    .map((node) => node.layerId));
  const cadence = cadenceValue(result.cadence, rig.sampleEveryFrames);
  const changedPaths = changedPathList(result.changedPaths);
  assertPersistedOutput(pkg, outputLayerIds, source.assetRef);
  const receiptPath = resolve(pathField(result, "receiptPath"));
  const receipt = {
    schema: "shellx-motion/receipt@1" as const,
    id: debug.receiptId,
    packageId: pkg.manifest.id,
    operation: "timeline.cutout.rig.bake" as const,
    status: "passed" as const,
    path: receiptPath,
    sha256: await verifyPersistedReceipt(pkg.root, receiptPath, {
      id: debug.receiptId,
      packageId: pkg.manifest.id,
      operation: "timeline.cutout.rig.bake",
      status: "passed",
    }, "cutout rig bake receipt"),
  };
  return {
    packageRoot: pkg.root,
    package: await runtime.packageIdentity(pkg),
    source,
    outputLayerIds,
    changedPaths,
    cadence,
    receipt,
    receiptPath,
    warnings: [...debug.warnings],
  };
}

function inputRecord(value: unknown, allowed: string[]): Record<string, unknown> {
  const record = dataRecord(value, "cutout rig bake input");
  const unexpected = Object.keys(record).find((key) => !allowed.includes(key));
  if (unexpected) throw new Error(`cutout rig bake input contains unsupported field ${unexpected}.`);
  return record;
}

function successfulResult(debug: MotionDebugResult): Record<string, unknown> {
  if (!debug.ok) throw new LocalMotionSdkError(debug.error.code, `Cutout rig bake failed: ${debug.error.message}`, false, debug.error.detail);
  return dataRecord(debug.result, "cutout rig bake result");
}

function sourceIdentity(value: unknown, sourceLayerId: string): MotionSdkCutoutRigSourceIdentity {
  const source = dataRecord(value, "cutout rig source");
  if (source.layerId !== sourceLayerId || typeof source.assetRef !== "string" || !source.assetRef.startsWith("assets/")
    || !positiveInteger(source.width) || !positiveInteger(source.height) || !sha256(source.sha256)) {
    throw new Error("Cutout rig bake source identity is invalid.");
  }
  const transform = dataRecord(source.staticTransform, "cutout rig static source transform");
  if (!finiteCoordinate(transform.x) || !finiteCoordinate(transform.y) || transform.width !== source.width || transform.height !== source.height
    || !finite(transform.scale) || Number(transform.scale) < 0.001 || Number(transform.scale) > 100
    || !finiteCoordinate(transform.rotation) || !finiteCoordinate(transform.originX) || !finiteCoordinate(transform.originY)) {
    throw new Error("Cutout rig bake static source transform is invalid.");
  }
  return source as unknown as MotionSdkCutoutRigSourceIdentity;
}

function outputIds(value: unknown, nodeIds: string[]): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16 || !value.every(safeId)) {
    throw new Error("Cutout rig bake output layer ids are invalid.");
  }
  const expected = [...nodeIds];
  const unique = new Set(value);
  if (unique.size !== value.length || value.length !== expected.length || value.some((id, index) => id !== expected[index])) {
    throw new Error("Cutout rig bake output layer ids do not preserve the requested stack order.");
  }
  return [...value];
}

function cadenceValue(value: unknown, sampleEveryFrames: number): MotionSdkCutoutRigBakeCadence {
  const cadence = dataRecord(value, "cutout rig bake cadence");
  const activeWindow = dataRecord(cadence.activeWindow, "cutout rig bake active window");
  if (cadence.sampleEveryFrames !== sampleEveryFrames || !positiveInteger(cadence.observedFrameCount)
    || !positiveInteger(cadence.bakedSampleCount) || Number(cadence.bakedSampleCount) > 256
    || Number(cadence.bakedSampleCount) > Number(cadence.observedFrameCount)
    || !finite(cadence.firstSampleMs) || !finite(cadence.lastSampleMs)
    || cadence.firstSampleMs > cadence.lastSampleMs || !finite(activeWindow.startMs)
    || !finite(activeWindow.endMsExclusive) || activeWindow.startMs >= activeWindow.endMsExclusive
    || cadence.firstSampleMs < activeWindow.startMs || cadence.lastSampleMs >= activeWindow.endMsExclusive
    || cadence.approximation !== "ordinary linear transform tracks between sampled renderer frames") {
    throw new Error("Cutout rig bake cadence is invalid.");
  }
  return cadence as unknown as MotionSdkCutoutRigBakeCadence;
}

function changedPathList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2 || value[0] !== "/layers"
    || value.some((entry) => entry !== "/layers" && entry !== "/tracks")) {
    throw new Error("Cutout rig bake changed paths are invalid.");
  }
  return [...value] as string[];
}

function assertPersistedOutput(pkg: MotionPackage, outputLayerIds: string[], assetRef: string): void {
  for (const layerId of outputLayerIds) {
    const layer = pkg.motion.layers.find((candidate) => candidate.id === layerId);
    if (!layer || layer.type !== "image" || layer.assetRef !== assetRef || !layer.crop || !layer.keyframes) {
      throw new Error(`Cutout rig bake output layer ${layerId} is not a persisted flat cropped image layer.`);
    }
  }
}

function dataRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be a plain object.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null || Object.getOwnPropertySymbols(value).length > 0
    || Object.values(Object.getOwnPropertyDescriptors(value)).some((descriptor) => !("value" in descriptor))) {
    throw new Error(`${label} must contain data properties only.`);
  }
  return value as Record<string, unknown>;
}

function pathField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim() || value.length > 4_096 || value.includes("\0")) throw new Error(`${key} must be a bounded path.`);
  return value;
}

function idField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (!safeId(value)) throw new Error(`${key} must be a safe id.`);
  return value;
}

function optionalText(record: Record<string, unknown>, key: "receiptsRoot" | "createdBy"): Record<string, string> {
  if (!(key in record)) return {};
  const value = record[key];
  if (typeof value !== "string" || !value.trim() || value.length > 4_096 || value.includes("\0")) throw new Error(`${key} must be a bounded string.`);
  return { [key]: value };
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(value);
}
function positiveInteger(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function finiteCoordinate(value: unknown): value is number { return finite(value) && Math.abs(value) <= 1_000_000; }
function sha256(value: unknown): boolean { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
