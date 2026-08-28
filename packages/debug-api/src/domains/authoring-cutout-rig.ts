import {
  bakeCutoutRig,
  assertCutoutRigSource,
  canonicalJson,
  hashBuffer,
  hashPackageFile,
  loadSchema,
  resolvePackageAsset,
  validateDocument,
  type MotionPackage,
  type OperationReceipt
} from "@shellx-motion/core";
import { resolve } from "node:path";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import { commitMotionDocumentEdit, PackageEditTransactionError } from "./package-edit-transaction.js";
import { assertConfiguredAuthoringInputRoot, assertConfiguredAuthoringOutputRoot, AuthoringRootPolicyError } from "./authoring-root-policy.js";
import { readCutoutRigSourcePng, revalidateCutoutRigSourcePng } from "./cutout-rig-source-png.js";

export interface CutoutRigAuthoringServices {
  packageLoader?: (packageRoot: string) => Promise<MotionPackage>;
  writeReceipt?: (root: string, receipt: OperationReceipt) => Promise<string>;
  authoringInputRoots?: string[];
  authoringOutputRoots?: string[];
}

export async function dispatchCutoutRigAuthoringCommand(
  command: MotionDebugCommand,
  args: unknown,
  services: CutoutRigAuthoringServices
): Promise<MotionDebugResult | null> {
  if (command !== "motion.timeline.cutout.rig.bake") return null;
  const request = requestArgs(args);
  if ("error" in request) return request.error;
  if (!services.packageLoader) return unavailable("Cutout rig baking is unavailable.");
  if (request.receiptsRoot && !services.writeReceipt) return unavailable("Cutout rig receipt persistence is unavailable.");
  try {
    await assertConfiguredAuthoringInputRoot(request.packageRoot, services.authoringInputRoots);
    await assertConfiguredAuthoringOutputRoot(request.outDir, services.authoringOutputRoots);
    const pkg = await services.packageLoader(request.packageRoot);
    await assertConfiguredAuthoringInputRoot(pkg.root, services.authoringInputRoots);
    const source = await readCutoutRigSourcePng(pkg, request.sourceLayerId);
    const baked = bakeCutoutRig(pkg.motion, request.sourceLayerId, request.rig, source.identity);
    const validation = await validateDocument(await loadSchema("motion"), baked.motion);
    if (!validation.ok) throw new Error(`Baked Motion document failed validation: ${validation.errors.map((entry) => `${entry.path}: ${entry.message}`).join("; ")}`);
    const outputRoot = resolve(request.outDir);
    const inputHashes = {
      "manifest.json": await hashPackageFile(resolvePackageAsset(pkg, "manifest.json")),
      [pkg.manifest.motion]: await hashPackageFile(resolvePackageAsset(pkg, pkg.manifest.motion)),
      [source.identity.assetRef]: source.identity.sha256,
      rig: hashBuffer(Buffer.from(canonicalJson({ sourceLayerId: request.sourceLayerId, rig: request.rig }), "utf8"))
    };
    const receipt = cutoutRigReceipt(pkg, inputHashes, outputRoot, request, source.identity, baked);
    const installed = await commitMotionDocumentEdit({
      sourcePackage: pkg,
      outputRoot,
      authoringInputRoots: services.authoringInputRoots!,
      authoringOutputRoots: services.authoringOutputRoots!,
      patchedMotion: baked.motion,
      receipt,
      receiptFileName: "cutout-rig-bake.receipt.json",
      validateStagedSource: async (staged) => {
        // The transaction has already rebound manifest/motion/input hashes to this copied root.
        // Re-read both the stable PNG identity and the full static-source refusal proof here,
        // before the copied Motion document can be replaced.
        await revalidateCutoutRigSourcePng(staged, request.sourceLayerId, source.identity);
        assertCutoutRigSource(staged.motion, request.sourceLayerId, source.identity);
      },
      ...(request.receiptsRoot ? { receiptsRoot: request.receiptsRoot, writeHostReceipt: services.writeReceipt! } : {})
    });
    const result = {
      packageId: pkg.manifest.id,
      packageRoot: outputRoot,
      source: { layerId: request.sourceLayerId, ...source.identity, staticTransform: baked.sourceStaticTransform },
      outputLayerIds: baked.outputLayerIds,
      changedPaths: baked.changedPaths,
      cadence: baked.cadence,
      validation,
      motionPath: installed.motionPath,
      receiptPath: installed.receiptPath,
      ...(installed.hostReceiptPath ? { hostReceiptPath: installed.hostReceiptPath } : {})
    };
    return {
      ok: true,
      receiptId: receipt.id,
      result,
      visibleState: { panel: "timeline", operation: receipt.operation, packageId: pkg.manifest.id, outputLayerIds: baked.outputLayerIds },
      warnings: []
    };
  } catch (error) {
    const code = error instanceof AuthoringRootPolicyError || error instanceof PackageEditTransactionError
      ? error.code
      : "cutout_rig_bake_failed";
    return failure(code, error);
  }
}

interface CutoutRigRequest {
  packageRoot: string;
  outDir: string;
  sourceLayerId: string;
  rig: unknown;
  receiptsRoot?: string;
  createdBy?: string;
}

function requestArgs(args: unknown): { error: MotionDebugResult } | CutoutRigRequest {
  const record = dataRecord(args);
  if (!record) return { error: invalid("motion.timeline.cutout.rig.bake requires a plain argument object.") };
  const allowed = new Set(["packageRoot", "outDir", "sourceLayerId", "rig", "receiptsRoot", "createdBy"]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    return { error: invalid("motion.timeline.cutout.rig.bake received an unsupported argument.") };
  }
  const packageRoot = text(record.packageRoot);
  const outDir = text(record.outDir);
  const sourceLayerId = text(record.sourceLayerId);
  if (!packageRoot || !outDir || !sourceLayerId || !("rig" in record)) {
    return { error: invalid("motion.timeline.cutout.rig.bake requires packageRoot, outDir, sourceLayerId, and rig.") };
  }
  const receiptsRoot = record.receiptsRoot === undefined ? undefined : text(record.receiptsRoot);
  const createdBy = record.createdBy === undefined ? undefined : text(record.createdBy);
  if ((record.receiptsRoot !== undefined && !receiptsRoot) || (record.createdBy !== undefined && !createdBy)) {
    return { error: invalid("Cutout rig optional text arguments must be non-empty strings.") };
  }
  return { packageRoot, outDir, sourceLayerId, rig: record.rig, ...(receiptsRoot ? { receiptsRoot } : {}), ...(createdBy ? { createdBy } : {}) };
}

function cutoutRigReceipt(
  pkg: MotionPackage,
  inputHashes: Record<string, string>,
  outputRoot: string,
  request: CutoutRigRequest,
  identity: { assetRef: string; width: number; height: number; sha256: string },
  baked: ReturnType<typeof bakeCutoutRig>
): OperationReceipt {
  const id = hashBuffer(Buffer.from(canonicalJson({ packageId: pkg.manifest.id, inputHashes }), "utf8")).slice(0, 16);
  return {
    schema: "shellx-motion/receipt@1",
    id: `cutout-rig-bake-${id}`,
    operation: "timeline.cutout.rig.bake",
    status: "passed",
    packageId: pkg.manifest.id,
    inputHashes,
    createdAt: new Date().toISOString(),
    lane: "debug-api",
    output: {
      packageRoot: outputRoot,
      source: { layerId: request.sourceLayerId, ...identity, staticTransform: baked.sourceStaticTransform },
      outputLayerIds: baked.outputLayerIds,
      changedPaths: baked.changedPaths,
      cadence: baked.cadence,
      approximation: "This is a sampled author-time bake; it does not claim live parent-child equivalence between sampled renderer frames.",
      ...(request.createdBy ? { createdBy: request.createdBy } : {})
    },
    artifacts: [
      { role: "motion_package", path: outputRoot, status: "available", primary: true },
      { role: "cutout_rig_bake_receipt", path: `${outputRoot}/receipts/cutout-rig-bake.receipt.json`, status: "available", mediaType: "application/json" }
    ],
    warnings: []
  };
}

function dataRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const entries: Array<[string, unknown]> = [];
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") return null;
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !("value" in descriptor)) return null;
    entries.push([key, descriptor.value]);
  }
  return Object.assign(Object.create(null), Object.fromEntries(entries)) as Record<string, unknown>;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function invalid(message: string): MotionDebugResult { return { ok: false, error: { code: "invalid_args", message }, warnings: [] }; }
function unavailable(message: string): MotionDebugResult { return { ok: false, error: { code: "capability_unavailable", message }, warnings: [] }; }
function failure(code: string, error: unknown): MotionDebugResult { return { ok: false, error: { code, message: error instanceof Error ? error.message : String(error) }, warnings: [] }; }
