import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ReceiptArtifact } from "@shellx-motion/core";

/** Return a normalized leaf below the final capture directory, or reject an escape/equal path. */
export function captureBundleRelativePath(outputDir: string, candidatePath: string): string | undefined {
  const path = relative(outputDir, candidatePath).split(sep).join("/");
  if (!path || path === ".." || path.startsWith("../") || isAbsolute(path)) return undefined;
  if (path.split("/").some((part) => !part || part === "." || part === "..")) return undefined;
  return path;
}

/** Paths overlap when either one could shadow the other's file or directory leaf. */
export function capturePathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

/** A mutable workflow catalog is a post-bundle observer, never a bundle leaf. */
export function captureCatalogIsExternal(outputDir: string, catalogPath: string): boolean {
  return resolve(outputDir) !== resolve(catalogPath) && captureBundleRelativePath(outputDir, catalogPath) === undefined;
}

export interface MappedCaptureBundleArtifact {
  artifact: ReceiptArtifact;
  stagePath: string;
  publicPath: string;
  relativePath: string;
}

/** Bind renderer-owned evidence to one regular leaf under the private capture stage. */
export function mapCaptureBundleArtifacts(
  stagingDir: string,
  outputDir: string,
  artifacts: readonly ReceiptArtifact[]
): MappedCaptureBundleArtifact[] {
  return artifacts.map((artifact) => {
    const relativePath = captureBundleRelativePath(stagingDir, artifact.path);
    if (!relativePath || artifact.status !== "available") {
      throw new Error("Browser renderer artifact must be an available regular leaf below the private capture bundle stage.");
    }
    const stagePath = join(resolve(stagingDir), relativePath);
    const publicPath = join(resolve(outputDir), relativePath);
    return { artifact: { ...artifact, path: publicPath }, stagePath, publicPath, relativePath };
  });
}

/** Build the exact regular-file inventory accepted by the governed directory publication. */
export function closedCaptureBundleInventory(outputDir: string, finalPaths: readonly string[]): string[] {
  const inventory = finalPaths.map((path) => captureBundleRelativePath(outputDir, path));
  if (inventory.some((path) => !path) || new Set(inventory).size !== inventory.length
    || inventory.some((path, index) => inventory.slice(index + 1).some((other) => capturePathsOverlap(path!, other!)))) {
    throw new Error("Capture bundle inventory contains an escaped, empty, duplicate, or overlapping leaf.");
  }
  return inventory as string[];
}
