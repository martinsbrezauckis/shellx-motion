import { lstat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import {
  BoundedResourceBudget,
  DEFAULT_PACKAGE_ARCHIVE_WRITE_LIMITS,
  buildScriptedVideoFromSourceImport,
  hashBuffer,
  readBudgetedStableFile,
  readSourceImportDocumentFromMarkdown,
  type OperationReceipt,
  type SourceImportKind
} from "@shellx-motion/core";
import { connectorReceiptStatus, type ConnectorArtifact } from "./artifacts";
import { throwIfConnectorAborted } from "./connector-cancellation";
import { createPrivateConnectorDelivery } from "./connector-delivery";
import {
  assertNoP2BPrivateDeliveryPath,
  assertP2BExternalInput,
  assertP2BLinuxBeforeInput,
  assertP2BNoExternalPath,
  captureP2BDeliveryLeaf,
  writeP2BDeliveryJson
} from "./p2b-connector-delivery";
import { mergeP2BExpectedInventory, p2bJsonInventoryEntry } from "./p2b-delivery-validation";
import { materializeP2BScriptToCut } from "./script-to-cut-materializer";
import type { ScriptToCutConnectorResult } from "./script-to-cut";
import { readSourceImportReceiptEvidence, type SourceImportReceiptEvidence } from "./source-import-receipt-evidence";

export interface SourceToCutConnectorInput {
  sourcePath: string;
  /** Host-selected authority root containing sourcePath; never derive this inside a remote command. */
  sourceInputRoot: string;
  outDir: string;
  maxFrames?: number;
  frameDurationMs?: number;
  width?: number;
  height?: number;
  fps?: number;
  /** Coordinator-owned cancellation for this private P2B delivery. */
  signal?: AbortSignal;
  /** Explicit compatibility spelling; only real rendered media is accepted. */
  cutImportMode?: "rendered_media";
}

export interface SourceToCutConnectorResult {
  ok: true;
  source: { url: string; title: string; kind: SourceImportKind; hash: string; markdownSha256: string; importReceiptSha256?: string };
  storyboard: { scriptPath: string; receiptPath: string; frameCount: number; reviewRequired: boolean };
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
  throwIfConnectorAborted(input.signal, "before Source-to-Cut admission");
  assertP2BLinuxBeforeInput();
  assertP2BSourceLegacyFields(input);
  const outDir = resolve(input.outDir), sourcePath = resolve(input.sourcePath), sourceInputRoot = resolve(input.sourceInputRoot);
  assertP2BExternalInput(outDir, sourcePath, "Source-to-Cut Markdown input");
  const budget = new BoundedResourceBudget(DEFAULT_PACKAGE_ARCHIVE_WRITE_LIMITS, "Source-to-Cut P2B interchange");
  const sourceInput = await readBudgetedStableFile(sourcePath, { label: "Source Markdown input", budget, withinRoot: sourceInputRoot });
  throwIfConnectorAborted(input.signal, "after Source-to-Cut Markdown admission");
  const sourceImportReceipt = await readSourceImportReceiptEvidence({ sourcePath, sourceInputRoot, sourceMarkdownHash: sourceInput.sha256, budget });
  throwIfConnectorAborted(input.signal, "after Source-to-Cut receipt-evidence admission");
  const source = readSourceImportDocumentFromMarkdown(sourceInput.bytes.toString("utf8"));
  const scripted = buildScriptedVideoFromSourceImport(source, {
    sourcePath: "input/source.md",
    ...(input.maxFrames !== undefined ? { maxFrames: input.maxFrames } : {}),
    ...(input.frameDurationMs !== undefined ? { frameDurationMs: input.frameDurationMs } : {}),
    ...(input.width !== undefined ? { width: input.width } : {}),
    ...(input.height !== undefined ? { height: input.height } : {}),
    ...(input.fps !== undefined ? { fps: input.fps } : {})
  });
  const scriptBytes = Buffer.from(`${JSON.stringify(scripted, null, 2)}\n`, "utf8");
  const createdAt = new Date().toISOString();
  const storyboardDir = join(outDir, "storyboard"), scriptPath = join(storyboardDir, "scripted-video.json");
  const storyboardReceiptPath = join(storyboardDir, "receipts", "source-storyboard.receipt.json");
  const childOutDir = join(outDir, "cut"), connectorReceiptPath = join(outDir, "receipts", "source-to-cut.receipt.json");
  const storyboardReceipt = createSourceStoryboardReceipt({
    sourceMarkdownHash: sourceInput.sha256, sourceHash: source.sha256, sourceUrl: source.url, sourceTitle: source.title,
    sourceKind: source.kind, scriptPath, scriptBytes, frameCount: scripted.frames.length, reviewRequired: scripted.review.required, createdAt
  });
  const delivery = await createPrivateConnectorDelivery(outDir);
  try {
    await writeP2BDeliveryJson(delivery, delivery.stagePath(scriptPath), scripted, true);
    await writeP2BDeliveryJson(delivery, delivery.stagePath(storyboardReceiptPath), storyboardReceipt, true);
    const child = await materializeP2BScriptToCut({
      delivery, outDir: childOutDir, script: scripted,
      inputEvidence: { label: "source-storyboard.json", sha256: hashBuffer(scriptBytes), byteLength: scriptBytes.byteLength },
      externalInputPaths: [sourcePath, ...(sourceImportReceipt ? [sourceImportReceipt.path] : [])],
      outerReservedLeaves: 3,
      packageRootRelativePath: "cut/package",
      createdAt,
      signal: input.signal
    });
    throwIfConnectorAborted(input.signal, "after Source-to-Cut child materialization");
    const childHandleArtifact = child.result.artifacts.find((artifact) => artifact.role === "artifact_handle" && artifact.status === "available");
    if (!childHandleArtifact) throw new Error("Source-to-Cut P2B child is missing its exact artifact-handle evidence.");
    // Re-capture exact F/H/C only after the private child has completed its independent P2B
    // validation.  The parent F below binds these three byte identities before the sole commit.
    const childF = await captureP2BDeliveryLeaf({ delivery, publicPath: child.result.receiptPath, label: "Source-to-Cut child connector receipt" });
    const childH = await captureP2BDeliveryLeaf({ delivery, publicPath: childHandleArtifact.path, label: "Source-to-Cut child artifact handle", maxBytes: 4 * 1024 * 1024 });
    const childC = await captureP2BDeliveryLeaf({ delivery, publicPath: child.result.cutPlanPath, label: "Source-to-Cut child Cut plan" });
    const artifacts = sourceP2BArtifacts({ scriptPath, storyboardReceiptPath, childArtifacts: child.result.artifacts, connectorReceiptPath });
    const warnings = child.result.warnings;
    const connectorReceipt = createSourceToCutReceipt({
      packageId: child.connectorReceipt.packageId, createdAt, sourceMarkdownHash: sourceInput.sha256, sourceHash: source.sha256,
      sourceUrl: source.url, sourceTitle: source.title, sourceKind: source.kind, sourceImportReceipt, scriptPath,
      storyboardReceiptPath, scriptHash: hashBuffer(scriptBytes), frameCount: scripted.frames.length, reviewRequired: scripted.review.required,
      connector: child.result, artifacts, warnings, childF, childH, childC
    });
    await writeP2BDeliveryJson(delivery, delivery.stagePath(connectorReceiptPath), connectorReceipt, true);
    await assertSourceAvailableArtifacts(delivery, artifacts);
    const expectedInventory = mergeP2BExpectedInventory([
      ...child.expectedInventory,
      p2bJsonInventoryEntry(delivery, scriptPath, scripted),
      p2bJsonInventoryEntry(delivery, storyboardReceiptPath, storyboardReceipt),
      p2bJsonInventoryEntry(delivery, connectorReceiptPath, connectorReceipt)
    ]);
    const result: SourceToCutConnectorResult = {
      ok: true,
      source: {
        url: source.url, title: source.title, kind: source.kind, hash: source.sha256, markdownSha256: sourceInput.sha256,
        ...(sourceImportReceipt ? { importReceiptSha256: sourceImportReceipt.sha256 } : {})
      },
      storyboard: { scriptPath, receiptPath: storyboardReceiptPath, frameCount: scripted.frames.length, reviewRequired: scripted.review.required },
      connector: child.result, packageDir: child.result.packageDir, preview: child.result.preview, render: child.result.render,
      cutPlanPath: child.result.cutPlanPath, artifacts, receiptPath: connectorReceiptPath, warnings
    };
    assertNoP2BPrivateDeliveryPath({ result, storyboardReceipt, connectorReceipt }, delivery);
    assertP2BNoExternalPath({ result, storyboardReceipt, connectorReceipt }, [sourcePath, sourceImportReceipt?.path ?? ""], "Source-to-Cut accepted delivery");
    throwIfConnectorAborted(input.signal, "after Source-to-Cut validation and before delivery commit");
    await delivery.commit(expectedInventory);
    return result;
  } catch (error) {
    await delivery.abort();
    throw error;
  }
}

function assertP2BSourceLegacyFields(input: SourceToCutConnectorInput): void {
  const legacy = input as SourceToCutConnectorInput & Record<string, unknown>;
  if (legacy.cutImportMode !== undefined && legacy.cutImportMode !== "rendered_media") throw new Error("Source-to-Cut P2B accepted delivery refuses legacy cutImportMode other than rendered_media.");
  const rejected = ["force", "previewLane", "renderLane", "frameLane", "dryRunRender", "streamingRenderer", "ffmpegRunner", "now"].find((key) => legacy[key] !== undefined);
  if (rejected) throw new Error(`Source-to-Cut P2B accepted delivery does not support legacy ${rejected}; it always produces real Browser-preview and Browser-frame-to-FFmpeg H.264 rendered_media.`);
}

function createSourceStoryboardReceipt(input: {
  sourceMarkdownHash: string; sourceHash: string; sourceUrl: string; sourceTitle: string; sourceKind: SourceImportKind;
  scriptPath: string; scriptBytes: Buffer; frameCount: number; reviewRequired: boolean; createdAt: string;
}): OperationReceipt {
  const output = {
    source: { url: input.sourceUrl, title: input.sourceTitle, kind: input.sourceKind, hash: input.sourceHash },
    scriptPath: input.scriptPath, scriptHash: hashBuffer(input.scriptBytes), frameCount: input.frameCount, reviewRequired: input.reviewRequired
  };
  return {
    schema: "shellx-motion/receipt@1", id: `source-storyboard-${hashBuffer(Buffer.from(JSON.stringify({ sourceMarkdownHash: input.sourceMarkdownHash, output }), "utf8")).slice(0, 16)}`,
    operation: "source.to_scripted_video", status: "passed", packageId: "source_storyboard",
    inputHashes: { sourceMarkdown: input.sourceMarkdownHash, source: input.sourceHash }, createdAt: input.createdAt, lane: "connector",
    output,
    artifacts: [
      { role: "scripted_video", path: input.scriptPath, status: "available", mediaType: "application/json", primary: true },
      { role: "source_storyboard_receipt", path: join(dirnameOf(input.scriptPath), "receipts", "source-storyboard.receipt.json"), status: "available", mediaType: "application/json" }
    ], warnings: []
  };
}

function sourceP2BArtifacts(input: { scriptPath: string; storyboardReceiptPath: string; childArtifacts: ConnectorArtifact[]; connectorReceiptPath: string }): ConnectorArtifact[] {
  return [
    { role: "scripted_video", path: input.scriptPath, status: "available", mediaType: "application/json" },
    { role: "source_storyboard_receipt", path: input.storyboardReceiptPath, status: "available", mediaType: "application/json" },
    ...input.childArtifacts,
    { role: "source_to_cut_receipt", path: input.connectorReceiptPath, status: "available", mediaType: "application/json" }
  ];
}

function createSourceToCutReceipt(input: {
  packageId: string; createdAt: string; sourceMarkdownHash: string; sourceHash: string; sourceUrl: string; sourceTitle: string; sourceKind: SourceImportKind;
  sourceImportReceipt?: SourceImportReceiptEvidence; scriptPath: string; storyboardReceiptPath: string; scriptHash: string; frameCount: number; reviewRequired: boolean;
  connector: ScriptToCutConnectorResult; artifacts: ConnectorArtifact[]; warnings: string[];
  childF: { sha256: string; byteLength: number; path: string }; childH: { sha256: string; byteLength: number; path: string }; childC: { sha256: string; byteLength: number; path: string };
}): OperationReceipt {
  return {
    schema: "shellx-motion/receipt@1", id: `connector-source-cut-${hashBuffer(Buffer.from(`${input.packageId}:${input.createdAt}`)).slice(0, 16)}`,
    operation: "connector.source_to_cut", status: connectorReceiptStatus({ failed: false, warnings: input.warnings }), packageId: input.packageId,
    inputHashes: {
      sourceMarkdown: input.sourceMarkdownHash, source: input.sourceHash, script: input.scriptHash,
      childConnectorReceipt: input.childF.sha256, childArtifactHandle: input.childH.sha256, childCutPlan: input.childC.sha256,
      ...(input.sourceImportReceipt ? { sourceImportReceipt: input.sourceImportReceipt.sha256 } : {})
    }, createdAt: input.createdAt, lane: "connector",
    output: {
      artifacts: input.artifacts,
      source: { url: input.sourceUrl, title: input.sourceTitle, kind: input.sourceKind, hash: input.sourceHash },
      inputEvidence: input.sourceImportReceipt ? { sourceImportReceiptSha256: input.sourceImportReceipt.sha256, sourceImportReceiptByteLength: input.sourceImportReceipt.byteLength } : undefined,
      storyboard: { scriptPath: input.scriptPath, receiptPath: input.storyboardReceiptPath, frameCount: input.frameCount, reviewRequired: input.reviewRequired },
      connector: { receiptPath: input.connector.receiptPath, packageDir: input.connector.packageDir, childF: input.childF, childH: input.childH, childC: input.childC },
      preview: input.connector.preview, render: input.connector.render,
      cut: { ok: true, mode: "rendered_media", planPath: input.connector.cutPlanPath }
    }, warnings: input.warnings
  };
}

async function assertSourceAvailableArtifacts(delivery: { publicRoot: string; stagePath(path: string): string }, artifacts: ConnectorArtifact[]): Promise<void> {
  for (const artifact of artifacts) {
    if (artifact.status !== "available") continue;
    const publicPath = resolve(artifact.path), relation = relative(delivery.publicRoot, publicPath);
    if (!relation || relation === ".." || relation.startsWith(`..${sep}`)) throw new Error(`Source-to-Cut P2B artifact escapes the outer delivery root: ${artifact.role}`);
    const facts = await lstat(delivery.stagePath(publicPath));
    if (facts.isSymbolicLink() || (artifact.role === "motion_package" ? !facts.isDirectory() : !facts.isFile())) throw new Error(`Source-to-Cut P2B artifact is missing or unsafe: ${artifact.role}`);
  }
}

function dirnameOf(path: string): string { return path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))); }
