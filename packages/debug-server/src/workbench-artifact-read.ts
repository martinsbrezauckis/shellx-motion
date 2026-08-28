/**
 * Filesystem admission for Workbench preview artifacts and template posters.
 *
 * Opaque session handles decide which path a browser session may request. This
 * module owns the separate filesystem boundary: each admitted path must remain
 * an absolute, bounded, symlink-free regular file under an unchanged
 * host-retained root through open and read. Format policy remains in
 * workbench-image.ts.
 */
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { OutputDirectoryReservation, type RetainedDirectoryAuthority } from "@shellx-motion/core";
import {
  WORKBENCH_POSTER_EXTENSIONS,
  WORKBENCH_RASTER_CONTENT_TYPES,
  WORKBENCH_RASTER_EXTENSIONS,
  assessWorkbenchPosterPayload,
  matchesWorkbenchImageMagic
} from "./workbench-image.js";

const MAX_WORKBENCH_ARTIFACT_BYTES = 64 * 1024 * 1024;

type BoundedArtifactRead =
  | { ok: true; bytes: Buffer; extension: string }
  | { ok: false; status: number; code: string; message: string };

export type WorkbenchArtifactRead =
  | { ok: true; bytes: Buffer; contentType: string }
  | { ok: false; status: number; code: string; message: string };

export type WorkbenchPosterRead =
  | { ok: true; bytes: Buffer; contentType: string; contentSecurityPolicy: string }
  | { ok: false; status: number; code: string; message: string };

/**
 * Read a bounded raster preview artifact (PNG/JPEG/GIF/WebP) and confirm its
 * bytes match the declared image type via a fixed magic-byte signature.
 */
export async function readWorkbenchArtifact(
  requestedPath: string,
  roots: readonly string[],
  authorities: readonly RetainedDirectoryAuthority[]
): Promise<WorkbenchArtifactRead> {
  const read = await readBoundedArtifactBytes(requestedPath, roots, authorities, {
    allowedExtensions: WORKBENCH_RASTER_EXTENSIONS,
    unsupportedCode: "unsupported_artifact",
    unsupportedMessage: "Workbench preview artifacts must be PNG, JPEG, GIF, or WebP images."
  });
  if (!read.ok) return read;
  if (!matchesWorkbenchImageMagic(read.bytes, read.extension)) {
    return { ok: false, status: 400, code: "artifact_magic_mismatch", message: "Workbench artifact bytes do not match the declared image type." };
  }
  return { ok: true, bytes: read.bytes, contentType: WORKBENCH_RASTER_CONTENT_TYPES[read.extension]! };
}

/**
 * Read a template poster. Packs may use SVG or PNG/JPEG key art, so posters
 * apply the format-specific SVG safety or raster magic-byte gate after the
 * common filesystem admission path.
 */
export async function readWorkbenchPoster(
  requestedPath: string,
  roots: readonly string[],
  authorities: readonly RetainedDirectoryAuthority[]
): Promise<WorkbenchPosterRead> {
  const read = await readBoundedArtifactBytes(requestedPath, roots, authorities, {
    allowedExtensions: WORKBENCH_POSTER_EXTENSIONS,
    unsupportedCode: "unsupported_poster",
    unsupportedMessage: "Workbench template posters must be SVG, PNG, or JPEG images."
  });
  if (!read.ok) return read;
  const assessed = assessWorkbenchPosterPayload(read.bytes, read.extension);
  if (!assessed.ok) {
    return { ok: false, status: 400, code: "unsafe_poster", message: assessed.message };
  }
  return { ok: true, bytes: read.bytes, ...assessed.payload };
}

/** Retain host roots once at startup; missing roots do not become authority. */
export async function retainExistingArtifactRoots(roots: readonly string[]): Promise<readonly RetainedDirectoryAuthority[]> {
  const authorities: RetainedDirectoryAuthority[] = [];
  for (const root of roots) {
    const existing = await lstat(root).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!existing) continue;
    authorities.push(await OutputDirectoryReservation.acquire(root, {
      allowExistingContents: true, requireExisting: true, requireExclusiveChildAuthority: true
    }));
  }
  return authorities;
}

/**
 * Open a bounded, symlink-free regular file that resolves inside an
 * authenticated host root, retaining its identity through the read.
 */
async function readBoundedArtifactBytes(
  requestedPath: string,
  roots: readonly string[],
  authorities: readonly RetainedDirectoryAuthority[],
  options: { allowedExtensions: Set<string>; unsupportedCode: string; unsupportedMessage: string }
): Promise<BoundedArtifactRead> {
  const resolvedPath = resolve(requestedPath);
  const extension = extname(resolvedPath).toLowerCase();
  if (!isAbsolute(requestedPath) || !options.allowedExtensions.has(extension)) {
    return { ok: false, status: 400, code: options.unsupportedCode, message: options.unsupportedMessage };
  }
  let canonicalPath: string;
  let requestedFacts: Awaited<ReturnType<typeof lstat>>;
  try {
    await assertArtifactRootAuthorities(authorities);
    [requestedFacts, canonicalPath] = await Promise.all([lstat(resolvedPath), realpath(resolvedPath)]);
    if (!requestedFacts.isFile() || requestedFacts.isSymbolicLink() || requestedFacts.size > MAX_WORKBENCH_ARTIFACT_BYTES) {
      return { ok: false, status: 400, code: "unsafe_artifact", message: "Workbench artifact must be a bounded regular file, not a symlink." };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, status: 404, code: "artifact_not_found", message: "Workbench preview artifact was not found." };
    }
    return { ok: false, status: 400, code: "unsafe_artifact", message: "Workbench preview artifact could not be opened safely." };
  }
  let inside = false;
  for (const root of roots) {
    try {
      const canonicalRoot = await realpath(root);
      const rel = relative(canonicalRoot, canonicalPath);
      if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) {
        inside = true;
        break;
      }
    } catch {
      // Missing/unreadable host roots do not widen artifact access.
    }
  }
  if (!inside) {
    return { ok: false, status: 403, code: "artifact_outside_roots", message: "Workbench preview artifact is outside authenticated host artifact roots." };
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await openReadNoFollow(resolvedPath);
    const opened = await handle.stat();
    const [canonicalAfterOpen, pathAfterOpen] = await Promise.all([realpath(resolvedPath), lstat(resolvedPath)]);
    if (!opened.isFile()
      || pathAfterOpen.isSymbolicLink()
      || canonicalAfterOpen !== canonicalPath
      || opened.dev !== requestedFacts.dev
      || opened.ino !== requestedFacts.ino
      || pathAfterOpen.dev !== opened.dev
      || pathAfterOpen.ino !== opened.ino
      || opened.size > MAX_WORKBENCH_ARTIFACT_BYTES) {
      return { ok: false, status: 400, code: "unsafe_artifact", message: "Workbench artifact changed before it could be opened safely." };
    }
    const bytes = await handle.readFile();
    const openedAfter = await handle.stat();
    const pathAfterRead = await lstat(resolvedPath);
    if (bytes.byteLength !== opened.size
      || openedAfter.dev !== opened.dev
      || openedAfter.ino !== opened.ino
      || openedAfter.size !== opened.size
      || openedAfter.mtimeMs !== opened.mtimeMs
      || pathAfterRead.isSymbolicLink()
      || pathAfterRead.dev !== opened.dev
      || pathAfterRead.ino !== opened.ino) {
      return { ok: false, status: 400, code: "unsafe_artifact", message: "Workbench artifact changed while it was being read." };
    }
    await assertArtifactRootAuthorities(authorities);
    return { ok: true, bytes, extension };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, status: 404, code: "artifact_not_found", message: "Workbench preview artifact was not found." };
    }
    return { ok: false, status: 400, code: "unsafe_artifact", message: "Workbench preview artifact could not be read safely." };
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function assertArtifactRootAuthorities(authorities: readonly RetainedDirectoryAuthority[]): Promise<void> {
  for (const authority of authorities) await authority.assertCurrent();
}

async function openReadNoFollow(path: string) {
  try {
    return await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EOPNOTSUPP") throw error;
    return open(path, fsConstants.O_RDONLY);
  }
}
