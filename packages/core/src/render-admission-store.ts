/** Durable, owner-scoped admission class for one final-render job identity. */
import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, lstat, open, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { motionJobOwnerKey } from "./job-id-file";
import { defaultMotionRuntimeRoot } from "./job-lease";
import { assertMotionJobId } from "./job-registry";
import { opaqueText } from "./lifecycle-envelope-validation";
import { PrivateMotionRuntimeDirectory } from "./private-runtime-directory";
import {
  MOTION_RENDER_ADMISSION_STORE_MAX_BYTES,
  parseStoredMotionRenderAdmission,
  parseStoredMotionRenderAdmissionBinding,
  serializeStoredMotionRenderAdmissionBinding,
  type StoredMotionRenderAdmission
} from "./render-admission-binding";

const CALLER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
/** One short immutable class binding; it carries no execution paths or plan content. */
export { MOTION_RENDER_ADMISSION_STORE_MAX_BYTES } from "./render-admission-binding";

export type MotionRenderAdmission = StoredMotionRenderAdmission;

export interface MotionRenderAdmissionStoreServices {
  /** Trusted host-owned state root. Never derive it from a submitted request. */
  readonly admissionRoot?: string;
}

export type MotionRenderAdmissionBindResult =
  | Readonly<{ ok: true; admission: MotionRenderAdmission; replayed: boolean }>
  | Readonly<{ ok: false; code: "admission_conflict" | "admission_invalid" }>;

export type MotionRenderAdmissionReadResult =
  | Readonly<{ ok: true; admission: MotionRenderAdmission }>
  | Readonly<{ ok: false; code: "admission_unknown" | "admission_invalid" }>;

/** Opaque owner-qualified filename; caller and job ids never appear in a runtime path. */
export function motionRenderAdmissionFileName(callerId: string, jobId: string): string {
  return `${motionJobOwnerKey(assertCallerId(callerId), assertMotionJobId(jobId))}.render-admission.json`;
}

/** Coordinator-adjacent default root, overrideable only by the trusted host. */
export function defaultMotionRenderAdmissionRoot(env: NodeJS.ProcessEnv = process.env): string {
  const coordinator = env.SHELLX_MOTION_JOB_COORDINATOR_ROOT?.trim();
  return join(coordinator || defaultMotionRuntimeRoot(env), "render-admissions");
}

/**
 * Atomic mode binding before lease/event/execution. Exact class replays recover a crash, while a
 * mode or planned-fingerprint change refuses without changing the retained first binding.
 */
export class MotionRenderAdmissionStore {
  private readonly root: string;
  private readonly runtime: PrivateMotionRuntimeDirectory;

  constructor(services: MotionRenderAdmissionStoreServices = {}) {
    this.root = resolve(services.admissionRoot ?? defaultMotionRenderAdmissionRoot());
    this.runtime = new PrivateMotionRuntimeDirectory(this.root);
  }

  async bind(input: { callerId: string; jobId: string; admission: unknown }): Promise<MotionRenderAdmissionBindResult> {
    const callerId = assertCallerId(input.callerId);
    const jobId = assertMotionJobId(input.jobId);
    const admission = parseAdmission(input.admission);
    await this.runtime.assertCurrent();
    const prior = await this.readStored(callerId, jobId);
    if (prior.kind === "invalid") return { ok: false, code: "admission_invalid" };
    if (prior.kind === "admission") return sameAdmission(prior.admission, admission)
      ? { ok: true, admission: prior.admission, replayed: true }
      : { ok: false, code: "admission_conflict" };
    const serialized = serializeStoredMotionRenderAdmissionBinding({ callerId, jobId, admission });
    await this.runtime.assertCurrent();
    const created = await writeNoClobber(this.pathFor(callerId, jobId), serialized);
    if (created) return { ok: true, admission, replayed: false };
    const existing = await this.readStored(callerId, jobId);
    if (existing.kind !== "admission") return { ok: false, code: "admission_invalid" };
    return sameAdmission(existing.admission, admission)
      ? { ok: true, admission: existing.admission, replayed: true }
      : { ok: false, code: "admission_conflict" };
  }

  async read(input: { callerId: string; jobId: string }): Promise<MotionRenderAdmissionReadResult> {
    const callerId = assertCallerId(input.callerId);
    const jobId = assertMotionJobId(input.jobId);
    await this.runtime.assertCurrent();
    const stored = await this.readStored(callerId, jobId);
    if (stored.kind === "missing") return { ok: false, code: "admission_unknown" };
    if (stored.kind === "invalid") return { ok: false, code: "admission_invalid" };
    return { ok: true, admission: stored.admission };
  }

  private pathFor(callerId: string, jobId: string): string {
    return join(this.root, motionRenderAdmissionFileName(callerId, jobId));
  }

  private async readStored(callerId: string, jobId: string): Promise<{ kind: "missing" } | { kind: "invalid" } | { kind: "admission"; admission: MotionRenderAdmission }> {
    try {
      await this.runtime.assertCurrent();
      const raw = (await readBindingFile(this.pathFor(callerId, jobId))).toString("utf8");
      const parsed = parseStoredMotionRenderAdmissionBinding(JSON.parse(raw) as unknown);
      if (parsed.callerId !== callerId || parsed.jobId !== jobId || raw !== serializeStoredMotionRenderAdmissionBinding(parsed)) return { kind: "invalid" };
      return { kind: "admission", admission: parsed.admission };
    } catch (error) {
      return isMissing(error) ? { kind: "missing" } : { kind: "invalid" };
    }
  }
}

function parseAdmission(value: unknown): MotionRenderAdmission {
  return parseStoredMotionRenderAdmission(value);
}

function sameAdmission(left: MotionRenderAdmission, right: MotionRenderAdmission): boolean {
  if (left.mode !== right.mode) return false;
  return left.mode === "legacy-planless" || (right.mode === "planned" && left.planFingerprint === right.planFingerprint);
}

async function writeNoClobber(path: string, serialized: string): Promise<boolean> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
    try {
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

async function readBindingFile(path: string): Promise<Buffer> {
  const before = await lstat(path);
  assertBindingFile(before);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    assertBindingFile(opened);
    if (!sameFile(before, opened)) throw new Error("Render admission binding changed before it was opened.");
    const bytes = Buffer.allocUnsafe(opened.size + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    const lexicalAfter = await lstat(path);
    if (offset !== opened.size || !sameFile(opened, after) || !sameFile(after, lexicalAfter) || lexicalAfter.isSymbolicLink()) throw new Error("Render admission binding changed while it was read.");
    assertBindingFile(after);
    assertBindingFile(lexicalAfter);
    return bytes.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

function assertBindingFile(metadata: Stats): void {
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || !Number.isSafeInteger(metadata.size)
    || metadata.size < 2 || metadata.size > MOTION_RENDER_ADMISSION_STORE_MAX_BYTES) {
    throw new Error("Render admission binding must be a bounded single-link regular non-symlink file.");
  }
}

function assertCallerId(value: unknown): string {
  return opaqueText(value, "Render admission callerId", 1, 256, CALLER_ID);
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "EEXIST";
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs;
}
