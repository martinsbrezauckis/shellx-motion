export const MOTION_PROCEDURAL_SCHEMA = "shellx-motion/procedural-relationships@1" as const;
export const MAX_PROCEDURAL_RELATIONSHIPS = 64;
export const MAX_PROCEDURAL_NODES_PER_RELATIONSHIP = 64;
export const MAX_PROCEDURAL_NODES = 256;
export const MAX_PROCEDURAL_DEPTH = 24;
export const MAX_PROCEDURAL_AUDIO_ENVELOPES = 16;
export const MAX_PROCEDURAL_ENVELOPE_SAMPLES = 4_096;
export const MAX_PROCEDURAL_BAKE_SAMPLES = 3_600;
export const MAX_PROCEDURAL_ABS_VALUE = 1_000_000_000;
/** Trig inputs are radians and must remain in this bounded, quantized range. */
export const MAX_PROCEDURAL_TRIG_INPUT_RADIANS = 1_000_000;
/** Every evaluated scalar is rounded to this many decimal places before it is observable or baked. */
export const PROCEDURAL_VALUE_DECIMALS = 6;

export const MOTION_PROCEDURAL_PROPERTIES = [
  "transform.x", "transform.y", "transform.width", "transform.height",
  "transform.originX", "transform.originY", "transform.scale", "transform.rotation",
  "opacity", "volume", "pan", "playbackRate",
  "style.fontSize", "style.fontWeight", "style.letterSpacing", "style.lineHeight",
  "style.width", "style.height", "style.strokeWidth", "style.borderWidth",
  "effects.blur", "effects.brightness", "effects.contrast", "effects.saturate",
  "effects.grayscale", "effects.glow.radius", "gradient.angle",
  "environment.intensity", "environment.wind", "environment.dropSpeed", "environment.dropLength",
  "environment.ground.horizon", "environment.ground.wetness", "environment.ground.roughness",
  "environment.ground.rippleAmount", "environment.ground.splashAmount",
  "environment.ground.reflectionStrength", "environment.atmosphere.mist",
  "environment.atmosphere.lensDroplets", "environment.surface.horizon",
  "environment.surface.waveScale", "environment.surface.waveHeight", "environment.surface.waveSpeed",
  "environment.surface.direction", "environment.surface.choppiness",
  "environment.optics.reflectionStrength", "environment.optics.refractionStrength",
  "environment.optics.fresnel", "environment.optics.caustics", "environment.optics.clarity",
  "environment.optics.foam", "environment.fall.intensity", "environment.fall.speed",
  "environment.fall.wind", "environment.fall.turbulence", "environment.fall.flakeSize",
  "environment.fall.focusFalloff", "environment.ground.accumulation", "environment.ground.drift",
  "environment.ground.contactAmount", "environment.atmosphere.haze", "environment.atmosphere.depthFade",
  "environment.fog.density", "environment.fog.speed", "environment.fog.scale",
  "environment.fog.turbulence", "environment.fog.height", "environment.fog.lightStrength",
] as const;

export type MotionProceduralProperty = typeof MOTION_PROCEDURAL_PROPERTIES[number] | `shader.uniforms.${string}`;
export interface MotionProceduralPropertyRef { layerId: string; property: MotionProceduralProperty }
interface NodeBase { id: string }
export interface ProceduralConstantNode extends NodeBase { type: "constant"; value: number }
export interface ProceduralPropertyNode extends NodeBase { type: "property"; ref: MotionProceduralPropertyRef }
export interface ProceduralTimeNode extends NodeBase { type: "time"; unit: "seconds" | "milliseconds" }
export interface ProceduralFrameNode extends NodeBase { type: "frame" }
export interface ProceduralAudioEnvelopeNode extends NodeBase { type: "audio-envelope"; envelopeId: string }
export interface ProceduralUnaryNode extends NodeBase { type: "abs" | "negate" | "sin" | "cos"; input: string }
export interface ProceduralBinaryNode extends NodeBase {
  type: "add" | "subtract" | "multiply" | "divide" | "min" | "max";
  left: string;
  right: string;
}
export interface ProceduralClampNode extends NodeBase { type: "clamp"; input: string; min: string; max: string }
export interface ProceduralMapNode extends NodeBase {
  type: "map";
  input: string;
  inMin: string;
  inMax: string;
  outMin: string;
  outMax: string;
  clamp: boolean;
}
export interface ProceduralEaseNode extends NodeBase { type: "ease"; input: string; easing: string }
export interface ProceduralDistanceNode extends NodeBase { type: "distance"; x1: string; y1: string; x2: string; y2: string }
export interface ProceduralNoiseNode extends NodeBase { type: "noise"; input: string; seed: number; frequency: number }

export type MotionProceduralNode = ProceduralConstantNode | ProceduralPropertyNode | ProceduralTimeNode
  | ProceduralFrameNode | ProceduralAudioEnvelopeNode | ProceduralUnaryNode | ProceduralBinaryNode
  | ProceduralClampNode | ProceduralMapNode | ProceduralEaseNode | ProceduralDistanceNode | ProceduralNoiseNode;

export interface MotionProceduralRelationship {
  id: string;
  enabled: boolean;
  target: MotionProceduralPropertyRef;
  nodes: MotionProceduralNode[];
  outputNodeId: string;
}

export interface MotionProceduralEnvelopeSample { atMs: number; value: number }
export interface MotionProceduralAudioEnvelope {
  id: string;
  sourceLayerId: string;
  channel: "mix" | "left" | "right";
  samples: MotionProceduralEnvelopeSample[];
}

export interface MotionProceduralGraph {
  schema: typeof MOTION_PROCEDURAL_SCHEMA;
  relationships: MotionProceduralRelationship[];
  audioEnvelopes?: MotionProceduralAudioEnvelope[];
}

export interface MotionProceduralIssue { path: string; code: string; message: string }
export interface MotionProceduralEstimate {
  relationshipCount: number;
  nodeCount: number;
  envelopeSampleCount: number;
  maxDepth: number;
  maxWorkPerFrame: number;
}
export interface MotionProceduralValidationResult {
  ok: boolean;
  issues: MotionProceduralIssue[];
  relationshipOrder: string[];
  nodeOrders: Record<string, string[]>;
  estimate: MotionProceduralEstimate;
}
