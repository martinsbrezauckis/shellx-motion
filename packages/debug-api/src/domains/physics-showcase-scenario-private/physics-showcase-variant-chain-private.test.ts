import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson } from "@shellx-motion/core";
import { createTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { afterEach, describe, expect, it } from "vitest";
import { bakePhysicsToDurableArtifact, reopenPhysicsBakeDurableArtifact } from "../physics-bake-durable-private/physics-bake-durable-private.js";
import { compilePhysicsVisualBindingPlan, evaluatePhysicsVisualBindingFrame } from "../physics-visual-binding-private/physics-visual-binding-private.js";
import { materializePhysicsVisualPackage, preparePhysicsVisualPackageMaterialization } from "../physics-visual-package-materialize-private/physics-visual-package-materialize-private.js";
import { readPhysicsVisualPackageSidecar } from "../physics-visual-package-materialize-private/physics-visual-package-materialize-artifacts-private.js";
import { withC7B4dOutputAuthority } from "../physics-visual-package-materialize-private/physics-visual-package-materialize-facts-private.js";
import { reopenPhysicsVisualPackageMaterializationOutput, reopenPhysicsVisualPackagePreviewInput } from "../physics-visual-package-materialize-private/physics-visual-package-materialize-output-private.js";
import { compilePhysicsVisualPresentationFramePlan, compilePhysicsVisualPresentationStaticPlan } from "../physics-visual-presentation-private/physics-visual-presentation-private.js";
import { compilePhysicsVisualRetainedStaticPlan } from "../physics-visual-retained-private/physics-visual-retained-private.js";
import {
  compilePhysicsShowcaseScenario,
  createPhysicsShowcasePresentationRecipe,
  createPhysicsShowcaseRetainedRenderRecipe,
  createPhysicsShowcaseScenario,
  createPhysicsShowcaseVisualBindingRecipe,
} from "./unadopted/physics-showcase-scenario-private.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

const VARIANTS = [
  {
    scenarioName: "bingo-longer",
    durationUs: 7_500_000,
    frameCount: 450,
    dynamicBodies: 16,
    staticBodies: 42,
    actions: [
      { id: "force", kind: "force", startStep: 120, endStep: 360, bodyId: "ball-00", vector: [5, 4, 6] },
      { id: "impulse", kind: "impulse", atStep: 0, bodyId: "ball-01", vector: [0.65, 1.2, 0] },
    ],
    geometry: [{ id: "ball", kind: "sphere", radius: Math.fround(0.18), quality: "cinematic" }],
    colors: ["#1d9bf0", "#36c275", "#7654ff", "#e5536d", "#f0be32", "#ff814f", "#e65ec2", "#63cff3"],
    additionalGeometry: [{ id: "z-cage-sphere", kind: "sphere", radius: 2.75, quality: "cinematic" }],
    additionalColors: ["#9fe7ff"],
    presentation: { backgroundColor: "#07111f", viewport: { width: 640, height: 360 }, camera: { position: [5.2, 3.6, 7.2], target: [0, 1.9, 0], fovDeg: 38, near: 0.1, far: 100 }, lighting: { direction: [-0.4, -0.8, -0.4], color: "#ffffff", ambient: 0.3, intensity: 1.4 } },
    presentationSlots: 1,
    enclosure: { center: [0, 2.25, 0], visibleRadius: 2.75, surfaceMargin: 0.05, ballRadius: 0.18 },
    identities: { compilation: "fe71cff3cc34534328f5fcd779a832ee4a7f28e272a2e851f2c406e3ab6c973b", physicsPlan: "443333a946b49d4533fe1238a2d809f447ad4134c13a17585106ffe6d6c752d1", provider: "383afd854dd21ad10a8f004cb21ff91ce8b06935311f748818828527b0f229e2", durableManifest: "009b47f1e90b2470f32d84a6030ffb10b7254103b9c4dec4257e6d3780647a95", durableReceipt: "8b485bbf1408ecb7a278ed49ec5f3816cd80753a2c234d0980d5ae616f0b06e6", visual: "57c9f23a1f5d183cbdaa923b64ea8df1ba3ceddfd25faab0a9519fa7e14b4815", retained: "9a1a170de344dbf5a4b146a954ca3d1e8c851d031970fa94bb451e879254a1ed", presentation: "3905249ae6a673bf28057de9389229aae45cea5e9359e75a33843a80d0409369", outputReceipt: "cc6ffcfe45e0562d5dfa51af8ca9ddad0632d6283e970fcfe0782db7c9bbd1a4", recipeBundle: "8733882908d2eaa01c8a4001a4e3d7660075d7b45c14dca8928dbf25957bbfaa" },
  },
  {
    scenarioName: "wrecking-wall-large",
    durationUs: 6_000_000,
    frameCount: 360,
    dynamicBodies: 136,
    staticBodies: 1,
    actions: [
      { id: "impact", kind: "impulse", atStep: 40, bodyId: "sphere", vector: [-1_500, 0, 0] },
      { id: "push", kind: "force", startStep: 80, endStep: 130, bodyId: "sphere", vector: [-35, 0, 0] },
    ],
    geometry: [{ id: "brick", kind: "box", size: [1, 0.5, 0.5] }, { id: "sphere", kind: "sphere", radius: 1.15, quality: "cinematic" }],
    colors: ["#c44d36", "#ebaa55", "#a93d2b", "#223248"],
    additionalGeometry: [{ id: "z-ground-visual", kind: "box", size: [24, 0.2, 10] }, { id: "z-tether-visual", kind: "box", size: [0.1, 1, 0.1] }],
    additionalColors: ["#203146", "#d9e2ec"],
    presentation: { backgroundColor: "#07111f", viewport: { width: 640, height: 360 }, camera: { position: [18, 12, 23], target: [0, 3.8, 0], fovDeg: 43, near: 0.1, far: 150 }, lighting: { direction: [-0.4, -0.8, -0.4], color: "#ffffff", ambient: 0.3, intensity: 1.4 } },
    presentationSlots: 0,
    identities: { compilation: "45e729fa0eb0e5de99236f4bc6828e30c2610110337463f58a1c1a31c0e2125d", physicsPlan: "df82b3c12e8bb39ecd887b13409b7465197c69e64c741347441fe25f4684ba16", provider: "b7e0822c9f711c057ef41a14cb1eeb0ded2963f03bbbda7a48e46676880290be", durableManifest: "479345aa6f05ceb4df5b73f3cb512ad6b4f9c244aeb277df8029441286262dd6", durableReceipt: "933893b022c0d199e970c2d5fdf0f32602cc57d1f1e38eb72fd5a520a41b028f", visual: "69c6e89bf29b19be55972ca42127c1c4056cd272cfa6fd0c1848aba49aa04c88", retained: "c0eea2325ab748348f040da85b1c29a0dff04303458c702c9312c91661d6fad9", presentation: "82e92848ded08a62dc11d7e34265539ec2e2bc270be95d4d73380c75ef911c05", outputReceipt: "edbd7b13fd8449e2b7925941104db23c9e4930e7508a3517501a6cfd4bddf725", recipeBundle: "baade4ef1aeecac23715b09bca8bf519a7a9f90db8bb9a0ca0274b0578b45637" },
  },
] as const;

describe.skipIf(process.platform !== "linux")("C7B6B private variable-scenario chain", () => {
  for (const expected of VARIANTS) {
    it(`drives ${expected.scenarioName} through C7B2/C7B3/C7B4A-D and reopens only installed output`, async () => {
      const root = await mkdtemp(join(tmpdir(), `shellx-motion-c7b6b-${expected.scenarioName}-`));
      roots.push(root);

      const compilation = compilePhysicsShowcaseScenario(createPhysicsShowcaseScenario(expected.scenarioName));
      const physicsWorkspace = join(root, "physics-workspace");
      await mkdir(physicsWorkspace, { recursive: true, mode: 0o700 });
      await chmod(physicsWorkspace, 0o700);
      const physicsHost = {
        outputRoot: join(physicsWorkspace, "artifact"),
        workspaceRoot: physicsWorkspace,
        workspaceAuthority: await createTrustedWorkspaceAnchor(physicsWorkspace),
        requireAbsentOutput: true as const,
      };

      // C7B2 is invoked by the C7B3 publisher. C7B4A independently reopens the durable result.
      const durable = await bakePhysicsToDurableArtifact(compilation.physicsPlan, physicsHost);
      const reopenedDurable = await reopenPhysicsBakeDurableArtifact(physicsHost);
      const visualRecipe = createPhysicsShowcaseVisualBindingRecipe(compilation, compilation.physicsPlan);
      const visual = await compilePhysicsVisualBindingPlan(compilation.physicsPlan, physicsHost, visualRecipe);
      const retainedRecipe = createPhysicsShowcaseRetainedRenderRecipe(compilation, visual.fingerprint);
      const retained = compilePhysicsVisualRetainedStaticPlan(visual, retainedRecipe);
      const presentationRecipe = createPhysicsShowcasePresentationRecipe(compilation, retained.fingerprint, compilation.physicsPlan);
      const presentation = compilePhysicsVisualPresentationStaticPlan(retained, compilation.physicsPlan, presentationRecipe);

      expect(compilation.physicsPlan.schedule).toMatchObject({ startUs: 0, endUs: expected.durationUs, stepsPerSecond: 120, stepCount: expected.durationUs * 120 / 1_000_000 });
      expect(compilation.budget).toMatchObject({ dynamicBodyCount: expected.dynamicBodies, staticBodyCount: expected.staticBodies, renderFrameCount: expected.frameCount });
      const actualActions = compilation.physicsPlan.recipe.actions;
      expect(actualActions.map(({ vector: _vector, ...action }) => action)).toEqual(expected.actions.map(({ vector: _vector, ...action }) => action));
      for (const [index, action] of actualActions.entries()) {
        for (const [component, value] of action.vector.entries()) expect(value).toBeCloseTo(expected.actions[index]!.vector[component]!, 6);
      }
      expect(durable.manifest.source).toMatchObject({ planFingerprint: compilation.physicsPlan.fingerprint, recipeSha256: compilation.physicsPlan.recipeSha256 });
      expect(reopenedDurable.manifest.fingerprint).toBe(durable.manifest.fingerprint);
      expect(visual.schedule).toMatchObject({ endUs: expected.durationUs, frameRate: 60, renderFrameCount: expected.frameCount, terminalFrameIndex: expected.frameCount });
      expect(visual.budget).toMatchObject({ renderFrameCount: expected.frameCount, evaluationFrameCount: expected.frameCount + 1 });
      expect(visual.recipe.resources.geometry).toEqual(expected.geometry);
      expect(visual.recipe.resources.materials.map((material) => material.baseColor)).toEqual(expected.colors);
      expect(retained.recipe.backgroundColor).toBe(expected.presentation.backgroundColor);
      expect(retained.recipe.viewport).toEqual(expected.presentation.viewport);
      expect(retained.recipe.camera.fovDeg).toBeCloseTo(expected.presentation.camera.fovDeg, 6);
      expect(retained.recipe.camera.near).toBeCloseTo(expected.presentation.camera.near, 6);
      expect(retained.recipe.camera.far).toBeCloseTo(expected.presentation.camera.far, 6);
      expect(retained.recipe.lighting.color).toBe(expected.presentation.lighting.color);
      for (const [actual, intended] of [
        [retained.recipe.camera.position, expected.presentation.camera.position],
        [retained.recipe.camera.target, expected.presentation.camera.target],
        [retained.recipe.lighting.direction, expected.presentation.lighting.direction],
      ] as const) {
        for (const [index, value] of actual.entries()) expect(value).toBeCloseTo(intended[index]!, 6);
      }
      expect(retained.recipe.lighting.ambient).toBeCloseTo(expected.presentation.lighting.ambient, 6);
      expect(retained.recipe.lighting.intensity).toBeCloseTo(expected.presentation.lighting.intensity, 6);
      expect(presentation.recipe.additionalResources.geometry).toEqual(expected.additionalGeometry);
      expect(presentation.recipe.additionalResources.materials.map((material) => material.baseColor)).toEqual(expected.additionalColors);
      expect(presentation.budget).toMatchObject({ instanceSlotCount: expected.dynamicBodies + (expected.scenarioName === "wrecking-wall-large" ? 2 : 1), presentationBindingCount: expected.presentationSlots });
      if ("enclosure" in expected) {
        const enclosure = compilation.enclosure!, radius = expected.enclosure.ballRadius, limit = enclosure.record.visibleRadius - enclosure.record.surfaceMargin;
        expect(enclosure.record.center).toEqual(expected.enclosure.center);
        expect(enclosure.record.visibleRadius).toBeCloseTo(expected.enclosure.visibleRadius, 6);
        expect(enclosure.record.surfaceMargin).toBeCloseTo(expected.enclosure.surfaceMargin, 6);
        expect(enclosure.panels).toHaveLength(42);
        expect(compilation.physicsPlan.recipe.bodies.filter((body) => body.kind === "static").map((body) => body.id)).toEqual(enclosure.panels.map((panel) => panel.id));
        const dynamicIds = compilation.physicsPlan.recipe.bodies.filter((body) => body.kind === "dynamic").map((body) => body.id), dynamicSet = new Set(dynamicIds);
        expect(visual.recipe.bindings.map((binding) => binding.bodyId)).toEqual(dynamicIds);
        for (const observation of reopenedDurable.bodyStateObservations) for (const sample of observation.samples) {
          const balls = sample.states.filter((state) => dynamicSet.has(state.bodyId));
          expect(balls.map((state) => state.bodyId)).toEqual(dynamicIds);
          for (const state of balls) expect(surfaceDistance(state.position, enclosure.record.center, radius)).toBeLessThanOrEqual(limit);
        }
        const bodyStates = reopenedDurable.bodyStateObservations[0]!.samples;
        const lateStart = bodyStates.find((sample) => sample.step === 450)!, lateEnd = bodyStates.find((sample) => sample.step === 898)!;
        expect(lateStart.states.map((state, index) => surfaceDistance(state.position, lateEnd.states[index]!.position, 0)).filter((distance) => distance > 0.01)).toHaveLength(dynamicIds.length);
        for (let frameIndex = 0; frameIndex <= visual.schedule.terminalFrameIndex; frameIndex += 1) {
          const bound = evaluatePhysicsVisualBindingFrame(visual, frameIndex), rendered = compilePhysicsVisualPresentationFramePlan(presentation, frameIndex);
          for (const binding of bound.bindings) expect(surfaceDistance(binding.position, enclosure.record.center, radius)).toBeLessThanOrEqual(limit);
          for (const binding of rendered.bindings.slice(0, bound.bindings.length)) expect(surfaceDistance(binding.modelMatrix.slice(12, 15), enclosure.record.center, radius)).toBeLessThanOrEqual(limit);
        }
      }

      const frameIndexes = [0, 1, Math.floor(expected.frameCount / 2), expected.frameCount - 1, expected.frameCount] as const;
      const frames = frameIndexes.map((frameIndex) => compilePhysicsVisualPresentationFramePlan(presentation, frameIndex));
      expect(frames.map((frame) => frame.frameIndex)).toEqual(frameIndexes);
      expect(frames.map((frame) => frame.terminal)).toEqual([false, false, false, false, true]);
      expect(new Set(frames.map((frame) => frame.fingerprint)).size).toBe(frameIndexes.length);
      expect(frames.every((frame) => frame.bindings.length === presentation.instanceSlots.length && frame.evidence.rendererInvoked === false && frame.evidence.pixels === false)).toBe(true);

      const packageWorkspace = join(root, "package-workspace");
      const sourcePackageRoot = join(packageWorkspace, "source");
      const outputPackageRoot = join(packageWorkspace, "output");
      await mkdir(join(sourcePackageRoot, "assets", "empty"), { recursive: true, mode: 0o700 });
      await chmod(packageWorkspace, 0o700);
      await chmod(sourcePackageRoot, 0o700);
      await writePackageSource(sourcePackageRoot, expected.scenarioName, expected.durationUs / 1_000);
      const packageHost = {
        sourcePackageRoot,
        outputPackageRoot,
        packageWorkspaceRoot: packageWorkspace,
        packageWorkspaceAuthority: await createTrustedWorkspaceAnchor(packageWorkspace),
        physicsBakeArtifactRoot: physicsHost.outputRoot,
        physicsWorkspaceRoot: physicsHost.workspaceRoot,
        physicsWorkspaceAuthority: physicsHost.workspaceAuthority,
        requireAbsentOutput: true as const,
      };
      const recipes = { physicsBake: compilation.physicsPlan.recipe, visualBinding: visual.recipe, retainedRender: retained.recipe, presentation: presentation.recipe };
      const prepared = await preparePhysicsVisualPackageMaterialization(packageHost, presentation, recipes);
      const materialized = await materializePhysicsVisualPackage(packageHost, prepared.approval, { schema: "shellx-motion/private-physics-visual-package-materialization-request@1", expected: prepared.expected });

      expect(materialized.receipt.evidence).toEqual({ rendererInvoked: false, pixels: false, providerInvoked: false, videoInvoked: false });
      expect(materialized.receipt.approval.base.plans).toEqual(prepared.expected.plans);
      await rm(sourcePackageRoot, { recursive: true, force: true });
      await rm(physicsWorkspace, { recursive: true, force: true });
      const reopenedOutput = await reopenPhysicsVisualPackageMaterializationOutput({ outputPackageRoot, packageWorkspaceRoot: packageWorkspace, packageWorkspaceAuthority: packageHost.packageWorkspaceAuthority });
      const preview = await reopenPhysicsVisualPackagePreviewInput({ outputPackageRoot, packageWorkspaceRoot: packageWorkspace, packageWorkspaceAuthority: packageHost.packageWorkspaceAuthority });
      const outputOnlySidecar = await withC7B4dOutputAuthority({ outputPackageRoot, packageWorkspaceRoot: packageWorkspace, packageWorkspaceAuthority: packageHost.packageWorkspaceAuthority }, async (outputRoot) => await readPhysicsVisualPackageSidecar(outputRoot));

      expect(reopenedOutput).toMatchObject({
        presentationStaticFingerprint: presentation.fingerprint,
        plans: prepared.expected.plans,
        recipeBundleFingerprint: prepared.expected.recipeBundleFingerprint,
        renderer: { invoked: false, pixels: false, providerInvoked: false, videoInvoked: false },
      });
      expect(reopenedOutput.artifact).toEqual(prepared.expected.externalArtifact);
      expect(preview.presentationStaticPlan.fingerprint).toBe(presentation.fingerprint);
      expect(outputOnlySidecar.recipes).toEqual(recipes);
      expect({
        compilation: compilation.fingerprint,
        physicsPlan: compilation.physicsPlan.fingerprint,
        provider: durable.manifest.source.resultFingerprint,
        durableManifest: durable.manifest.fingerprint,
        durableReceipt: durable.receipt.fingerprint,
        visual: visual.fingerprint,
        retained: retained.fingerprint,
        presentation: presentation.fingerprint,
        outputReceipt: materialized.receipt.fingerprint,
        recipeBundle: reopenedOutput.recipeBundleFingerprint,
      }).toEqual(expected.identities);
    }, expected.scenarioName === "wrecking-wall-large" ? 90_000 : 45_000);
  }
});

async function writePackageSource(root: string, id: string, durationMs: number): Promise<void> {
  await writeJson(join(root, "manifest.json"), { schema: "shellx-motion/package-manifest@1", id: `c7b6b-${id}`, name: `C7B6B ${id}`, motion: "motion.json", assets: [], sourceApp: "private-test", compatibility: { lanes: [], hosts: [] } });
  await writeJson(join(root, "motion.json"), { schema: "shellx-motion/motion@1", id: `c7b6b-${id}-motion`, name: `C7B6B ${id}`, durationMs, fps: 60, width: 640, height: 360, assets: [], provenance: { sourceApp: "private-test", createdBy: "private-test" }, layers: [{ id: "placeholder", type: "shape", shape: "rect", fill: "#07111f", opacity: 1, startMs: 0, durationMs, transform: { x: 0, y: 0, width: 640, height: 360 } }] });
  await writeFile(join(root, "keep.txt"), "keep\n", "utf8");
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${canonicalJson(value)}\n`, "utf8");
}
function surfaceDistance(position: readonly number[], center: readonly number[], radius: number): number { return Math.hypot(position[0]! - center[0]!, position[1]! - center[1]!, position[2]! - center[2]!) + radius; }
