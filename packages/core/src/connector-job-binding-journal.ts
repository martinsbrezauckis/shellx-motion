/**
 * Immutable, restart-safe storage for one connector binding per host-visible job id.
 * It stores no executor or resolved path: a future coordinator must re-resolve opaque references
 * through its trusted host context before it can execute anything.
 */
import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, lstat, mkdir, open, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson } from "./canonical-json";
import {
  MOTION_CONNECTOR_JOB_BINDING_MAX_BYTES,
  createMotionConnectorJobBinding,
  motionConnectorJobBindingFileName,
  motionConnectorJobOwnerBindingFileName,
  parseMotionConnectorJobBinding
} from "./connector-job-binding";
import type { MotionConnectorJobBinding, MotionConnectorJobBindingInput } from "./connector-job-binding";
import { assertMotionJobId } from "./job-registry";

export {
  MOTION_CONNECTOR_JOB_BINDING_MAX_BYTES,
  MOTION_CONNECTOR_JOB_BINDING_SCHEMA,
  createMotionConnectorJobBinding,
  motionConnectorJobBindingFileName,
  motionConnectorJobOwnerBindingFileName,
  motionConnectorJobBindingFingerprint,
  parseMotionConnectorJobBinding
} from "./connector-job-binding";
export type { MotionConnectorJobBinding, MotionConnectorJobBindingInput, MotionConnectorJobBindingRequest } from "./connector-job-binding";

export interface MotionConnectorJobBindingJournalServices {
  /** Host-owned state root.  Never derive this from a connector request. */
  readonly bindingRoot?: string;
}

export type MotionConnectorJobBindingWriteResult =
  | Readonly<{ ok: true; binding: MotionConnectorJobBinding; replayed: boolean }>
  | Readonly<{ ok: false; code: "binding_conflict" | "binding_invalid" }>;

export type MotionConnectorJobBindingReadResult =
  | Readonly<{ ok: true; binding: MotionConnectorJobBinding }>
  | Readonly<{ ok: false; code: "binding_unknown" | "binding_not_visible" | "binding_invalid" }>;

/** Coordinator-adjacent default root, overrideable only by the trusted host. */
export function defaultMotionConnectorJobBindingRoot(env: NodeJS.ProcessEnv = process.env): string {
  const coordinator = env.SHELLX_MOTION_JOB_COORDINATOR_ROOT?.trim();
  if (coordinator) return join(coordinator, "connector-job-bindings");
  const runtime = env.XDG_RUNTIME_DIR?.trim();
  return runtime ? join(runtime, "shellx-motion", "connector-job-bindings") : join(".scratch", "connector-job-bindings");
}

export class MotionConnectorJobBindingJournal {
  private readonly root: string;

  constructor(services: MotionConnectorJobBindingJournalServices = {}) {
    this.root = services.bindingRoot ?? defaultMotionConnectorJobBindingRoot();
  }

  /** Atomic no-clobber write; exact replay succeeds, any substitution for this job id refuses. */
  async write(input: MotionConnectorJobBindingInput): Promise<MotionConnectorJobBindingWriteResult> {
    const binding = createMotionConnectorJobBinding(input);
    const serialized = serializeBinding(binding);
    await mkdir(this.root, { recursive: true });
    await this.assertRoot();
    const prior = await this.readStored(binding.callerId, binding.jobId);
    if (prior.kind === "invalid") return { ok: false, code: "binding_invalid" };
    if (prior.kind === "binding") {
      return serializeBinding(prior.binding) === serialized
        ? { ok: true, binding: prior.binding, replayed: true }
        : { ok: false, code: "binding_conflict" };
    }
    const created = await writeNoClobber(this.pathFor(binding.callerId, binding.jobId), serialized);
    if (created) return { ok: true, binding, replayed: false };

    const existing = await this.readStored(binding.callerId, binding.jobId);
    if (existing.kind !== "binding") return { ok: false, code: "binding_invalid" };
    // Compare canonical bytes as well as the hash, preserving no-substitution even under a
    // hypothetical constructed hash collision.
    return serializeBinding(existing.binding) === serialized
      ? { ok: true, binding: existing.binding, replayed: true }
      : { ok: false, code: "binding_conflict" };
  }

  /** Owner-scoped read.  There is deliberately no cross-caller enumeration surface here. */
  async read(input: { jobId: string; callerId: string }): Promise<MotionConnectorJobBindingReadResult> {
    const jobId = assertMotionJobId(input.jobId);
    const stored = await this.readStored(input.callerId, jobId);
    if (stored.kind === "missing") return { ok: false, code: "binding_unknown" };
    if (stored.kind === "invalid") return { ok: false, code: "binding_invalid" };
    if (stored.binding.callerId !== input.callerId) return { ok: false, code: "binding_not_visible" };
    return { ok: true, binding: stored.binding };
  }

  private pathFor(callerId: string, jobId: string): string {
    return join(this.root, motionConnectorJobOwnerBindingFileName(callerId, jobId));
  }

  private async assertRoot(): Promise<void> {
    const metadata = await lstat(this.root);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Connector job binding root must be a direct non-symlink directory.");
  }

  private async readStored(callerId: string, jobId: string): Promise<{ kind: "missing" } | { kind: "invalid" } | { kind: "binding"; binding: MotionConnectorJobBinding }> {
    const current = await this.readStoredPath(this.pathFor(callerId, jobId), jobId, callerId, true);
    if (current.kind !== "missing") return current;
    // Legacy journal paths keyed only by external job id.  The file itself must authenticate the
    // same owner before it can be used; a differently-owned legacy binding is indistinguishable
    // from missing rather than an oracle for another caller's work.
    return await this.readStoredPath(this.legacyPathFor(jobId), jobId, callerId, false);
  }

  private legacyPathFor(jobId: string): string {
    return join(this.root, motionConnectorJobBindingFileName(jobId));
  }

  private async readStoredPath(
    path: string,
    jobId: string,
    callerId: string,
    current: boolean
  ): Promise<{ kind: "missing" } | { kind: "invalid" } | { kind: "binding"; binding: MotionConnectorJobBinding }> {
    try {
      await this.assertRoot();
      await lstat(path);
    } catch (error) {
      return isMissing(error) ? { kind: "missing" } : { kind: "invalid" };
    }
    try {
      const raw = (await readBindingFile(path)).toString("utf8");
      const binding = parseMotionConnectorJobBinding(JSON.parse(raw) as unknown);
      if (raw !== serializeBinding(binding) || binding.jobId !== jobId) return { kind: "invalid" };
      if (binding.callerId !== callerId) return current ? { kind: "invalid" } : { kind: "missing" };
      return { kind: "binding", binding };
    } catch {
      return { kind: "invalid" };
    }
  }
}

function serializeBinding(binding: MotionConnectorJobBinding): string {
  const serialized = canonicalJson(binding);
  if (Buffer.byteLength(serialized, "utf8") > MOTION_CONNECTOR_JOB_BINDING_MAX_BYTES) {
    throw new Error(`Connector job binding exceeds its ${MOTION_CONNECTOR_JOB_BINDING_MAX_BYTES}-byte limit.`);
  }
  return serialized;
}

async function writeNoClobber(path: string, serialized: string): Promise<boolean> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
    try {
      // `link` is atomic and refuses EEXIST, unlike rename which overwrites the prior binding.
      await link(temporary, path);
      return true;
    } catch (error) {
      if (isAlreadyExists(error)) return false;
      throw error;
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

/**
 * Read the direct child of a host-owned runtime root without following a leaf symlink, accepting a
 * replacement while it is read, or allocating beyond the journal cap.  Runtime state may sit
 * under an OS-owned parent such as /tmp, so authority is established at the configured root.
 */
async function readBindingFile(path: string): Promise<Buffer> {
  const before = await lstat(path);
  assertBindingFile(before);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    assertBindingFile(opened);
    if (!sameFile(before, opened)) throw new Error("Connector job binding changed before it was opened.");
    const bytes = Buffer.allocUnsafe(opened.size + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    const lexicalAfter = await lstat(path);
    if (offset !== opened.size || !sameFile(opened, after) || !sameFile(after, lexicalAfter) || lexicalAfter.isSymbolicLink()) {
      throw new Error("Connector job binding changed while it was read.");
    }
    assertBindingFile(after);
    assertBindingFile(lexicalAfter);
    return bytes.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

function assertBindingFile(metadata: Stats): void {
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || !Number.isSafeInteger(metadata.size)
    || metadata.size < 2 || metadata.size > MOTION_CONNECTOR_JOB_BINDING_MAX_BYTES) {
    throw new Error("Connector job binding must be a bounded single-link regular non-symlink file.");
  }
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "EEXIST";
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}
