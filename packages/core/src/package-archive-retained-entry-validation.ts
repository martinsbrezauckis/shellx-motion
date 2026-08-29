import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  assertTemplatePackageSemantics,
  readMotionDocument,
  readPackageManifest,
  readTemplateDocument,
  resolvePackageAsset
} from "./package";
import {
  PACKAGE_MANIFEST_MAX_BYTES,
  PACKAGE_MOTION_MAX_BYTES,
  PACKAGE_TEMPLATE_MAX_BYTES
} from "./package-loaded-inputs";
import { parseBoundedPackageJsonBytes } from "./package-json-admission";
import type { PackageArchiveSourceEntry } from "./package-archive-write-input";

const RETAINED_ARCHIVE_PACKAGE_ROOT = "/shellx-motion-retained-archive";

/**
 * Re-establish loadMotionPackage's document boundary against exactly the bytes that become tar
 * entries. This intentionally relies on the archive collector's bounds rather than adding a
 * second file-count, aggregate-byte, or depth cap.
 */
export function retainedArchivePackageId(entries: readonly PackageArchiveSourceEntry[]): string {
  const retainedEntries = new Map(entries.map((entry) => [entry.path, entry]));
  const manifest = readPackageManifest(readRetainedArchiveJson(
    retainedEntries,
    "manifest.json",
    PACKAGE_MANIFEST_MAX_BYTES,
    "Package manifest"
  ));
  const motion = readMotionDocument(readRetainedArchiveJson(
    retainedEntries,
    retainedArchiveEntryPath(manifest.motion),
    PACKAGE_MOTION_MAX_BYTES,
    "Motion document"
  ));
  const template = manifest.template
    ? readTemplateDocument(readRetainedArchiveJson(
      retainedEntries,
      retainedArchiveEntryPath(manifest.template),
      PACKAGE_TEMPLATE_MAX_BYTES,
      "Template document"
    ))
    : undefined;
  if (template) {
    assertTemplatePackageSemantics(template, motion, RETAINED_ARCHIVE_PACKAGE_ROOT, {
      hasPackageFile: (path) => retainedEntries.has(retainedArchiveEntryPathFromPackagePath(path))
    });
  }
  return manifest.id;
}

function readRetainedArchiveJson(
  entries: ReadonlyMap<string, PackageArchiveSourceEntry>,
  path: string,
  maxBytes: number,
  label: string
): unknown {
  const entry = entries.get(path);
  if (!entry) throw new Error(`${label} is absent from retained package archive: ${path}`);
  return parseBoundedPackageJsonBytes(entry.data, maxBytes, label);
}

function retainedArchiveEntryPath(assetRef: string): string {
  return retainedArchiveEntryPathFromPackagePath(resolvePackageAsset({ root: RETAINED_ARCHIVE_PACKAGE_ROOT }, assetRef));
}

function retainedArchiveEntryPathFromPackagePath(path: string): string {
  const relativePath = relative(RETAINED_ARCHIVE_PACKAGE_ROOT, resolve(path));
  if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`Package archive retained reference escapes package root: ${path}`);
  }
  return relativePath.split(sep).join("/");
}
