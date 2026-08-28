/**
 * Package-local asset reference inspection shared by validation doors.
 *
 * A package can describe assets in its manifest, in a Motion asset record, or directly on a
 * layer.  Renderers eventually resolve those references independently, which used to turn a
 * simple absent file into a late, renderer-specific failure.  This module deliberately verifies
 * only the common package contract: every non-URI reference must name an existing regular,
 * non-symlink file contained by the package.  It does not infer media type or require a layer
 * reference to be declared in manifest.assets; those are renderer- and feature-specific rules.
 */
import { lstat } from "node:fs/promises";
import { resolvePackageAsset } from "./package";
import type { MotionDocument, MotionPackage } from "./types";

export interface PackageAssetReference {
  /** Stable JSON pointer into the document that carries this reference. */
  readonly path: string;
  readonly ref: string;
}

export interface PackageAssetReferenceProblem extends PackageAssetReference {
  readonly code: "missing" | "not_regular_file" | "symlink" | "outside_package" | "unavailable";
}

export interface PackageAssetReferenceValidation {
  readonly ok: boolean;
  readonly references: readonly PackageAssetReference[];
  readonly problems: readonly PackageAssetReferenceProblem[];
}

/** Returns true when a string is a URI-like external reference, not a package file spelling. */
export function isExternalPackageAssetRef(ref: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(ref);
}

/**
 * The portable target spelling accepted by package asset import and template media replacement.
 * A package may reference other package-local files (for example an HTML entry point), but new
 * imported bytes are intentionally limited to the package's assets directory.
 */
export function isImportablePackageAssetRef(assetRef: string): boolean {
  return typeof assetRef === "string"
    && /^assets\/[^/].*/.test(assetRef)
    && !assetRef.includes("..")
    && !assetRef.startsWith("/")
    && !assetRef.includes("\\")
    && !isExternalPackageAssetRef(assetRef)
    && !assetRef.endsWith("/");
}

/**
 * Read-only package asset inspection.  The output keeps source-document ordering so an author
 * gets deterministic, directly actionable pointers without a filesystem-dependent sort.
 */
export async function validatePackageAssetReferences(pkg: MotionPackage): Promise<PackageAssetReferenceValidation> {
  const references = collectPackageAssetReferences(pkg);
  const problems: PackageAssetReferenceProblem[] = [];
  for (const reference of references) {
    if (isExternalPackageAssetRef(reference.ref)) continue;
    try {
      const path = resolvePackageAsset(pkg, reference.ref);
      const entry = await lstat(path);
      if (entry.isSymbolicLink()) {
        problems.push({ ...reference, code: "symlink" });
      } else if (!entry.isFile()) {
        problems.push({ ...reference, code: "not_regular_file" });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      problems.push({
        ...reference,
        code: message.startsWith("Asset path escapes package root:")
          ? "outside_package"
          : isMissingPathError(error)
            ? "missing"
            : "unavailable",
      });
    }
  }
  return { ok: problems.length === 0, references, problems };
}

export function collectPackageAssetReferences(pkg: MotionPackage): PackageAssetReference[] {
  const refs: PackageAssetReference[] = [];
  for (const [index, ref] of pkg.manifest.assets.entries()) addReference(refs, `/manifest/assets/${index}`, ref);

  const motionAssetRefsById = new Map<string, string>();
  for (const [index, value] of pkg.motion.assets.entries()) {
    const record = objectRecord(value);
    if (!record) continue;
    const ref = motionAssetRef(record);
    if (!ref) continue;
    addReference(refs, `/motion/assets/${index}${motionAssetRefPath(record)}`, ref);
    if (typeof record.id === "string" && record.id.length > 0) motionAssetRefsById.set(record.id, ref);
  }

  for (const [index, layer] of pkg.motion.layers.entries()) {
    for (const field of ["assetRef", "source", "src"] as const) addReference(refs, `/motion/layers/${index}/${field}`, layer[field]);
    if (typeof layer.assetId === "string" && layer.assetId.length > 0) {
      const ref = motionAssetRefsById.get(layer.assetId);
      if (ref) addReference(refs, `/motion/layers/${index}/assetId`, ref);
    }
  }
  return refs;
}

function addReference(references: PackageAssetReference[], path: string, value: unknown): void {
  if (typeof value === "string" && value.length > 0) references.push({ path, ref: value });
}

function motionAssetRef(record: Record<string, unknown>): string | undefined {
  for (const key of ["ref", "assetRef", "source", "src"] as const) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
    if (key === "source") {
      const source = objectRecord(value);
      if (typeof source?.path === "string" && source.path.length > 0) return source.path;
    }
  }
  return undefined;
}

function motionAssetRefPath(record: Record<string, unknown>): string {
  if (typeof record.ref === "string") return "/ref";
  if (typeof record.assetRef === "string") return "/assetRef";
  if (typeof record.source === "string") return "/source";
  if (typeof record.src === "string") return "/src";
  return "/source/path";
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}
