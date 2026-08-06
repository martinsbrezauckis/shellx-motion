import type { MotionBlendMode, MotionEffects, MotionLayer, MotionTransform } from "./types";
import type { MotionMask } from "./keying";

export const MOTION_COMPOSITING_GRAPH_SCHEMA = "shellx-motion/compositing-graph@1" as const;
export const MOTION_COMPOSITING_COMPILE_SCHEMA = "shellx-motion/compositing-compile@1" as const;
export const MAX_COMPOSITING_GRAPH_NODES = 64;
export const MAX_COMPOSITING_GRAPH_EDGES = 128;
export const MAX_COMPOSITING_GRAPH_DEPTH = 32;
export const MAX_COMPOSITING_PIXEL_OPERATIONS = 1_000_000_000;
export const MAX_COMPOSITING_WORKING_BYTES = 512 * 1024 * 1024;

export type MotionCompositingNodeType =
  | "source" | "transform" | "mask" | "matte" | "blend" | "color" | "blur" | "output";

export interface MotionCompositingSourceNode {
  id: string;
  type: "source";
  layerId: string;
}

export interface MotionCompositingTransformNode {
  id: string;
  type: "transform";
  transform: MotionTransform;
}

export interface MotionCompositingMaskNode {
  id: string;
  type: "mask";
  mask: MotionMask;
}

export interface MotionCompositingMatteNode {
  id: string;
  type: "matte";
  matteType: "alpha" | "alpha-inverted" | "luma" | "luma-inverted";
}

export interface MotionCompositingBlendNode {
  id: string;
  type: "blend";
  mode: MotionBlendMode;
}

export interface MotionCompositingColorNode {
  id: string;
  type: "color";
  brightness?: number;
  contrast?: number;
  saturate?: number;
  grayscale?: number;
}

export interface MotionCompositingBlurNode {
  id: string;
  type: "blur";
  radius: number;
}

export interface MotionCompositingOutputNode {
  id: string;
  type: "output";
}

export type MotionCompositingNode =
  | MotionCompositingSourceNode | MotionCompositingTransformNode | MotionCompositingMaskNode
  | MotionCompositingMatteNode | MotionCompositingBlendNode | MotionCompositingColorNode
  | MotionCompositingBlurNode | MotionCompositingOutputNode;

export type MotionCompositingInputPort = "input" | "matte" | "background" | "foreground";

export interface MotionCompositingEdge {
  id: string;
  from: { nodeId: string; port: "output" };
  to: { nodeId: string; port: MotionCompositingInputPort };
}

export interface MotionCompositingGraph {
  schema: typeof MOTION_COMPOSITING_GRAPH_SCHEMA;
  id: string;
  nodes: MotionCompositingNode[];
  edges: MotionCompositingEdge[];
}

export interface MotionCompositingResourceEstimate {
  nodeCount: number;
  edgeCount: number;
  sourceCount: number;
  maxDepth: number;
  maxFanOut: number;
  pixelOperations: number;
  workingBytes: number;
}

export interface MotionCompositingIssue {
  path: string;
  code: string;
  message: string;
}

export interface MotionCompositingValidationResult {
  ok: boolean;
  issues: MotionCompositingIssue[];
  order: string[];
  estimate: MotionCompositingResourceEstimate;
}

export interface MotionCompositingCompileMetadata {
  schema: typeof MOTION_COMPOSITING_COMPILE_SCHEMA;
  graphId: string;
  fingerprint: string;
  nodeOrder: string[];
  sourceLayerIds: string[];
  outputLayerIds: string[];
  estimate: MotionCompositingResourceEstimate;
}

export interface CompiledMotionCompositingGraph {
  layers: MotionLayer[];
  metadata: MotionCompositingCompileMetadata;
  sourceLayers: MotionLayer[];
}

export interface MotionCompositingGraphContext {
  width: number;
  height: number;
  layers: MotionLayer[];
}

export type MotionCompositingUnaryEffects = Pick<MotionEffects, "brightness" | "contrast" | "saturate" | "grayscale" | "blur">;
