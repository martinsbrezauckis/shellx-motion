import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultMotionRenderAdmissionRoot,
  motionRenderAdmissionFileName,
  MotionRenderAdmissionStore
} from "./render-admission-store";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "./output-path-trusted-workspace";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))); });

async function store(): Promise<{ root: string; admissions: MotionRenderAdmissionStore }> {
  const root = await mkdtemp(join(process.cwd(), ".scratch-render-admission-"));
  roots.push(root);
  return { root, admissions: new MotionRenderAdmissionStore({ admissionRoot: root }) };
}

async function trusted<T>(operation: () => Promise<T>): Promise<T> {
  return await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(process.cwd()), operation);
}

const identity = { callerId: "cut:workspace-a", jobId: "cut:render-1" };
const fingerprint = "a".repeat(64);

describe("MotionRenderAdmissionStore", () => {
  it("uses the governed coordinator root when one is configured", () => {
    expect(defaultMotionRenderAdmissionRoot({ SHELLX_MOTION_JOB_COORDINATOR_ROOT: "/host/coordinator" }))
      .toBe("/host/coordinator/render-admissions");
  });

  it("atomically retains only the exact admission class replay", async () => {
    const { admissions } = await store();
    const legacy = { ...identity, admission: { mode: "legacy-planless" } as const };
    const [first, replay] = await trusted(async () => await Promise.all([admissions.bind(legacy), admissions.bind(legacy)]));
    expect([first, replay].map((result) => result.ok && result.replayed).sort()).toEqual([false, true]);
    await expect(trusted(async () => await admissions.bind({ ...identity, admission: { mode: "planned", planFingerprint: fingerprint } })))
      .resolves.toEqual({ ok: false, code: "admission_conflict" });
  });

  it("accepts an exact planned recovery but rejects another fingerprint", async () => {
    const { admissions } = await store();
    const planned = { ...identity, admission: { mode: "planned", planFingerprint: fingerprint } as const };
    await expect(trusted(async () => await admissions.bind(planned))).resolves.toMatchObject({ ok: true, replayed: false });
    await expect(trusted(async () => await admissions.bind(planned))).resolves.toMatchObject({ ok: true, replayed: true });
    await expect(trusted(async () => await admissions.bind({ ...identity, admission: { mode: "planned", planFingerprint: "b".repeat(64) } })))
      .resolves.toEqual({ ok: false, code: "admission_conflict" });
  });

  it("fails closed for corrupt leaves and unsafe roots", async () => {
    const { root, admissions } = await store();
    await writeFile(join(root, motionRenderAdmissionFileName(identity.callerId, identity.jobId)), "{not-json}");
    await expect(trusted(async () => await admissions.read(identity))).resolves.toEqual({ ok: false, code: "admission_invalid" });

    const parent = await mkdtemp(join(process.cwd(), ".scratch-render-admission-parent-"));
    const target = await mkdtemp(join(process.cwd(), ".scratch-render-admission-target-"));
    roots.push(parent, target);
    const unsafeRoot = join(parent, "admissions");
    await symlink(target, unsafeRoot, "dir");
    await expect(trusted(async () => await new MotionRenderAdmissionStore({ admissionRoot: unsafeRoot }).bind({ ...identity, admission: { mode: "legacy-planless" } })))
      .rejects.toThrow(/symlink|directory/i);
    if (process.platform !== "win32") {
      const shared = await mkdtemp(join(process.cwd(), ".scratch-render-admission-shared-"));
      roots.push(shared);
      await chmod(shared, 0o755);
      await expect(trusted(async () => await new MotionRenderAdmissionStore({ admissionRoot: shared }).bind({ ...identity, admission: { mode: "legacy-planless" } })))
        .rejects.toThrow(/private/i);
    }
  });
});
