import { describe, expect, it } from "vitest";
import { canonicalJsonSha256 } from "./canonical-json";
import { GPU_EFFECT_MODULE_RENDERER_ABI, createGpuEffectModuleBinding, gpuEffectModuleInstallationProvenanceFingerprint, gpuEffectModuleInstallationProvenanceProblem, gpuEffectModuleRegistryEntryFingerprint, gpuEffectModuleRendererIdentityProblem, gpuEffectModuleResourceCeilingFingerprint, gpuEffectModuleStaticDescriptorProblem, isCanonicalMotionEffectModuleVersion, motionEffectModuleManifestProblem, motionEffectModuleReferenceProblem, resolveGpuEffectModuleFrameBindings, type GpuEffectModuleBinding, type GpuEffectModuleRegistryEntry, type MotionEffectModuleReference } from "./effect-module";
import { compileGpuScene2dPlan } from "./gpu-scene-2d-plan";
import { GPU_FRAME_INTENT_SCHEMA, compileGpuFramePlan } from "./gpu-frame-intent";
import { compileGpuSceneStaticPlan } from "./gpu-scene-static-plan";
import { validateMotionDocumentInStages } from "./motion-validation";
import type { MotionDocument } from "./types";
import { loadSchema, validateDocument } from "./validate";

const hash = (fill: string): string => fill.repeat(64);
const rendererIdentity = { intrinsic: "motion.afterimage-stack.v1" as const, rendererAbi: GPU_EFFECT_MODULE_RENDERER_ABI, parameterSchema: "motion.afterimage-stack.parameters@1" as const, pipelineImplementationSha256: hash("c") };
const ref = (patch: Record<string, unknown> = {}) => ({ schema: "shellx-motion/effect-module-ref@1", moduleId: "motion.afterimage-stack", version: "1.2.3", parameters: { echoes: [{ dxPx: -12, dyPx: 7, color: "#C04080C0", opacityQ16: 45_000 }, { dxPx: 4, dyPx: -3, color: "#80C0FFFF", opacityQ16: 12_000 }], amountQ16: 32_768 }, ...patch } as MotionEffectModuleReference);
function motion(patch: Partial<MotionDocument> = {}): MotionDocument {
  return { schema: "shellx-motion/motion@1", id: "afterimage", name: "Afterimage", durationMs: 1_000, fps: 30, width: 64, height: 64, assets: [], provenance: { sourceApp: "test", createdBy: "test" }, layers: [
    { id: "subject", type: "group", startMs: 0, durationMs: 1_000, childLayerIds: ["plate", "afterimage"] },
    { id: "plate", type: "shape", shape: "rect", startMs: 0, durationMs: 1_000, fill: "#ffffffff", width: 64, height: 64 },
    { id: "afterimage", type: "adjustment", startMs: 0, durationMs: 1_000, effectModule: ref() }
  ], ...patch };
}
function entry(): GpuEffectModuleRegistryEntry {
  const provenance = { schema: "shellx-motion/effect-module-installation-provenance@1" as const, moduleId: "motion.afterimage-stack", version: "1.2.3", manifestSha256: hash("a"), manifestByteLength: 512, installedAt: "2026-08-15T09:00:00.000Z", authority: "workbench-operator" as const };
  const base = { moduleId: provenance.moduleId, version: provenance.version, manifestSha256: provenance.manifestSha256, manifestByteLength: provenance.manifestByteLength, installationProvenanceSha256: gpuEffectModuleInstallationProvenanceFingerprint(provenance), installationProvenance: provenance, intrinsic: "motion.afterimage-stack.v1" as const, rendererAbi: GPU_EFFECT_MODULE_RENDERER_ABI, parameterSchema: "motion.afterimage-stack.parameters@1" as const };
  return { ...base, registryEntrySha256: gpuEffectModuleRegistryEntryFingerprint(base), state: "active" };
}
function staticAndBinding(value: MotionDocument = motion()): { descriptor: NonNullable<Extract<ReturnType<typeof compileGpuSceneStaticPlan>, { ok: true }> ["plan"]["effectModules"]>[number]; binding: GpuEffectModuleBinding } {
  const result = compileGpuSceneStaticPlan(value, { effectModuleRegistry: new Map([["motion.afterimage-stack\u00001.2.3", entry()]]), effectModuleRendererIdentity: rendererIdentity });
  if (!result.ok || !result.plan.effectModules?.[0]) throw new Error("expected a resolved module descriptor");
  const descriptor = result.plan.effectModules[0]; return { descriptor, binding: createGpuEffectModuleBinding(descriptor) };
}

describe("closed local effect-module Core contract", () => {
  it("uses one bounded canonical SemVer parser for package, manifest, provenance, and descriptors", () => {
    const accepted = ["0.0.0", "1.2.3", "1.2.3-0", "1.2.3-alpha", "1.2.3-alpha.1", "1.2.3-rc-1.0"];
    const rejected = ["v1.2.3", "1.2.3+build.1", "latest", "^1.2.3", "1.2", "01.2.3", "1.02.3", "1.2.03", "1.2.3-01", "1.2.3-00", "1.2.3-rc.01", "1.2.3-", `1.2.3-${"a".repeat(128)}`];
    const manifest = { schema: "shellx-motion/effect-module-manifest@1", moduleId: "motion.afterimage-stack", version: "1.2.3", displayName: "Afterimage", intrinsic: "motion.afterimage-stack.v1", rendererAbi: GPU_EFFECT_MODULE_RENDERER_ABI, parameterSchema: "motion.afterimage-stack.parameters@1" };
    const provenance = entry().installationProvenance;
    const { descriptor } = staticAndBinding();

    for (const version of accepted) {
      expect(isCanonicalMotionEffectModuleVersion(version), version).toBe(true);
      expect(motionEffectModuleReferenceProblem(ref({ version })), version).toBeNull();
      expect(motionEffectModuleManifestProblem({ ...manifest, version }), version).toBeNull();
      expect(gpuEffectModuleInstallationProvenanceProblem({ ...provenance, version }), version).toBeNull();
    }
    for (const version of rejected) {
      expect(isCanonicalMotionEffectModuleVersion(version), version).toBe(false);
      expect(motionEffectModuleReferenceProblem(ref({ version })), version).toContain("invalid");
      expect(motionEffectModuleManifestProblem({ ...manifest, version }), version).toContain("invalid");
      expect(gpuEffectModuleInstallationProvenanceProblem({ ...provenance, version }), version).toContain("invalid");
      const { descriptorFingerprint: _descriptorFingerprint, ...payload } = descriptor;
      const resealed = { ...payload, version };
      expect(gpuEffectModuleStaticDescriptorProblem({ ...resealed, descriptorFingerprint: canonicalJsonSha256(resealed) }), version).toContain("invalid");
    }
  });

  it("validates only exact executable-free manifest and parameter data", async () => {
    expect(motionEffectModuleManifestProblem({ schema: "shellx-motion/effect-module-manifest@1", moduleId: "motion.afterimage-stack", version: "1.2.3", displayName: "Afterimage", intrinsic: "motion.afterimage-stack.v1", rendererAbi: GPU_EFFECT_MODULE_RENDERER_ABI, parameterSchema: "motion.afterimage-stack.parameters@1" })).toBeNull();
    expect(motionEffectModuleManifestProblem({ schema: "shellx-motion/effect-module-manifest@1", moduleId: "Motion.Afterimage", version: "1.2.3", displayName: "Afterimage", intrinsic: "motion.afterimage-stack.v1", rendererAbi: GPU_EFFECT_MODULE_RENDERER_ABI, parameterSchema: "motion.afterimage-stack.parameters@1" })).toContain("invalid");
    expect(motionEffectModuleReferenceProblem(ref({ moduleId: "Motion.Afterimage" }))).toContain("invalid");
    expect(motionEffectModuleReferenceProblem(ref({ version: "1.2.3-01" }))).toContain("invalid");
    expect(motionEffectModuleReferenceProblem(ref({ parameters: { echoes: [{ dxPx: 1, dyPx: 2, color: "#c04080c0", opacityQ16: 1 }], amountQ16: 1 } }))).toContain("invalid");
    const validation = await validateDocument(await loadSchema("motion"), motion());
    expect(validation).toEqual({ ok: true });
  });

  it("refuses executable-looking fields and every bounded-data escape", () => {
    const manifest = { schema: "shellx-motion/effect-module-manifest@1", moduleId: "motion.afterimage-stack", version: "1.2.3", displayName: "Afterimage", intrinsic: "motion.afterimage-stack.v1", rendererAbi: GPU_EFFECT_MODULE_RENDERER_ABI, parameterSchema: "motion.afterimage-stack.parameters@1" };
    for (const field of ["wgsl", "javascript", "wasm", "url", "path", "assets", "import", "browser", "resourceCeiling", "command"]) expect(motionEffectModuleManifestProblem({ ...manifest, [field]: "forged" })).toContain("unknown");
    expect(motionEffectModuleReferenceProblem({ ...ref(), extra: true })).toContain("unknown");
    expect(motionEffectModuleReferenceProblem(ref({ parameters: { echoes: Array.from({ length: 5 }, () => ({ dxPx: 0, dyPx: 0, color: "#FFFFFFFF", opacityQ16: 0 })), amountQ16: 0 } }))).toContain("invalid");
    for (const parameters of [{ echoes: [{ dxPx: 257, dyPx: 0, color: "#FFFFFFFF", opacityQ16: 0 }], amountQ16: 0 }, { echoes: [{ dxPx: 0, dyPx: 0, color: "#FFFFFFFF", opacityQ16: 65_536 }], amountQ16: 0 }, { echoes: [{ dxPx: 0, dyPx: 0, color: "#FFFFFFFF", opacityQ16: 0 }], amountQ16: -1 }]) expect(motionEffectModuleReferenceProblem(ref({ parameters }))).toContain("invalid");
  });

  it("refuses present invalid module fields before planners can fall back to ordinary adjustments", () => {
    for (const value of [null, false, 0, "", undefined]) {
      const hostile = motion(); const adjustment = hostile.layers[2] as unknown as Record<string, unknown>;
      adjustment.effectModule = value;
      adjustment.effects = { vignette: { amount: 0.2, softness: 0.4, color: "#ffffffff" } };
      expect(compileGpuSceneStaticPlan(hostile)).toMatchObject({ ok: false, failure: { code: "gpu_resource_refused", layerId: "afterimage" } });
      expect(compileGpuScene2dPlan(hostile, 0)).toMatchObject({ ok: false, failure: { code: "gpu_resource_refused", layerId: "afterimage" } });
    }
  });

  it("refuses non-string closed-reference primitives at the public structural stage", async () => {
    const cases: Array<{ path: string; apply(reference: Record<string, unknown>): void }> = [
      { path: "/layers/2/effectModule/moduleId", apply(reference) { reference.moduleId = 7; } },
      { path: "/layers/2/effectModule/version", apply(reference) { reference.version = { range: "latest" }; } },
      { path: "/layers/2/effectModule/parameters/echoes/0/color", apply(reference) { (reference.parameters as { echoes: Array<Record<string, unknown>> }).echoes[0].color = 7; } }
    ];
    for (const testCase of cases) {
      const invalid = motion(); const reference = (invalid.layers[2] as unknown as { effectModule: Record<string, unknown> }).effectModule;
      testCase.apply(reference);
      const result = await validateMotionDocumentInStages(invalid);
      expect(result).toMatchObject({ ok: false, stage: "structural" });
      if (!result.ok) expect(result.errors).toEqual(expect.arrayContaining([expect.objectContaining({ path: testCase.path })]));
    }
  });

  it("binds only a terminal direct adjustment of a non-nested isolated group", async () => {
    const root = motion({ layers: [...motion().layers.slice(1), { id: "afterimage", type: "adjustment", startMs: 0, durationMs: 1_000, effectModule: ref() }] });
    expect((await validateDocument(await loadSchema("motion"), root)).ok).toBe(false);
    expect(compileGpuSceneStaticPlan(root, { effectModuleRegistry: new Map([["motion.afterimage-stack\u00001.2.3", entry()]]) })).toMatchObject({ ok: false });
    const notFinal = motion(); (notFinal.layers[0].childLayerIds = ["afterimage", "plate"]);
    expect((await validateDocument(await loadSchema("motion"), notFinal)).ok).toBe(false);
    const extra = motion(); (extra.layers[2] as unknown as Record<string, unknown>).effects = { vignette: { amount: .2, softness: .4, color: "#ffffffff" } };
    expect((await validateDocument(await loadSchema("motion"), extra)).ok).toBe(false);
  });

  it("lowers exact rgba8 data into one fixed terminal group pass and rejects forged joins", () => {
    expect(compileGpuSceneStaticPlan(motion(), { effectModuleRegistry: new Map([["motion.afterimage-stack\u00001.2.3", entry()]]) })).toMatchObject({ ok: false, failure: { code: "gpu_resource_refused" } });
    const { descriptor, binding } = staticAndBinding();
    expect(descriptor).toMatchObject({ drawId: "effect-module-draw-2", scopeGroupId: "subject", scopeGroupDrawId: "subject.group", uniformBytes: 160, textureLoadCount: 3, passCount: 1, retainedTextureCount: 0, pipelineImplementationSha256: rendererIdentity.pipelineImplementationSha256, resourceCeilingSha256: gpuEffectModuleResourceCeilingFingerprint() }); expect(descriptor.echoes[0]).toMatchObject({ dxPx: -12, dyPx: 7, rgba8: [192, 64, 128, 192] });
    const resources = { effectModuleDescriptors: new Map([[descriptor.layerId, descriptor]]), effectModuleBindings: new Map([[binding.layerId, binding]]) };
    const frame = compileGpuScene2dPlan(motion(), 0, resources);
    expect(frame).toMatchObject({ ok: true, plan: { effectModuleCount: 1, frame: { budget: { effectModuleCount: 1, effectModuleUniformBytes: 160, effectModuleTextureLoadCount: 3, effectModulePassCount: 1 }, draws: [{ kind: "groupStart" }, { kind: "rect" }, { kind: "effectModule", scopeGroupDrawId: "subject.group" }, { kind: "groupEnd" }] } } });
    if (!frame.ok) throw new Error("expected an admitted effect-module frame");
    const outer = { kind: "groupStart", id: "outer.group", drawCount: frame.plan.frame.draws.length, x: 0, y: 0, scale: 1, rotationDeg: 0, pivotX: 0, pivotY: 0, opacity: 1, blendMode: "normal", effects: null };
    expect(() => compileGpuFramePlan({ schema: GPU_FRAME_INTENT_SCHEMA, width: frame.plan.frame.width, height: frame.plan.frame.height, clear: frame.plan.frame.clear, draws: [outer, ...frame.plan.frame.draws, { kind: "groupEnd", id: "outer.group.end", groupId: "outer.group" }] })).toThrow("non-nested scoped isolated group");
    const { descriptorFingerprint: _descriptorFingerprint, ...forgedBase } = descriptor; const forgedDescriptor = { ...forgedBase, manifestSha256: hash("f") }; const forged = { ...forgedDescriptor, descriptorFingerprint: canonicalJsonSha256(forgedDescriptor) }; const forgedBinding = createGpuEffectModuleBinding(forged);
    expect(compileGpuScene2dPlan(motion(), 0, { effectModuleDescriptors: resources.effectModuleDescriptors, effectModuleBindings: new Map([[forgedBinding.layerId, forgedBinding]]) })).toMatchObject({ ok: false, failure: { code: "gpu_resource_refused" } });
    const { descriptorFingerprint: _fingerprint, ...pipelineBase } = descriptor; const wrongResource = { ...pipelineBase, resourceCeilingSha256: hash("d") }; expect(() => createGpuEffectModuleBinding({ ...wrongResource, descriptorFingerprint: canonicalJsonSha256(wrongResource) })).toThrow("invalid descriptor fields"); expect(gpuEffectModuleRendererIdentityProblem({ ...rendererIdentity, pipelineImplementationSha256: "bad" })).toContain("invalid");
  });

  it("reserves a module draw ID across document and group synthetic identities", () => {
    const colliding = motion();
    (colliding.layers[0] as { childLayerIds: string[] }).childLayerIds = ["plate", "subject.group"];
    (colliding.layers[2] as { id: string }).id = "subject.group";
    colliding.layers.push({ id: "effect-module-draw-2", type: "shape", startMs: 0, durationMs: 1_000, visible: false, shape: "rect", fill: "#ffffffff", width: 1, height: 1 });
    const { descriptor, binding } = staticAndBinding(colliding);
    expect(descriptor).toMatchObject({ layerId: "subject.group", scopeGroupDrawId: "subject.group", drawId: "effect-module-draw-2-1" });
    const frame = compileGpuScene2dPlan(colliding, 0, { effectModuleDescriptors: new Map([[descriptor.layerId, descriptor]]), effectModuleBindings: new Map([[binding.layerId, binding]]) });
    expect(frame).toMatchObject({ ok: true, plan: { frame: { draws: [{ kind: "groupStart", id: "subject.group" }, { kind: "rect", id: "plate" }, { kind: "effectModule", id: "effect-module-draw-2-1", layerId: "subject.group", scopeGroupDrawId: "subject.group" }, { kind: "groupEnd", groupId: "subject.group" }] } } });
  });

  it("uses root exact time for nonzero group and child start, then permits non-overlap", () => {
    const delayed = motion(); delayed.layers[0].startMs = 300; delayed.layers[0].durationMs = 500; delayed.layers[1].startMs = 0; delayed.layers[1].durationMs = 500; delayed.layers[2].startMs = 200; delayed.layers[2].durationMs = 100;
    const { descriptor, binding } = staticAndBinding(delayed); const resources = { effectModuleDescriptors: new Map([[descriptor.layerId, descriptor]]), effectModuleBindings: new Map([[binding.layerId, binding]]) };
    const before = compileGpuScene2dPlan(delayed, 499, resources); expect(before.ok).toBe(true); if (before.ok) expect(before.plan).not.toHaveProperty("effectModuleCount");
    expect(compileGpuScene2dPlan(delayed, 500, resources)).toMatchObject({ ok: true, plan: { effectModuleCount: 1 } });
    const after = compileGpuScene2dPlan(delayed, 600, resources); expect(after.ok).toBe(true); if (after.ok) expect(after.plan).not.toHaveProperty("effectModuleCount");
  });

  it("omits hidden descriptors and refuses surplus resources while no-module plans retain identity", () => {
    const hidden = motion(); hidden.layers[0].visible = false;
    const hiddenPlan = compileGpuSceneStaticPlan(hidden); expect(hiddenPlan.ok).toBe(true); if (hiddenPlan.ok) expect(hiddenPlan.plan).not.toHaveProperty("effectModules");
    expect(resolveGpuEffectModuleFrameBindings(hidden, 0, new Map([["afterimage", {} as never]]), new Map([["afterimage", {} as never]]))).toMatchObject({ ok: false });
    const plain = motion({ layers: [{ id: "plate", type: "shape", shape: "rect", startMs: 0, durationMs: 1_000, fill: "#ffffffff", width: 64, height: 64 }] });
    expect(compileGpuSceneStaticPlan(plain, { effectModuleRegistry: new Map([["unused\u00001.0.0", entry()]]) })).toEqual(compileGpuSceneStaticPlan(plain));
    expect(compileGpuScene2dPlan(plain, 0, { effectModuleDescriptors: new Map(), effectModuleBindings: new Map() })).toEqual(compileGpuScene2dPlan(plain, 0));
    const childHidden = motion(); childHidden.layers[2].visible = false; const childPlan = compileGpuSceneStaticPlan(childHidden); expect(childPlan.ok).toBe(true); if (childPlan.ok) expect(childPlan.plan).not.toHaveProperty("effectModules");
  });

  it("accepts two non-overlapping scopes and refuses overlap, nesting, and registry-state forgery", () => {
    const two = motion(); two.layers[0].durationMs = 500; two.layers[1].durationMs = 500; two.layers[2].durationMs = 500;
    two.layers.push({ id: "subject-two", type: "group", startMs: 500, durationMs: 500, childLayerIds: ["plate-two", "afterimage-two"] }, { id: "plate-two", type: "shape", shape: "rect", startMs: 0, durationMs: 500, fill: "#ffffffff", width: 64, height: 64 }, { id: "afterimage-two", type: "adjustment", startMs: 0, durationMs: 500, effectModule: ref() });
    const registry = new Map([["motion.afterimage-stack\u00001.2.3", entry()]]), staticResources = { effectModuleRegistry: registry, effectModuleRendererIdentity: rendererIdentity }; expect(compileGpuSceneStaticPlan(two, staticResources)).toMatchObject({ ok: true, plan: { effectModules: [{ layerId: "afterimage" }, { layerId: "afterimage-two" }] } });
    (two.layers[3] as { startMs: number }).startMs = 400; expect(compileGpuSceneStaticPlan(two, staticResources)).toMatchObject({ ok: false, failure: { code: "gpu_resource_refused" } });
    const nested = motion(); nested.layers.push({ id: "outer", type: "group", startMs: 0, durationMs: 1_000, childLayerIds: ["subject"] }); expect(compileGpuSceneStaticPlan(nested, staticResources)).toMatchObject({ ok: false });
    const revoked = { ...entry(), state: "revoked" as const }; expect(compileGpuSceneStaticPlan(motion(), { effectModuleRegistry: new Map([["motion.afterimage-stack\u00001.2.3", revoked]]), effectModuleRendererIdentity: rendererIdentity })).toMatchObject({ ok: false });
    const badEntry = { ...entry(), registryEntrySha256: hash("e") }; expect(compileGpuSceneStaticPlan(motion(), { effectModuleRegistry: new Map([["motion.afterimage-stack\u00001.2.3", badEntry]]), effectModuleRendererIdentity: rendererIdentity })).toMatchObject({ ok: false });
    const badProvenance = { ...entry(), installationProvenanceSha256: hash("d") }; expect(compileGpuSceneStaticPlan(motion(), { effectModuleRegistry: new Map([["motion.afterimage-stack\u00001.2.3", badProvenance]]), effectModuleRendererIdentity: rendererIdentity })).toMatchObject({ ok: false });
  });
});
