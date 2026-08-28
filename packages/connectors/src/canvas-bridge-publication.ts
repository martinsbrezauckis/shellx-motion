import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rmdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, parse, resolve, sep } from "node:path";
import { canonicalJsonSha256, hashFile, prepareOutputFile, type OperationReceipt } from "@shellx-motion/core";
import type { ConnectorArtifact } from "./artifacts";

export type CanvasBridgeFrameSelectionSchema =
  | "shellx-motion/canvas-frame-selection@1"
  | "shellx-canvas/frame-selection@1";

export function canvasBridgeReceiptPath(outPath: string): string {
  return resolve(dirname(outPath), "canvas-bridge-export.receipt.json");
}

export type CanvasBridgePublicationErrorCode = "canvas_bridge_output_busy" | "canvas_bridge_output_parent_unsafe";

export class CanvasBridgePublicationError extends Error {
  constructor(
    readonly code: CanvasBridgePublicationErrorCode,
    message: string,
    readonly suggestedAction?: string
  ) {
    super(message);
    this.name = "CanvasBridgePublicationError";
    Object.setPrototypeOf(this, CanvasBridgePublicationError.prototype);
  }
}

/**
 * One Canvas export always owns the fixed sibling receipt too. The receipt path is therefore the
 * pair-wide key: every selection in that directory shares it and cannot publish concurrently.
 * Retained locks are deliberately fail-closed; no invocation guesses whether an older lock is
 * stale and no invocation removes a lock it did not create.
 */
export class CanvasBridgeOutputReservation {
  #released = false;

  private constructor(
    private readonly lockPath: string,
    private readonly lockIdentity: CanvasBridgeDirectoryIdentity
  ) {}

  static async acquire(parentPath: string, receiptPath: string): Promise<CanvasBridgeOutputReservation> {
    const parent = resolve(parentPath);
    const receipt = resolve(receiptPath);
    if (dirname(receipt) !== parent) {
      throw new CanvasBridgePublicationError(
        "canvas_bridge_output_parent_unsafe",
        "Canvas bridge selection and fixed receipt must share one canonical parent directory."
      );
    }
    const fingerprint = createHash("sha256").update(receipt).digest("hex").slice(0, 32);
    const lockPath = join(parent, `.shellx-motion-canvas-bridge-${fingerprint}.lock`);
    try {
      await mkdir(lockPath, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new CanvasBridgePublicationError(
          "canvas_bridge_output_busy",
          "Another Canvas bridge export already owns this selection and fixed receipt. Motion never breaks retained publication locks automatically.",
          canvasBridgeReservationRecoveryAction(lockPath)
        );
      }
      throw error;
    }
    return new CanvasBridgeOutputReservation(lockPath, await canvasBridgeDirectoryIdentity(lockPath, "Canvas bridge reservation"));
  }

  async createPrivateStageDirectory(): Promise<{ path: string; identity: CanvasBridgeDirectoryIdentity }> {
    if (this.#released) throw new Error("Canvas bridge output reservation is already released.");
    const path = await mkdtemp(join(this.lockPath, "stage-"));
    return { path, identity: await canvasBridgeDirectoryIdentity(path, "Canvas bridge private stage") };
  }

  async removePrivateStage(path: string, expected: CanvasBridgeDirectoryIdentity): Promise<boolean> {
    if (!await canvasBridgeDirectoryMatches(path, expected)) return false;
    await rm(path, { recursive: true, force: true }).catch(() => undefined);
    return !(await lstat(path).catch(() => null));
  }

  async release(): Promise<void> {
    if (this.#released) return;
    this.#released = true;
    if (!await canvasBridgeDirectoryMatches(this.lockPath, this.lockIdentity)) {
      throw retainedCanvasBridgeReservation(this.lockPath, "The Canvas bridge reservation changed before release, so Motion left it intact.");
    }
    try {
      await rmdir(this.lockPath);
    } catch {
      // POSIX reports ENOTEMPTY while Windows may report EEXIST. Other refusal codes are also
      // fail-closed: the reservation is retained and gets the same explicit manual remedy.
      throw retainedCanvasBridgeReservation(this.lockPath, "The Canvas bridge reservation could not be released, so Motion left it intact.");
    }
  }
}

export interface CanvasBridgeDirectoryIdentity {
  dev: number;
  ino: number;
}

async function canvasBridgeDirectoryIdentity(path: string, label: string): Promise<CanvasBridgeDirectoryIdentity> {
  const facts = await lstat(path);
  if (!facts.isDirectory() || facts.isSymbolicLink() || await realpath(path) !== path) {
    throw new Error(`${label} must be a canonical non-symlink directory.`);
  }
  return { dev: Number(facts.dev), ino: Number(facts.ino) };
}

async function canvasBridgeDirectoryMatches(path: string, expected: CanvasBridgeDirectoryIdentity): Promise<boolean> {
  const actual = await lstat(path).catch(() => null);
  return !!actual && actual.isDirectory() && !actual.isSymbolicLink()
    && Number(actual.dev) === expected.dev && Number(actual.ino) === expected.ino;
}

function retainedCanvasBridgeReservation(lockPath: string, message: string): CanvasBridgePublicationError {
  return new CanvasBridgePublicationError(
    "canvas_bridge_output_busy",
    message,
    canvasBridgeReservationRecoveryAction(lockPath)
  );
}

function canvasBridgeReservationRecoveryAction(lockPath: string): string {
  return `Wait for the active export. If it crashed, inspect ${lockPath}; only after verifying no exporter targets this pair and every child is an expected Motion-owned private stage, remove its files and stage directory individually, then rmdir ${lockPath}. Never recursively delete the lock or output parent.`;
}

/**
 * Materialize and pin the caller-selected parent before any bridge import or publication.
 *
 * A private reservation cannot protect itself when an unrelated account owns a writable ancestor:
 * that account can rename the reservation directory wholesale despite its 0700 mode. On POSIX,
 * reject that topology before importing the bridge. Root-owned immutable ancestors and sticky
 * roots such as `/tmp` are allowed; a non-root shared writable directory is not. Windows has no
 * uid/mode ownership model exposed through Node, so its native ACL remains the host boundary.
 */
export async function ensureCanvasBridgeOutputParent(outPath: string): Promise<string> {
  const parent = resolve(dirname(outPath));
  const root = parse(parent).root;
  let current = root;
  for (const part of parent.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    const before = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!before) {
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    const facts = await lstat(current);
    if (!facts.isDirectory() || facts.isSymbolicLink() || await realpath(current) !== current || hasUnsafeCanvasBridgeParentAuthority(facts)) {
      throw new CanvasBridgePublicationError(
        "canvas_bridge_output_parent_unsafe",
        "Canvas bridge output parent must be canonical, non-symlink, and protected from unrelated rename authority."
      );
    }
  }
  return parent;
}

function hasUnsafeCanvasBridgeParentAuthority(facts: Awaited<ReturnType<typeof lstat>>): boolean {
  if (typeof process.getuid !== "function") return false;
  const currentUid = process.getuid();
  if (facts.uid !== currentUid && facts.uid !== 0) return true;
  const mode = Number(facts.mode);
  const isGroupOrWorldWritable = (mode & 0o022) !== 0;
  const isSticky = (mode & 0o1000) !== 0;
  return isGroupOrWorldWritable && !isSticky;
}

export interface CanvasBridgeFileEvidence {
  sha256: string;
  byteLength: number;
  dev: number;
  ino: number;
}

/**
 * Copy bytes returned by the trusted bridge into the reservation's private producer stage only
 * after proving their parsed JSON is the same selection object the bridge returned to Motion.
 */
export async function commitCanvasBridgeSelection(input: {
  sourcePath: string;
  committedPath: string;
  selection: unknown;
}): Promise<CanvasBridgeFileEvidence> {
  const bytes = await readFile(input.sourcePath);
  let stagedSelection: unknown;
  try {
    stagedSelection = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Canvas bridge staged selection is not valid JSON.");
  }
  if (canonicalJsonSha256(stagedSelection) !== canonicalJsonSha256(input.selection)) {
    throw new Error("Canvas bridge staged selection bytes do not match the selection returned by the bridge.");
  }
  await writeFile(input.committedPath, bytes, { flag: "wx", mode: 0o600 });
  return await canvasBridgeFileEvidence(input.committedPath, "Committed Canvas bridge selection");
}

export async function canvasBridgeFileEvidence(path: string, label: string): Promise<CanvasBridgeFileEvidence> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file.`);
  const sha256 = await hashFile(path);
  const after = await lstat(path);
  if (!after.isFile() || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size) {
    throw new Error(`${label} changed while its identity was being verified.`);
  }
  return { sha256, byteLength: after.size, dev: after.dev, ino: after.ino };
}

export async function verifyCanvasBridgeFileEvidence(path: string, expected: CanvasBridgeFileEvidence, label: string): Promise<void> {
  const actual = await canvasBridgeFileEvidence(path, label);
  if (actual.sha256 !== expected.sha256
    || actual.byteLength !== expected.byteLength
    || actual.dev !== expected.dev
    || actual.ino !== expected.ino) {
    throw new Error(`${label} no longer matches the producer-bound staged artifact.`);
  }
}

export async function verifyCanvasBridgeReceiptBinding(receiptPath: string, selectionHash: string): Promise<void> {
  const receipt = readRecord(JSON.parse(await readFile(receiptPath, "utf8")));
  const inputHashes = readRecord(receipt?.inputHashes);
  if (inputHashes?.selection !== selectionHash) {
    throw new Error("Canvas bridge receipt does not bind the published selection bytes.");
  }
}

export async function canvasBridgeOutputOwnershipFailure(
  paths: string[],
  force: boolean
): Promise<{ code: string; message: string } | null> {
  for (const path of paths) {
    // Read-only preflight keeps an occupied receipt from invoking the bridge or creating a partial
    // selection. `prepareOutputFile(..., force: true)` is deliberately deferred until both staged
    // artifacts are complete.
    const guard = await prepareOutputFile(path, { force: false });
    if (guard.ok) continue;
    if (!force) return guard.error;
    const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    // `--force` may replace a regular file or unlink a symlink, but it never turns a directory or
    // special filesystem object into a file.
    if (existing && !existing.isFile() && !existing.isSymbolicLink()) return guard.error;
  }
  return null;
}

export async function forceCanvasBridgeOutputDestinations(
  paths: string[]
): Promise<{ code: string; message: string } | null> {
  // Recheck immediately before the destructive operation. The earlier preflight happened before
  // bridge work; this one rejects a destination that changed into a directory or special object.
  const ownershipFailure = await canvasBridgeOutputOwnershipFailure(paths, true);
  if (ownershipFailure) return ownershipFailure;
  const guards = await Promise.all(paths.map((path) => prepareOutputFile(path, { force: true })));
  const refusal = guards.find((guard) => !guard.ok);
  return refusal && !refusal.ok ? refusal.error : null;
}

export async function writeStagedJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

export async function createCanvasBridgeExportReceipt(input: {
  canvasRoot: string;
  bridgePath: string;
  bridgeSha256: string;
  selectionHash: string;
  selectionPath: string;
  schema: CanvasBridgeFrameSelectionSchema;
  selectedFrameId: string;
  layerIds: string[];
  receiptPath: string;
  artifacts: ConnectorArtifact[];
  createdAt: string;
}): Promise<OperationReceipt> {
  return {
    schema: "shellx-motion/receipt@1",
    id: `canvas-bridge-export-${input.selectionHash.slice(0, 16)}`,
    operation: "canvas.bridge_export",
    status: "passed",
    packageId: "canvas_bridge_export",
    inputHashes: { bridge: input.bridgeSha256, selection: input.selectionHash },
    createdAt: input.createdAt,
    lane: "connector",
    output: {
      canvasRoot: input.canvasRoot,
      bridgePath: input.bridgePath,
      path: input.selectionPath,
      receiptPath: input.receiptPath,
      schema: input.schema,
      selectedFrameId: input.selectedFrameId,
      layerIds: input.layerIds
    },
    artifacts: input.artifacts.filter((artifact) => artifact.role !== "connector_receipt"),
    warnings: []
  };
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}
