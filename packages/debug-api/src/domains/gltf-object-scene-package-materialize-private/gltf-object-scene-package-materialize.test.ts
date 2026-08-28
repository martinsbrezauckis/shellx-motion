import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { canonicalJson, hashBuffer, parseGltfContainer } from "@shellx-motion/core";
import {
  compileGltfObjectPlan,
  compileGltfObjectRetainedRenderStaticPlan,
  compileGltfObjectSceneEvaluationPlan,
  compileGltfObjectScenePlan,
  compileGltfObjectStoryPlan,
  GLTF_OBJECT_DECLARATION_SCHEMA,
  GLTF_OBJECT_RETAINED_RENDER_SCHEMA,
  GLTF_OBJECT_SCENE_EVALUATION_SCHEMA,
  GLTF_OBJECT_SCENE_SCHEMA,
  GLTF_OBJECT_STORY_SCHEMA,
} from "@shellx-motion/core/internal/scene-recipe";
import { createTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { snapshotPackageEditTree } from "../package-edit-tree-snapshot.js";
import { renderGltfObjectScenePackagePreviewAtUs } from "../../internal/gltf-object-scene-package-preview.js";
import { C7A3F_RECEIPT_PATH, C7A3F_SIDECAR_PATH } from "./gltf-object-scene-package-facts-private.js";
import {
  materializeGltfObjectScenePackage,
  prepareGltfObjectScenePackageMaterialization,
  reopenGltfObjectScenePackageMaterializationOutput,
  reopenGltfObjectScenePackagePreviewInput,
} from "./gltf-object-scene-package-materialize-private.js";

const TEST_PARENT = join(process.cwd(), `.c7a3f-gltf-object-package-test-${process.pid}`);
const hardwareRunner = { enabled: process.env.MOTION_GPU_C7A3F_PACKAGE_PREVIEW === "1", platform: process.platform, arch: process.arch, node: Number(process.versions.node.split(".")[0]) };
const describeQualifiedLinuxGpu = hardwareRunner.enabled && hardwareRunner.platform === "linux" && hardwareRunner.arch === "x64" && hardwareRunner.node === 24 ? describe : describe.skip;
const fault = vi.hoisted(() => ({ output: "", renamed: false, postInstall: false, outputManifestOpens: 0, afterCommitFaulted: false, precommitSource: "", beforeCommitClaimed: false, beforeCommitFaulted: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>(), path = await import("node:path");
  return { ...actual,
    rename: (async (...args: unknown[]) => { const from = typeof args[0] === "string" ? path.resolve(args[0]) : "", to = typeof args[1] === "string" ? path.resolve(args[1]) : ""; const result = await (actual.rename as (...inner: unknown[]) => Promise<void>)(...args); if (fault.precommitSource && from === fault.output) fault.beforeCommitClaimed = true; if (fault.postInstall && path.basename(from) === "package" && to === fault.output) { fault.renamed = true; fault.outputManifestOpens = 0; } return result; }) as typeof actual.rename,
    open: (async (...args: unknown[]) => { const file = typeof args[0] === "string" ? path.resolve(args[0]) : ""; if (fault.precommitSource && fault.beforeCommitClaimed && file === path.join(path.dirname(fault.precommitSource), "manifest.json")) { const motion = JSON.parse(await actual.readFile(fault.precommitSource, "utf8")); motion.name = "source drifted at C7A3f beforeCommit"; await actual.writeFile(fault.precommitSource, `${JSON.stringify(motion, null, 2)}\n`, "utf8"); fault.precommitSource = ""; fault.beforeCommitFaulted = true; } if (fault.postInstall && fault.renamed && file === path.join(fault.output, "manifest.json") && ++fault.outputManifestOpens >= 2) { fault.postInstall = false; fault.renamed = false; fault.afterCommitFaulted = true; throw Object.assign(new Error("test-only C7A3f afterCommit reopen failure"), { code: "EIO" }); } return await (actual.open as (...inner: unknown[]) => Promise<any>)(...args); }) as typeof actual.open,
  };
});

async function fixture(options: { readonly receipts?: boolean } = {}) {
  await mkdir(TEST_PARENT, { recursive: true });
  const root = await mkdtemp(join(TEST_PARENT, "run-")), workspace = join(root, "workspace"), source = join(workspace, "source"), output = join(workspace, "output"), sourceRef = "source/input.gltf";
  await mkdir(join(source, "source"), { recursive: true }); await chmod(workspace, 0o700); await chmod(source, 0o700); await chmod(join(source, "source"), 0o700); await mkdir(join(source, "assets", "empty"), { recursive: true }); if (options.receipts) { await mkdir(join(source, "receipts"), { recursive: true }); await chmod(join(source, "receipts"), 0o700); }
  const gltfBytes = Buffer.from(`${canonicalJson(carGltf())}\n`, "utf8"), sourceSha256 = hashBuffer(gltfBytes);
  await writeFile(join(source, sourceRef), gltfBytes, { mode: 0o600 });
  await json(join(source, "manifest.json"), { schema: "shellx-motion/package-manifest@1", id: "package-car", name: "C7A3f car", motion: "motion.json", assets: [], sourceApp: "gltf", compatibility: { lanes: ["gpu"], hosts: ["shellx-motion"] }, data: { adapter: { id: "adapter.gltf", source: sourceRef, sourceSha256, container: { schema: "shellx-motion/gltf-source@1", format: "gltf", resourcePolicy: { network: "denied", externalBuffers: "denied", geometry: "bounded-static-triangles" } } } } });
  await json(join(source, "motion.json"), { schema: "shellx-motion/motion@1", id: "motion-car", name: "C7A3f car", durationMs: 1000, fps: 30, width: 640, height: 360, assets: [], provenance: { sourceApp: "gltf", createdBy: "test" }, layers: [{ id: "placeholder", type: "shape", shape: "rect", fill: "#07111f", opacity: 1, startMs: 0, durationMs: 1000, transform: { x: 0, y: 0, width: 640, height: 360 } }] });
  await writeFile(join(source, "preserve.txt"), "preserve\n", "utf8");
  const authority = await createTrustedWorkspaceAnchor(workspace), host = { sourcePackageRoot: source, outputPackageRoot: output, packageWorkspaceRoot: workspace, packageWorkspaceAuthority: authority, requireAbsentOutput: true as const }, recipes = recipeBundle(gltfBytes), prepared = await prepareGltfObjectScenePackageMaterialization(host, recipes);
  return { root, workspace, source, output, sourceRef, gltfBytes, authority, host, recipes, prepared, request: { schema: "shellx-motion/private-gltf-object-scene-package-materialization-request@1", expected: prepared.expected } };
}
function invoke(value: Awaited<ReturnType<typeof fixture>>, request: unknown = value.request) { return materializeGltfObjectScenePackage(value.host, value.prepared.approval, request); }
function outputHost(value: Awaited<ReturnType<typeof fixture>>) { return { outputPackageRoot: value.output, packageWorkspaceRoot: value.workspace, packageWorkspaceAuthority: value.authority }; }

describe.skipIf(process.platform !== "linux")("private C7A3f imported-object recipe package materializer", () => {
  it("COW-installs only canonical recipes/receipt, preserves source bytes, and reopens after source deletion", async () => {
    const value = await fixture(); try {
      const before = await snapshotPackageEditTree(value.source), manifest = await readFile(join(value.source, "manifest.json")), motion = await readFile(join(value.source, "motion.json")), gltf = await readFile(join(value.source, value.sourceRef));
      const result = await invoke(value), output = await snapshotPackageEditTree(value.output);
      expect(await readFile(join(value.source, "manifest.json"))).toEqual(manifest); expect(await readFile(join(value.source, "motion.json"))).toEqual(motion); expect(await readFile(join(value.source, value.sourceRef))).toEqual(gltf); expect((await snapshotPackageEditTree(value.source)).entries).toEqual(before.entries);
      expect(await readFile(join(value.output, C7A3F_SIDECAR_PATH), "utf8")).toBe(`${canonicalJson(value.prepared.sidecar)}\n`);
      expect([...output.entries.keys()].filter((path) => !before.entries.has(path) && output.entries.get(path)?.startsWith("file:"))).toEqual([C7A3F_SIDECAR_PATH, C7A3F_RECEIPT_PATH]);
      expect(result.receipt.output.changed).toEqual({ paths: [C7A3F_SIDECAR_PATH, C7A3F_RECEIPT_PATH], count: 2, motionAndManifest: "unchanged", gltfSource: "unchanged" }); expect(result.receipt.renderer).toEqual({ invoked: false, pixels: false, gpuAbi: "none", upload: "none" });
      const installed = await reopenGltfObjectScenePackageMaterializationOutput(outputHost(value)); expect(installed).toMatchObject({ recipeBundleFingerprint: value.prepared.expected.recipeBundleFingerprint, plans: value.prepared.expected.plans, renderer: { invoked: false, gpuAbi: "none" } });
      const preview = await reopenGltfObjectScenePackagePreviewInput(outputHost(value)); expect(preview).toMatchObject({ evaluationPlan: { fingerprint: value.prepared.expected.plans.evaluationFingerprint }, retainedRenderPlan: { fingerprint: value.prepared.expected.plans.retainedRenderFingerprint } }); expect(Object.isFrozen(preview.retainedRenderPlan)).toBe(true);
      await rm(value.source, { recursive: true, force: true }); await expect(reopenGltfObjectScenePackageMaterializationOutput(outputHost(value))).resolves.toMatchObject({ source: { sha256: hashBuffer(value.gltfBytes) } });
    } finally { await dispose(value.root); }
  });

  it("refuses forged approval, exact-base drift, source drift, occupied output, and pre-existing fixed artifacts", async () => {
    const forged = await fixture(), requestDrift = await fixture(), sourceDrift = await fixture(), occupied = await fixture(), existing = await fixture(); try {
      await expect(materializeGltfObjectScenePackage(forged.host, Object.freeze({}) as never, forged.request)).rejects.toThrow(/host-minted/i);
      await expect(invoke(requestDrift, { ...requestDrift.request, expected: { ...requestDrift.request.expected, recipeBundleFingerprint: "a".repeat(64) } })).rejects.toThrow(/source|exact/i);
      await writeFile(join(sourceDrift.source, sourceDrift.sourceRef), Buffer.from(`${canonicalJson({ ...carGltf(), scene: 99 })}\n`, "utf8")); await expect(invoke(sourceDrift)).rejects.toThrow(/source|identity/i);
      await mkdir(occupied.output); await expect(invoke(occupied)).rejects.toThrow(/absent|output/i);
      await mkdir(join(existing.source, "analysis", "scene-recipe"), { recursive: true }); await writeFile(join(existing.source, C7A3F_SIDECAR_PATH), "{}\n", "utf8"); await expect(prepareGltfObjectScenePackageMaterialization(existing.host, existing.recipes)).rejects.toThrow(/sidecar|receipt/i);
    } finally { await dispose(forged.root, requestDrift.root, sourceDrift.root, occupied.root, existing.root); }
  });

  it("replays byte-identically, accounts for an existing receipts directory, and never executes hostile recipe accessors", async () => {
    const first = await fixture(), replay = await fixture(), receipts = await fixture({ receipts: true }), hostile = await fixture(); try {
      const [one, two] = await Promise.all([invoke(first), invoke(replay)]); expect(two.receipt).toEqual(one.receipt); expect(await readFile(join(first.output, C7A3F_SIDECAR_PATH))).toEqual(await readFile(join(replay.output, C7A3F_SIDECAR_PATH))); expect(await readFile(join(first.output, C7A3F_RECEIPT_PATH))).toEqual(await readFile(join(replay.output, C7A3F_RECEIPT_PATH)));
      await expect(invoke(receipts)).resolves.toBeTruthy(); expect((await snapshotPackageEditTree(receipts.output)).entries.get("receipts")).toBe("dir");
      let calls = 0; const trap: Record<string, unknown> = {}; Object.defineProperty(trap, "declaration", { enumerable: true, get() { calls += 1; return {}; } }); await expect(prepareGltfObjectScenePackageMaterialization(hostile.host, trap)).rejects.toThrow(); expect(calls).toBe(0);
    } finally { await dispose(first.root, replay.root, receipts.root, hostile.root); }
  });

  it("output-only reopen refuses recipe, receipt, package source, document, extra-leaf, and empty-directory tamper", async () => {
    const values = await Promise.all([fixture(), fixture(), fixture(), fixture(), fixture(), fixture()]); try {
      await Promise.all(values.map(async (value) => await invoke(value))); const [sidecar, receipt, source, manifest, extra, empty] = values;
      await writeFile(join(sidecar!.output, C7A3F_SIDECAR_PATH), "{}\n", "utf8");
      const receiptJson = JSON.parse(await readFile(join(receipt!.output, C7A3F_RECEIPT_PATH), "utf8")); receiptJson.fingerprint = "0".repeat(64); await writeFile(join(receipt!.output, C7A3F_RECEIPT_PATH), `${canonicalJson(receiptJson)}\n`, "utf8");
      await writeFile(join(source!.output, source!.sourceRef), Buffer.from(`${canonicalJson({ ...carGltf(), scene: 99 })}\n`, "utf8"));
      const manifestJson = JSON.parse(await readFile(join(manifest!.output, "manifest.json"), "utf8")); manifestJson.name = "tampered"; await json(join(manifest!.output, "manifest.json"), manifestJson);
      await writeFile(join(extra!.output, "extra.txt"), "unexpected\n", "utf8"); await rm(join(empty!.output, "assets", "empty"), { recursive: true });
      for (const value of values) await expect(reopenGltfObjectScenePackageMaterializationOutput(outputHost(value!))).rejects.toThrow(/C7A3f|inventory|sidecar|receipt|identity|source/i);
    } finally { await dispose(...values.map((value) => value.root)); }
  });

  it("refuses precommit source drift and retains a post-rename uncertain output for explicit reopen", async () => {
    const drift = await fixture(), uncertain = await fixture(); try {
      fault.output = resolve(drift.output); fault.precommitSource = resolve(join(drift.source, "motion.json")); fault.beforeCommitClaimed = false; fault.beforeCommitFaulted = false;
      await expect(invoke(drift)).rejects.toThrow(/source|exact|rederive|documents/i); expect(fault.beforeCommitFaulted).toBe(true); await expect(lstat(drift.output)).rejects.toMatchObject({ code: "ENOENT" });
      fault.output = resolve(uncertain.output); fault.postInstall = true; fault.renamed = false; fault.afterCommitFaulted = false;
      const error = await invoke(uncertain).catch((reason: unknown) => reason as { readonly code?: unknown; readonly evidence?: unknown }); expect(fault.afterCommitFaulted).toBe(true); expect(error).toMatchObject({ code: "publication_commit_uncertain", evidence: { publicPath: uncertain.output, kind: "directory" } }); await expect(reopenGltfObjectScenePackageMaterializationOutput(outputHost(uncertain))).resolves.toMatchObject({ plans: uncertain.prepared.expected.plans });
    } finally { fault.output = ""; fault.postInstall = false; fault.renamed = false; fault.outputManifestOpens = 0; fault.afterCommitFaulted = false; fault.precommitSource = ""; fault.beforeCommitClaimed = false; fault.beforeCommitFaulted = false; await dispose(drift.root, uncertain.root); }
  });
});

describe("private C7A3f static contract", () => {
  it("keeps renderer/GPU imports out of mutation and output-only reopen while Core scene recipes have packed parity", async () => {
    const [writer, output, manifest] = await Promise.all([readFile(new URL("./gltf-object-scene-package-materialize-private.ts", import.meta.url), "utf8"), readFile(new URL("./gltf-object-scene-package-output-private.ts", import.meta.url), "utf8"), readFile(new URL("../../../../core/package.json", import.meta.url), "utf8")]);
    expect(`${writer}\n${output}`).not.toMatch(/renderer-browser|createGpu|WebGPU|GPUBuffer/u); const parsed = JSON.parse(manifest) as { publishConfig: { exports: Record<string, unknown> } }; expect(parsed.publishConfig.exports).toHaveProperty("./internal/scene-recipe");
  });
});

describeQualifiedLinuxGpu("qualified Linux GPU host C7A3f installed-package retained preview", () => {
  it("reopens the installed sidecar, renders one intermediate frame, and terminally releases", async () => {
    expect(hardwareRunner).toEqual({ enabled: true, platform: "linux", arch: "x64", node: 24 });
    const value = await fixture(); try {
      await invoke(value);
      const result = await renderGltfObjectScenePackagePreviewAtUs(outputHost(value), 375_000, { timeoutMs: 30_000 });
      expect(result).toMatchObject({ installed: { plans: value.prepared.expected.plans }, frame: { width: 640, height: 360, evidence: { backend: "webgpu-browser" } }, metrics: { geometryResourceCount: 2, instanceSlotCount: 5, sharedGeometryReuseCount: 3, perFrameGpuAllocations: 0 }, release: { hadResources: true, destroyedVertexBuffers: 2, destroyedIndexBuffers: 2, destroyedUniformBuffers: 5, remainingGpuBytes: 0 } });
      expect(nonBackgroundPixels(result.frame.rgba, [7, 17, 31])).toBeGreaterThan(100);
    } finally { await dispose(value.root); }
  }, 240_000);
});

function recipeBundle(gltfBytes: Buffer) {
  const container = parseGltfContainer(gltfBytes, "gltf"), objectPlan = compileGltfObjectPlan(container, { schema: GLTF_OBJECT_DECLARATION_SCHEMA, assetId: "car", sourceSha256: container.sourceSha256, roles: [{ roleId: "body", nodeIndex: 1, expectedNodeName: "Body" }, { roleId: "car-root", nodeIndex: 0, expectedNodeName: "Car" }, { roleId: "wheel-back-left", nodeIndex: 4, expectedNodeName: "Wheel-BL" }, { roleId: "wheel-back-right", nodeIndex: 5, expectedNodeName: "Wheel-BR" }, { roleId: "wheel-front-left", nodeIndex: 2, expectedNodeName: "Wheel-FL" }, { roleId: "wheel-front-right", nodeIndex: 3, expectedNodeName: "Wheel-FR" }] });
  const storyPlan = compileGltfObjectStoryPlan(objectPlan, carStory(objectPlan.fingerprint));
  const scenePlan = compileGltfObjectScenePlan(objectPlan, storyPlan, { schema: GLTF_OBJECT_SCENE_SCHEMA, id: "car-shot", objectFingerprint: objectPlan.fingerprint, storyFingerprint: storyPlan.fingerprint, camera: { viewDirection: [1, 0.65, 1], fovDeg: 42, padding: 1.2 } });
  const evaluationPlan = compileGltfObjectSceneEvaluationPlan(objectPlan, storyPlan, scenePlan, { schema: GLTF_OBJECT_SCENE_EVALUATION_SCHEMA, sceneFingerprint: scenePlan.fingerprint, segments: storyPlan.checkpoints.slice(0, -1).map((from, index) => { const to = storyPlan.checkpoints[index + 1]!; return { id: `segment-${index}`, fromCheckpointId: from.id, toCheckpointId: to.id, controls: storyPlan.controls.map((control) => control.kind === "material" ? { controlId: control.id, kind: "material", switchAtUs: from.atUs + 375_000 } : { controlId: control.id, kind: "transform", interpolation: "ease-in-out" }) }; }) });
  const retainedRenderPlan = compileGltfObjectRetainedRenderStaticPlan(evaluationPlan, { schema: GLTF_OBJECT_RETAINED_RENDER_SCHEMA, evaluationFingerprint: evaluationPlan.fingerprint, viewport: { width: 640, height: 360 }, backgroundColor: "#07111f", lighting: { direction: [-0.4, -0.8, -0.4], color: "#ffffff", ambient: 0.3, intensity: 1.4 }, sourceMaterials: [{ materialIndex: 0, baseColor: "#d97706", emissive: 0 }, { materialIndex: 1, baseColor: "#202126", emissive: 0.02 }] });
  return { declaration: objectPlan.declaration, story: storyPlan.story, scene: scenePlan.assembly, evaluation: evaluationPlan.evaluation, retainedRender: retainedRenderPlan.recipe };
}
function carStory(objectFingerprint: string) { const controls = [{ id: "body-paint", kind: "material", roleId: "body", primitiveRef: "car.mesh.00.primitive.00" }, { id: "car-motion", kind: "transform", roleId: "car-root" }, { id: "wheel-bl-spin", kind: "transform", roleId: "wheel-back-left" }, { id: "wheel-br-spin", kind: "transform", roleId: "wheel-back-right" }, { id: "wheel-fl-spin", kind: "transform", roleId: "wheel-front-left" }, { id: "wheel-fr-spin", kind: "transform", roleId: "wheel-front-right" }] as const; const checkpoints = Array.from({ length: 3 }, (_value, index) => { const progress = index / 2, spin = index * 180, transform = (controlId: string, rotationDeg: [number, number, number]) => ({ controlId, value: { translation: [0, 0, 0] as [number, number, number], rotationDeg, scale: 1 } }); return { id: `cp-${String(index).padStart(2, "0")}`, atUs: index * 500_000, states: [{ controlId: "body-paint", value: { materialRef: index % 2 === 0 ? "amber" : "blue" } }, { controlId: "car-motion", value: { translation: [progress * 10, 0, -progress * 3] as [number, number, number], rotationDeg: [0, progress * 90, 0] as [number, number, number], scale: 1 } }, transform("wheel-bl-spin", [spin, 0, 0]), transform("wheel-br-spin", [spin, 0, 0]), transform("wheel-fl-spin", [spin, 0, 0]), transform("wheel-fr-spin", [spin, 0, 0])] }; }); return { schema: GLTF_OBJECT_STORY_SCHEMA, objectFingerprint, startUs: 0, endUs: 1_000_000, materials: [{ id: "amber", kind: "basic" as const, baseColor: "#f59e0b", emissive: 0 }, { id: "blue", kind: "basic" as const, baseColor: "#38bdf8", emissive: 0.05 }], controls, checkpoints }; }
function carGltf(): Record<string, unknown> { const bytes = Buffer.alloc(42); [-0.5, -0.5, 0, 0.5, -0.5, 0, 0, 0.5, 0].forEach((value, index) => bytes.writeFloatLE(value, index * 4)); [0, 1, 2].forEach((value, index) => bytes.writeUInt16LE(value, 36 + index * 2)); return { asset: { version: "2.0" }, buffers: [{ byteLength: bytes.byteLength, uri: `data:application/octet-stream;base64,${bytes.toString("base64")}` }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 6 }], accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3" }, { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" }], materials: [{ name: "Body" }, { name: "Wheel" }], meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }, { primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 1 }] }], nodes: [{ name: "Car", children: [1, 2, 3, 4, 5] }, { name: "Body", mesh: 0 }, { name: "Wheel-FL", mesh: 1 }, { name: "Wheel-FR", mesh: 1 }, { name: "Wheel-BL", mesh: 1 }, { name: "Wheel-BR", mesh: 1 }], scenes: [{ nodes: [0] }], scene: 0 }; }
async function json(path: string, value: unknown) { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8"); }
async function dispose(...paths: string[]) { await Promise.all(paths.filter(Boolean).map(async (path) => await rm(path, { recursive: true, force: true }))); }
function nonBackgroundPixels(rgba: Uint8Array, background: readonly [number, number, number]): number { let count = 0; for (let index = 0; index < rgba.length; index += 4) if (rgba[index] !== background[0] || rgba[index + 1] !== background[1] || rgba[index + 2] !== background[2]) count += 1; return count; }
