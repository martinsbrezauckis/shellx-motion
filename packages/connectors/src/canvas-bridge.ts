import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { hashBuffer, prepareOutputFile, type OperationReceipt } from "@shellx-motion/core";
import type { ConnectorArtifact } from "./artifacts";

export interface CanvasBridgeLayer {
  id: string;
  kind: "shape" | "text";
  shape?: string;
  text?: string;
  x: number;
  y: number;
  w?: number;
  h?: number;
  font?: string;
  size?: number;
  color?: string;
  bold?: boolean;
  style?: Record<string, unknown>;
}

export interface CanvasBridgeSmokeDoc {
  width: number;
  height: number;
  layers: Array<{
    id: string;
    name: string;
    visible: boolean;
    locked: boolean;
    opacity: number;
    ops: CanvasBridgeLayer[];
  }>;
  activeLayerId: string;
}

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
  receiptPath?: string;
  durationMs?: number;
  fps?: number;
  trustedCanvasRoots?: string[];
  /**
   * Overwrite an existing file at `outPath`. Off by default: `--out` is a caller-supplied FILE path
   * here, and the Canvas bridge writes it unconditionally (the output-ownership invariant — a caller's own `sel.json`
   * was replaced by a run that reported ok:true).
   */
  force?: boolean;
}

export type CanvasBridgeFrameSelectionSchema =
  | "shellx-motion/canvas-frame-selection@1"
  | "shellx-canvas/frame-selection@1";

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
      error: { code: string; message: string; cause?: string };
    };

interface CanvasMotionBridge {
  buildMotionFrameSelection: (input: Record<string, unknown>) => unknown;
  writeMotionFrameSelection: (selection: unknown, options: { outPath: string }) => Promise<unknown>;
}

export function buildCanvasBridgeSmokeDoc(): CanvasBridgeSmokeDoc {
  return {
    width: 1280,
    height: 800,
    activeLayerId: "layer-main",
    layers: [
      {
        id: "layer-main",
        name: "Page",
        visible: true,
        locked: false,
        opacity: 1,
        ops: [
          {
            id: "rect-blue",
            kind: "shape",
            shape: "rectangle",
            x: 140,
            y: 150,
            w: 240,
            h: 150,
            style: { stroke: "#1e3a5f", fill: "#3b82f6", width: 2, opacity: 1 }
          },
          {
            id: "heading",
            kind: "text",
            x: 150,
            y: 560,
            text: "ShellX Canvas",
            font: "Georgia, serif",
            size: 64,
            color: "#111827",
            bold: true
          }
        ]
      }
    ]
  };
}

export async function runCanvasBridgeFrameSelectionExport(
  input: CanvasBridgeFrameSelectionExportInput
): Promise<CanvasBridgeFrameSelectionExportResult> {
  const canvasRoot = resolve(input.canvasRoot);
  const bridgePath = resolve(canvasRoot, "app", "server", "motion-package.mjs");
  const outPath = resolve(input.outPath);

  try {
    // Trust first — an untrusted Canvas root must be refused as untrusted, whatever else is wrong.
    await assertTrustedCanvasBridgeRoot(canvasRoot, bridgePath, input.trustedCanvasRoots ?? trustedCanvasRootsFromEnv());
    // The bridge writes `outPath` unconditionally, so the guard has to run before it is handed over.
    const outPathGuard = await prepareOutputFile(outPath, { force: input.force === true });
    if (!outPathGuard.ok) {
      return { ok: false, canvasRoot, bridgePath, path: outPath, error: { code: outPathGuard.error.code, message: outPathGuard.error.message } };
    }
    const bridge = await loadCanvasMotionBridge(bridgePath);
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
    const writeResult = await bridge.writeMotionFrameSelection(selection, { outPath });
    const schema = schemaFromWriteResult(writeResult, selection);
    if (!isSupportedCanvasBridgeFrameSelectionSchema(schema)) {
      return {
        ok: false,
        canvasRoot,
        bridgePath,
        path: outPath,
        error: {
          code: "canvas_bridge_schema_mismatch",
          message: `Canvas bridge returned unsupported schema: ${schema}.`
        }
      };
    }
    const selectionPath = pathFromWriteResult(writeResult) ?? outPath;
    const selectedFrameId = selectedFrameIdFromSelection(selection);
    const layerIds = layerIdsFromSelection(selection);
    const receiptPath = resolve(input.receiptPath ?? join(dirname(selectionPath), "canvas-bridge-export.receipt.json"));
    const artifacts: ConnectorArtifact[] = [
      { role: "canvas_bridge", path: bridgePath, status: "available" },
      { role: "canvas_frame_selection", path: selectionPath, status: "available", mediaType: "application/json", primary: true },
      { role: "connector_receipt", path: receiptPath, status: "available", mediaType: "application/json" }
    ];
    const receipt = await createCanvasBridgeExportReceipt({
      canvasRoot,
      bridgePath,
      selection,
      selectionPath,
      schema,
      selectedFrameId,
      layerIds,
      receiptPath,
      artifacts,
      createdAt: input.generatedAt ?? new Date().toISOString()
    });
    await writeJson(receiptPath, receipt);

    return {
      ok: true,
      canvasRoot,
      bridgePath,
      path: selectionPath,
      schema,
      selectedFrameId,
      layerIds,
      artifacts,
      receiptPath,
      selection
    };
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

async function createCanvasBridgeExportReceipt(input: {
  canvasRoot: string;
  bridgePath: string;
  selection: unknown;
  selectionPath: string;
  schema: CanvasBridgeFrameSelectionSchema;
  selectedFrameId: string;
  layerIds: string[];
  receiptPath: string;
  artifacts: ConnectorArtifact[];
  createdAt: string;
}): Promise<OperationReceipt> {
  const bridgeBytes = await readFile(input.bridgePath);
  const selectionBytes = Buffer.from(JSON.stringify(input.selection), "utf8");
  const selectionHash = hashBuffer(selectionBytes);
  return {
    schema: "shellx-motion/receipt@1",
    id: `canvas-bridge-export-${selectionHash.slice(0, 16)}`,
    operation: "canvas.bridge_export",
    status: "passed",
    packageId: "canvas_bridge_export",
    inputHashes: {
      bridge: hashBuffer(bridgeBytes),
      selection: selectionHash
    },
    createdAt: input.createdAt,
    lane: "connector",
    output: {
      canvasRoot: input.canvasRoot,
      bridgePath: input.bridgePath,
      path: input.selectionPath,
      receiptPath: input.receiptPath,
      schema: input.schema,
      selectedFrameId: input.selectedFrameId,
      layerIds: input.layerIds
    },
    artifacts: input.artifacts.filter((artifact) => artifact.role !== "connector_receipt"),
    warnings: []
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

class CanvasBridgeTrustError extends Error {}

async function assertTrustedCanvasBridgeRoot(canvasRoot: string, bridgePath: string, trustedRoots: string[]): Promise<void> {
  try {
    const rootPath = await realpathOrResolve(canvasRoot);
    const trustedRootPaths = await Promise.all(trustedRoots.map(realpathOrResolve));
    if (trustedRootPaths.length === 0 || !trustedRootPaths.some((trustedRoot) => isPathInsideOrEqual(trustedRoot, rootPath))) {
      throw new CanvasBridgeTrustError("Canvas root is not in the trusted Canvas roots allowlist.");
    }
    const appRoot = await realpath(resolve(rootPath, "app"));
    const resolvedBridgePath = await realpath(bridgePath);
    if (!isPathInsideOrEqual(rootPath, resolvedBridgePath) || !isPathInsideOrEqual(appRoot, resolvedBridgePath)) {
      throw new CanvasBridgeTrustError("Canvas bridge path resolves outside the Canvas checkout app root.");
    }

    const packageJson = readRecord(JSON.parse(await readFile(resolve(appRoot, "package.json"), "utf8")));
    if (packageJson?.name !== "shellx-canvas") {
      throw new CanvasBridgeTrustError("Canvas app package.json is not named shellx-canvas.");
    }
  } catch (error) {
    if (error instanceof CanvasBridgeTrustError) throw error;
    throw new CanvasBridgeTrustError(error instanceof Error ? error.message : String(error));
  }
}

function trustedCanvasRootsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.SHELLX_MOTION_TRUSTED_CANVAS_ROOTS ?? "")
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function realpathOrResolve(path: string): Promise<string> {
  try {
    return await realpath(resolve(path));
  } catch {
    return resolve(path);
  }
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

function isPathInsideOrEqual(parent: string, candidate: string): boolean {
  const relativePath = relative(parent, candidate);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
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
