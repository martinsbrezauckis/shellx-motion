import { chmod } from "node:fs/promises";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MOTION_RENDER_PLAN_STORE_MAX_BYTES,
  MotionRenderPlanStore,
  defaultMotionRenderPlanRoot,
  motionRenderPlanBindingFileName
} from "./render-plan-store";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "./output-path-trusted-workspace";
import { defaultMotionRuntimeRoot } from "./job-lease";
import { createMotionRenderPlan, MOTION_RENDER_PLAN_V2_SCHEMA, type MotionRenderPlanInput } from "./render-plan";
import { canonicalJsonSha256 } from "./canonical-json";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))); });

async function createStore(): Promise<{ root: string; store: MotionRenderPlanStore }> {
  const root = await mkdtemp(join(process.cwd(), ".scratch-render-plan-"));
  roots.push(root);
  return { root, store: new MotionRenderPlanStore({ planRoot: root }) };
}

function binding(overrides: Partial<{ callerId: string; jobId: string; plan: unknown }> = {}) {
  return {
    callerId: "cut:workspace-a",
    jobId: "cut:render-1",
    plan: createMotionRenderPlan(renderPlanInput()),
    ...overrides
  };
}

function renderPlanInput(overrides: Partial<MotionRenderPlanInput> = {}): MotionRenderPlanInput {
  const manifestSha256 = "a".repeat(64);
  const documentSha256 = "b".repeat(64);
  return {
    package: { id: "pkg_demo", manifestSha256 },
    motion: { id: "motion_demo", documentSha256 },
    lineage: { schema: "shellx-motion/package-render-lineage@1", manifestSha256, motionSha256: documentSha256 },
    output: { preset: "mp4-h264", mediaRole: "final-video", intentSha256: "c".repeat(64) },
    quality: { mode: "none" },
    requested: { lane: "ffmpeg", frameLane: "gpu", delivery: "streamed", segmented: null, fallback: "none" },
    runtime: { engine: "ffmpeg@7.1", routeFingerprint: "d".repeat(64), presetFingerprint: "e".repeat(64), capabilityFingerprint: "f".repeat(64) },
    compatibility: { version: 1, state: "current" },
    ...overrides
  };
}

function historicalV2Plan(): Record<string, unknown> {
  const v1 = createMotionRenderPlan(renderPlanInput());
  const { capabilityFingerprint: _opaqueCapabilityFingerprint, ...runtime } = v1.runtime;
  const { fingerprint: _v1Fingerprint, ...v1Content } = v1;
  const capability = {
    schema: "shellx-motion/render-capability-snapshot@1",
    tools: {
      ffmpeg: { source: "shellx-family", executableSha256: "a".repeat(64), versionSha256: "b".repeat(64), configurationSha256: "c".repeat(64), filtersSha256: "d".repeat(64), encodersSha256: "e".repeat(64) },
      ffprobe: { source: "shellx-family", executableSha256: "f".repeat(64), versionSha256: "a".repeat(64), configurationSha256: "b".repeat(64) }
    },
    filterGraph: { schema: "shellx-motion/ffmpeg-filter-graph-contract@1", sha256: "c".repeat(64), requiredFilters: [] },
    encoder: { attempts: [{ source: "software", encoder: "libx264" }], fallback: "none" },
    implementation: { frameLane: "gpu", renderer: "renderer-gpu@1", launch: "chromium@1", adapterFingerprint: "d".repeat(64), containment: "contained@1" }
  };
  const content = { ...v1Content, schema: MOTION_RENDER_PLAN_V2_SCHEMA, runtime, capability, compatibility: { version: 2, state: "current" } };
  return { ...content, fingerprint: canonicalJsonSha256(content) };
}

async function inTrustedWorkspace<T>(operation: () => Promise<T>): Promise<T> {
  const anchor = await createTrustedWorkspaceAnchor(process.cwd());
  return await withTrustedWorkspaceAnchor(anchor, operation);
}

describe("MotionRenderPlanStore", () => {
  it("uses the shared runtime root unless a trusted coordinator root overrides it", () => {
    expect(defaultMotionRenderPlanRoot({ SHELLX_MOTION_JOB_COORDINATOR_ROOT: "/host/coordinator" }))
      .toBe("/host/coordinator/render-plans");
    const environment = { XDG_RUNTIME_DIR: "/run/user/1000", SHELLX_MOTION_RUNTIME_ROOT: "/host/runtime" };
    expect(defaultMotionRenderPlanRoot(environment)).toBe(`${defaultMotionRuntimeRoot(environment)}/render-plans`);
  });

  it("atomically binds once and accepts only the identical canonical owner-scoped replay", async () => {
    const { store } = await createStore();
    const [first, replay] = await inTrustedWorkspace(async () => await Promise.all([store.bind(binding()), store.bind(binding())]));
    const accepted = [first, replay].filter((result): result is Extract<typeof result, { ok: true }> => result.ok);
    expect(accepted).toHaveLength(2);
    expect(accepted.map((result) => result.replayed).sort()).toEqual([false, true]);
    await expect(inTrustedWorkspace(async () => await store.read({ callerId: "cut:workspace-a", jobId: "cut:render-1" })))
      .resolves.toMatchObject({ ok: true, plan: { output: { intentSha256: "c".repeat(64) } } });
  });

  it("refuses a V2 record at the active writer while retaining parser-only history support", async () => {
    const { store } = await createStore();
    await expect(inTrustedWorkspace(async () => await store.bind(binding({ plan: historicalV2Plan() })))).resolves.toEqual({ ok: false, code: "plan_invalid" });
  });

  it("refuses a changed canonical plan and preserves the original bytes", async () => {
    const { store } = await createStore();
    const first = binding();
    await expect(inTrustedWorkspace(async () => await store.bind(first))).resolves.toMatchObject({ ok: true, replayed: false });
    const changed = createMotionRenderPlan(renderPlanInput({ output: { preset: "mp4-h264", mediaRole: "final-video", intentSha256: "d".repeat(64) } }));
    await expect(inTrustedWorkspace(async () => await store.bind(binding({ plan: changed })))).resolves.toEqual({ ok: false, code: "plan_conflict" });
    await expect(inTrustedWorkspace(async () => await store.read({ callerId: "cut:workspace-a", jobId: "cut:render-1" })))
      .resolves.toMatchObject({ ok: true, plan: { output: { intentSha256: "c".repeat(64) } } });
  });

  it("keeps a relative store root anchored across a host cwd change", async () => {
    const originalCwd = process.cwd();
    const root = await mkdtemp(join(originalCwd, ".scratch-render-plan-relative-"));
    const alternate = await mkdtemp(join(originalCwd, ".scratch-render-plan-alternate-"));
    roots.push(root, alternate);
    await mkdir(join(alternate, basename(root)), { mode: 0o700 });
    const store = new MotionRenderPlanStore({ planRoot: basename(root) });
    await expect(inTrustedWorkspace(async () => await store.bind(binding()))).resolves.toMatchObject({ ok: true, replayed: false });
    const changed = createMotionRenderPlan(renderPlanInput({ output: { preset: "mp4-h264", mediaRole: "final-video", intentSha256: "d".repeat(64) } }));
    try {
      process.chdir(alternate);
      await expect(store.bind(binding({ plan: changed }))).resolves.toEqual({ ok: false, code: "plan_conflict" });
    } finally {
      process.chdir(originalCwd);
    }
    await expect(inTrustedWorkspace(async () => await store.read({ callerId: "cut:workspace-a", jobId: "cut:render-1" })))
      .resolves.toMatchObject({ ok: true, plan: { output: { intentSha256: "c".repeat(64) } } });
  });

  it("isolates an identical external job id by caller identity", async () => {
    const { store } = await createStore();
    await expect(inTrustedWorkspace(async () => await store.bind(binding()))).resolves.toMatchObject({ ok: true, replayed: false });
    await expect(inTrustedWorkspace(async () => await store.bind(binding({ callerId: "design-studio:workspace-b" })))).resolves.toMatchObject({ ok: true, replayed: false });
    await expect(inTrustedWorkspace(async () => await store.read({ callerId: "design-studio:workspace-b", jobId: "cut:render-1" }))).resolves.toMatchObject({ ok: true });
    await expect(inTrustedWorkspace(async () => await store.read({ callerId: "other:workspace", jobId: "cut:render-1" }))).resolves.toEqual({ ok: false, code: "plan_unknown" });
  });

  it("fails closed for an oversized or symlinked direct-child binding", async () => {
    const { root, store } = await createStore();
    const name = motionRenderPlanBindingFileName("cut:workspace-a", "cut:render-1");
    await writeFile(join(root, name), "x".repeat(MOTION_RENDER_PLAN_STORE_MAX_BYTES + 1));
    await expect(inTrustedWorkspace(async () => await store.read({ callerId: "cut:workspace-a", jobId: "cut:render-1" }))).resolves.toEqual({ ok: false, code: "plan_invalid" });

    const symlinkedJob = "cut:render-2";
    const target = join(root, "outside.json");
    await writeFile(target, "{}");
    await symlink(target, join(root, motionRenderPlanBindingFileName("cut:workspace-a", symlinkedJob)));
    await expect(inTrustedWorkspace(async () => await store.read({ callerId: "cut:workspace-a", jobId: symlinkedJob }))).resolves.toEqual({ ok: false, code: "plan_invalid" });
  });

  it("does not adopt a symlinked or shared root", async () => {
    const parent = await mkdtemp(join(process.cwd(), ".scratch-render-plan-parent-"));
    const target = await mkdtemp(join(process.cwd(), ".scratch-render-plan-target-"));
    roots.push(parent, target);
    const symlinkRoot = join(parent, "plans");
    await symlink(target, symlinkRoot, "dir");
    const symlinkStore = new MotionRenderPlanStore({ planRoot: symlinkRoot });
    await expect(inTrustedWorkspace(async () => await symlinkStore.bind(binding()))).rejects.toThrow(/symlink|directory/i);

    if (process.platform !== "win32") {
      const sharedRoot = await mkdtemp(join(process.cwd(), ".scratch-render-plan-shared-"));
      roots.push(sharedRoot);
      await chmod(sharedRoot, 0o755);
      const sharedStore = new MotionRenderPlanStore({ planRoot: sharedRoot });
      await expect(inTrustedWorkspace(async () => await sharedStore.bind(binding()))).rejects.toThrow(/private/i);
    }
  });
});
