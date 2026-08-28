import { lstat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  loadMotionPackage,
  loadSchema,
  readBoundedStableFile,
  type OperationReceipt,
  type ReceiptArtifact,
  validateDocument
} from "@shellx-motion/core";
import {
  HTML_SNIPPET_IMPORT_RECEIPT_FILE,
  MAX_HTML_SNIPPET_BYTES,
  MOTION_PACKAGE_MEDIA_TYPE,
  type HtmlSnippetImportOptions,
  type HtmlSnippetImportResult
} from "./html-snippet-types.js";
import { stageHtmlSnippetAssets } from "./html-snippet-import-assets.js";
import { parseHtmlSnippet } from "./html-snippet-import-parse.js";
import { HtmlSnippetOutputTransaction } from "./html-snippet-output-transaction.js";

export async function importHtmlSnippetToMotionPackage(options: HtmlSnippetImportOptions): Promise<HtmlSnippetImportResult> {
  const htmlPath = resolve(options.htmlPath);
  const packageDir = resolve(options.packageDir);

  const htmlInfo = await lstat(htmlPath);
  if (!htmlInfo.isFile() || htmlInfo.isSymbolicLink()) throw new Error("HTML snippet import requires a regular HTML file.");
  if (htmlInfo.size > MAX_HTML_SNIPPET_BYTES) throw new Error("HTML snippet import source exceeds the 8 MiB limit.");
  const htmlSource = await readBoundedStableFile(htmlPath, {
    label: "HTML snippet import source",
    maxBytes: MAX_HTML_SNIPPET_BYTES,
    withinRoot: dirname(htmlPath),
    allowRootAlias: true,
  });
  const html = htmlSource.bytes.toString("utf8");
  const imported = parseHtmlSnippet(html, { createdBy: options.createdBy ?? "html-adapter" });
  const validation = await validateDocument(await loadSchema("motion"), imported.motion);
  if (!validation.ok) {
    const summary = validation.errors.slice(0, 8).map((error) => `${error.path}: ${error.message}`).join(", ");
    throw new Error(`HTML snippet import produced an invalid Motion document: ${summary}.`);
  }
  const manifestPath = join(packageDir, "manifest.json");
  const motionPath = join(packageDir, imported.manifest.motion);
  const receiptPath = join(packageDir, "receipts", HTML_SNIPPET_IMPORT_RECEIPT_FILE);
  const artifacts: ReceiptArtifact[] = [
    { role: "motion_package", path: packageDir, status: "available", mediaType: MOTION_PACKAGE_MEDIA_TYPE, primary: true },
    { role: "html_snippet_import_receipt", path: receiptPath, status: "available", mediaType: "application/json" }
  ];
  let stagedAssets: Array<{ path: string; sha256: string; size: number }>;
  const receipt: OperationReceipt = {
    schema: "shellx-motion/receipt@1",
    id: `html-snippet-import-${imported.manifest.id}`,
    operation: "html.snippet.import",
    status: imported.lossiness.length > 0 ? "warning" : "passed",
    packageId: imported.manifest.id,
    inputHashes: { [htmlPath]: htmlSource.sha256 },
    createdAt: options.createdAt ?? new Date().toISOString(),
    lane: "html",
    output: {
      htmlPath,
      motionPath,
      layerCount: imported.motion.layers.length,
      warningCount: imported.lossiness.length,
      stagedAssets: [],
      lossiness: { unsupported: imported.lossiness }
    },
    artifacts,
    warnings: imported.lossiness.map((finding) => `${finding.path}: ${finding.reason}`)
  };

  let transaction: HtmlSnippetOutputTransaction | undefined;
  try {
    transaction = await HtmlSnippetOutputTransaction.acquire(packageDir);
    stagedAssets = await stageHtmlSnippetAssets({ htmlPath, transaction, assetRefs: imported.manifest.assets });
    receipt.inputHashes = {
      [htmlPath]: htmlSource.sha256,
      ...Object.fromEntries(stagedAssets.map((asset) => [asset.path, asset.sha256]))
    };
    receipt.output = {
      htmlPath,
      motionPath,
      layerCount: imported.motion.layers.length,
      warningCount: imported.lossiness.length,
      stagedAssets,
      lossiness: { unsupported: imported.lossiness }
    };
    await transaction.writeFile("manifest.json", jsonBytes(imported.manifest));
    await transaction.writeFile(imported.manifest.motion, jsonBytes(imported.motion));
    await transaction.writeFile(`receipts/${HTML_SNIPPET_IMPORT_RECEIPT_FILE}`, jsonBytes(receipt));
    await loadMotionPackage(transaction.stagePath);
    await transaction.publish();
  } catch (error) {
    await transaction?.abort().catch(() => undefined);
    throw error;
  }
  return {
    ok: true,
    packageDir,
    packageId: imported.manifest.id,
    manifestPath,
    motionPath,
    receiptPath,
    receipt,
    layerCount: imported.motion.layers.length,
    warningCount: imported.lossiness.length,
    stagedAssetCount: stagedAssets.length,
    stagedAssets: stagedAssets!,
    artifacts,
    warnings: receipt.warnings
  };
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}
