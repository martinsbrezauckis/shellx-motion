import {
  MAX_MOTION_SCENE3D_ANIMATION_KEYFRAMES_PER_TRACK,
  MAX_MOTION_SCENE3D_ANIMATION_TIME_US,
  MAX_MOTION_SCENE3D_ANIMATION_TRACKS,
  MOTION_SCENE3D_ANIMATION_SCHEMA,
} from "./motion-scene3d-animation-types";
import { SCENE_3D_CONTROL_BOUNDS } from "./scene-3d";

/** Exact portable shape for the optional `scene3dAnimation` document root. */
export function buildMotionScene3DAnimationDefinitions(): Record<string, unknown> {
  const id = { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$" };
  const color = { type: "string", pattern: "^#[0-9A-Fa-f]{6}$" };
  const vector = (minimum: number, maximum: number) => ({ type: "array", minItems: 3, maxItems: 3, items: { type: "number", minimum, maximum } });
  const number = (minimum: number, maximum: number) => ({ type: "number", minimum, maximum });
  const camera = {
    type: "object", required: ["layerId", "scope", "property"], additionalProperties: false,
    properties: { layerId: id, scope: { const: "camera" }, property: { enum: ["position", "target", "fovDeg"] } },
  };
  const lighting = {
    type: "object", required: ["layerId", "scope", "property"], additionalProperties: false,
    properties: { layerId: id, scope: { const: "lighting" }, property: { enum: ["ambient", "direction", "intensity", "color"] } },
  };
  const object = {
    type: "object", required: ["layerId", "scope", "objectId", "property"], additionalProperties: false,
    properties: { layerId: id, scope: { const: "object" }, objectId: id, property: { enum: ["position", "rotationDeg", "scale", "emissive", "color"] } },
  };
  const background = {
    type: "object", required: ["layerId", "scope", "property"], additionalProperties: false,
    properties: { layerId: id, scope: { const: "background" }, property: { const: "color" } },
  };
  return {
    motionScene3dAnimation: {
      type: "object", required: ["schema", "tracks"], additionalProperties: false,
      properties: {
        schema: { const: MOTION_SCENE3D_ANIMATION_SCHEMA },
        tracks: { type: "array", minItems: 1, maxItems: MAX_MOTION_SCENE3D_ANIMATION_TRACKS, items: { $ref: "#/$defs/motionScene3dAnimationTrack" } },
      },
      $comment: "Runtime enforces aggregate keyframe/work/input bounds, unique ids and locators, exact ascending microsecond times, document-time bounds, existing static scene authority, and transform-driver exclusivity.",
    },
    motionScene3dAnimationTrack: {
      type: "object", required: ["id", "locator", "keyframes"], additionalProperties: false,
      properties: {
        id,
        locator: { oneOf: [camera, lighting, object, background] },
        keyframes: { type: "array", minItems: 1, maxItems: MAX_MOTION_SCENE3D_ANIMATION_KEYFRAMES_PER_TRACK, items: { $ref: "#/$defs/motionScene3dAnimationKeyframe" } },
      },
    },
    motionScene3dAnimationKeyframe: {
      type: "object", required: ["atUs", "value"], additionalProperties: false,
      properties: {
        atUs: { type: "integer", minimum: 0, maximum: MAX_MOTION_SCENE3D_ANIMATION_TIME_US },
        value: {
          anyOf: [
            color,
            vector(...SCENE_3D_CONTROL_BOUNDS.position),
            vector(...SCENE_3D_CONTROL_BOUNDS.rotationDeg),
            vector(...SCENE_3D_CONTROL_BOUNDS.lightingDirection),
            number(...SCENE_3D_CONTROL_BOUNDS.cameraFovDeg),
            number(...SCENE_3D_CONTROL_BOUNDS.lightingAmbient),
            number(...SCENE_3D_CONTROL_BOUNDS.lightingIntensity),
            number(...SCENE_3D_CONTROL_BOUNDS.scale),
            number(...SCENE_3D_CONTROL_BOUNDS.emissive),
          ],
        },
        easing: { $ref: "#/$defs/easing" },
      },
      $comment: "Runtime binds value kind and exact bounds to the locator, rejects zero lighting direction, and uses the shared easing and color authorities.",
    },
  };
}
