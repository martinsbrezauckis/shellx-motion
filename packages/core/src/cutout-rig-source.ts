/** Static image-source refusal proof shared by cutout-rig planning and hidden-stage revalidation. */
import { type MotionSimilarityTransform } from "./motion-transform-matrix";
import type { MotionDocument, MotionLayer } from "./types";

const MAX_ABSOLUTE_COORDINATE = 1_000_000;
const MIN_SCALE = 0.001;
const MAX_SCALE = 100;

export interface CutoutRigSourceIdentity {
  assetRef: string;
  width: number;
  height: number;
  sha256: string;
}

export interface CutoutRigSourceStaticTransform extends MotionSimilarityTransform {
  width: number;
  height: number;
  originX: number;
  originY: number;
}

/**
 * Central refusal proof used before initial planning and again in the hidden copy-on-write stage.
 * v1 is deliberately narrow: exactly one unlocked owning track and no relationship/compositing
 * reference may depend on the source that is being replaced.
 */
export function assertCutoutRigSource(
  document: MotionDocument,
  sourceLayerId: string,
  identity: CutoutRigSourceIdentity
): MotionLayer {
  const source = document.layers.find((layer) => layer.id === sourceLayerId);
  if (!source) throw new Error(`Cutout rig source layer ${sourceLayerId} does not exist.`);
  assertSourceLayer(source, identity);
  assertSourceTrack(document, source);
  if (document.relationships && referencesLayerId(document.relationships, source.id)) {
    throw new Error("Cutout rig source may not be referenced by a procedural relationship.");
  }
  if (document.compositing && referencesLayerId(document.compositing, source.id)) {
    throw new Error("Cutout rig source may not be referenced by compositing state.");
  }
  return source;
}

/** Preserve the source's current static transform rather than resetting its placement. */
export function staticCutoutRigSourceTransform(
  source: MotionLayer,
  identity: CutoutRigSourceIdentity
): CutoutRigSourceStaticTransform {
  const transform = source.transform ?? {};
  const allowed = new Set(["x", "y", "width", "height", "scale", "rotation", "originX", "originY"]);
  if (Object.keys(transform).some((key) => !allowed.has(key))) throw new Error("Cutout rig source transform contains unsupported state.");
  const width = transform.width === undefined ? identity.width : finite(transform.width, "source transform.width");
  const height = transform.height === undefined ? identity.height : finite(transform.height, "source transform.height");
  if (width !== identity.width || height !== identity.height) throw new Error("Cutout rig source transform width and height must equal its PNG pixels.");
  const scale = transform.scale === undefined ? 1 : finite(transform.scale, "source transform.scale");
  if (scale < MIN_SCALE || scale > MAX_SCALE) throw new Error(`Source transform scale must be between ${MIN_SCALE} and ${MAX_SCALE}.`);
  return {
    x: transform.x === undefined ? 0 : boundedCoordinate(transform.x, "source transform.x"),
    y: transform.y === undefined ? 0 : boundedCoordinate(transform.y, "source transform.y"),
    width,
    height,
    scale,
    rotation: transform.rotation === undefined ? 0 : boundedCoordinate(transform.rotation, "source transform.rotation"),
    originX: transform.originX === undefined ? width / 2 : boundedCoordinate(transform.originX, "source transform.originX"),
    originY: transform.originY === undefined ? height / 2 : boundedCoordinate(transform.originY, "source transform.originY")
  };
}

function assertSourceLayer(source: MotionLayer, identity: CutoutRigSourceIdentity): void {
  if (source.type !== "image" || source.visible === false || source.locked === true) throw new Error("Cutout rig source must be one visible unlocked image layer.");
  if (!identity.assetRef.startsWith("assets/") || !/^[a-f0-9]{64}$/.test(identity.sha256) || !positiveInteger(identity.width) || !positiveInteger(identity.height)) {
    throw new Error("Cutout rig source PNG identity is invalid.");
  }
  if (source.crop !== undefined || source.keyframes !== undefined || source.transitions !== undefined || source.mask !== undefined
    || source.effects !== undefined || source.gradient !== undefined || source.pathReveal !== undefined || source.emitter !== undefined
    || source.pointCloud !== undefined || source.shader !== undefined || source.scene3d !== undefined || source.environment !== undefined
    || source.matte !== undefined || source.keying !== undefined || source.style !== undefined || source.fit !== undefined
    || source.blendMode !== undefined || source.opacity !== undefined || source.width !== undefined || source.height !== undefined
    || source.trimStartMs !== undefined || source.trimDurationMs !== undefined || source.loop !== undefined || source.playbackRate !== undefined
    || source.depth !== undefined) {
    throw new Error("Cutout rig source must be an unstyled static image without crop, effects, masking, or animation.");
  }
  if (Object.keys(source).some((key) => key.startsWith("x-"))) throw new Error("Cutout rig source may not carry extension animation state.");
}

function assertSourceTrack(document: MotionDocument, source: MotionLayer): void {
  if (!source.trackId) throw new Error("Cutout rig source must belong to exactly one unlocked track.");
  const owners = (document.tracks ?? []).filter((track) => track.layerIds?.includes(source.id));
  const owner = (document.tracks ?? []).find((track) => track.id === source.trackId);
  if (!owner || owners.length !== 1 || owners[0] !== owner || (owner as unknown as { locked?: unknown }).locked === true) {
    throw new Error("Cutout rig source must belong to exactly one unlocked track.");
  }
}

function referencesLayerId(value: unknown, layerId: string, depth = 0): boolean {
  if (depth > 16) return true;
  if (Array.isArray(value)) return value.length > 256 || value.some((entry) => referencesLayerId(entry, layerId, depth + 1));
  if (typeof value !== "object" || value === null) return false;
  for (const [key, entry] of Object.entries(value)) {
    if ((key === "layerId" || key.endsWith("LayerId")) && entry === layerId) return true;
    if ((key === "layerIds" || key.endsWith("LayerIds")) && Array.isArray(entry) && entry.includes(layerId)) return true;
    if (referencesLayerId(entry, layerId, depth + 1)) return true;
  }
  return false;
}

function finite(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${path} must be a finite number.`);
  return value;
}
function positiveInteger(value: unknown): boolean { return typeof value === "number" && Number.isInteger(value) && value > 0; }
function boundedCoordinate(value: unknown, path: string): number {
  const number = finite(value, path);
  if (Math.abs(number) > MAX_ABSOLUTE_COORDINATE) throw new Error(`${path} exceeds the ${MAX_ABSOLUTE_COORDINATE} coordinate bound.`);
  return number;
}
