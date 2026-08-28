import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import * as core from "@shellx-motion/core";
import { compileGpuScene2dPlan, type MotionDocument, type MotionPackage } from "@shellx-motion/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEffectModuleRegistryAuthority, createEffectModuleRegistryUseAuthority } from "./effect-module-registry.js";
import { createGpuPreviewSession } from "./gpu-points-preview.js";
import type { GpuFrameRenderSessionOpenResult } from "./gpu-frame-renderer.js";
import {
  gpuEffectModuleApplicationLedger,
  gpuEffectModuleBeginUseSummary,
  gpuEffectModuleBeginUseFrameResources,
  gpuEffectModuleFinalReceiptEvidence,
  gpuPreviewEffectModuleReceiptEvidence,
  recordGpuEffectModuleApplication,
  resolveGpuEffectModuleStaticPlanForUse,
  verifyGpuEffectModuleBeginUseLease,
  type GpuEffectModuleUseAuthority
} from "./gpu-effect-module-use-authority.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

describe("GPU effect-module read/use authority", () => {
  it("keeps a group-hidden module on the Core no-module path without waking a trusted authority", async () => {
    const hidden = document();
    hidden.layers[0]!.visible = false;
    const installed = await installedRegistryAuthority();
    const list = vi.spyOn(installed.registry, "list");
    const result = await resolveGpuEffectModuleStaticPlanForUse(hidden, installed.authority);
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.plan).not.toHaveProperty("effectModules");
    expect(list).not.toHaveBeenCalled();
  });

  it("refuses an unminted structural authority before it can read or use a visible module", async () => {
    let called = false;
    const forged = {
      async resolveForMotion() { called = true; return {}; },
      async beginUse() { called = true; return {}; }
    } as unknown as GpuEffectModuleUseAuthority;
    await expect(resolveGpuEffectModuleStaticPlanForUse(document(), forged)).resolves.toMatchObject({
      ok: false, failure: { code: "gpu_resource_refused", message: expect.stringContaining("trusted host") }
    });
    expect(called).toBe(false);
  });

  it("holds maps privately, binds an exact current lease, verifies its draw, and releases once", async () => {
    const authority = await installedAuthority();
    const resolved = await resolveGpuEffectModuleStaticPlanForUse(document(), authority);
    expect(resolved).toMatchObject({ ok: true, plan: { effectModules: [expect.objectContaining({ moduleId: "motion.afterimage-stack", rendererAbi: "shellx-motion/gpu-effect-module@1" })] } });
    if (!resolved.ok || !resolved.resolution) return;
    expect(Object.keys(resolved.resolution)).toEqual([]);
    expect((resolved.resolution as unknown as { registry?: unknown }).registry).toBeUndefined();
    const lease = await authority.beginUse(resolved.resolution);
    const frame = compileGpuScene2dPlan(document(), 0.25, gpuEffectModuleBeginUseFrameResources(lease));
    expect(frame).toMatchObject({ ok: true, plan: { effectModuleCount: 1 } });
    if (!frame.ok) return;
    const active = frame.plan.frame.draws.find((draw) => draw.kind === "effectModule");
    expect(verifyGpuEffectModuleBeginUseLease(lease, active)).toBeNull();
    const application = { index: 0, atUs: 250, framePlanFingerprint: frame.plan.frame.fingerprint, layerId: "afterimage" };
    recordGpuEffectModuleApplication(lease, application, frame.plan.frame);
    const ledger = gpuEffectModuleApplicationLedger(lease, [application]);
    expect(gpuEffectModuleBeginUseSummary(lease)).toMatchObject({ canonicalFrameCount: 30, modules: [expect.objectContaining({ layerId: "afterimage", bindingFingerprint: expect.any(String), registryGeneration: 1, revocation: "not-revoked-at-begin-use" })] });
    expect(() => gpuEffectModuleFinalReceiptEvidence(lease, ledger)).toThrow("completed");
    expect(await lease.release()).toEqual({ released: true });
    expect(await lease.release()).toEqual({ released: false });
    expect(verifyGpuEffectModuleBeginUseLease(lease, active)).toContain("released");
    expect(gpuPreviewEffectModuleReceiptEvidence(lease, ledger)).toMatchObject({
      applications: [expect.objectContaining({ atUs: 250, atMs: 0.25, drawId: "effect-module-draw-2", scopeGroupId: "subject", amountQ16: 32_768, release: "released", registryGeneration: 1 })]
    });
    expect(gpuEffectModuleFinalReceiptEvidence(lease, ledger)).toMatchObject({ release: "released", beginUse: { modules: [expect.objectContaining({ descriptorFingerprint: expect.any(String) })] }, applications: [expect.objectContaining({ index: 0, release: "released" })] });
  });

  it("refuses forged, unordered, and over-ceiling active ledgers", async () => {
    const authority = await installedAuthority();
    const { lease } = await resolvedLease(authority, document());
    const frame = compileGpuScene2dPlan(document(), 0, gpuEffectModuleBeginUseFrameResources(lease));
    if (!frame.ok) return;
    const entry = { index: 0, atUs: 0, framePlanFingerprint: frame.plan.frame.fingerprint, layerId: "afterimage" };
    recordGpuEffectModuleApplication(lease, entry, frame.plan.frame);
    expect(() => gpuEffectModuleApplicationLedger(lease, [{ ...entry, layerId: "forged" }])).toThrow("invalid");
    expect(() => gpuEffectModuleApplicationLedger(lease, [{ ...entry, framePlanFingerprint: "0".repeat(64) }])).toThrow("invalid");
    recordGpuEffectModuleApplication(lease, { ...entry, index: 1 }, frame.plan.frame);
    expect(() => gpuEffectModuleApplicationLedger(lease, [entry, { ...entry, index: 1, atUs: 0 }])).toThrow("monotonic");
    expect(() => gpuEffectModuleApplicationLedger(lease, Array.from({ length: 31 }, (_, index) => ({ ...entry, index, atUs: index })))).toThrow("ceiling");
    await lease.release();
  });

  it("allows A-to-B-to-A across one non-overlapping plan but refuses a foreign B binding", async () => {
    const authority = await installedAuthority();
    const onlyA = await resolvedLease(authority, document());
    const onlyB = await resolvedLease(authority, document({ amountQ16: 12_000 }));
    const foreign = frameFor(document({ amountQ16: 12_000 }), onlyB.lease, 0);
    expect(verifyGpuEffectModuleBeginUseLease(onlyA.lease, foreign)).toContain("does not match");
    await onlyA.lease.release();
    await onlyB.lease.release();

    const sequenceMotion = sequentialDocument();
    const sequence = await resolvedLease(authority, sequenceMotion);
    for (const atMs of [0, 500, 0]) {
      expect(verifyGpuEffectModuleBeginUseLease(sequence.lease, frameFor(sequenceMotion, sequence.lease, atMs))).toBeNull();
    }
    const first = compileGpuScene2dPlan(sequenceMotion, 0, gpuEffectModuleBeginUseFrameResources(sequence.lease));
    const later = compileGpuScene2dPlan(sequenceMotion, 500, gpuEffectModuleBeginUseFrameResources(sequence.lease));
    if (!first.ok || !later.ok) return;
    const firstLayer = first.plan.frame.draws.find((draw) => draw.kind === "effectModule")?.layerId;
    const laterLayer = later.plan.frame.draws.find((draw) => draw.kind === "effectModule")?.layerId;
    if (!firstLayer || !laterLayer) return;
    const entries = [{ index: 0, atUs: 0, framePlanFingerprint: first.plan.frame.fingerprint, layerId: firstLayer }, { index: 15, atUs: 500_000, framePlanFingerprint: later.plan.frame.fingerprint, layerId: laterLayer }];
    for (const [entry, frame] of [[entries[0]!, first.plan.frame], [entries[1]!, later.plan.frame]] as const) recordGpuEffectModuleApplication(sequence.lease, entry, frame);
    expect(gpuEffectModuleApplicationLedger(sequence.lease, entries).applications.map((entry) => entry.index)).toEqual([0, 15]);
    await sequence.lease.release();
  });
});

describe("GPU preview effect-module lease ordering", () => {
  it("uses a fresh opaque lease and receipts one fractional-time application only", async () => {
    const installed = await installedRegistryAuthority();
    const publication = vi.spyOn(core, "acquireDerivedOutputPublication").mockImplementation(async ({ outputPath }) => ({
      stagingPath: `${outputPath}.staging`,
      async verifyFile() { const bytes = await readFile(`${outputPath}.staging`); return { sha256: createHash("sha256").update(bytes).digest("hex") }; },
      async publishFile() {}, async abort() {}
    } as never));
    let passedLease: unknown;
    const session = createGpuPreviewSession(modulePackage(installed.root), { effectModuleAuthority: installed.authority, openRuntime: async () => {
      const opened = await fakeRuntime();
      if (!opened.ok) return opened;
      return { ok: true, session: { ...opened.session, async render(plan, options) { passedLease = options?.effectModuleLease; return await opened.session.render(plan, options); } } };
    } });
    try {
      const result = await session.renderFrame({ atMs: 0.25, outDir: join(installed.root, "preview") });
      expect(result.ok, result.ok ? undefined : result.error.message).toBe(true);
      if (!result.ok) return;
      expect(passedLease).toBeDefined();
      expect(result.receipt.output).toMatchObject({ gpuEffectModules: { applications: [expect.objectContaining({ atUs: 250, atMs: 0.25, layerId: "afterimage", release: "released" })] } });
    } finally {
      await session.close();
      publication.mockRestore();
    }
  });

  it("receipts a released empty module ledger for inactive module time while omitting it for module-free preview", async () => {
    const installed = await installedRegistryAuthority();
    const publication = vi.spyOn(core, "acquireDerivedOutputPublication").mockImplementation(async ({ outputPath }) => ({
      stagingPath: `${outputPath}.staging`, async verifyFile() { const bytes = await readFile(`${outputPath}.staging`); return { sha256: createHash("sha256").update(bytes).digest("hex") }; }, async publishFile() {}, async abort() {}
    } as never));
    let inactiveDraws: readonly { kind: string }[] | undefined;
    const inactive = createGpuPreviewSession(modulePackage(installed.root, lateModuleDocument()), { effectModuleAuthority: installed.authority, openRuntime: async () => {
      const opened = await fakeRuntime();
      if (!opened.ok) return opened;
      return { ok: true, session: { ...opened.session, async render(plan, options) { inactiveDraws = (plan as { draws: readonly { kind: string }[] }).draws; return await opened.session.render(plan, options); } } };
    } });
    const moduleFree = createGpuPreviewSession(modulePackage(installed.root, moduleFreeDocument()), { openRuntime: fakeRuntime });
    try {
      const inactiveResult = await inactive.renderFrame({ atMs: 0, outDir: join(installed.root, "inactive") });
      expect(inactiveResult.ok, inactiveResult.ok ? undefined : inactiveResult.error.message).toBe(true);
      if (!inactiveResult.ok) return;
      expect(inactiveDraws?.some((draw) => draw.kind === "effectModule")).toBe(false);
      expect(inactiveResult.receipt.output).toMatchObject({ gpuEffectModules: { release: "released", applications: [], beginUse: { modules: [expect.objectContaining({ revocation: "not-revoked-at-begin-use" })] } } });
      const plainResult = await moduleFree.renderFrame({ atMs: 0, outDir: join(installed.root, "module-free") });
      expect(plainResult.ok, plainResult.ok ? undefined : plainResult.error.message).toBe(true);
      if (!plainResult.ok) return;
      expect(plainResult.receipt.output).not.toHaveProperty("gpuEffectModules");
    } finally {
      await inactive.close(); await moduleFree.close(); publication.mockRestore();
    }
  });

  it("fails closed when a render consumes its lease before preview release", async () => {
    const installed = await installedRegistryAuthority();
    const session = createGpuPreviewSession(modulePackage(installed.root), { effectModuleAuthority: installed.authority, openRuntime: async () => {
      const opened = await fakeRuntime();
      if (!opened.ok) return opened;
      return { ok: true, session: { ...opened.session, async render(plan, options) { await options?.effectModuleLease?.release(); return await opened.session.render(plan, options); } } };
    } });
    try {
      await expect(session.renderFrame({ atMs: 0, outDir: join(installed.root, "lease-consumed") })).resolves.toMatchObject({ ok: false, error: { code: "gpu_execution_refused" } });
    } finally {
      await session.close();
    }
  });

  it("refuses module-plus-video before provider, scene-resource, or runtime opening", async () => {
    const installed = await installedRegistryAuthority();
    let providerOpened = 0, runtimeOpened = 0;
    const session = createGpuPreviewSession(modulePackage(installed.root, moduleVideoDocument()), {
      effectModuleAuthority: installed.authority,
      openVideoProvider: async () => { providerOpened += 1; throw new Error("video provider must not open"); },
      openRuntime: async () => { runtimeOpened += 1; return await fakeRuntime(); }
    });
    try {
      await expect(session.renderFrame({ atMs: 0, outDir: join(installed.root, "module-video") })).resolves.toMatchObject({ ok: false, error: { code: "gpu_effect_module_video_unsupported" } });
      expect({ providerOpened, runtimeOpened }).toEqual({ providerOpened: 0, runtimeOpened: 0 });
    } finally {
      await session.close();
    }
  });

  it("rechecks revocation after governor admission and before any runtime opens", async () => {
    const installed = await installedRegistryAuthority();
    let admitted: (() => void) | undefined;
    let governorEntered: (() => void) | undefined;
    const governor = {
      async run(_request: unknown, work: (context: { signal: AbortSignal; watchProcess(pid: number): void }) => Promise<unknown>) {
        governorEntered?.();
        await new Promise<void>((resolve) => { admitted = resolve; });
        return { value: await work({ signal: new AbortController().signal, watchProcess() {} }), evidence: {} };
      }
    } as never;
    let opened = 0, providerOpened = 0;
    const session = createGpuPreviewSession(modulePackage(installed.root, missingResourceModuleDocument()), { governor, effectModuleAuthority: installed.authority, openVideoProvider: async () => { providerOpened += 1; throw new Error("provider must not open"); }, openRuntime: async () => { opened += 1; return await fakeRuntime(); } });
    const entered = new Promise<void>((resolve) => { governorEntered = resolve; });
    const pending = session.renderFrame({ atMs: 0, outDir: join(installed.root, "preview") });
    await entered;
    await installed.registry.revoke("motion.afterimage-stack", "1.0.0");
    admitted?.();
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: "revoked" } });
    expect({ providerOpened, opened }).toEqual({ providerOpened: 0, opened: 0 });
    await session.close();
  });
});

async function installedAuthority(): Promise<GpuEffectModuleUseAuthority> {
  return (await installedRegistryAuthority()).authority;
}

async function installedRegistryAuthority(): Promise<{ root: string; registry: ReturnType<typeof createEffectModuleRegistryAuthority>; authority: GpuEffectModuleUseAuthority }> {
  const base = join(resolve(process.cwd(), "../.."), ".scratch", "gpu-effect-module-use-authority");
  await mkdir(base, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(base, "shellx-motion-gpu-effect-use-"));
  roots.push(root);
  const stateRoot = join(root, "effect-modules");
  await mkdir(stateRoot, { mode: 0o700 });
  const source = join(root, "afterimage.json");
  await writeFile(source, `${JSON.stringify({ schema: "shellx-motion/effect-module-manifest@1", moduleId: "motion.afterimage-stack", version: "1.0.0", displayName: "Afterimage Stack", intrinsic: "motion.afterimage-stack.v1", rendererAbi: "shellx-motion/gpu-effect-module@1", parameterSchema: "motion.afterimage-stack.parameters@1" })}\n`, { mode: 0o600 });
  const registry = createEffectModuleRegistryAuthority({ stateRoot, readManifestFileForTest: async (path) => {
    const bytes = await readFile(path);
    return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
  } });
  const pending = await registry.prepareInstallFromManifestFile(source);
  await registry.confirmInstall(pending.confirmationId);
  return { root, registry, authority: createEffectModuleRegistryUseAuthority(registry) };
}

async function resolvedLease(authority: GpuEffectModuleUseAuthority, motion: MotionDocument) {
  const resolved = await resolveGpuEffectModuleStaticPlanForUse(motion, authority);
  if (!resolved.ok || !resolved.resolution) throw new Error("expected a resolved effect-module static plan");
  return { lease: await authority.beginUse(resolved.resolution) };
}

function frameFor(motion: MotionDocument, lease: Awaited<ReturnType<typeof resolvedLease>>["lease"], atMs: number) {
  const frame = compileGpuScene2dPlan(motion, atMs, gpuEffectModuleBeginUseFrameResources(lease));
  if (!frame.ok) throw new Error(frame.failure.message);
  const active = frame.plan.frame.draws.find((draw) => draw.kind === "effectModule");
  if (!active) throw new Error("expected an active effect-module draw");
  return active;
}

function document(parameters: { amountQ16?: number } = {}): MotionDocument {
  return {
    schema: "shellx-motion/motion@1", id: "effect-preview", name: "Effect preview", durationMs: 1_000, fps: 30, width: 64, height: 64, assets: [], provenance: { sourceApp: "test", createdBy: "test" },
    layers: [
      { id: "subject", type: "group", startMs: 0, durationMs: 1_000, childLayerIds: ["plate", "afterimage"] },
      { id: "plate", type: "shape", shape: "rect", startMs: 0, durationMs: 1_000, fill: "#ffffffff", width: 64, height: 64 },
      { id: "afterimage", type: "adjustment", startMs: 0, durationMs: 1_000, effectModule: { schema: "shellx-motion/effect-module-ref@1", moduleId: "motion.afterimage-stack", version: "1.0.0", parameters: { echoes: [{ dxPx: -8, dyPx: 4, color: "#FF8040C0", opacityQ16: 48_000 }], amountQ16: parameters.amountQ16 ?? 32_768 } } }
    ]
  };
}

function sequentialDocument(): MotionDocument {
  const motion = document();
  motion.layers[0]!.durationMs = 500;
  motion.layers[1]!.durationMs = 500;
  motion.layers[2]!.durationMs = 500;
  motion.layers.push(
    { id: "subject-b", type: "group", startMs: 500, durationMs: 500, childLayerIds: ["plate-b", "afterimage-b"] },
    { id: "plate-b", type: "shape", shape: "rect", startMs: 0, durationMs: 500, fill: "#ffffffff", width: 64, height: 64 },
    { id: "afterimage-b", type: "adjustment", startMs: 0, durationMs: 500, effectModule: { schema: "shellx-motion/effect-module-ref@1", moduleId: "motion.afterimage-stack", version: "1.0.0", parameters: { echoes: [{ dxPx: 9, dyPx: -4, color: "#80C0FFFF", opacityQ16: 26_000 }], amountQ16: 12_000 } } }
  );
  return motion;
}

function lateModuleDocument(): MotionDocument {
  const motion = document();
  motion.layers[0] = { ...motion.layers[0]!, startMs: 500, durationMs: 500 };
  motion.layers[1] = { ...motion.layers[1]!, durationMs: 500 };
  motion.layers[2] = { ...motion.layers[2]!, durationMs: 500 };
  return motion;
}

function moduleFreeDocument(): MotionDocument {
  const motion = document();
  motion.layers[0] = { ...motion.layers[0]!, childLayerIds: ["plate"] };
  motion.layers.pop();
  return motion;
}

function missingResourceModuleDocument(): MotionDocument {
  const motion = document();
  motion.layers.push({ id: "missing", type: "image", assetRef: "missing.png", startMs: 0, durationMs: 1_000, transform: { x: 0, y: 0, width: 1, height: 1 } });
  return motion;
}

function moduleVideoDocument(): MotionDocument {
  const motion = missingResourceModuleDocument();
  motion.layers.push({ id: "clip", type: "video", assetRef: "clip.mp4", startMs: 0, durationMs: 1_000 });
  return motion;
}

function modulePackage(root: string, motion = document()): MotionPackage {
  return { root, manifest: { schema: "shellx-motion/package-manifest@1", id: "effect-preview-package", name: "Effect preview", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["gpu"], hosts: ["motion"] } }, motion };
}

async function fakeRuntime(): Promise<GpuFrameRenderSessionOpenResult> {
  return { ok: true, session: {
    browserProcess: { pid: 9_001, launcher: "playwright-launch-server", containment: null },
    async uploadImages(images) { return { ok: true as const, uploaded: images.length }; },
    async render(plan) {
      const frame = plan as { width: number; height: number };
      const rgba = Buffer.alloc(frame.width * frame.height * 4, 255);
      return { ok: true as const, frame: { rgba, sha256: createHash("sha256").update(rgba).digest("hex"), width: frame.width, height: frame.height, evidence: { schema: "shellx-motion/gpu-runtime@1", adapter: { vendor: "test", device: "test" }, browser: { name: "test", version: "1" } } as never } };
    },
    async close() {}
  } };
}
