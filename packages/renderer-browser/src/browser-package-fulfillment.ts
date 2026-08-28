/**
 * Browser package bytes are consumed through this bounded stable-read cache,
 * never by Chromium reopening a package pathname.  A file is admitted once,
 * retained with its hash, and later fulfilled from those exact bytes.
 */
import { BoundedResourceBudget, canonicalJsonSha256, readBudgetedStableFile, type MotionPackage, type StableFileReadResult } from "@shellx-motion/core";
import { admittedPackageExecutionSnapshot } from "@shellx-motion/core/internal/admitted-package-execution";
import { fileURLToPath } from "node:url";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { realpath } from "node:fs/promises";

const MAX_BROWSER_PACKAGE_FILE_BYTES = 512 * 1024 * 1024;
const MAX_BROWSER_PACKAGE_FILES = 4_096;
const MAX_BROWSER_PACKAGE_BYTES = 512 * 1024 * 1024;

export interface BrowserPackageFulfilledFile {
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly byteLength: number;
  readonly relativePath: string;
  readonly contentType: string;
}

export interface BrowserPackageFulfillment {
  readonly rootPath: string;
  /** Lexical admission only; a later read still proves a bounded non-symlink file. */
  canFulfillFileUrl(url: string): boolean;
  readPath(path: string, label: string): Promise<BrowserPackageFulfilledFile>;
  readFileUrl(url: string, label: string): Promise<BrowserPackageFulfilledFile>;
  inputHashes(): Readonly<Record<string, string>>;
}

const admittedFulfillmentFingerprints = new WeakMap<BrowserPackageFulfillment, string>();

/**
 * Internal-only bridge for a Core package parsed from admitted bytes. It is intentionally not
 * re-exported by the renderer barrel: Connector P2A owns minting, and a browser receives copies
 * from the frozen closure rather than reopening the package root.
 */
export function admittedBrowserPackageFulfillment(pkg: MotionPackage): BrowserPackageFulfillment | undefined {
  const snapshot = admittedPackageExecutionSnapshot(pkg);
  if (!snapshot) return undefined;
  assertAdmittedBrowserPackageDocuments(pkg);
  const rootPath = resolve(pkg.root);
  const files = new Map<string, Readonly<{ bytes: Buffer; sha256: string; byteLength: number }>>();
  for (const relativePath of snapshot.paths) {
    const file = snapshot.read(relativePath);
    if (!file || file.byteLength !== file.bytes.byteLength) throw new Error("Admitted browser package snapshot is incomplete.");
    files.set(relativePath, file);
  }
  const hashes = Object.freeze({
    "admitted-package-tree": snapshot.treeSha256,
    ...Object.fromEntries([...files.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([path, file]) => [`browser-package/${path}`, file.sha256]))
  });
  const fulfillment: BrowserPackageFulfillment = {
    rootPath,
    canFulfillFileUrl(url: string): boolean {
      try {
        return url.startsWith("file:") && relativeSnapshotPath(rootPath, fileURLToPath(url)) !== undefined;
      } catch {
        return false;
      }
    },
    async readPath(path: string, label: string): Promise<BrowserPackageFulfilledFile> {
      const relativePath = relativeSnapshotPath(rootPath, path);
      const file = relativePath ? files.get(relativePath) : undefined;
      if (!relativePath || !file) throw new Error(`${label} is absent from the admitted browser package snapshot.`);
      return { bytes: Buffer.from(file.bytes), sha256: file.sha256, byteLength: file.byteLength, relativePath, contentType: contentTypeFor(relativePath) };
    },
    async readFileUrl(url: string, label: string): Promise<BrowserPackageFulfilledFile> {
      if (!url.startsWith("file:")) throw new Error(`${label} is not a file URL.`);
      return await fulfillment.readPath(fileURLToPath(url), label);
    },
    inputHashes(): Readonly<Record<string, string>> {
      return hashes;
    }
  };
  admittedFulfillmentFingerprints.set(fulfillment, snapshot.treeSha256);
  return fulfillment;
}

/** Reject same-process mutation of a parsed admitted package before Browser consumes it. */
export function assertAdmittedBrowserPackageDocuments(pkg: MotionPackage): void {
  const snapshot = admittedPackageExecutionSnapshot(pkg);
  if (!snapshot) return;
  const manifest = snapshot.read("manifest.json");
  const motion = snapshot.read(pkg.manifest.motion);
  if (!manifest || !motion) throw new Error("Admitted browser package documents are incomplete.");
  const snapshotManifest = JSON.parse(manifest.bytes.toString("utf8"));
  const snapshotMotion = JSON.parse(motion.bytes.toString("utf8"));
  if (canonicalJsonSha256(snapshotManifest) !== canonicalJsonSha256(pkg.manifest)
    || canonicalJsonSha256(snapshotMotion) !== canonicalJsonSha256(pkg.motion)) {
    throw new Error("Admitted browser package documents changed after immutable admission.");
  }
}

/** Internal companion used only by the renderer session to avoid a mutable pathname fingerprint. */
export function admittedBrowserFulfillmentFingerprint(fulfillment: BrowserPackageFulfillment): string | undefined {
  return admittedFulfillmentFingerprints.get(fulfillment);
}

/**
 * Construct a bounded immutable-on-first-consumption file fulfillment store.
 * The browser route hands Chromium copies of these verified bytes, so a
 * replacement of a package pathname cannot alter a frame after inspection.
 */
export async function createBrowserPackageFulfillment(root: string): Promise<BrowserPackageFulfillment> {
  const rootPath = await realpath(resolve(root));
  const budget = new BoundedResourceBudget({
    maxFileBytes: MAX_BROWSER_PACKAGE_FILE_BYTES,
    maxFiles: MAX_BROWSER_PACKAGE_FILES,
    maxPathDepth: 64,
    maxAggregateBytes: MAX_BROWSER_PACKAGE_BYTES,
    maxConcurrentReads: 4,
  }, "Browser package fulfillment");
  const fulfilled = new Map<string, Promise<BrowserPackageFulfilledFile>>();
  const hashes = new Map<string, string>();

  const readPath = async (path: string, label: string): Promise<BrowserPackageFulfilledFile> => {
    const lexical = resolve(path);
    if (!inside(rootPath, lexical)) throw new Error(`${label} escapes the browser package root.`);
    const existing = fulfilled.get(lexical);
    if (existing) return copyFulfilledFile(await existing);
    const pending = readBudgetedStableFile(lexical, { label, budget, withinRoot: rootPath })
      .then((file) => fulfilledFile(rootPath, file));
    fulfilled.set(lexical, pending);
    try {
      const file = await pending;
      hashes.set(file.relativePath, file.sha256);
      return copyFulfilledFile(file);
    } catch (error) {
      fulfilled.delete(lexical);
      throw error;
    }
  };

  return {
    rootPath,
    canFulfillFileUrl(url: string): boolean {
      try {
        return url.startsWith("file:") && inside(rootPath, fileURLToPath(url));
      } catch {
        return false;
      }
    },
    readPath,
    async readFileUrl(url: string, label: string): Promise<BrowserPackageFulfilledFile> {
      if (!url.startsWith("file:")) throw new Error(`${label} is not a file URL.`);
      return await readPath(fileURLToPath(url), label);
    },
    inputHashes(): Readonly<Record<string, string>> {
      return Object.freeze(Object.fromEntries([...hashes.entries()]
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([path, sha256]) => [`browser-package/${path}`, sha256])));
    }
  };
}

function fulfilledFile(root: string, file: StableFileReadResult): BrowserPackageFulfilledFile {
  const relativePath = relative(root, file.canonicalPath).replaceAll("\\", "/");
  if (!relativePath || relativePath.startsWith("../") || isAbsolute(relativePath)) {
    throw new Error("Browser package fulfillment read escaped its package root.");
  }
  return Object.freeze({
    // Do not expose the stable reader's Buffer itself to an untrusted browser route.
    bytes: Buffer.from(file.bytes),
    sha256: file.sha256,
    byteLength: file.byteLength,
    relativePath,
    contentType: contentTypeFor(relativePath),
  });
}

function copyFulfilledFile(file: BrowserPackageFulfilledFile): BrowserPackageFulfilledFile {
  return { ...file, bytes: Buffer.from(file.bytes) };
}

function inside(root: string, candidate: string): boolean {
  const relation = relative(resolve(root), resolve(candidate));
  return relation === "" || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation));
}

function relativeSnapshotPath(root: string, path: string): string | undefined {
  const candidate = resolve(path);
  if (!inside(root, candidate)) return undefined;
  const relativePath = relative(root, candidate).replaceAll("\\", "/");
  return relativePath && !relativePath.startsWith("../") && !isAbsolute(relativePath) ? relativePath : undefined;
}

function contentTypeFor(path: string): string {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  switch (extension) {
    case "html": case "htm": return "text/html; charset=utf-8";
    case "css": return "text/css; charset=utf-8";
    case "js": case "mjs": return "text/javascript; charset=utf-8";
    case "json": return "application/json; charset=utf-8";
    case "svg": return "image/svg+xml";
    case "png": return "image/png";
    case "jpg": case "jpeg": return "image/jpeg";
    case "webp": return "image/webp";
    case "gif": return "image/gif";
    case "woff": return "font/woff";
    case "woff2": return "font/woff2";
    case "ttf": return "font/ttf";
    case "otf": return "font/otf";
    case "mp4": return "video/mp4";
    case "webm": return "video/webm";
    case "mp3": return "audio/mpeg";
    case "wav": return "audio/wav";
    default: return "application/octet-stream";
  }
}
