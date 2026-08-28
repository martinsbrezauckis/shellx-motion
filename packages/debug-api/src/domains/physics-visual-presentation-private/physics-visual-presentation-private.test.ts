import { readFile, rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { DEBUG_COMMANDS } from "../../command-registry.js";
import { compilePhysicsVisualRetainedFramePlan, compilePhysicsVisualRetainedStaticPlan } from "../physics-visual-retained-private/physics-visual-retained-private.js";
import { physicsVisualFixture, retainedRecipe } from "../physics-visual-retained-private/physics-visual-retained.test-support.js";
import {
  compilePhysicsVisualPresentationFramePlan,
  compilePhysicsVisualPresentationStaticPlan,
  readPhysicsVisualPresentationFrameUpload,
  readPhysicsVisualPresentationStaticUpload,
} from "./physics-visual-presentation-private.js";
import { PHYSICS_VISUAL_PRESENTATION_SCHEMA } from "./physics-visual-presentation-types-private.js";

const roots: string[] = [];
afterEach(async () => await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))));

describe("C7B4C static collision and presentation visuals", () => {
  it("adds one final translucent Bingo cage while retaining exact C7B4B dynamic frames", async () => {
    const fixture = await physicsVisualFixture("bingo"); roots.push(fixture.root);
    const retained = compilePhysicsVisualRetainedStaticPlan(fixture.visualPlan, retainedRecipe(fixture.visualPlan.fingerprint, "bingo")), recipe = bingoPresentation(retained.fingerprint, fixture.physicsPlan.fingerprint);
    const plan = compilePhysicsVisualPresentationStaticPlan(retained, fixture.physicsPlan, recipe), frame = compilePhysicsVisualPresentationFramePlan(plan, 150), sourceFrame = compilePhysicsVisualRetainedFramePlan(retained, 150), staticUpload = readPhysicsVisualPresentationStaticUpload(plan), frameUpload = readPhysicsVisualPresentationFrameUpload(plan, frame);
    expect(plan.budget).toMatchObject({ geometryResourceCount: 2, materialResourceCount: 11, instanceSlotCount: 11, staticCollisionBindingCount: 0, constraintBindingCount: 0, presentationBindingCount: 1, transparentPresentationCount: 1, reusedInstanceCount: 9 });
    expect(plan.instanceSlots.slice(0, 10).map(({ instanceId, primitiveRef }) => ({ instanceId, primitiveRef }))).toEqual(retained.instanceSlots.map(({ instanceId, primitiveRef }) => ({ instanceId, primitiveRef })));
    expect(plan.instanceSlots.at(-1)).toMatchObject({ instanceId: "c7b4c-fixed-cage", primitiveRef: "z-cage-sphere", kind: "presentation", renderMode: "alpha" });
    expect(frame.bindings.slice(0, 10)).toEqual(sourceFrame.bindings);
    expect(frame.bindings.at(-1)).toMatchObject({ instanceId: "c7b4c-fixed-cage", primitiveRef: "z-cage-sphere", color: [expect.any(Number), expect.any(Number), expect.any(Number), Math.fround(0.18)] });
    expect(staticUpload).toMatchObject({ width: 640, height: 360, instanceSlots: expect.arrayContaining([{ instanceId: "c7b4c-fixed-cage", primitiveRef: "z-cage-sphere", renderMode: "alpha" }]) });
    expect(frameUpload).toMatchObject({ staticFingerprint: plan.fingerprint, sourceFrameFingerprint: frame.sourcePhysicsFrameFingerprint, viewport: { width: 640, height: 360 } });
    expect(plan.evidence).toMatchObject({ exactC7b4bDynamicFrames: true, exactRevalidatedC7b1Physics: true, constraintDisplaysArePresentationOnly: true, fixedPresentationsAffectNoPhysics: true, rendererInvoked: false, pixels: false, packageWritten: false, video: false });
  });

  it("derives the wall ground and tether from admitted body and constraint data at every frame", async () => {
    const fixture = await physicsVisualFixture("wall"); roots.push(fixture.root);
    const retained = compilePhysicsVisualRetainedStaticPlan(fixture.visualPlan, retainedRecipe(fixture.visualPlan.fingerprint, "wall")), recipe = wallPresentation(retained.fingerprint, fixture.physicsPlan.fingerprint), plan = compilePhysicsVisualPresentationStaticPlan(retained, fixture.physicsPlan, recipe);
    const first = compilePhysicsVisualPresentationFramePlan(plan, 0), middle = compilePhysicsVisualPresentationFramePlan(plan, 150), terminal = compilePhysicsVisualPresentationFramePlan(plan, 300);
    expect(plan.budget).toMatchObject({ geometryResourceCount: 4, materialResourceCount: 5, instanceSlotCount: 48, staticCollisionBindingCount: 1, constraintBindingCount: 1, presentationBindingCount: 0, transparentPresentationCount: 0, reusedInstanceCount: 44 });
    expect(plan.instanceSlots.slice(-2)).toEqual([
      expect.objectContaining({ instanceId: "c7b4c-static-ground", kind: "static-collision", sourceId: "ground" }),
      expect.objectContaining({ instanceId: "c7b4c-constraint-tether", kind: "constraint-display", sourceId: "tether" }),
    ]);
    for (const frame of [first, middle, terminal]) {
      const segment = frame.constraintSegments[0]!, sphere = frame.bindings.find((entry) => entry.instanceId === "sphere")!, ground = frame.bindings.at(-2)!, tether = frame.bindings.at(-1)!;
      expect(segment.constraintId).toBe("tether"); expect(segment.start).toEqual(sphere.modelMatrix.slice(12, 15)); expect(segment.end).toEqual([4.5, 5.5, 0]);
      expect(ground.modelMatrix.slice(12, 15)).toEqual([0, 0, 0]);
      expect(tether.modelMatrix.slice(12, 15)).toEqual(segment.start.map((value, index) => Math.fround((value + segment.end[index]!) / 2)));
      expect(columnLength(tether.modelMatrix, 1)).toBeCloseTo(segment.length, 5);
    }
    expect(first.constraintSegments[0]!.start).not.toEqual(middle.constraintSegments[0]!.start);
  });

  it("binds resource, selection and presentation changes only into C7B4C identity", async () => {
    const fixture = await physicsVisualFixture("bingo"); roots.push(fixture.root);
    const retained = compilePhysicsVisualRetainedStaticPlan(fixture.visualPlan, retainedRecipe(fixture.visualPlan.fingerprint, "bingo")), firstRecipe = bingoPresentation(retained.fingerprint, fixture.physicsPlan.fingerprint), secondRecipe = structuredClone(firstRecipe); secondRecipe.presentationBindings[0]!.opacity = 0.28;
    const first = compilePhysicsVisualPresentationStaticPlan(retained, fixture.physicsPlan, firstRecipe), replay = compilePhysicsVisualPresentationStaticPlan(retained, structuredClone(fixture.physicsPlan), firstRecipe), second = compilePhysicsVisualPresentationStaticPlan(retained, fixture.physicsPlan, secondRecipe);
    expect(first.fingerprint).toBe(replay.fingerprint); expect(first.fingerprint).not.toBe(second.fingerprint);
    expect(first.source).toEqual(second.source); expect(retained.fingerprint).toBe(first.source.retainedStaticFingerprint); expect(fixture.physicsPlan.fingerprint).toBe(first.source.physicsPlanFingerprint);
    expect(compilePhysicsVisualRetainedFramePlan(retained, 60).fingerprint).toBe(compilePhysicsVisualRetainedFramePlan(retained, 60).fingerprint);
  });

  it("pins the cross-host Bingo and wall presentation plan and frame identities", async () => {
    const bingo = await physicsVisualFixture("bingo"), wall = await physicsVisualFixture("wall"); roots.push(bingo.root, wall.root);
    const bingoRetained = compilePhysicsVisualRetainedStaticPlan(bingo.visualPlan, retainedRecipe(bingo.visualPlan.fingerprint, "bingo"));
    const wallRetained = compilePhysicsVisualRetainedStaticPlan(wall.visualPlan, retainedRecipe(wall.visualPlan.fingerprint, "wall"));
    const bingoPlan = compilePhysicsVisualPresentationStaticPlan(bingoRetained, bingo.physicsPlan, bingoPresentation(bingoRetained.fingerprint, bingo.physicsPlan.fingerprint));
    const wallPlan = compilePhysicsVisualPresentationStaticPlan(wallRetained, wall.physicsPlan, wallPresentation(wallRetained.fingerprint, wall.physicsPlan.fingerprint));
    expect(bingoPlan.fingerprint).toBe("20fffa3af04fd9c31341e734a48c8e670a2dca716c5bf6284051c3b300525d96");
    expect([0, 60, 150, 300].map((frameIndex) => compilePhysicsVisualPresentationFramePlan(bingoPlan, frameIndex).fingerprint)).toEqual([
      "fdc818254d03b30f8d58f9b869b1a85305201e15af4414e44ff2823efca87403",
      "4a8682d5a663861ee09f4df7634f94a09cb6ebda9d48a5cc39a2ae174e1c0cfc",
      "c872d65b5a620365542969d25054cd5a58379bf803014aed53856a28186dfef8",
      "03b7ab2dfeeda4f10a17b33b9ba0e10dcad352d0b5c8abcd58679d64d6792350",
    ]);
    expect(wallPlan.fingerprint).toBe("84de05667680d74a4116d8ac52692ef45ecfd6b93e56046f6bc2ba2ae620ef64");
    expect([0, 60, 150, 300].map((frameIndex) => compilePhysicsVisualPresentationFramePlan(wallPlan, frameIndex).fingerprint)).toEqual([
      "ebf49413e58ec1a18eb01d07ff3704ea9952d0f90141a59419e429c71eb33c95",
      "f8cc62d59c5f8dceaeddf66163b006a7fa54ec53053926a68593ac151fdbf7d8",
      "3f9c47d5f0ccd5c8a61c01d66d5c9269a78423165bc1af51a852d54d6ece9390",
      "4896ea38659a8bf81c99214bade4283b74728644a53f8742cf879cdd7aff3972",
    ]);
  });

  it("refuses hostile identities, orders, references, transforms and forged output plans", async () => {
    const fixture = await physicsVisualFixture("wall"); roots.push(fixture.root);
    const retained = compilePhysicsVisualRetainedStaticPlan(fixture.visualPlan, retainedRecipe(fixture.visualPlan.fingerprint, "wall")), valid = wallPresentation(retained.fingerprint, fixture.physicsPlan.fingerprint);
    expect(() => compilePhysicsVisualPresentationStaticPlan(structuredClone(retained), fixture.physicsPlan, valid)).toThrow(/compiler-minted/i);
    expect(() => compilePhysicsVisualPresentationStaticPlan(retained, fixture.physicsPlan, { ...valid, extra: true })).toThrow(/unknown/i);
    const accessor = structuredClone(valid); Object.defineProperty(accessor, "presentationBindings", { enumerable: true, get: () => [] });
    expect(() => compilePhysicsVisualPresentationStaticPlan(retained, fixture.physicsPlan, accessor)).toThrow(/data field|reflection/i);
    expect(() => compilePhysicsVisualPresentationStaticPlan(retained, fixture.physicsPlan, { ...valid, retainedStaticFingerprint: "0".repeat(64) })).toThrow(/source identity/i);
    const wrongPhysics = { ...fixture.physicsPlan, recipe: { ...fixture.physicsPlan.recipe, seed: fixture.physicsPlan.recipe.seed + 1 } };
    expect(() => compilePhysicsVisualPresentationStaticPlan(retained, wrongPhysics, valid)).toThrow(/exact compiler-minted|identity/i);
    const duplicateResource = structuredClone(valid); duplicateResource.additionalResources.geometry[0]!.id = "brick";
    expect(() => compilePhysicsVisualPresentationStaticPlan(retained, fixture.physicsPlan, duplicateResource)).toThrow(/strict code-unit ascending and unique/i);
    const dynamicStatic = structuredClone(valid); dynamicStatic.staticCollisionBindings[0]!.bodyId = "sphere";
    expect(() => compilePhysicsVisualPresentationStaticPlan(retained, fixture.physicsPlan, dynamicStatic)).toThrow(/static body/i);
    const missingRef = structuredClone(valid); missingRef.constraintBindings[0]!.geometryRef = "missing";
    expect(() => compilePhysicsVisualPresentationStaticPlan(retained, fixture.physicsPlan, missingRef)).toThrow(/combined C7B4C resource/i);
    const badSegment = structuredClone(valid); badSegment.additionalResources.geometry[1]!.size[1] = 0.9;
    expect(() => compilePhysicsVisualPresentationStaticPlan(retained, fixture.physicsPlan, badSegment)).toThrow(/unit Y/i);
    const nonUniform = bingoPresentation(retained.fingerprint, fixture.physicsPlan.fingerprint); nonUniform.presentationBindings[0]!.scale = [1, 2, 1];
    expect(() => compilePhysicsVisualPresentationStaticPlan(retained, fixture.physicsPlan, nonUniform)).toThrow(/uniform/i);
    const badOpacity = bingoPresentation(retained.fingerprint, fixture.physicsPlan.fingerprint); badOpacity.presentationBindings[0]!.opacity = 0.99;
    expect(() => compilePhysicsVisualPresentationStaticPlan(retained, fixture.physicsPlan, badOpacity)).toThrow(/0\.05\.\.0\.95/i);
    const badQuaternion = bingoPresentation(retained.fingerprint, fixture.physicsPlan.fingerprint); badQuaternion.presentationBindings[0]!.rotation = [0, 0, 0, 0];
    expect(() => compilePhysicsVisualPresentationStaticPlan(retained, fixture.physicsPlan, badQuaternion)).toThrow(/unit quaternion/i);
    const presentation = bingoPresentation(retained.fingerprint, fixture.physicsPlan.fingerprint); presentation.additionalResources.geometry.push({ id: "zz-opaque-box", kind: "box", size: [1, 1, 1] }); presentation.additionalResources.materials.push({ id: "zz-opaque", kind: "basic", baseColor: "#ffffff", emissive: 0 }); presentation.presentationBindings.unshift({ id: "alpha-first", geometryRef: "zz-opaque-box", materialRef: "zz-opaque", opacity: 0.2, position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
    expect(() => compilePhysicsVisualPresentationStaticPlan(retained, fixture.physicsPlan, presentation)).toThrow(/final translucent/i);
    const plan = compilePhysicsVisualPresentationStaticPlan(retained, fixture.physicsPlan, valid), frame = compilePhysicsVisualPresentationFramePlan(plan, 0);
    expect(() => compilePhysicsVisualPresentationFramePlan(structuredClone(plan), 0)).toThrow(/compiler-minted/i);
    expect(() => readPhysicsVisualPresentationFrameUpload(plan, structuredClone(frame))).toThrow(/compiler-minted/i);
  });

  it("refuses generated slot ids that collide with inherited dynamic-body slots before renderer work", async () => {
    const fixture = await physicsVisualFixture("bingo", 60, { firstDynamicId: "c7b4c-fixed-cage" }); roots.push(fixture.root);
    const retained = compilePhysicsVisualRetainedStaticPlan(fixture.visualPlan, retainedRecipe(fixture.visualPlan.fingerprint, "bingo")), recipe = bingoPresentation(retained.fingerprint, fixture.physicsPlan.fingerprint);
    expect(() => compilePhysicsVisualPresentationStaticPlan(retained, fixture.physicsPlan, recipe)).toThrow(/instance-slot identities collide/i);
  });

  it("keeps C7B4C on the existing private host export with no public command or package/video route", async () => {
    const source = await readFile(new URL("./physics-visual-presentation-private.ts", import.meta.url), "utf8"), publicIndex = await readFile(new URL("../../index.ts", import.meta.url), "utf8"), hostInternal = await readFile(new URL("../../internal/physics-visual-retained-render.ts", import.meta.url), "utf8"), publicSurfaces = await Promise.all([
      "../../../../actions/src/catalog.ts", "../../../../cli/src/main.ts", "../../../../connectors/src/index.ts", "../../../../renderer-browser/src/index.ts", "../../../../renderer-ffmpeg/src/index.ts", "../../../../renderer-native/src/index.ts", "../../../../sdk/src/index.ts",
    ].map(async (path) => await readFile(new URL(path, import.meta.url), "utf8")));
    expect(source).toMatch(/compilePhysicsVisualRetainedFramePlan|readPhysicsBakeAdmissionPlan|compileSceneRecipeResources/u);
    expect(source).not.toMatch(/PackageEditWorkspace|bakePhysicsWithPinnedRapier|createGpuGltfObjectRetainedRenderSession|dispatchDebugCommand|encodeGpuPng|renderer-ffmpeg/u);
    expect(hostInternal).toMatch(/compilePhysicsVisualPresentationStaticPlan/u); expect(publicIndex).not.toMatch(/physics-visual-presentation/u);
    expect(DEBUG_COMMANDS.filter((command) => command.includes("physics"))).toEqual([]); expect(publicSurfaces.join("\n")).not.toMatch(/physics-visual-presentation|physicsVisualPresentation|motion\.physics/u);
  });
});

function bingoPresentation(retainedStaticFingerprint: string, physicsPlanFingerprint: string): any {
  return { schema: PHYSICS_VISUAL_PRESENTATION_SCHEMA, retainedStaticFingerprint, physicsPlanFingerprint, additionalResources: { geometry: [{ id: "z-cage-sphere", kind: "sphere", radius: 2.7, quality: "cinematic" }], materials: [{ id: "z-cage-ice", kind: "basic", baseColor: "#8fdcff", emissive: 0.08 }] }, staticCollisionBindings: [], constraintBindings: [], presentationBindings: [{ id: "cage", geometryRef: "z-cage-sphere", materialRef: "z-cage-ice", opacity: 0.18, position: [0, 2, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }] };
}

function wallPresentation(retainedStaticFingerprint: string, physicsPlanFingerprint: string): any {
  return { schema: PHYSICS_VISUAL_PRESENTATION_SCHEMA, retainedStaticFingerprint, physicsPlanFingerprint, additionalResources: { geometry: [{ id: "z-ground-visual", kind: "box", size: [20, 0.2, 8] }, { id: "z-tether-visual", kind: "box", size: [0.08, 1, 0.08] }], materials: [{ id: "z-ground-matte", kind: "basic", baseColor: "#26364a", emissive: 0 }, { id: "z-tether-steel", kind: "basic", baseColor: "#d9e2ec", emissive: 0.04 }] }, staticCollisionBindings: [{ bodyId: "ground", geometryRef: "z-ground-visual", materialRef: "z-ground-matte" }], constraintBindings: [{ constraintId: "tether", geometryRef: "z-tether-visual", materialRef: "z-tether-steel" }], presentationBindings: [] };
}

function columnLength(matrix: readonly number[], column: number): number { const offset = column * 4; return Math.hypot(matrix[offset]!, matrix[offset + 1]!, matrix[offset + 2]!); }
