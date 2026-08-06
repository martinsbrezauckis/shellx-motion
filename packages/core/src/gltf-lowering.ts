import { readGltfIndexAccessor, readGltfVec3Accessor } from "./gltf-accessor";
import type { AdapterDiagnosticResult } from "./adapter-diagnostics";
import { buildGltfDiagnostics } from "./gltf-diagnostics";
import { hashBuffer } from "./receipts";
import {
  generatedGltfNormals as generatedNormals,
  gltfQuaternionToEuler as quaternionToEuler,
  gltfSceneBounds as sceneBounds,
  normalizeGltfNormals,
} from "./gltf-math";
import { preflightGltfScene, type GltfPrimitivePlan } from "./gltf-preflight";
import {
  boundedGltfCreatedBy as boundedCreatedBy,
  gltfArray as array,
  gltfBoundedInteger as boundedInteger,
  gltfIndexArray as indexArray,
  gltfInteger as integer,
  gltfRecord as record,
  gltfString as string,
  uniqueGltfObjectId as uniqueObjectId,
} from "./gltf-read";
import {
  MAX_SCENE_3D_MESH_INDICES_TOTAL,
  MAX_SCENE_3D_MESH_VERTICES_TOTAL,
  SCENE_3D_MESH_SCHEMA,
} from "./scene-3d";
import type { ParsedGltfContainer } from "./gltf-types";
import type { MotionDocument, MotionScene3DMeshObject, OperationReceipt } from "./types";

export interface GltfLoweringInput {
  adapterId: "adapter.gltf";
  sourcePath: string;
  sourceText: string;
  normalizedPackagePath: string;
  container: ParsedGltfContainer;
  createdBy?: string;
  createdAt?: string;
  width?: number;
  height?: number;
  durationMs?: number;
  fps?: number;
}

export interface GltfLoweringResult {
  schema: "shellx-motion/adapter-lowering@1";
  adapterId: "adapter.gltf";
  source: { path: string; sha256: string };
  motion: MotionDocument;
  diagnostics: AdapterDiagnosticResult;
  receipt: OperationReceipt;
}

/** Lower a strict, static glTF 2.0 triangle subset into bounded data-only scene3d mesh objects. */
export function lowerGltfToMotion(input: GltfLoweringInput): GltfLoweringResult {
  const json = input.container.json;
  rejectUnsupportedDocumentFeatures(json);
  const nodes = array(json.nodes, "glTF nodes");
  const meshes = array(json.meshes, "glTF meshes");
  const scenes = array(json.scenes, "glTF scenes");
  const sceneIndex = json.scene === undefined ? 0 : integer(json.scene, "glTF scene index", 0, scenes.length - 1);
  const scene = record(scenes[sceneIndex], "glTF scene");
  const rootNodes = indexArray(scene.nodes, nodes.length, "glTF scene nodes");
  if (rootNodes.length === 0) throw new Error("glTF selected scene must contain at least one root node.");
  const warnings: string[] = [];
  const preflight = preflightGltfScene(input.container, nodes, meshes, rootNodes);
  if (preflight.plans.length === 0) throw new Error("glTF selected scene contains no supported mesh primitives.");
  const objects: MotionScene3DMeshObject[] = [];
  for (const plan of preflight.plans) materializePrimitive(plan, input, objects, warnings);
  const vertexCount = objects.reduce((total, object) => total + object.geometry.positions.length / 3, 0);
  const indexCount = objects.reduce((total, object) => total + object.geometry.indices.length, 0);
  if (vertexCount !== preflight.vertexCount || indexCount !== preflight.indexCount
    || vertexCount > MAX_SCENE_3D_MESH_VERTICES_TOTAL || indexCount > MAX_SCENE_3D_MESH_INDICES_TOTAL) {
    throw new Error("glTF materialized geometry does not match its bounded scene preflight.");
  }
  const frame = sceneBounds(objects);
  const width = boundedInteger(input.width, 1280, 16, 8192, "width");
  const height = boundedInteger(input.height, 720, 16, 8192, "height");
  const durationMs = boundedInteger(input.durationMs, 3000, 1, 3_600_000, "durationMs");
  const fps = boundedInteger(input.fps, 30, 1, 240, "fps");
  const sourceSha256 = hashBuffer(Buffer.from(input.sourceText, "utf8"));
  const name = string(json.asset && record(json.asset, "glTF asset").generator) ?? "glTF 3D Import";
  const motion: MotionDocument = {
    schema: "shellx-motion/motion@1",
    id: `motion_gltf_${input.container.sourceSha256.slice(0, 16)}`,
    name: name.slice(0, 128),
    durationMs,
    fps,
    width,
    height,
    background: "#020617",
    layers: [{
      id: "gltf-scene",
      type: "scene3d",
      startMs: 0,
      durationMs,
      transform: { x: 0, y: 0, width, height },
      scene3d: {
        schema: SCENE_3D_MESH_SCHEMA,
        camera: { position: frame.camera, target: frame.center, fovDeg: 42, near: frame.near, far: frame.far, orbitDegPerSecond: 12 },
        lighting: { ambient: 0.32, direction: [-0.4, -0.8, -0.5], intensity: 1.35, color: "#ffffff" },
        backgroundColor: "#020617",
        objects,
      },
    }],
    assets: [],
    provenance: { sourceApp: input.container.format, createdBy: boundedCreatedBy(input.createdBy), sourceSchema: "gltf-2.0-static-mesh" },
  };
  const motionSha256 = hashBuffer(Buffer.from(`${JSON.stringify(motion, null, 2)}\n`, "utf8"));
  const diagnostics = buildGltfDiagnostics({
    adapterId: input.adapterId,
    sourcePath: input.sourcePath,
    normalizedPackagePath: input.normalizedPackagePath,
    sourceSha256,
    format: input.container.format,
    objectCount: objects.length,
    warnings,
    ...(input.createdAt ? { createdAt: input.createdAt } : {}),
  });
  const receipt: OperationReceipt = {
    schema: "shellx-motion/receipt@1",
    id: `adapter-lowering-gltf-${motionSha256.slice(0, 16)}`,
    operation: "adapter.lower",
    status: warnings.length > 0 ? "warning" : "passed",
    packageId: input.normalizedPackagePath,
    inputHashes: {
      source: sourceSha256,
      ...Object.fromEntries(input.container.bufferSha256.map((hash, index) => [`buffer${index}`, hash])),
    },
    createdAt: input.createdAt ?? new Date().toISOString(),
    lane: "adapter",
    output: {
      adapterId: input.adapterId,
      format: input.container.format,
      motionId: motion.id,
      motionSha256,
      layerCount: 1,
      objectCount: objects.length,
      vertexCount,
      triangleCount: indexCount / 3,
      lossiness: diagnostics.lossiness,
    },
    warnings,
  };
  return {
    schema: "shellx-motion/adapter-lowering@1",
    adapterId: input.adapterId,
    source: { path: input.sourcePath, sha256: sourceSha256 },
    motion,
    diagnostics,
    receipt,
  };
}

function materializePrimitive(
  plan: GltfPrimitivePlan,
  input: GltfLoweringInput,
  objects: MotionScene3DMeshObject[],
  warnings: string[],
): void {
  const positions = readGltfVec3Accessor(input.container, plan.attributes.POSITION, "POSITION");
  const indices = readGltfIndexAccessor(input.container, plan.indicesAccessor, positions.count);
  if (positions.count !== plan.positionCount || indices.length !== plan.indexCount) {
    throw new Error("glTF accessor geometry changed after bounded preflight.");
  }
  const normals = plan.attributes.NORMAL === undefined
    ? generatedNormals(positions.values, indices)
    : normalizeAccessorNormals(
      readGltfVec3Accessor(input.container, plan.attributes.NORMAL, "NORMAL"),
      positions.count,
    );
  if (plan.attributes.NORMAL === undefined) {
    warnings.push(`Generated flat vertex normals for mesh ${plan.meshIndex} primitive ${plan.primitiveIndex}.`);
  }
  objects.push({
    id: uniqueObjectId(
      plan.baseId,
      objects,
    ),
    primitive: "mesh",
    geometry: { positions: positions.values, normals, indices },
    position: plan.transform.position,
    rotationDeg: quaternionToEuler(plan.transform.rotation),
    scale: plan.transform.scale,
    color: plan.material.color,
    emissive: plan.material.emissive,
    source: {
      format: input.container.format,
      meshIndex: plan.meshIndex,
      primitiveIndex: plan.primitiveIndex,
      ...(plan.materialIndex !== undefined ? { materialIndex: plan.materialIndex } : {}),
    },
  });
}

function rejectUnsupportedDocumentFeatures(json: Record<string, unknown>): void {
  for (const field of ["animations", "skins", "textures", "images", "samplers", "cameras"] as const) {
    if (Array.isArray(json[field]) && json[field].length > 0) {
      throw new Error(`glTF ${field} are not supported by the static bounded importer.`);
    }
  }
  for (const field of ["extensionsUsed", "extensionsRequired"] as const) {
    if (Array.isArray(json[field]) && json[field].length > 0) {
      throw new Error(`glTF ${field} must be empty; compressed or executable extensions are not accepted.`);
    }
  }
}

function normalizeAccessorNormals(data: { values: number[]; count: number }, positionCount: number): number[] {
  return normalizeGltfNormals(data.values, data.count, positionCount);
}
