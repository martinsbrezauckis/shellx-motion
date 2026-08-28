import { constants } from "node:fs";
import { mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import {
  BoundedResourceBudget,
  OutputDirectoryReservation,
  canonicalJsonSha256,
  readBoundedStableFile,
  readBudgetedStableFile,
  type RetainedDirectoryAuthority
} from "@shellx-motion/core";

const BRIDGE_FILE_LIMIT = 4 * 1024 * 1024;
const BRIDGE_GRAPH_LIMIT = 16 * 1024 * 1024;
const BRIDGE_MODULE_LIMIT = 128;

export class CanvasBridgeTrustError extends Error {}

export interface TrustedCanvasBridgeSource {
  canvasRoot: string;
  bridgePath: string;
  serverRoot: string;
  authority: RetainedDirectoryAuthority;
  assertCurrent(): Promise<void>;
}

export async function admitTrustedCanvasBridge(
  canvasRoot: string,
  bridgePath: string,
  trustedRoots: readonly string[]
): Promise<TrustedCanvasBridgeSource> {
  try {
    const authority = await OutputDirectoryReservation.acquire(canvasRoot, {
      allowExistingContents: true,
      requireExisting: true,
      requireExclusiveChildAuthority: true
    });
    const rootPath = await realpath(canvasRoot);
    const trustedRootPaths = await Promise.all(trustedRoots.map(realpathOrResolve));
    if (trustedRootPaths.length === 0 || !trustedRootPaths.some((trustedRoot) => inside(trustedRoot, rootPath))) {
      throw new CanvasBridgeTrustError("Canvas root is not in the trusted Canvas roots allowlist.");
    }
    const appRoot = await realpath(join(rootPath, "app"));
    const serverRoot = await realpath(join(appRoot, "server"));
    const resolvedBridgePath = await realpath(bridgePath);
    if (!inside(rootPath, resolvedBridgePath) || !inside(appRoot, resolvedBridgePath)
      || !inside(serverRoot, resolvedBridgePath) || basename(resolvedBridgePath) !== "motion-package.mjs") {
      throw new CanvasBridgeTrustError("Canvas bridge path resolves outside the Canvas checkout app/server root.");
    }

    const packageSnapshot = await readBoundedStableFile(join(appRoot, "package.json"), {
      label: "Canvas bridge package metadata",
      maxBytes: 64 * 1024,
      withinRoot: rootPath
    });
    if (record(JSON.parse(packageSnapshot.bytes.toString("utf8")))?.name !== "shellx-canvas") {
      throw new CanvasBridgeTrustError("Canvas app package.json is not named shellx-canvas.");
    }
    const bridgeSnapshot = await readBoundedStableFile(resolvedBridgePath, {
      label: "Canvas bridge entry module",
      maxBytes: BRIDGE_FILE_LIMIT,
      withinRoot: rootPath
    });

    const assertCurrent = async (): Promise<void> => {
      try {
        await authority.assertCurrent();
        const [currentPackage, currentBridge] = await Promise.all([
          readBoundedStableFile(join(appRoot, "package.json"), {
            label: "Canvas bridge package metadata",
            maxBytes: 64 * 1024,
            withinRoot: rootPath
          }),
          readBoundedStableFile(resolvedBridgePath, {
            label: "Canvas bridge entry module",
            maxBytes: BRIDGE_FILE_LIMIT,
            withinRoot: rootPath
          })
        ]);
        if (currentPackage.sha256 !== packageSnapshot.sha256 || currentBridge.sha256 !== bridgeSnapshot.sha256) {
          throw new CanvasBridgeTrustError("Canvas bridge source changed after trust admission.");
        }
      } catch (error) {
        if (error instanceof CanvasBridgeTrustError) throw error;
        throw new CanvasBridgeTrustError(error instanceof Error ? error.message : String(error));
      }
    };
    const admitted: TrustedCanvasBridgeSource = {
      canvasRoot: rootPath,
      bridgePath: resolvedBridgePath,
      serverRoot,
      authority,
      assertCurrent
    };
    await admitted.assertCurrent();
    return admitted;
  } catch (error) {
    if (error instanceof CanvasBridgeTrustError) throw error;
    throw new CanvasBridgeTrustError(error instanceof Error ? error.message : String(error));
  }
}

export async function snapshotTrustedCanvasBridge(
  source: TrustedCanvasBridgeSource,
  snapshotRoot: string
): Promise<{ bridgePath: string; bridgeSha256: string }> {
  await source.assertCurrent();
  const entries = await readdir(source.serverRoot, { withFileTypes: true });
  const moduleNames = entries
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(".mjs"))
    .map((entry) => entry.name)
    .sort();
  if (!moduleNames.includes("motion-package.mjs") || moduleNames.length > BRIDGE_MODULE_LIMIT) {
    throw new CanvasBridgeTrustError("Canvas bridge module graph is missing or exceeds its bounded module limit.");
  }
  await mkdir(snapshotRoot, { mode: 0o700 });
  const budget = new BoundedResourceBudget({
    maxFileBytes: BRIDGE_FILE_LIMIT,
    maxFiles: BRIDGE_MODULE_LIMIT,
    maxPathDepth: 1,
    maxAggregateBytes: BRIDGE_GRAPH_LIMIT,
    maxConcurrentReads: 1
  }, "Canvas bridge module graph");
  const moduleHashes: Array<{ path: string; sha256: string }> = [];
  for (const name of moduleNames) {
    const loaded = await readBudgetedStableFile(join(source.serverRoot, name), {
      label: "Canvas bridge module",
      budget,
      withinRoot: source.serverRoot
    });
    await writeFile(join(snapshotRoot, name), loaded.bytes, {
      flag: constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      mode: 0o600
    });
    moduleHashes.push({ path: name, sha256: loaded.sha256 });
  }
  await source.assertCurrent();
  const namesAfter = (await readdir(source.serverRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(".mjs"))
    .map((entry) => entry.name)
    .sort();
  if (JSON.stringify(namesAfter) !== JSON.stringify(moduleNames)) {
    throw new CanvasBridgeTrustError("Canvas bridge module graph changed while it was snapshotted.");
  }
  return {
    bridgePath: join(snapshotRoot, "motion-package.mjs"),
    bridgeSha256: canonicalJsonSha256(moduleHashes)
  };
}

async function realpathOrResolve(path: string): Promise<string> {
  try {
    return await realpath(resolve(path));
  } catch {
    return resolve(path);
  }
}

function inside(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
