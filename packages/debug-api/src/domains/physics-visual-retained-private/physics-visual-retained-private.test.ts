import { readFile, rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { DEBUG_COMMANDS } from "../../command-registry.js";
import { evaluatePhysicsVisualBindingFrame } from "../physics-visual-binding-private/physics-visual-binding-private.js";
import { compilePhysicsVisualRetainedFramePlan, compilePhysicsVisualRetainedStaticPlan, readPhysicsVisualRetainedFrameUpload, readPhysicsVisualRetainedStaticUpload } from "./physics-visual-retained-private.js";
import { physicsVisualFixture, retainedRecipe } from "./physics-visual-retained.test-support.js";

const roots: string[] = [];
afterEach(async () => await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))));

describe("C7B4B retained physics-visual plans and uploads", () => {
  it("retains shared cinematic sphere/box geometry and stable body slots for Bingo and the 45-brick wall", async () => {
    const fingerprints: string[][] = [];
    for (const kind of ["bingo", "wall"] as const) {
      const fixture = await physicsVisualFixture(kind); roots.push(fixture.root);
      const plan = compilePhysicsVisualRetainedStaticPlan(fixture.visualPlan, retainedRecipe(fixture.visualPlan.fingerprint, kind)), first = compilePhysicsVisualRetainedFramePlan(plan, 0), middle = compilePhysicsVisualRetainedFramePlan(plan, 150), terminal = compilePhysicsVisualRetainedFramePlan(plan, 300), upload = readPhysicsVisualRetainedStaticUpload(plan);
      expect(plan.budget).toMatchObject(kind === "bingo" ? { geometryResourceCount: 1, materialResourceCount: 10, instanceSlotCount: 10, reusedInstanceCount: 9 } : { geometryResourceCount: 2, materialResourceCount: 3, instanceSlotCount: 46, reusedInstanceCount: 44 });
      expect(plan.geometries.map(({ id, vertexCount, indexCount }) => ({ id, vertexCount, indexCount }))).toEqual(kind === "bingo" ? [{ id: "ball", vertexCount: 830, indexCount: 4_968 }] : [{ id: "brick", vertexCount: 24, indexCount: 36 }, { id: "sphere", vertexCount: 830, indexCount: 4_968 }]);
      expect(plan.evidence).toMatchObject({ sharedC7aGeometryCompiler: true, sharedRetainedIndexedMeshKernel: true, stableInstanceUniformSlots: true, perFrameGpuAllocations: 0, rendererInvoked: false, pixels: false });
      expect(upload).toMatchObject({ schema: "shellx-motion/private-gltf-object-retained-render-static-upload@1", staticFingerprint: plan.fingerprint, width: 640, height: 360, instanceSlots: expect.any(Array) });
      expect(upload.instanceSlots.map((entry) => entry.instanceId)).toEqual(fixture.visualPlan.bindings.map((entry) => entry.bodyId));
      if (kind === "wall") {
        const initialBricks = first.bindings.slice(0, 45), movedBricks = middle.bindings.slice(0, 45).filter((binding, index) => translationDistance(binding.modelMatrix, initialBricks[index]!.modelMatrix) > 0.2);
        expect(movedBricks.length).toBeGreaterThanOrEqual(5);
      }
      fingerprints.push([plan.fingerprint, first.fingerprint, middle.fingerprint, terminal.fingerprint]);
    }
    expect(fingerprints).toEqual([
      [
        "e5f3bc118e9080f434e01cd70323044f882bac9084efea124c637a71d1b889aa",
        "19ec64563abbacb3400eeb9f3840b60b464631191573e29b5eda16a2fbcd889a",
        "f327c641f8a49b2239381ed03c7611a6022e14800f0742636795c8be5f435ae2",
        "cc609dd837d8b395898f1bd6c6f60ecf6e82500da148b8c0900491524870bff6",
      ],
      [
        "58014958ac92d634700563680d477534ce4d6eac63639b713ecaf5e084f6725e",
        "1c484eefabfc0c81134f069986891bee9b90c974cacce1a4070f144285343d82",
        "aaeab4fbfd9e781a6190dea481e6eec6cc1f863f100746dfb83963efdd6545f0",
        "5f02e1b1d4a4e758830ee16b83664a434ce3aa92e14149e1264eb1eee7695d5c",
      ],
    ]);
  });

  it("lowers exact C7B4A positions, quaternions, materials and rational time into retained frame uploads", async () => {
    const fixture = await physicsVisualFixture("bingo", 50); roots.push(fixture.root);
    const plan = compilePhysicsVisualRetainedStaticPlan(fixture.visualPlan, retainedRecipe(fixture.visualPlan.fingerprint, "bingo")), source = evaluatePhysicsVisualBindingFrame(fixture.visualPlan, 1), frame = compilePhysicsVisualRetainedFramePlan(plan, 1), upload = readPhysicsVisualRetainedFrameUpload(plan, frame);
    expect(frame.time).toEqual({ startUs: 0, offsetNumeratorUs: 1_000_000, denominator: 50 });
    expect(frame.bindings[0]!.modelMatrix.slice(12, 15)).toEqual(source.bindings[0]!.position);
    expect(frame.bindings[0]).toMatchObject({ instanceId: "ball-00", primitiveRef: "ball", color: expect.any(Array), emissive: 0.08 });
    expect(upload).toMatchObject({ schema: "shellx-motion/private-gltf-object-retained-render-frame-upload@1", staticFingerprint: plan.fingerprint, evaluationFingerprint: fixture.visualPlan.fingerprint, sourceFrameFingerprint: source.fingerprint, atUs: 20_000 });
    expect(upload.fingerprint).toBe(frame.fingerprint);
  });

  it("keeps presentation independent from simulation while binding it into static and frame identity", async () => {
    const fixture = await physicsVisualFixture("bingo"); roots.push(fixture.root);
    const firstRecipe = retainedRecipe(fixture.visualPlan.fingerprint, "bingo"), secondRecipe = structuredClone(firstRecipe); secondRecipe.backgroundColor = "#101827";
    const first = compilePhysicsVisualRetainedStaticPlan(fixture.visualPlan, firstRecipe), second = compilePhysicsVisualRetainedStaticPlan(fixture.visualPlan, secondRecipe), firstFrame = compilePhysicsVisualRetainedFramePlan(first, 60), secondFrame = compilePhysicsVisualRetainedFramePlan(second, 60), source = evaluatePhysicsVisualBindingFrame(fixture.visualPlan, 60);
    expect(first.fingerprint).not.toBe(second.fingerprint); expect(firstFrame.fingerprint).not.toBe(secondFrame.fingerprint);
    expect(firstFrame.bindings).toEqual(secondFrame.bindings); expect(firstFrame.bindings.map((entry) => entry.modelMatrix.slice(12, 15))).toEqual(source.bindings.map((entry) => entry.position));
    expect(first.source.durableManifestFingerprint).toBe(second.source.durableManifestFingerprint);
  });

  it("refuses hostile presentation, wrong identity, forged plans/frames and out-of-range evaluation", async () => {
    const fixture = await physicsVisualFixture("bingo"); roots.push(fixture.root); const valid = retainedRecipe(fixture.visualPlan.fingerprint, "bingo");
    expect(() => compilePhysicsVisualRetainedStaticPlan(fixture.visualPlan, { ...valid, extra: true })).toThrow(/unknown/i);
    expect(() => compilePhysicsVisualRetainedStaticPlan(fixture.visualPlan, { ...valid, visualBindingFingerprint: "0".repeat(64) })).toThrow(/identity/i);
    expect(() => compilePhysicsVisualRetainedStaticPlan(fixture.visualPlan, { ...valid, viewport: { width: 1921, height: 360 } })).toThrow(/1\.\.1920/i);
    expect(() => compilePhysicsVisualRetainedStaticPlan(fixture.visualPlan, { ...valid, camera: { ...valid.camera, target: valid.camera.position } })).toThrow(/non-degenerate/i);
    const plan = compilePhysicsVisualRetainedStaticPlan(fixture.visualPlan, valid), frame = compilePhysicsVisualRetainedFramePlan(plan, 0);
    expect(() => compilePhysicsVisualRetainedFramePlan(structuredClone(plan), 0)).toThrow(/compiler-minted/i);
    expect(() => compilePhysicsVisualRetainedFramePlan(plan, 301)).toThrow(/frame index/i);
    expect(() => readPhysicsVisualRetainedFrameUpload(plan, structuredClone(frame))).toThrow(/compiler-minted/i);
  });

  it("keeps renderer execution, package mutation, video and public commands outside the compiler", async () => {
    const source = await readFile(new URL("./physics-visual-retained-private.ts", import.meta.url), "utf8"), publicIndex = await readFile(new URL("../../index.ts", import.meta.url), "utf8"), packageJson = JSON.parse(await readFile(new URL("../../../package.json", import.meta.url), "utf8")), publicSurfaces = await Promise.all([
      "../../../../actions/src/catalog.ts",
      "../../../../cli/src/main.ts",
      "../../../../connectors/src/index.ts",
      "../../../../renderer-browser/src/index.ts",
      "../../../../renderer-ffmpeg/src/index.ts",
      "../../../../renderer-native/src/index.ts",
      "../../../../sdk/src/index.ts",
    ].map(async (path) => await readFile(new URL(path, import.meta.url), "utf8")));
    expect(source).toMatch(/compileSceneRecipeResources|compileRetainedMeshGeometry|evaluatePhysicsVisualBindingFrame/u);
    expect(source).not.toMatch(/createGpuGltfObjectRetainedRenderSession|PackageEditWorkspace|renderer-ffmpeg|encodeGpuPng|dispatchDebugCommand|motion\.physics/u);
    expect(publicIndex).not.toMatch(/physics-visual-retained/u);
    expect(DEBUG_COMMANDS.filter((command) => command.includes("physics"))).toEqual([]);
    expect(publicSurfaces.join("\n")).not.toMatch(/physics-visual-retained|physicsVisualRetained|motion\.physics/u);
    expect(packageJson.shellxMotion.hostInternalExports).toContain("./internal/physics-visual-retained-render");
  });
});

function translationDistance(left: readonly number[], right: readonly number[]): number { return Math.hypot(left[12]! - right[12]!, left[13]! - right[13]!, left[14]! - right[14]!); }
