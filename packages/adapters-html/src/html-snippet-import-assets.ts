import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath, stat, type FileHandle } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { hashBuffer } from "@shellx-motion/core";
import {
  MAX_HTML_ASSET_BYTES,
  MAX_HTML_TOTAL_ASSET_BYTES
} from "./html-snippet-types.js";
import { assertSafeHtmlMediaAsset, pathIsInside } from "./html-snippet-shared.js";
import { HtmlSnippetOutputTransaction } from "./html-snippet-output-transaction.js";

/** Stage each declared asset from the verified descriptor rather than resolving its path twice. */
export async function stageHtmlSnippetAssets(input: {
  htmlPath: string;
  transaction: HtmlSnippetOutputTransaction;
  assetRefs: string[];
}): Promise<Array<{ path: string; sha256: string; size: number }>> {
  const sourceRoot = await realpath(dirname(input.htmlPath));
  const staged: Array<{ path: string; sha256: string; size: number }> = [];
  let totalBytes = 0;
  for (const assetRef of input.assetRefs) {
    const declaredExtension = extname(assetRef).toLowerCase();
    const destination = resolve(input.transaction.stagePath, ...assetRef.split("/"));
    if (!pathIsInside(input.transaction.stagePath, destination)) {
      throw new Error(`HTML snippet import asset destination escapes packageDir: ${assetRef}.`);
    }
    const handle = await openValidatedSnippetAsset(sourceRoot, assetRef, declaredExtension);
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error(`HTML snippet import asset must be a regular file: ${assetRef}.`);
      if (info.size > MAX_HTML_ASSET_BYTES) throw new Error(`HTML snippet import asset exceeds the 256 MiB limit: ${assetRef}.`);
      totalBytes += info.size;
      if (totalBytes > MAX_HTML_TOTAL_ASSET_BYTES) throw new Error("HTML snippet import assets exceed the 512 MiB total limit.");
      if (declaredExtension === ".svg") {
        const bytes = await handle.readFile();
        assertSafeHtmlMediaAsset(assetRef, bytes, `HTML snippet import asset ${assetRef}`);
        await input.transaction.writeFile(assetRef, bytes);
        staged.push({ path: assetRef, sha256: hashBuffer(bytes), size: bytes.byteLength });
      } else {
        staged.push({ path: assetRef, ...await input.transaction.copyFromDescriptor(assetRef, handle, info.size, assetRef) });
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
  }
  return staged;
}

/**
 * Resolve and open one asset once, proving the descriptor is still the canonical in-root regular
 * file whose declared and resolved extensions agree. The caller owns the returned descriptor.
 */
async function openValidatedSnippetAsset(sourceRoot: string, assetRef: string, declaredExtension: string): Promise<FileHandle> {
  const sourceCandidate = resolve(sourceRoot, ...assetRef.split("/"));
  const sourcePath = await realpath(sourceCandidate).catch(() => {
    throw new Error(`HTML snippet import asset is missing: ${assetRef}.`);
  });
  if (!pathIsInside(sourceRoot, sourcePath)) {
    throw new Error(`HTML snippet import asset escapes the source directory: ${assetRef}.`);
  }
  if (extname(sourcePath).toLowerCase() !== declaredExtension) {
    throw new Error(`HTML snippet import asset extension changes through a symlink: ${assetRef}.`);
  }
  const linkInfo = await lstat(sourcePath);
  if (!linkInfo.isFile() || linkInfo.isSymbolicLink()) {
    throw new Error(`HTML snippet import asset must be a regular file: ${assetRef}.`);
  }
  const handle = await open(sourcePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch(() => {
    throw new Error(`HTML snippet import asset could not be opened: ${assetRef}.`);
  });
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== linkInfo.dev || opened.ino !== linkInfo.ino) {
      throw new Error(`HTML snippet import asset changed before it could be staged: ${assetRef}.`);
    }
    const recheckPath = await realpath(sourceCandidate);
    const recheckInfo = await lstat(recheckPath);
    if (recheckPath !== sourcePath
      || !pathIsInside(sourceRoot, recheckPath)
      || recheckInfo.dev !== opened.dev
      || recheckInfo.ino !== opened.ino) {
      throw new Error(`HTML snippet import asset changed before it could be staged: ${assetRef}.`);
    }
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
  return handle;
}
