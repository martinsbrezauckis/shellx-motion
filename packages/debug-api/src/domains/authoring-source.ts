import {
  buildScriptedVideoFromSourceImport,
  buildSourceImportDocument,
  DEFAULT_HOST_INTERCHANGE_LIMITS,
  hashBuffer,
  OutputDirectoryTransaction,
  readBoundedStableFile,
  readSourceImportDocumentFromMarkdown,
  type OperationReceipt,
  type SourceImportKind,
  type fetchSourceDocument
} from "@shellx-motion/core";
import { join, resolve } from "node:path";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import { positiveIntegerArg, positiveNumberArg, stringArg } from "./args.js";
import { assertConfiguredAuthoringInputFile, assertConfiguredAuthoringOutputRoot, configuredAuthoringInputRoot } from "./authoring-root-policy.js";
import { sourceAuthoringCommandFailure, sourceCommittedObserverFailure } from "./authoring-source-publication-failure.js";

export interface SourceAuthoringServices {
  authoringInputRoots?: string[];
  authoringOutputRoots?: string[];
  receiptsRoot?: string;
  fetchSource?: (url: string) => ReturnType<typeof fetchSourceDocument>;
  isEmptyOrAbsentDirectory?: (path: string) => Promise<boolean>;
  readSourceMarkdown?: (path: string, roots: string[] | undefined) => Promise<{ text: string; sha256: string }>;
  writeText?: (path: string, value: string) => Promise<void>;
  writeJson?: (path: string, value: unknown) => Promise<void>;
  writeReceipt?: (root: string, receipt: OperationReceipt) => Promise<string>;
}

export async function dispatchSourceAuthoringCommand(
  command: MotionDebugCommand,
  args: unknown,
  services: SourceAuthoringServices
): Promise<MotionDebugResult | null> {
  if (command === "motion.source.import") return importSource(args, services);
  if (command === "motion.source.to_scripted_video") return sourceToScriptedVideo(args, services);
  return null;
}

async function importSource(args: unknown, services: SourceAuthoringServices): Promise<MotionDebugResult> {
  const url = stringArg(args, "url");
  const outDir = stringArg(args, "outDir");
  const receiptsRoot = stringArg(args, "receiptsRoot") ?? services.receiptsRoot;
  const markdownArg = stringArg(args, "markdown") ?? undefined;
  const title = stringArg(args, "title") ?? undefined;
  const kindArg = stringArg(args, "kind") ?? undefined;
  const createdBy = stringArg(args, "createdBy") ?? undefined;
  const maxChars = positiveNumberArg(args, "maxChars");
  if (!url) return invalidArgs("motion.source.import requires url.");
  if (!outDir) return invalidArgs("motion.source.import requires outDir.");
  if (maxChars === false) return invalidArgs("maxChars must be a positive number.");
  const kind = readSourceImportKind(kindArg);
  if (kind === false) return invalidArgs("kind must be article, repo, or text.");
  if (markdownArg === undefined && !services.fetchSource) return capabilityUnavailable("Secure source fetching is unavailable.");
  if (!services.isEmptyOrAbsentDirectory || !services.writeText || !services.writeJson) {
    return capabilityUnavailable("Source import artifact persistence is unavailable.");
  }
  if (!services.authoringOutputRoots?.length) {
    return capabilityUnavailable("Source import requires host-approved authoring output roots.");
  }
  if (receiptsRoot && !services.writeReceipt) return capabilityUnavailable("Source import receipt persistence is unavailable.");

  let source;
  try {
    const fetched = markdownArg === undefined ? await services.fetchSource!(url) : undefined;
    source = buildSourceImportDocument({
      url,
      title: title ?? fetched?.title,
      kind: kind ?? fetched?.kind,
      markdown: markdownArg ?? fetched?.markdown ?? "",
      ...(maxChars !== null ? { maxChars } : {})
    });
  } catch (error) {
    return invalidArgs(error instanceof Error ? error.message : String(error));
  }

  try {
    const sourceDir = resolve(outDir);
    await assertConfiguredAuthoringOutputRoot(sourceDir, services.authoringOutputRoots, "Source import output");
    if (!await services.isEmptyOrAbsentDirectory(sourceDir)) {
      return invalidArgs("motion.source.import outDir must be empty or absent before source import.");
    }
    const transaction = await OutputDirectoryTransaction.create(sourceDir);
    const markdownPath = join(sourceDir, "source.md");
    const receiptPath = join(sourceDir, "receipts", "source-import.receipt.json");
    const stagedMarkdownPath = join(transaction.stagingPath, "source.md");
    const stagedReceiptPath = join(transaction.stagingPath, "receipts", "source-import.receipt.json");
    const output = {
      url: source.url,
      title: source.title,
      kind: source.kind,
      markdownPath,
      sourceHash: source.sha256,
      truncated: source.truncated,
      sourceChars: source.sourceChars,
      keptChars: source.keptChars,
      safeFetchPolicy: "public-http-only",
      ...(createdBy ? { createdBy } : {})
    };
    const artifacts = [
      { role: "source_markdown", path: markdownPath, status: "available" as const, mediaType: "text/markdown", primary: true },
      { role: "source_import_receipt", path: receiptPath, status: "available" as const, mediaType: "application/json" }
    ];
    const inputHashes = { url: hashBuffer(Buffer.from(source.url, "utf8")), source: source.sha256 };
    const receipt: OperationReceipt = {
      schema: "shellx-motion/receipt@1",
      id: `source-import-${hashBuffer(Buffer.from(JSON.stringify({ inputHashes, output }), "utf8")).slice(0, 16)}`,
      operation: "source.import",
      status: "passed",
      packageId: "source_import",
      inputHashes,
      createdAt: new Date().toISOString(),
      lane: "debug-api",
      output,
      artifacts,
      warnings: []
    };
    try {
      await services.writeText(stagedMarkdownPath, source.markdown);
      await services.writeJson(stagedReceiptPath, receipt);
      await transaction.assertCurrent();
      await transaction.commit();
      await transaction.assertPublishedCurrent();
    } catch (error) {
      await transaction.abort();
      throw error;
    }
    let hostReceiptPath: string | undefined;
    try {
      hostReceiptPath = receiptsRoot ? await services.writeReceipt!(receiptsRoot, receipt) : undefined;
    } catch (error) {
      return sourceCommittedObserverFailure("source_import_receipt_observer_failed", error, {
        outputPath: sourceDir,
        receiptPath,
        receipt,
        artifacts,
        output
      });
    }
    return {
      ok: true,
      receiptId: receipt.id,
      visibleState: {
        panel: "receipts",
        operation: "source.import",
        url: source.url,
        kind: source.kind,
        markdownPath,
        receiptPath,
        truncated: source.truncated,
        ...(hostReceiptPath ? { hostReceiptPath } : {})
      },
      result: { ok: true, ...output, receiptPath, ...(hostReceiptPath ? { hostReceiptPath } : {}), artifacts, receipt },
      warnings: []
    };
  } catch (error) {
    return sourceAuthoringCommandFailure("source_import_failed", error);
  }
}

async function sourceToScriptedVideo(args: unknown, services: SourceAuthoringServices): Promise<MotionDebugResult> {
  const sourcePathArg = stringArg(args, "sourcePath") ?? stringArg(args, "source") ?? stringArg(args, "sourceMarkdownPath");
  const outDir = stringArg(args, "outDir");
  const receiptsRoot = stringArg(args, "receiptsRoot") ?? services.receiptsRoot;
  const maxFrames = positiveIntegerArg(args, "maxFrames");
  const frameDurationMs = positiveIntegerArg(args, "frameDurationMs");
  const width = positiveIntegerArg(args, "width");
  const height = positiveIntegerArg(args, "height");
  const fps = positiveIntegerArg(args, "fps");
  const createdBy = stringArg(args, "createdBy") ?? undefined;
  if (!sourcePathArg) return invalidArgs("motion.source.to_scripted_video requires sourcePath.");
  if (!outDir) return invalidArgs("motion.source.to_scripted_video requires outDir.");
  for (const [label, value] of [["maxFrames", maxFrames], ["frameDurationMs", frameDurationMs], ["width", width], ["height", height], ["fps", fps]] as const) {
    if (value === false) return invalidArgs(`${label} must be a positive integer.`);
  }
  if (!services.isEmptyOrAbsentDirectory || !services.readSourceMarkdown || !services.writeJson) {
    return capabilityUnavailable("Source storyboard artifact persistence is unavailable.");
  }
  if (!services.authoringInputRoots?.length) {
    return capabilityUnavailable("Source storyboard planning requires host-approved authoring input roots.");
  }
  if (!services.authoringOutputRoots?.length) {
    return capabilityUnavailable("Source storyboard planning requires host-approved authoring output roots.");
  }
  if (receiptsRoot && !services.writeReceipt) return capabilityUnavailable("Source storyboard receipt persistence is unavailable.");

  try {
    const sourcePath = resolve(sourcePathArg);
    const storyboardDir = resolve(outDir);
    await assertConfiguredAuthoringOutputRoot(storyboardDir, services.authoringOutputRoots, "Source storyboard output");
    if (!await services.isEmptyOrAbsentDirectory(storyboardDir)) {
      return invalidArgs("motion.source.to_scripted_video outDir must be empty or absent before storyboard planning.");
    }
    const sourceSnapshot = await services.readSourceMarkdown(sourcePath, services.authoringInputRoots);
    const markdown = sourceSnapshot.text;
    const source = readSourceImportDocumentFromMarkdown(markdown);
    const scripted = buildScriptedVideoFromSourceImport(source, {
      sourcePath,
      ...(typeof maxFrames === "number" ? { maxFrames } : {}),
      ...(typeof frameDurationMs === "number" ? { frameDurationMs } : {}),
      ...(typeof width === "number" ? { width } : {}),
      ...(typeof height === "number" ? { height } : {}),
      ...(typeof fps === "number" ? { fps } : {})
    });
    const scriptPath = join(storyboardDir, "scripted-video.json");
    const receiptPath = join(storyboardDir, "receipts", "source-storyboard.receipt.json");
    const transaction = await OutputDirectoryTransaction.create(storyboardDir);
    const scriptBytes = Buffer.from(`${JSON.stringify(scripted, null, 2)}\n`, "utf8");
    const inputHashes = { sourceMarkdown: sourceSnapshot.sha256, source: source.sha256 };
    const output = {
      sourcePath,
      scriptPath,
      sourceUrl: source.url,
      sourceTitle: source.title,
      sourceKind: source.kind,
      sourceHash: source.sha256,
      scriptHash: hashBuffer(scriptBytes),
      frameCount: scripted.frames.length,
      reviewRequired: scripted.review.required,
      ...(createdBy ? { createdBy } : {})
    };
    const artifacts = [
      { role: "scripted_video", path: scriptPath, status: "available" as const, mediaType: "application/json", primary: true },
      { role: "source_storyboard_receipt", path: receiptPath, status: "available" as const, mediaType: "application/json" }
    ];
    const receipt: OperationReceipt = {
      schema: "shellx-motion/receipt@1",
      id: `source-storyboard-${hashBuffer(Buffer.from(JSON.stringify({ inputHashes, output }), "utf8")).slice(0, 16)}`,
      operation: "source.to_scripted_video",
      status: "passed",
      packageId: "source_storyboard",
      inputHashes,
      createdAt: new Date().toISOString(),
      lane: "debug-api",
      output,
      artifacts,
      warnings: []
    };
    try {
      await services.writeJson(join(transaction.stagingPath, "scripted-video.json"), scripted);
      await services.writeJson(join(transaction.stagingPath, "receipts", "source-storyboard.receipt.json"), receipt);
      await transaction.assertCurrent();
      await transaction.commit();
      await transaction.assertPublishedCurrent();
    } catch (error) {
      await transaction.abort();
      throw error;
    }
    let hostReceiptPath: string | undefined;
    try {
      hostReceiptPath = receiptsRoot ? await services.writeReceipt!(receiptsRoot, receipt) : undefined;
    } catch (error) {
      return sourceCommittedObserverFailure("source_storyboard_receipt_observer_failed", error, {
        outputPath: storyboardDir,
        receiptPath,
        receipt,
        artifacts,
        output: { sourcePath, scriptPath, frameCount: scripted.frames.length, reviewRequired: scripted.review.required, scripted }
      });
    }
    return {
      ok: true,
      receiptId: receipt.id,
      visibleState: {
        panel: "receipts",
        operation: "source.to_scripted_video",
        sourcePath,
        scriptPath,
        receiptPath,
        frameCount: scripted.frames.length,
        reviewRequired: scripted.review.required,
        ...(hostReceiptPath ? { hostReceiptPath } : {})
      },
      result: {
        ok: true,
        sourcePath,
        scriptPath,
        receiptPath,
        frameCount: scripted.frames.length,
        reviewRequired: scripted.review.required,
        scripted,
        artifacts,
        receipt,
        ...(hostReceiptPath ? { hostReceiptPath } : {})
      },
      warnings: []
    };
  } catch (error) {
    return sourceAuthoringCommandFailure("source_storyboard_failed", error);
  }
}

export async function readApprovedSourceMarkdown(
  path: string,
  roots: string[] | undefined,
): Promise<{ text: string; sha256: string }> {
  await assertConfiguredAuthoringInputFile(path, roots, "Source Markdown");
  const lexical = resolve(path);
  const approvedRoot = configuredAuthoringInputRoot(lexical, roots, "Source Markdown");
  const snapshot = await readBoundedStableFile(lexical, {
    label: "Source Markdown",
    maxBytes: DEFAULT_HOST_INTERCHANGE_LIMITS.maxFileBytes,
    withinRoot: approvedRoot,
  });
  return { text: snapshot.bytes.toString("utf8"), sha256: snapshot.sha256 };
}

function readSourceImportKind(value: string | undefined): SourceImportKind | undefined | false {
  if (value === undefined) return undefined;
  return value === "article" || value === "repo" || value === "text" ? value : false;
}

function invalidArgs(message: string): MotionDebugResult {
  return { ok: false, error: { code: "invalid_args", message }, warnings: [] };
}

function capabilityUnavailable(message: string): MotionDebugResult {
  return {
    ok: false,
    error: { code: "capability_unavailable", message, suggestedAction: "Configure the required host capability and retry." },
    warnings: []
  };
}
