import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ConnectorArtifact } from "./artifacts";
import { publishConnectorArtifact } from "./artifact-handle";
import { buildCanvasBridgeSmokeDoc, type CanvasBridgeSmokeDoc } from "./canvas-bridge-smoke";
import {
  admitTrustedCanvasBridge,
  CanvasBridgeTrustError,
  snapshotTrustedCanvasBridge
} from "./canvas-bridge-authority";
import {
  CanvasBridgeOutputReservation,
  CanvasBridgePublicationError,
  canvasBridgeFileEvidence,
  canvasBridgeOutputOwnershipFailure,
  canvasBridgeReceiptPath,
  commitCanvasBridgeSelection,
  createCanvasBridgeExportReceipt,
  ensureCanvasBridgeOutputParent,
  forceCanvasBridgeOutputDestinations,
  verifyCanvasBridgeFileEvidence,
  verifyCanvasBridgeReceiptBinding,
  writeStagedJson,
  type CanvasBridgeFrameSelectionSchema
} from "./canvas-bridge-publication";

export type { CanvasBridgeFrameSelectionSchema } from "./canvas-bridge-publication";
export { buildCanvasBridgeSmokeDoc } from "./canvas-bridge-smoke";
export type { CanvasBridgeLayer, CanvasBridgeSmokeDoc } from "./canvas-bridge-smoke";

export interface CanvasBridgeFrameSelectionExportInput {
  canvasRoot: string;
  outPath: string;
  target?: string;
  projectName?: string;
  frameName?: string;
  selectedIds?: string[];
  brandTokens?: Record<string, unknown>;
  doc?: CanvasBridgeSmokeDoc;
  generatedAt?: string;
  durationMs?: number;
  fps?: number;
  trustedCanvasRoots?: string[];
  /**
   * Overwrite the selected JSON and its fixed sibling receipt. Off by default: `--out` is a
   * caller-supplied FILE path, so both destinations are refused unless the CLI caller opted in.
   */
  force?: boolean;
  /**
   * Compatibility-only internal option. Canvas bridge receipts are always the fixed sibling
   * `canvas-bridge-export.receipt.json`; a different value is refused before bridge execution.
   */
  receiptPath?: string;
}

export type CanvasBridgeFrameSelectionExportResult =
  | {
      ok: true;
      canvasRoot: string;
      bridgePath: string;
      path: string;
      schema: CanvasBridgeFrameSelectionSchema;
      selectedFrameId: string;
      layerIds: string[];
      artifacts: ConnectorArtifact[];
      receiptPath: string;
      selection: unknown;
    }
  | {
      ok: false;
      canvasRoot: string;
      bridgePath: string;
      path: string;
      error: { code: string; message: string; cause?: string; suggestedAction?: string };
    };

/** Bounded fault seam for concurrent-publication regression coverage. Production callers omit it. */
export interface CanvasBridgeFrameSelectionExportServices {
  afterBridgeAuthorized?: () => Promise<void>;
  afterBridgeStaged?: (stagedSelectionPath: string) => Promise<void>;
  beforeSelectionPublished?: (privateStagePath: string) => Promise<void>;
  afterSelectionPublished?: () => Promise<void>;
}

interface CanvasMotionBridge {
  buildMotionFrameSelection: (input: Record<string, unknown>) => unknown;
  writeMotionFrameSelection: (selection: unknown, options: { outPath: string }) => Promise<unknown>;
}

export async function runCanvasBridgeFrameSelectionExport(
  input: CanvasBridgeFrameSelectionExportInput,
  services: CanvasBridgeFrameSelectionExportServices = {}
): Promise<CanvasBridgeFrameSelectionExportResult> {
  const canvasRoot = resolve(input.canvasRoot);
  const bridgePath = resolve(canvasRoot, "app", "server", "motion-package.mjs");
  const outPath = resolve(input.outPath);
  const receiptPath = canvasBridgeReceiptPath(outPath);
  if (outPath === receiptPath) {
    return canvasBridgeFailure(canvasRoot, bridgePath, outPath, "canvas_bridge_output_path_invalid", "Canvas frame-selection output cannot use the fixed sibling receipt filename.");
  }
  if (input.receiptPath !== undefined && resolve(input.receiptPath) !== receiptPath) {
    return canvasBridgeFailure(canvasRoot, bridgePath, outPath, "canvas_bridge_receipt_path_fixed", "Canvas bridge receipts are written only to the fixed sibling receipt path.");
  }

  try {
    // Trust first — an untrusted Canvas root must be refused as untrusted, whatever else is wrong.
    const bridgeSource = await admitTrustedCanvasBridge(
      canvasRoot,
      bridgePath,
      input.trustedCanvasRoots ?? trustedCanvasRootsFromEnv()
    );
    const outputParent = await ensureCanvasBridgeOutputParent(outPath);
    const reservation = await CanvasBridgeOutputReservation.acquire(outputParent, receiptPath);
    try {
      // The fixed receipt path is the pair-wide reservation key. Hold it from ownership preflight
      // through destructive force handling, publication, readback, and private-stage cleanup.
      const ownershipFailure = await canvasBridgeOutputOwnershipFailure([outPath, receiptPath], input.force === true);
      if (ownershipFailure) return canvasBridgeFailure(canvasRoot, bridgePath, outPath, ownershipFailure.code, ownershipFailure.message);

      const { path: stageDir, identity: stageIdentity } = await reservation.createPrivateStageDirectory();
      const bridgeSelectionPath = join(stageDir, "bridge-selection.json");
      const stagedSelectionPath = join(stageDir, "selection.json");
      const stagedReceiptPath = join(stageDir, "receipt.json");
      try {
      await services.afterBridgeAuthorized?.();
      const bridgeSnapshot = await snapshotTrustedCanvasBridge(bridgeSource, join(stageDir, "bridge-runtime"));
      const bridge = await loadCanvasMotionBridge(bridgeSnapshot.bridgePath);
      const selection = bridge.buildMotionFrameSelection({
        target: input.target ?? "sample",
        projectName: input.projectName ?? "Canvas Sample Project",
        frameName: input.frameName ?? "Story Hero",
        doc: input.doc ?? buildCanvasBridgeSmokeDoc(),
        selectedIds: input.selectedIds ?? ["rect-blue", "heading"],
        brandTokens: input.brandTokens ?? { color: { accent: "#3b82f6" } },
        generatedAt: input.generatedAt ?? new Date().toISOString(),
        durationMs: input.durationMs ?? 5000,
        fps: input.fps ?? 30
      });
      const writeResult = await bridge.writeMotionFrameSelection(selection, { outPath: bridgeSelectionPath });
      const schema = schemaFromWriteResult(writeResult, selection);
      if (!isSupportedCanvasBridgeFrameSelectionSchema(schema)) {
        return canvasBridgeFailure(canvasRoot, bridgePath, outPath, "canvas_bridge_schema_mismatch", `Canvas bridge returned unsupported schema: ${schema}.`);
      }
      const writtenSelectionPath = pathFromWriteResult(writeResult);
      if (writtenSelectionPath !== bridgeSelectionPath) {
        return canvasBridgeFailure(canvasRoot, bridgePath, outPath, "canvas_bridge_output_path_mismatch", "Canvas bridge returned a selection path outside its approved staged destination.");
      }
      await services.afterBridgeStaged?.(bridgeSelectionPath);
      const selectionEvidence = await commitCanvasBridgeSelection({
        sourcePath: bridgeSelectionPath,
        committedPath: stagedSelectionPath,
        selection
      });

      const selectedFrameId = selectedFrameIdFromSelection(selection);
      const layerIds = layerIdsFromSelection(selection);
      await bridgeSource.assertCurrent();
      const artifacts: ConnectorArtifact[] = [
        { role: "canvas_bridge", path: bridgePath, status: "available" },
        { role: "canvas_frame_selection", path: outPath, status: "available", mediaType: "application/json", primary: true },
        { role: "connector_receipt", path: receiptPath, status: "available", mediaType: "application/json" }
      ];
      const receipt = await createCanvasBridgeExportReceipt({
        canvasRoot,
        bridgePath,
        bridgeSha256: bridgeSnapshot.bridgeSha256,
        selectionHash: selectionEvidence.sha256,
        selectionPath: outPath,
        schema,
        selectedFrameId,
        layerIds,
        receiptPath,
        artifacts,
        createdAt: input.generatedAt ?? new Date().toISOString()
      });
      await writeStagedJson(stagedReceiptPath, receipt);
      const receiptEvidence = await canvasBridgeFileEvidence(stagedReceiptPath, "Committed Canvas bridge receipt");

      // CLI's explicit --force applies to the selection and its receipt as one decision. Debug
      // never passes force, so Debug callers always take the no-clobber branch.
      if (input.force === true) {
        const forcedFailure = await forceCanvasBridgeOutputDestinations([outPath, receiptPath]);
        if (forcedFailure) return canvasBridgeFailure(canvasRoot, bridgePath, outPath, forcedFailure.code, forcedFailure.message);
      }
      await services.beforeSelectionPublished?.(stageDir);
      await publishConnectorArtifact(stagedSelectionPath, outPath, {
        privateStagingRoot: stageDir,
        expectedPrivateStagingRoot: stageIdentity
      });
      await verifyCanvasBridgeFileEvidence(outPath, selectionEvidence, "Published Canvas bridge selection");
      await services.afterSelectionPublished?.();
      await publishConnectorArtifact(stagedReceiptPath, receiptPath, {
        privateStagingRoot: stageDir,
        expectedPrivateStagingRoot: stageIdentity
      });
      await verifyCanvasBridgeFileEvidence(receiptPath, receiptEvidence, "Published Canvas bridge receipt");
      await verifyCanvasBridgeReceiptBinding(receiptPath, selectionEvidence.sha256);

      return {
        ok: true,
        canvasRoot,
        bridgePath,
        path: outPath,
        schema,
        selectedFrameId,
        layerIds,
        artifacts,
        receiptPath,
        selection
      };
      } finally {
        // A public selection that published before a receipt failure is intentionally retained.
        // A retargeted private stage is retained too: the reservation release will return a typed
        // manual-recovery contract rather than recursively deleting an uncertain pathname.
        await reservation.removePrivateStage(stageDir, stageIdentity);
      }
    } finally {
      await reservation.release();
    }
  } catch (error) {
    if (error instanceof CanvasBridgeTrustError) {
      return {
        ok: false,
        canvasRoot,
        bridgePath,
        path: outPath,
        error: {
          code: "canvas_bridge_untrusted",
          message: "Canvas bridge import was refused because the root is not a trusted Design Studio checkout.",
          cause: error.message
        }
      };
    }
    if (error instanceof CanvasBridgePublicationError) {
      return canvasBridgeFailure(canvasRoot, bridgePath, outPath, error.code, error.message, error.suggestedAction);
    }
    return {
      ok: false,
      canvasRoot,
      bridgePath,
      path: outPath,
      error: {
        code: "canvas_bridge_export_failed",
        message: "Canvas Motion frame-selection export failed.",
        cause: error instanceof Error ? error.message : String(error)
      }
    };
  }
}

function canvasBridgeFailure(
  canvasRoot: string,
  bridgePath: string,
  path: string,
  code: string,
  message: string,
  suggestedAction?: string
): CanvasBridgeFrameSelectionExportResult {
  return { ok: false, canvasRoot, bridgePath, path, error: { code, message, ...(suggestedAction ? { suggestedAction } : {}) } };
}

function trustedCanvasRootsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.SHELLX_MOTION_TRUSTED_CANVAS_ROOTS ?? "")
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function loadCanvasMotionBridge(bridgePath: string): Promise<CanvasMotionBridge> {
  const moduleRecord = readRecord(await import(pathToFileURL(bridgePath).href));
  const buildMotionFrameSelection = moduleRecord?.buildMotionFrameSelection;
  const writeMotionFrameSelection = moduleRecord?.writeMotionFrameSelection;
  if (typeof buildMotionFrameSelection !== "function" || typeof writeMotionFrameSelection !== "function") {
    throw new Error("Canvas bridge does not expose buildMotionFrameSelection and writeMotionFrameSelection.");
  }
  return {
    buildMotionFrameSelection: (input) => buildMotionFrameSelection(input),
    writeMotionFrameSelection: async (selection, options) => writeMotionFrameSelection(selection, options)
  };
}

function schemaFromWriteResult(writeResult: unknown, selection: unknown): string {
  const writeRecord = readRecord(writeResult);
  const selectionRecord = readRecord(selection);
  if (typeof writeRecord?.schema === "string") return writeRecord.schema;
  if (typeof selectionRecord?.schema === "string") return selectionRecord.schema;
  return "";
}

function isSupportedCanvasBridgeFrameSelectionSchema(schema: string): schema is CanvasBridgeFrameSelectionSchema {
  return schema === "shellx-motion/canvas-frame-selection@1"
    || schema === "shellx-canvas/frame-selection@1";
}

function pathFromWriteResult(writeResult: unknown): string | null {
  const record = readRecord(writeResult);
  return typeof record?.path === "string" ? record.path : null;
}

function selectedFrameIdFromSelection(selection: unknown): string {
  const record = readRecord(selection);
  return typeof record?.selectedFrameId === "string" ? record.selectedFrameId : "";
}

function layerIdsFromSelection(selection: unknown): string[] {
  const selectionRecord = readRecord(selection);
  if (!selectionRecord || typeof selectionRecord.selectedFrameId !== "string" || !Array.isArray(selectionRecord.frames)) {
    return [];
  }
  const frame = selectionRecord.frames.map(readRecord).find((candidate) =>
    candidate?.id === selectionRecord.selectedFrameId
  );
  if (!frame || !Array.isArray(frame.layers)) return [];
  return frame.layers.flatMap((layer) => {
    const layerRecord = readRecord(layer);
    return typeof layerRecord?.id === "string" ? [layerRecord.id] : [];
  });
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}
