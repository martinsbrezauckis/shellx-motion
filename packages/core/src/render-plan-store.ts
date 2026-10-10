/**
 * Private, owner-scoped write-once storage for pre-event render plans.
 *
 * This store has no coordinator policy: it only makes the `(callerId, jobId) -> plan` binding
 * durable before events.  Existing legacy registry records remain untouched.  Exact canonical
 * replays are idempotent; a different complete plan refuses without overwriting the first one.
 */
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
  parseMotionRenderPlan,
  serializeMotionRenderPlan,
  type MotionRenderPlan
} from "./render-plan";
import {
  MOTION_RENDER_PLAN_STORE_MAX_BYTES,
  parseStoredMotionRenderPlanBinding,
  serializeStoredMotionRenderPlanBinding
} from "./render-plan-binding";

const CALLER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
/** A binding contains one bounded plan and only its two owner identifiers. */
export { MOTION_RENDER_PLAN_STORE_MAX_BYTES } from "./render-plan-binding";

export interface MotionRenderPlanStoreServices {
  /** Trusted host-owned state root. Never derive it from a submitted request. */
  readonly planRoot?: string;
}

export interface MotionRenderPlanBindingInput {
  readonly callerId: string;
  readonly jobId: string;
  readonly plan: unknown;
}

export type MotionRenderPlanBindResult =
  | Readonly<{ ok: true; plan: MotionRenderPlan; replayed: boolean }>
  | Readonly<{ ok: false; code: "plan_conflict" | "plan_invalid" }>;

export type MotionRenderPlanReadResult =
  | Readonly<{ ok: true; plan: MotionRenderPlan }>
  | Readonly<{ ok: false; code: "plan_unknown" | "plan_invalid" }>;

/** Opaque owner-qualified filename; caller and job ids never appear in a runtime path. */
export function motionRenderPlanBindingFileName(callerId: string, jobId: string): string {
  return `${motionJobOwnerKey(assertCallerId(callerId), assertMotionJobId(jobId))}.render-plan.json`;
}

/** Coordinator-adjacent default root, overrideable only by the trusted host. */
export function defaultMotionRenderPlanRoot(env: NodeJS.ProcessEnv = process.env): string {
  const coordinator = env.SHELLX_MOTION_JOB_COORDINATOR_ROOT?.trim();
  if (coordinator) return join(coordinator, "render-plans");
  return join(defaultMotionRuntimeRoot(env), "render-plans");
}

export class MotionRenderPlanStore {
  private readonly root: string;
  private readonly runtime: PrivateMotionRuntimeDirectory;

  constructor(services: MotionRenderPlanStoreServices = {}) {
    // Store paths must stay bound to their construction-time directory even if an embedding host
    // changes process.cwd() while a coordinator survives.
    this.root = resolve(services.planRoot ?? defaultMotionRenderPlanRoot());
    this.runtime = new PrivateMotionRuntimeDirectory(this.root);
  }

  /**
   * Atomically bind one plan before events.  Same canonical bytes plus the same self-fingerprint
   * replay; any different plan for the owner-qualified job refuses and preserves the first bytes.
   */
  async bind(input: MotionRenderPlanBindingInput): Promise<MotionRenderPlanBindResult> {
    const callerId = assertCallerId(input.callerId);
    const jobId = assertMotionJobId(input.jobId);
    const plan = parseMotionRenderPlan(input.plan);
    // The V2 parser exists for retained history. This active writer stays V1-only until a
    // coordinator can carry V2's nonserializable execution authority through every checkpoint.
    if (plan.schema !== "shellx-motion/render-plan@1") return { ok: false, code: "plan_invalid" };
    const planBytes = serializeMotionRenderPlan(plan);
    await this.runtime.assertCurrent();
    const prior = await this.readStored(callerId, jobId);
    if (prior.kind === "invalid") return { ok: false, code: "plan_invalid" };
    if (prior.kind === "plan") {
      return samePlan(prior.plan, plan, planBytes)
        ? { ok: true, plan: prior.plan, replayed: true }
        : { ok: false, code: "plan_conflict" };
    }
    const serialized = serializeStoredMotionRenderPlanBinding({ callerId, jobId, plan });
    await this.runtime.assertCurrent();
    const created = await writeNoClobber(this.pathFor(callerId, jobId), serialized);
    if (created) return { ok: true, plan, replayed: false };

    const existing = await this.readStored(callerId, jobId);
    if (existing.kind !== "plan") return { ok: false, code: "plan_invalid" };
    return samePlan(existing.plan, plan, planBytes)
      ? { ok: true, plan: existing.plan, replayed: true }
      : { ok: false, code: "plan_conflict" };
  }

  /** Owner-scoped read. There is deliberately no cross-caller enumeration surface. */
  async read(input: { callerId: string; jobId: string }): Promise<MotionRenderPlanReadResult> {
    const callerId = assertCallerId(input.callerId);
    const jobId = assertMotionJobId(input.jobId);
    await this.runtime.assertCurrent();
    const stored = await this.readStored(callerId, jobId);
    if (stored.kind === "missing") return { ok: false, code: "plan_unknown" };
    if (stored.kind === "invalid") return { ok: false, code: "plan_invalid" };
    return { ok: true, plan: stored.plan };
  }

  private pathFor(callerId: string, jobId: string): string {
    return join(this.root, motionRenderPlanBindingFileName(callerId, jobId));
  }

  private async readStored(callerId: string, jobId: string): Promise<{ kind: "missing" } | { kind: "invalid" } | { kind: "plan"; plan: MotionRenderPlan }> {
    try {
      await this.runtime.assertCurrent();
      const raw = (await readPlanFile(this.pathFor(callerId, jobId))).toString("utf8");
      const parsed = parseStoredMotionRenderPlanBinding(JSON.parse(raw) as unknown);
      if (parsed.callerId !== callerId || parsed.jobId !== jobId || raw !== serializeStoredMotionRenderPlanBinding(parsed)) return { kind: "invalid" };
      return { kind: "plan", plan: parsed.plan };
    } catch (error) {
      return isMissing(error) ? { kind: "missing" } : { kind: "invalid" };
    }
  }
}

function samePlan(existing: MotionRenderPlan, incoming: MotionRenderPlan, incomingBytes: string): boolean {
  return existing.fingerprint === incoming.fingerprint && serializeMotionRenderPlan(existing) === incomingBytes;
}

async function writeNoClobber(path: string, serialized: string): Promise<boolean> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
    try {
      // `link` is atomic and refuses EEXIST; rename could overwrite the prior immutable binding.
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

/** Read a direct private-root child without following a leaf symlink or accepting replacement. */
async function readPlanFile(path: string): Promise<Buffer> {
  const before = await lstat(path);
  assertPlanFile(before);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    assertPlanFile(opened);
    if (!sameFile(before, opened)) throw new Error("Render plan binding changed before it was opened.");
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
      throw new Error("Render plan binding changed while it was read.");
    }
    assertPlanFile(after);
    assertPlanFile(lexicalAfter);
    return bytes.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

function assertPlanFile(metadata: Stats): void {
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || !Number.isSafeInteger(metadata.size)
    || metadata.size < 2 || metadata.size > MOTION_RENDER_PLAN_STORE_MAX_BYTES) {
    throw new Error("Render plan binding must be a bounded single-link regular non-symlink file.");
  }
}

function assertCallerId(value: unknown): string {
  return opaqueText(value, "Render plan callerId", 1, 256, CALLER_ID);
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
