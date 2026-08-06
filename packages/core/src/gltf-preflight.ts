/** Document-wide glTF scene preflight that never materializes accessor value arrays. */
import { inspectGltfIndexAccessor, inspectGltfVec3Accessor } from "./gltf-accessor";
import {
  combineGltfTransform as combineTransform,
  identityGltfTransform as identityTransform,
  normalizeGltfQuaternion,
  type GltfWorldTransform as WorldTransform,
} from "./gltf-math";
import {
  gltfArray as array,
  gltfColorFactor as colorFactor,
  gltfIndexArray as indexArray,
  gltfInteger as integer,
  gltfRecord as record,
  gltfString as string,
  gltfTuple as tuple,
  gltfTuple4 as tuple4,
} from "./gltf-read";
import {
  MAX_SCENE_3D_MESH_INDICES_TOTAL,
  MAX_SCENE_3D_MESH_VERTICES_TOTAL,
  MAX_SCENE_3D_OBJECTS_PER_LAYER,
  SCENE_3D_CONTROL_BOUNDS,
} from "./scene-3d";
import type { ParsedGltfContainer } from "./gltf-types";

export interface GltfPrimitivePlan {
  meshIndex: number;
  primitiveIndex: number;
  baseId: string;
  transform: WorldTransform;
  attributes: Record<string, unknown>;
  indicesAccessor: unknown;
  positionCount: number;
  indexCount: number;
  materialIndex?: number;
  material: { color: string; emissive: number };
}

export interface GltfScenePreflight {
  plans: GltfPrimitivePlan[];
  vertexCount: number;
  indexCount: number;
}

interface GltfTraversalContext extends GltfScenePreflight {
  container: ParsedGltfContainer;
  nodes: unknown[];
  meshes: unknown[];
  visited: Set<number>;
  active: Set<number>;
}

/** Validates selected-scene topology, transforms, materials, and all geometry budgets before array allocation. */
export function preflightGltfScene(
  container: ParsedGltfContainer,
  nodes: unknown[],
  meshes: unknown[],
  rootNodes: number[],
): GltfScenePreflight {
  const context: GltfTraversalContext = {
    container,
    nodes,
    meshes,
    plans: [],
    vertexCount: 0,
    indexCount: 0,
    visited: new Set<number>(),
    active: new Set<number>(),
  };
  for (const nodeIndex of rootNodes) visitNode(nodeIndex, identityTransform(), context);
  return { plans: context.plans, vertexCount: context.vertexCount, indexCount: context.indexCount };
}

function visitNode(nodeIndex: number, parent: WorldTransform, context: GltfTraversalContext): void {
  if (context.active.has(nodeIndex)) throw new Error("glTF scene graph contains a cycle.");
  if (context.visited.has(nodeIndex)) throw new Error("glTF node instancing is not supported by the bounded importer.");
  context.active.add(nodeIndex);
  context.visited.add(nodeIndex);
  const node = record(context.nodes[nodeIndex], `glTF node ${nodeIndex}`);
  if (node.matrix !== undefined || node.skin !== undefined || node.camera !== undefined || node.weights !== undefined || node.extensions !== undefined) {
    throw new Error(`glTF node ${nodeIndex} uses unsupported matrix, skin, camera, weights, or extensions.`);
  }
  const world = canonicalWorldTransform(combineTransform(parent, nodeTransform(node, nodeIndex)), nodeIndex);
  if (node.mesh !== undefined) {
    const meshIndex = integer(node.mesh, `glTF node ${nodeIndex} mesh`, 0, context.meshes.length - 1);
    planMesh(meshIndex, nodeIndex, node, world, context);
  }
  const children = indexArray(node.children, context.nodes.length, `glTF node ${nodeIndex} children`, true);
  for (const child of children) visitNode(child, world, context);
  context.active.delete(nodeIndex);
}

function planMesh(
  meshIndex: number,
  nodeIndex: number,
  node: Record<string, unknown>,
  transform: WorldTransform,
  context: GltfTraversalContext,
): void {
  const mesh = record(context.meshes[meshIndex], `glTF mesh ${meshIndex}`);
  const primitives = array(mesh.primitives, `glTF mesh ${meshIndex} primitives`);
  if (context.plans.length + primitives.length > MAX_SCENE_3D_OBJECTS_PER_LAYER) {
    throw new Error(`glTF import exceeds ${MAX_SCENE_3D_OBJECTS_PER_LAYER} mesh primitives.`);
  }
  for (const [primitiveIndex, value] of primitives.entries()) {
    const primitive = record(value, `glTF mesh ${meshIndex} primitive ${primitiveIndex}`);
    if (primitive.mode !== undefined && primitive.mode !== 4) throw new Error("glTF importer supports TRIANGLES mode only.");
    if (primitive.targets !== undefined || primitive.extensions !== undefined) {
      throw new Error("glTF morph targets and primitive extensions are not supported.");
    }
    const attributes = record(primitive.attributes, `glTF mesh ${meshIndex} primitive ${primitiveIndex} attributes`);
    const positionCount = inspectGltfVec3Accessor(context.container, attributes.POSITION, "POSITION").count;
    const indexCount = inspectGltfIndexAccessor(context.container, primitive.indices, positionCount).count;
    if (attributes.NORMAL !== undefined) {
      const normalCount = inspectGltfVec3Accessor(context.container, attributes.NORMAL, "NORMAL").count;
      if (normalCount !== positionCount) throw new Error("glTF NORMAL accessor count must match POSITION count.");
    }
    const nextVertexCount = context.vertexCount + positionCount;
    const nextIndexCount = context.indexCount + indexCount;
    if (nextVertexCount > MAX_SCENE_3D_MESH_VERTICES_TOTAL || nextIndexCount > MAX_SCENE_3D_MESH_INDICES_TOTAL) {
      throw new Error("glTF import exceeds the composition mesh geometry budget.");
    }
    const materialIndex = primitive.material === undefined
      ? undefined
      : integer(primitive.material, "glTF material index", 0, materials(context.container).length - 1);
    context.plans.push({
      meshIndex,
      primitiveIndex,
      baseId: `${string(node.name) ?? string(mesh.name) ?? `node-${nodeIndex}`}-${primitiveIndex}`,
      transform,
      attributes,
      indicesAccessor: primitive.indices,
      positionCount,
      indexCount,
      ...(materialIndex !== undefined ? { materialIndex } : {}),
      material: materialColor(context.container, materialIndex),
    });
    context.vertexCount = nextVertexCount;
    context.indexCount = nextIndexCount;
  }
}

function nodeTransform(node: Record<string, unknown>, index: number): WorldTransform {
  const position = tuple(node.translation, [0, 0, 0], ...SCENE_3D_CONTROL_BOUNDS.position, `glTF node ${index} translation`);
  const rotation = quaternion(node.rotation, index);
  const scale = tuple(node.scale, [1, 1, 1], ...SCENE_3D_CONTROL_BOUNDS.scale, `glTF node ${index} scale`);
  if (Math.max(...scale) - Math.min(...scale) > 0.000_001) {
    throw new Error(`glTF node ${index} requires uniform scale.`);
  }
  return { position, rotation, scale: scale[0] };
}

function canonicalWorldTransform(transform: WorldTransform, nodeIndex: number): WorldTransform {
  return {
    position: transform.position.map((value) => canonicalWorldScalar(
      value,
      ...SCENE_3D_CONTROL_BOUNDS.position,
      `glTF node ${nodeIndex} world translation`,
    )) as WorldTransform["position"],
    rotation: normalizeGltfQuaternion(transform.rotation, `glTF node ${nodeIndex} world rotation quaternion`),
    scale: canonicalWorldScalar(transform.scale, ...SCENE_3D_CONTROL_BOUNDS.scale, `glTF node ${nodeIndex} world scale`),
  };
}

function canonicalWorldScalar(value: number, min: number, max: number, label: string): number {
  const epsilon = 1e-9;
  if (!Number.isFinite(value) || value < min - epsilon || value > max + epsilon) {
    throw new Error(`${label} must remain between ${min} and ${max}.`);
  }
  const bounded = Math.min(max, Math.max(min, value));
  return Object.is(bounded, -0) ? 0 : bounded;
}

function materialColor(container: ParsedGltfContainer, materialIndex?: number): { color: string; emissive: number } {
  if (materialIndex === undefined) return { color: "#cbd5e1", emissive: 0 };
  const material = record(materials(container)[materialIndex], `glTF material ${materialIndex}`);
  if (material.extensions !== undefined || material.alphaMode && material.alphaMode !== "OPAQUE") {
    throw new Error(`glTF material ${materialIndex} uses unsupported extensions or alpha mode.`);
  }
  const pbr = material.pbrMetallicRoughness === undefined
    ? {}
    : record(material.pbrMetallicRoughness, `glTF material ${materialIndex} PBR`);
  const factor = colorFactor(pbr.baseColorFactor, [0.8, 0.84, 0.88, 1], `glTF material ${materialIndex} baseColorFactor`);
  if (factor[3] !== 1) throw new Error(`glTF material ${materialIndex} must be opaque.`);
  const emissive = tuple(material.emissiveFactor, [0, 0, 0], 0, 1, `glTF material ${materialIndex} emissiveFactor`);
  const color = factor.slice(0, 3).map((value) => Math.round(value * 255).toString(16).padStart(2, "0")).join("");
  return { color: `#${color}`, emissive: Math.max(...emissive) };
}

function materials(container: ParsedGltfContainer): unknown[] {
  return container.json.materials === undefined ? [] : array(container.json.materials, "glTF materials");
}

function quaternion(value: unknown, index: number): [number, number, number, number] {
  const raw = value === undefined
    ? [0, 0, 0, 1] as [number, number, number, number]
    : tuple4(value, -1, 1, `glTF node ${index} rotation`);
  return normalizeGltfQuaternion(raw, `glTF node ${index} rotation quaternion`);
}
