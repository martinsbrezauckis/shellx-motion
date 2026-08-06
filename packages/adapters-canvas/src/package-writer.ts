import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { CanvasMotionExport } from "./index";

export interface WriteCanvasMotionPackageOptions {
  packageDir: string;
  sourceRoot?: string;
}

export interface WrittenCanvasMotionPackage {
  packageDir: string;
  manifestPath: string;
  motionPath: string;
  receiptPath: string;
  resourceCatalogPath: string;
  assetRefs: string[];
  copiedAssetRefs: string[];
  missingAssetRefs: string[];
}

export async function writeCanvasMotionPackage(
  canvasExport: CanvasMotionExport,
  options: WriteCanvasMotionPackageOptions
): Promise<WrittenCanvasMotionPackage> {
  const packageDir = resolve(options.packageDir);
  const manifestPath = join(packageDir, "manifest.json");
  const motionPath = join(packageDir, canvasExport.manifest.motion);
  const receiptPath = join(packageDir, "receipts", "canvas-export.receipt.json");
  const resourceCatalogPath = join(packageDir, "resource-catalog.json");

  await mkdir(join(packageDir, "receipts"), { recursive: true });
  await writeJson(manifestPath, canvasExport.manifest);
  await writeJson(motionPath, canvasExport.motion);
  await writeJson(receiptPath, canvasExport.receipt);
  await writeJson(resourceCatalogPath, buildResourceCatalog(canvasExport));
  const copied = await copyPackageAssets(canvasExport.manifest.assets, {
    packageDir,
    sourceRoot: options.sourceRoot,
    expectedSha256ByRef: expectedAssetHashes(canvasExport)
  });

  return {
    packageDir,
    manifestPath,
    motionPath,
    receiptPath,
    resourceCatalogPath,
    assetRefs: canvasExport.manifest.assets,
    copiedAssetRefs: copied.copiedAssetRefs,
    missingAssetRefs: copied.missingAssetRefs
  };
}

async function copyPackageAssets(
  assetRefs: string[],
  options: { packageDir: string; sourceRoot?: string; expectedSha256ByRef: Map<string, string> }
): Promise<{ copiedAssetRefs: string[]; missingAssetRefs: string[] }> {
  if (!options.sourceRoot) {
    return { copiedAssetRefs: [], missingAssetRefs: [] };
  }

  const copiedAssetRefs: string[] = [];
  const missingAssetRefs: string[] = [];
  const sourceRoot = resolve(options.sourceRoot);
  for (const assetRef of assetRefs) {
    const sourcePath = safeResolve(sourceRoot, assetRef);
    const targetPath = safeResolve(options.packageDir, assetRef);
    try {
      const expectedSha256 = options.expectedSha256ByRef.get(assetRef);
      if (expectedSha256) {
        const actualSha256 = await hashFileSha256(sourcePath);
        if (actualSha256 !== expectedSha256) {
          throw new Error(`Canvas asset hash mismatch for ${assetRef}: expected ${expectedSha256}, got ${actualSha256}.`);
        }
      }
      await mkdir(dirname(targetPath), { recursive: true });
      await copyFile(sourcePath, targetPath);
      copiedAssetRefs.push(assetRef);
    } catch (error) {
      if (isMissingFile(error)) {
        missingAssetRefs.push(assetRef);
        continue;
      }
      throw error;
    }
  }

  return { copiedAssetRefs, missingAssetRefs };
}

function expectedAssetHashes(canvasExport: CanvasMotionExport): Map<string, string> {
  const hashes = new Map<string, string>();
  for (const assetValue of canvasExport.motion.assets ?? []) {
    const asset = readRecord(assetValue);
    if (!asset) continue;
    const source = readRecord(asset.source);
    const hash = readRecord(asset.hash);
    if (typeof source?.path !== "string") continue;
    if (typeof hash?.sha256 !== "string" || hash.sha256.length === 0) continue;
    if (!/^[a-f0-9]{64}$/i.test(hash.sha256)) continue;
    hashes.set(source.path, hash.sha256.toLowerCase());
  }
  return hashes;
}

async function hashFileSha256(path: string): Promise<string> {
  return await new Promise((resolveHash, rejectHash) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", rejectHash);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

function buildResourceCatalog(canvasExport: CanvasMotionExport): Record<string, unknown> {
  return {
    schema: "shellx-motion/resource-catalog@1",
    packageId: canvasExport.manifest.id,
    sourceApp: canvasExport.manifest.sourceApp,
    resources: [
      motionPackageCatalogResource(canvasExport),
      ...canvasExport.motion.assets
        .flatMap((assetValue) => {
          const asset = readRecord(assetValue);
          if (!asset) return [];
          const source = readRecord(asset.source) ?? {};
          const hash = readRecord(asset.hash) ?? {};
          const provenance = readRecord(asset.provenance) ?? {};
          return {
            id: typeof asset.id === "string" ? asset.id : "",
            ref: typeof source.path === "string" ? source.path : "",
            kind: typeof asset.kind === "string" ? asset.kind : "unknown",
            mimeType: typeof source.mimeType === "string" ? source.mimeType : undefined,
            sha256: typeof hash.sha256 === "string" ? hash.sha256 : undefined,
            source: {
              app: typeof source.app === "string" ? source.app : canvasExport.manifest.sourceApp,
              sourceFrameId: typeof provenance.sourceFrameId === "string" ? provenance.sourceFrameId : undefined,
              receiptId: typeof provenance.receiptId === "string" ? provenance.receiptId : undefined
            }
          };
        })
        .filter((resource) => resource.id && resource.ref)
    ]
  };
}

function motionPackageCatalogResource(canvasExport: CanvasMotionExport): Record<string, unknown> {
  const motionProvenance = readRecord(canvasExport.motion.provenance) ?? {};
  const selectedFrameId = typeof canvasExport.manifest.selectedFrameId === "string"
    ? canvasExport.manifest.selectedFrameId
    : typeof motionProvenance.selectedFrameId === "string"
      ? motionProvenance.selectedFrameId
      : undefined;
  return {
    id: canvasExport.manifest.id,
    ref: ".",
    kind: "motion_package",
    source: {
      app: canvasExport.manifest.sourceApp,
      ...(selectedFrameId ? { sourceFrameId: selectedFrameId } : {}),
      receiptId: canvasExport.receipt.id
    }
  };
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function safeResolve(root: string, assetRef: string): string {
  const resolvedRoot = resolve(root);
  const resolved = resolve(resolvedRoot, assetRef);
  const rootWithSep = resolvedRoot.endsWith(sep) ? resolvedRoot : `${resolvedRoot}${sep}`;
  if (resolved !== resolvedRoot && !resolved.startsWith(rootWithSep)) {
    throw new Error(`Asset path escapes package root: ${assetRef}`);
  }
  return resolved;
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
