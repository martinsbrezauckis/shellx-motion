import { createHash } from "node:crypto";
import { canonicalJson, parseGltfContainer } from "@shellx-motion/core";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  compileGltfObjectPlan,
  compileGltfObjectRetainedRenderFramePlan,
  compileGltfObjectRetainedRenderStaticPlan,
  compileGltfObjectSceneEvaluationPlan,
  compileGltfObjectScenePlan,
  compileGltfObjectStoryPlan,
  evaluateGltfObjectSceneAtUs,
  GLTF_OBJECT_DECLARATION_SCHEMA,
  GLTF_OBJECT_RETAINED_RENDER_SCHEMA,
  GLTF_OBJECT_SCENE_EVALUATION_SCHEMA,
  GLTF_OBJECT_SCENE_SCHEMA,
  GLTF_OBJECT_STORY_SCHEMA,
  readGltfObjectRetainedRenderFrameUpload,
  readGltfObjectRetainedRenderStaticUpload,
} from "@shellx-motion/core/internal/scene-recipe";
import { describe, expect, it } from "vitest";
import { createGpuGltfObjectRetainedRenderSession } from "./gpu-gltf-object-retained-session";
import { encodeGpuPng } from "./gpu-png";

const OPERATION_TIMEOUT_MS = 30_000;
const FIXTURE_TIMEOUT_MS = 240_000;
const SCHEDULE = [0, 375_000, 1_000_000] as const;
const outputRoot = process.env.MOTION_GPU_C7A3E_OUTPUT_ROOT?.trim();
const runner = { enabled: process.env.MOTION_GPU_HARDWARE_FIXTURE === "1", platform: process.platform, arch: process.arch, node: Number(process.versions.node.split(".")[0]) };
const describeQualifiedLinuxGpu = runner.enabled && runner.platform === "linux" && runner.arch === "x64" && runner.node === 24 ? describe : describe.skip;

describeQualifiedLinuxGpu("qualified Linux GPU host C7A3e retained imported-object WebGPU pixels", () => {
  it("reuses shared geometry across exact/intermediate frames, shows the discrete material change, and terminally releases", async () => {
    expect(runner).toEqual({ enabled: true, platform: "linux", arch: "x64", node: 24 });
    const fixture = compiledFixture(), staticUpload = readGltfObjectRetainedRenderStaticUpload(fixture.staticPlan);
    expect(staticUpload).toMatchObject({ budget: { geometryResourceCount: 2, instanceSlotCount: 5, reusedInstanceCount: 3 }, geometries: expect.any(Array) });
    const opened = await createGpuGltfObjectRetainedRenderSession(staticUpload);
    expect(opened.ok, opened.ok ? undefined : opened.failure.message).toBe(true);
    if (!opened.ok) return;
    const frames: Array<{ atUs: number; planFingerprint: string; rgba: Uint8Array; hash: string; red: number; blue: number; visiblePixels: number; adapterFingerprint: string }> = [];
    let release: Awaited<ReturnType<typeof opened.session.close>> | null = null;
    try {
      for (const atUs of SCHEDULE) {
        const scene = evaluateGltfObjectSceneAtUs(fixture.evaluationPlan, atUs);
        expect(scene.ok, scene.ok ? undefined : scene.message).toBe(true);
        if (!scene.ok) return;
        const framePlan = compileGltfObjectRetainedRenderFramePlan(fixture.staticPlan, scene.frame);
        const result = await opened.session.render(readGltfObjectRetainedRenderFrameUpload(fixture.staticPlan, framePlan), { timeoutMs: OPERATION_TIMEOUT_MS });
        expect(result.ok, result.ok ? undefined : result.failure.message).toBe(true);
        if (!result.ok) return;
        expect(result.metrics).toMatchObject({ geometryResourceCount: 2, instanceSlotCount: 5, sharedGeometryReuseCount: 3, preparationOperations: 1, renderedFrames: frames.length + 1, perFrameGpuAllocations: 0 });
        expect(result.frame).toMatchObject({ width: 640, height: 360, evidence: { backend: "webgpu-browser", adapterFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) } });
        const visible = nonBackground(result.frame.rgba, [7, 17, 31]);
        expect(visible.count).toBeGreaterThan(100);
        frames.push({ atUs, planFingerprint: framePlan.fingerprint, rgba: result.frame.rgba, hash: createHash("sha256").update(result.frame.rgba).digest("hex"), red: visible.red, blue: visible.blue, visiblePixels: visible.count, adapterFingerprint: result.frame.evidence.adapterFingerprint });
      }
      expect(new Set(frames.map((frame) => frame.hash)).size).toBe(SCHEDULE.length);
      expect(frames[0]!.red).toBeGreaterThan(frames[0]!.blue);
      expect(frames[1]!.blue).toBeGreaterThan(frames[1]!.red);
      expect(frames[2]!.red).toBeGreaterThan(frames[2]!.blue);
    } finally { release = await opened.session.close(); }
    expect(release).toEqual({ schema: "shellx-motion/gltf-object-retained-page-release@1", hadResources: true, destroyedVertexBuffers: 2, destroyedIndexBuffers: 2, destroyedUniformBuffers: 5, destroyedRenderTargets: 2, destroyedReadbackBuffers: 1, releasedGpuBytes: fixture.staticPlan.budget.retainedGpuBytes, remainingGpuBytes: 0 });
    if (outputRoot) {
      await mkdir(outputRoot, { recursive: true, mode: 0o700 });
      for (const frame of frames) await writeFile(join(outputRoot, `gltf-object-retained-${frame.atUs}.png`), encodeGpuPng({ rgba: frame.rgba, width: 640, height: 360 }), { flag: "wx", mode: 0o600 });
      const receipt = {
        schema: "shellx-motion/gltf-object-retained-hardware-proof@1",
        runner,
        staticFingerprint: fixture.staticPlan.fingerprint,
        budget: fixture.staticPlan.budget,
        frames: frames.map(({ rgba: _rgba, ...frame }) => frame),
        release,
      };
      await writeFile(join(outputRoot, "receipt.json"), `${canonicalJson(receipt)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    }
  }, FIXTURE_TIMEOUT_MS);
});

function compiledFixture() {
  const objectPlan = carObjectPlan(), storyPlan = compileGltfObjectStoryPlan(objectPlan, carStory(objectPlan.fingerprint, 3));
  const scenePlan = compileGltfObjectScenePlan(objectPlan, storyPlan, { schema: GLTF_OBJECT_SCENE_SCHEMA, id: "car-pixels", objectFingerprint: objectPlan.fingerprint, storyFingerprint: storyPlan.fingerprint, camera: { viewDirection: [1, 0.65, 1], fovDeg: 42, padding: 1.2 } });
  const evaluationPlan = compileGltfObjectSceneEvaluationPlan(objectPlan, storyPlan, scenePlan, {
    schema: GLTF_OBJECT_SCENE_EVALUATION_SCHEMA, sceneFingerprint: scenePlan.fingerprint,
    segments: storyPlan.checkpoints.slice(0, -1).map((from, index) => { const to = storyPlan.checkpoints[index + 1]!; return { id: `segment-${index}`, fromCheckpointId: from.id, toCheckpointId: to.id, controls: storyPlan.controls.map((control) => control.kind === "material" ? { controlId: control.id, kind: "material", switchAtUs: from.atUs + 375_000 } : { controlId: control.id, kind: "transform", interpolation: "ease-in-out" }) }; }),
  });
  const staticPlan = compileGltfObjectRetainedRenderStaticPlan(evaluationPlan, { schema: GLTF_OBJECT_RETAINED_RENDER_SCHEMA, evaluationFingerprint: evaluationPlan.fingerprint, viewport: { width: 640, height: 360 }, backgroundColor: "#07111f", lighting: { direction: [-0.4, -0.8, -0.4], color: "#ffffff", ambient: 0.3, intensity: 1.4 }, sourceMaterials: [{ materialIndex: 0, baseColor: "#d97706", emissive: 0 }, { materialIndex: 1, baseColor: "#202126", emissive: 0.02 }] });
  return { evaluationPlan, staticPlan };
}

function nonBackground(rgba: Uint8Array, background: readonly [number, number, number]) {
  let count = 0, red = 0, blue = 0;
  for (let index = 0; index < rgba.length; index += 4) if (rgba[index] !== background[0] || rgba[index + 1] !== background[1] || rgba[index + 2] !== background[2]) { count += 1; red += rgba[index]!; blue += rgba[index + 2]!; }
  return { count, red, blue };
}

function carObjectPlan() {
  const container = parseGltfContainer(Buffer.from(canonicalJson(carGltf()), "utf8"), "gltf");
  return compileGltfObjectPlan(container, {
    schema: GLTF_OBJECT_DECLARATION_SCHEMA,
    assetId: "car",
    sourceSha256: container.sourceSha256,
    roles: [
      { roleId: "body", nodeIndex: 1, expectedNodeName: "Body" },
      { roleId: "car-root", nodeIndex: 0, expectedNodeName: "Car" },
      { roleId: "wheel-back-left", nodeIndex: 4, expectedNodeName: "Wheel-BL" },
      { roleId: "wheel-back-right", nodeIndex: 5, expectedNodeName: "Wheel-BR" },
      { roleId: "wheel-front-left", nodeIndex: 2, expectedNodeName: "Wheel-FL" },
      { roleId: "wheel-front-right", nodeIndex: 3, expectedNodeName: "Wheel-FR" },
    ],
  });
}

function carStory(objectFingerprint: string, checkpointCount: number) {
  const controls = [
    { id: "body-paint", kind: "material", roleId: "body", primitiveRef: "car.mesh.00.primitive.00" },
    { id: "car-motion", kind: "transform", roleId: "car-root" },
    { id: "wheel-bl-spin", kind: "transform", roleId: "wheel-back-left" },
    { id: "wheel-br-spin", kind: "transform", roleId: "wheel-back-right" },
    { id: "wheel-fl-spin", kind: "transform", roleId: "wheel-front-left" },
    { id: "wheel-fr-spin", kind: "transform", roleId: "wheel-front-right" },
  ] as const;
  const checkpoints = Array.from({ length: checkpointCount }, (_value, index) => {
    const progress = index / (checkpointCount - 1), spin = index * 180;
    const transform = (controlId: string, rotationDeg: [number, number, number]) => ({ controlId, value: { translation: [0, 0, 0] as [number, number, number], rotationDeg, scale: 1 } });
    return {
      id: `cp-${String(index).padStart(2, "0")}`,
      atUs: index * 500_000,
      states: [
        { controlId: "body-paint", value: { materialRef: index % 2 === 0 ? "amber" : "blue" } },
        { controlId: "car-motion", value: { translation: [progress * 10, 0, -progress * 3] as [number, number, number], rotationDeg: [0, progress * 90, 0] as [number, number, number], scale: 1 } },
        transform("wheel-bl-spin", [spin, 0, 0]),
        transform("wheel-br-spin", [spin, 0, 0]),
        transform("wheel-fl-spin", [spin, 0, 0]),
        transform("wheel-fr-spin", [spin, 0, 0]),
      ],
    };
  });
  return {
    schema: GLTF_OBJECT_STORY_SCHEMA,
    objectFingerprint,
    startUs: 0,
    endUs: (checkpointCount - 1) * 500_000,
    materials: [{ id: "amber", kind: "basic" as const, baseColor: "#f59e0b", emissive: 0 }, { id: "blue", kind: "basic" as const, baseColor: "#38bdf8", emissive: 0.05 }],
    controls,
    checkpoints,
  };
}

function carGltf(): Record<string, unknown> {
  const bytes = Buffer.alloc(42);
  [-0.5, -0.5, 0, 0.5, -0.5, 0, 0, 0.5, 0].forEach((value, index) => bytes.writeFloatLE(value, index * 4));
  [0, 1, 2].forEach((value, index) => bytes.writeUInt16LE(value, 36 + index * 2));
  return {
    asset: { version: "2.0" }, buffers: [{ byteLength: bytes.byteLength, uri: `data:application/octet-stream;base64,${bytes.toString("base64")}` }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 6 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3" }, { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" }],
    materials: [{ name: "Body" }, { name: "Wheel" }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }, { primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 1 }] }],
    nodes: [{ name: "Car", children: [1, 2, 3, 4, 5] }, { name: "Body", mesh: 0 }, { name: "Wheel-FL", mesh: 1 }, { name: "Wheel-FR", mesh: 1 }, { name: "Wheel-BL", mesh: 1 }, { name: "Wheel-BR", mesh: 1 }],
    scenes: [{ nodes: [0] }], scene: 0,
  };
}
