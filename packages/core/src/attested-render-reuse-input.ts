import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  attestedReusePathInside,
  canonicalAttestedReuseDirectory,
  canonicalAttestedReusePathInsideRoot,
} from "./attested-render-reuse-path";

export const ATTESTED_RENDER_REUSE_MAX_EXTERNAL_INPUT_BYTES = 4 * 1024 * 1024;

/** Read a workflow or quality-manifest source without turning a cache lookup into an unbounded read. */
export async function readAttestedRenderReuseExternalInput(pathInput: string): Promise<Buffer> {
  return await readBoundedRegularFile(
    resolve(pathInput),
    ATTESTED_RENDER_REUSE_MAX_EXTERNAL_INPUT_BYTES,
    "attested-reuse external input",
  );
}

/** Hash a bounded external input through the same no-follow file read used by its consumers. */
export async function hashAttestedRenderReuseExternalInput(pathInput: string): Promise<string> {
  return createHash("sha256").update(await readAttestedRenderReuseExternalInput(pathInput)).digest("hex");
}

/**
 * Hash a bounded external input only when its real, non-symlink parent is contained by `root`.
 * This is deliberately stricter than ordinary final rendering: an opt-in attested cache must not
 * turn a quality-manifest baseline into an arbitrary host file read.
 */
export async function hashAttestedRenderReuseExternalInputInsideRoot(input: {
  root: string;
  path: string;
  label?: string;
}): Promise<string> {
  const label = input.label ?? "attested-reuse external input";
  const root = await canonicalAttestedReuseDirectory(input.root, `${label} root`);
  const path = canonicalAttestedReusePathInsideRoot({
    requestedRoot: input.root,
    canonicalRoot: root,
    path: input.path,
    label,
  });
  await canonicalExistingPathInside(root, path, label);
  return await hashAttestedRenderReuseExternalInput(path);
}

async function canonicalExistingPathInside(root: string, pathInput: string, label: string): Promise<string> {
  const requested = resolve(pathInput);
  if (!attestedReusePathInside(root, requested)) throw new Error(`${label} escapes its root`);
  const parent = await realpath(dirname(requested));
  if (!attestedReusePathInside(root, parent) || join(parent, basename(requested)) !== requested) {
    throw new Error(`${label} directory is not canonical inside its root`);
  }
  return requested;
}

async function readBoundedRegularFile(path: string, maxBytes: number, label: string): Promise<Buffer> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) throw new Error(`${label} must be a bounded regular non-symlink file`);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > maxBytes) throw new Error(`${label} changed before it could be read`);
    const bytes = await file.readFile();
    const after = await file.stat();
    const pathAfter = await lstat(path);
    if (bytes.byteLength !== opened.size || !sameFile(opened, after) || !sameFile(after, pathAfter)) throw new Error(`${label} changed while it was read`);
    return bytes;
  } finally {
    await file.close();
  }
}

function sameFile(left: Awaited<ReturnType<typeof lstat>>, right: Awaited<ReturnType<typeof lstat>>): boolean {
  return !right.isSymbolicLink() && right.isFile() && left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}
