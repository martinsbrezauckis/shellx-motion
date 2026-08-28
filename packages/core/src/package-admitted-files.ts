import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  PACKAGE_MANIFEST_MAX_BYTES,
  PACKAGE_MOTION_MAX_BYTES,
  PACKAGE_TEMPLATE_MAX_BYTES,
  rememberLoadedPackageHashes
} from "./package-loaded-inputs";
import { parseBoundedPackageJsonBytes } from "./package-json-admission";
import { rememberAdmittedPackageExecutionSnapshot, type AdmittedPackageExecutionSnapshot } from "./package-admitted-execution-store";
import { canonicalJsonSha256 } from "./canonical-json";
import { hashBuffer } from "./receipts";
import {
  assertTemplatePackageSemantics,
  readMotionDocument,
  readPackageManifest,
  readTemplateDocument,
  resolvePackageAsset
} from "./package";
import type { MotionPackage } from "./types";

const ADMITTED_SNAPSHOT_MAX_FILES = 1_024;
const ADMITTED_SNAPSHOT_MAX_FILE_BYTES = 64 * 1024 * 1024;
const ADMITTED_SNAPSHOT_MAX_AGGREGATE_BYTES = 256 * 1024 * 1024;
const ADMITTED_SNAPSHOT_MAX_DEPTH = 16;

/** Parse a package only from a connector's already-admitted in-memory file snapshot. */
export function loadMotionPackageFromAdmittedFiles(
  root: string,
  files: ReadonlyMap<string, Readonly<{ bytes: Buffer; sha256: string }>>
): MotionPackage {
  const packageRoot = resolve(root);
  const snapshot = privateAdmittedPackageExecutionSnapshot(files);
  const manifestFile = readAdmittedPackageJson(snapshot, "manifest.json", PACKAGE_MANIFEST_MAX_BYTES, "Package manifest");
  const manifest = readPackageManifest(manifestFile.value);
  const motionPath = resolvePackageAsset({ root: packageRoot }, manifest.motion);
  const motionFile = readAdmittedPackageJson(snapshot, packageRelativePath(packageRoot, motionPath), PACKAGE_MOTION_MAX_BYTES, "Motion document");
  const motion = readMotionDocument(motionFile.value);
  const templateFile = manifest.template
    ? readAdmittedPackageJson(snapshot, packageRelativePath(packageRoot, resolvePackageAsset({ root: packageRoot }, manifest.template)), PACKAGE_TEMPLATE_MAX_BYTES, "Template document")
    : undefined;
  const template = templateFile ? readTemplateDocument(templateFile.value) : undefined;

  if (template) {
    assertTemplatePackageSemantics(template, motion, packageRoot, {
      hasPackageFile: (path) => snapshot.read(packageRelativePath(packageRoot, path)) !== undefined
    });
  }
  const pkg: MotionPackage = { root: packageRoot, manifest, motion, ...(template ? { template } : {}) };
  rememberAdmittedPackageExecutionSnapshot(pkg, snapshot);
  rememberLoadedPackageHashes(pkg, {
    "manifest.json": manifestFile.sha256,
    [manifest.motion]: motionFile.sha256,
    ...(manifest.template && templateFile ? { [manifest.template]: templateFile.sha256 } : {}),
    "admitted-package-tree": snapshot.treeSha256
  });
  return pkg;
}

function readAdmittedPackageJson(
  snapshot: AdmittedPackageExecutionSnapshot,
  relativePath: string,
  maxBytes: number,
  label: string
): { value: unknown; sha256: string } {
  const file = snapshot.read(relativePath);
  if (!file) throw new Error(`${label} is absent from the admitted package snapshot: ${relativePath}`);
  return { value: parseBoundedPackageJsonBytes(file.bytes, maxBytes, label), sha256: file.sha256 };
}

function privateAdmittedPackageExecutionSnapshot(
  files: ReadonlyMap<string, Readonly<{ bytes: Buffer; sha256: string }>>
): AdmittedPackageExecutionSnapshot {
  if (files.size === 0 || files.size > ADMITTED_SNAPSHOT_MAX_FILES) {
    throw new Error("Admitted package execution snapshot exceeds its file limit.");
  }
  const copied = new Map<string, Readonly<{ bytes: Buffer; sha256: string }>>();
  let aggregateBytes = 0;
  for (const [path, file] of files) {
    assertAdmittedSnapshotPath(path);
    if (copied.has(path) || !Buffer.isBuffer(file.bytes) || file.bytes.byteLength > ADMITTED_SNAPSHOT_MAX_FILE_BYTES) {
      throw new Error("Admitted package execution snapshot contains an invalid file entry.");
    }
    aggregateBytes += file.bytes.byteLength;
    if (!Number.isSafeInteger(aggregateBytes) || aggregateBytes > ADMITTED_SNAPSHOT_MAX_AGGREGATE_BYTES) {
      throw new Error("Admitted package execution snapshot exceeds its aggregate-byte limit.");
    }
    const bytes = Buffer.from(file.bytes);
    const sha256 = hashBuffer(bytes);
    if (file.sha256 !== sha256) throw new Error(`Admitted package execution snapshot hash mismatch: ${path}`);
    copied.set(path, Object.freeze({ bytes, sha256 }));
  }
  const paths = Object.freeze([...copied.keys()].sort((left, right) => left < right ? -1 : left > right ? 1 : 0));
  const directories = new Set<string>([""]);
  for (const path of paths) {
    const parts = path.split("/");
    for (let length = 1; length < parts.length; length += 1) directories.add(parts.slice(0, length).join("/"));
  }
  const treeEntries = [
    ...[...directories].sort((left, right) => left < right ? -1 : left > right ? 1 : 0).map((path) => ({ path, kind: "directory" as const })),
    ...paths.map((path) => {
      const file = copied.get(path);
      if (!file) throw new Error("Admitted package snapshot changed while deriving its tree identity.");
      return { path, kind: "file" as const, sha256: file.sha256, byteLength: file.bytes.byteLength };
    })
  ];
  return Object.freeze({
    paths,
    treeSha256: canonicalJsonSha256(treeEntries),
    read(path: string) {
      const file = copied.get(path);
      return file
        ? Object.freeze({ bytes: Buffer.from(file.bytes), sha256: file.sha256, byteLength: file.bytes.byteLength })
        : undefined;
    }
  });
}

function assertAdmittedSnapshotPath(path: string): void {
  if (!path || path.length > 4_096 || path.includes("\\") || path.startsWith("/") || path.endsWith("/")) {
    throw new Error("Admitted package execution snapshot contains an invalid path.");
  }
  const parts = path.split("/");
  if (parts.length > ADMITTED_SNAPSHOT_MAX_DEPTH || parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("Admitted package execution snapshot contains an invalid path.");
  }
}

function packageRelativePath(root: string, path: string): string {
  const relativePath = relative(resolve(root), resolve(path));
  if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`Package document path escapes its root: ${path}`);
  }
  return relativePath.split(sep).join("/");
}
