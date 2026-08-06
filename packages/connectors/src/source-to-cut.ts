import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  buildScriptedVideoFromSourceImport,
  hashBuffer,
  loadMotionPackage,
  readSourceImportDocumentFromMarkdown,
  type OperationReceipt,
  type ReceiptArtifact,
  type SourceImportKind
} from "@shellx-motion/core";
import type { FfmpegRunner } from "@shellx-motion/renderer-ffmpeg";
import { connectorReceiptStatus, type ConnectorArtifact } from "./artifacts";
import { type CutImportModeRequest } from "./cut-import-mode";
import { assertConnectorOutputOwnership } from "./output-ownership";
import { runScriptToCutConnector, type ScriptToCutConnectorResult } from "./script-to-cut";

export interface SourceToCutConnectorInput {
  sourcePath: string;
  outDir: string;
  /**
   * Overwrite the directories this connector owns under a non-empty `--out` (its own storyboard and
   * receipts, and the nested `cut/` run). Off by default: `outDir` is caller-supplied.
   */
  force?: boolean;
  maxFrames?: number;
  frameDurationMs?: number;
  width?: number;
  height?: number;
  fps?: number;
  previewLane?: "native";
  renderLane?: "ffmpeg";
  dryRunRender?: boolean;
  cutImportMode?: CutImportModeRequest;
  ffmpegRunner?: FfmpegRunner;
  now?: () => string;
}

export interface SourceToCutConnectorResult {
  ok: boolean;
  source: {
    path: string;
    url: string;
    title: string;
    kind: SourceImportKind;
    hash: string;
    importReceiptPath?: string;
  };
  storyboard: {
    scriptPath: string;
    receiptPath: string;
    frameCount: number;
    reviewRequired: boolean;
  };
  connector: ScriptToCutConnectorResult;
  packageDir: string;
  preview: ScriptToCutConnectorResult["preview"];
  render: ScriptToCutConnectorResult["render"];
  cutPlanPath: string;
  artifacts: ConnectorArtifact[];
  receiptPath: string;
  warnings: string[];
}

export async function runSourceToCutConnector(input: SourceToCutConnectorInput): Promise<SourceToCutConnectorResult> {
  const outDir = resolve(input.outDir);
  const sourcePath = resolve(input.sourcePath);
  const storyboardDir = join(outDir, "storyboard");
  const scriptPath = join(storyboardDir, "scripted-video.json");
  const storyboardReceiptPath = join(storyboardDir, "receipts", "source-storyboard.receipt.json");
  const childOutDir = join(outDir, "cut");
  const connectorReceiptPath = join(outDir, "receipts", "source-to-cut.receipt.json");
  const createdAt = input.now?.() ?? new Date().toISOString();
  // the output-ownership invariant: this connector wrote its storyboard into a caller-supplied `--out` with no guard. Checked
  // before the first write; the nested script-to-cut run guards `<out>/cut` for itself.
  await assertConnectorOutputOwnership({
    ownedDirs: [storyboardDir, join(outDir, "receipts"), childOutDir],
    force: input.force === true
  });
  const markdown = await readFile(sourcePath, "utf8");
  const source = readSourceImportDocumentFromMarkdown(markdown);
  const scripted = buildScriptedVideoFromSourceImport(source, {
    sourcePath,
    ...(input.maxFrames !== undefined ? { maxFrames: input.maxFrames } : {}),
    ...(input.frameDurationMs !== undefined ? { frameDurationMs: input.frameDurationMs } : {}),
    ...(input.width !== undefined ? { width: input.width } : {}),
    ...(input.height !== undefined ? { height: input.height } : {}),
    ...(input.fps !== undefined ? { fps: input.fps } : {})
  });
  const scriptBytes = Buffer.from(`${JSON.stringify(scripted, null, 2)}\n`, "utf8");
  const storyboardReceipt = createSourceStoryboardReceipt({
    sourcePath,
    sourceMarkdown: markdown,
    sourceHash: source.sha256,
    sourceUrl: source.url,
    sourceTitle: source.title,
    sourceKind: source.kind,
    scriptPath,
    scriptBytes,
    frameCount: scripted.frames.length,
    reviewRequired: scripted.review.required,
    createdAt
  });

  await writeJson(scriptPath, scripted);
  await writeJson(storyboardReceiptPath, storyboardReceipt);

  const connector = await runScriptToCutConnector({
    scriptPath,
    outDir: childOutDir,
    previewLane: input.previewLane,
    renderLane: input.renderLane,
    dryRunRender: input.dryRunRender,
    cutImportMode: input.cutImportMode,
    force: input.force === true,
    ffmpegRunner: input.ffmpegRunner,
    now: () => createdAt
  });
  const pkg = await loadMotionPackage(connector.packageDir);
  const sourceImportReceiptPath = await existingSourceImportReceiptPath(sourcePath);
  const artifacts = sourceToCutArtifacts({
    sourcePath,
    sourceImportReceiptPath,
    scriptPath,
    storyboardReceiptPath,
    childArtifacts: connector.artifacts,
    connectorReceiptPath
  });
  const warnings = connector.warnings;
  const receipt = createSourceToCutReceipt({
    packageId: pkg.manifest.id,
    createdAt,
    sourcePath,
    sourceHash: source.sha256,
    sourceUrl: source.url,
    sourceTitle: source.title,
    sourceKind: source.kind,
    sourceImportReceiptPath,
    scriptPath,
    storyboardReceiptPath,
    scriptHash: hashBuffer(scriptBytes),
    frameCount: scripted.frames.length,
    reviewRequired: scripted.review.required,
    cutMode: connector.render.required ? "rendered_media" : input.cutImportMode ?? null,
    connector,
    artifacts,
    warnings
  });
  await writeJson(connectorReceiptPath, receipt);

  return {
    ok: connector.ok,
    source: {
      path: sourcePath,
      url: source.url,
      title: source.title,
      kind: source.kind,
      hash: source.sha256,
      ...(sourceImportReceiptPath ? { importReceiptPath: sourceImportReceiptPath } : {})
    },
    storyboard: {
      scriptPath,
      receiptPath: storyboardReceiptPath,
      frameCount: scripted.frames.length,
      reviewRequired: scripted.review.required
    },
    connector,
    packageDir: connector.packageDir,
    preview: connector.preview,
    render: connector.render,
    cutPlanPath: connector.cutPlanPath,
    artifacts,
    receiptPath: connectorReceiptPath,
    warnings
  };
}

function createSourceStoryboardReceipt(input: {
  sourcePath: string;
  sourceMarkdown: string;
  sourceHash: string;
  sourceUrl: string;
  sourceTitle: string;
  sourceKind: SourceImportKind;
  scriptPath: string;
  scriptBytes: Buffer;
  frameCount: number;
  reviewRequired: boolean;
  createdAt: string;
}): OperationReceipt {
  const sourceMarkdownHash = hashBuffer(Buffer.from(input.sourceMarkdown, "utf8"));
  const output = {
    sourcePath: input.sourcePath,
    scriptPath: input.scriptPath,
    sourceUrl: input.sourceUrl,
    sourceTitle: input.sourceTitle,
    sourceKind: input.sourceKind,
    sourceHash: input.sourceHash,
    scriptHash: hashBuffer(input.scriptBytes),
    frameCount: input.frameCount,
    reviewRequired: input.reviewRequired
  };
  const artifacts: ReceiptArtifact[] = [
    { role: "scripted_video", path: input.scriptPath, status: "available", mediaType: "application/json", primary: true },
    { role: "source_storyboard_receipt", path: join(dirname(input.scriptPath), "receipts", "source-storyboard.receipt.json"), status: "available", mediaType: "application/json" }
  ];
  return {
    schema: "shellx-motion/receipt@1",
    id: `source-storyboard-${hashBuffer(Buffer.from(JSON.stringify({ sourceMarkdownHash, output }), "utf8")).slice(0, 16)}`,
    operation: "source.to_scripted_video",
    status: "passed",
    packageId: "source_storyboard",
    inputHashes: {
      sourceMarkdown: sourceMarkdownHash,
      source: input.sourceHash
    },
    createdAt: input.createdAt,
    lane: "connector",
    output,
    artifacts,
    warnings: []
  };
}

function sourceToCutArtifacts(input: {
  sourcePath: string;
  sourceImportReceiptPath?: string;
  scriptPath: string;
  storyboardReceiptPath: string;
  childArtifacts: ConnectorArtifact[];
  connectorReceiptPath: string;
}): ConnectorArtifact[] {
  const artifacts: ConnectorArtifact[] = [
    { role: "source_markdown", path: input.sourcePath, status: "available", mediaType: "text/markdown", primary: true }
  ];
  if (input.sourceImportReceiptPath) {
    artifacts.push({ role: "source_import_receipt", path: input.sourceImportReceiptPath, status: "available", mediaType: "application/json" });
  }
  artifacts.push(
    { role: "scripted_video", path: input.scriptPath, status: "available", mediaType: "application/json" },
    { role: "source_storyboard_receipt", path: input.storyboardReceiptPath, status: "available", mediaType: "application/json" },
    ...input.childArtifacts,
    { role: "source_to_cut_receipt", path: input.connectorReceiptPath, status: "available", mediaType: "application/json" }
  );
  return artifacts;
}

function createSourceToCutReceipt(input: {
  packageId: string;
  createdAt: string;
  sourcePath: string;
  sourceHash: string;
  sourceUrl: string;
  sourceTitle: string;
  sourceKind: SourceImportKind;
  sourceImportReceiptPath?: string;
  scriptPath: string;
  storyboardReceiptPath: string;
  scriptHash: string;
  frameCount: number;
  reviewRequired: boolean;
  cutMode: string | null;
  connector: ScriptToCutConnectorResult;
  artifacts: ConnectorArtifact[];
  warnings: string[];
}): OperationReceipt {
  return {
    schema: "shellx-motion/receipt@1",
    id: `connector-source-cut-${hashBuffer(Buffer.from(`${input.packageId}:${input.createdAt}`)).slice(0, 16)}`,
    operation: "connector.source_to_cut",
    status: connectorReceiptStatus({ failed: !input.connector.ok, warnings: input.warnings }),
    packageId: input.packageId,
    inputHashes: {
      source: input.sourceHash,
      script: input.scriptHash
    },
    createdAt: input.createdAt,
    lane: "connector",
    output: {
      artifacts: input.artifacts,
      source: {
        path: input.sourcePath,
        url: input.sourceUrl,
        title: input.sourceTitle,
        kind: input.sourceKind,
        hash: input.sourceHash,
        ...(input.sourceImportReceiptPath ? { importReceiptPath: input.sourceImportReceiptPath } : {})
      },
      storyboard: {
        scriptPath: input.scriptPath,
        receiptPath: input.storyboardReceiptPath,
        frameCount: input.frameCount,
        reviewRequired: input.reviewRequired
      },
      connector: {
        receiptPath: input.connector.receiptPath,
        packageDir: input.connector.packageDir
      },
      preview: input.connector.preview,
      render: input.connector.render,
      cut: {
        ok: input.connector.ok,
        mode: input.cutMode,
        planPath: input.connector.cutPlanPath
      }
    },
    warnings: input.warnings
  };
}

async function existingSourceImportReceiptPath(sourcePath: string): Promise<string | undefined> {
  const receiptPath = join(dirname(sourcePath), "receipts", "source-import.receipt.json");
  try {
    await access(receiptPath);
    return receiptPath;
  } catch {
    return undefined;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
