/**
 * Exact browser features consumed by the runtime capability gate.
 *
 * Keep this list concrete: a wildcard in agent-readable metadata is an unsupported-feature
 * promise until a conformance test proves every expansion. Fixed keyframe entries come from the
 * same vocabulary the evaluator accepts; volume and pan remain absent because browser capture
 * hands audio to the downstream encoder rather than mixing it into pixels.
 */
import { SUPPORTED_KEYFRAME_TARGET_LIST } from "./keyframe-targets";

const BROWSER_KEYFRAME_FEATURES = SUPPORTED_KEYFRAME_TARGET_LIST
  .filter((target) => target !== "volume" && target !== "pan")
  .map((target) => `keyframe.${target}`);

export const PARTICLE_RENDER_FEATURES = ["particles.seeded", "particles.analytic-field"] as const;

export const BROWSER_RENDER_FEATURES = [
  "shape.rect", "shape.rounded-rect", "shape.ellipse", "shape.triangle", "shape.star",
  "shape.path", "shape.path.curve", "shape.path.reveal", "shape.stroke", "shape.radius", "shape.gradient",
  "image.crop", "image.fit.none", "image.fit.scale-down",
  "video.crop", "video.fit.none", "video.fit.scale-down", "video.trim", "video.loop", "video.playbackRate",
  "transform.rotation", "transform.origin",
  ...BROWSER_KEYFRAME_FEATURES,
  "keyframe.shader.uniform",
  "style.shadow", "style.textShadow",
  "text.direction", "text.shaping.complex", "text.charset.non-ascii", "text.font.family", "text.runs.v1",
  "mask.rect", "mask.rounded-rect", "mask.path", "mask.roto", "mask.roto.tracked",
  "keying.chroma", "matte.alpha", "matte.alpha-inverted", "matte.luma", "matte.luma-inverted",
  "blend.multiply", "blend.screen", "blend.overlay", "blend.darken", "blend.lighten",
  "blend.color-dodge", "blend.color-burn", "blend.hard-light", "blend.soft-light", "blend.difference",
  "blend.exclusion", "blend.hue", "blend.saturation", "blend.color", "blend.luminosity", "blend.plus-lighter",
  "effect.blur", "effect.brightness", "effect.contrast", "effect.saturate", "effect.grayscale",
  "effect.glow", "effect.motionBlur", "effect.vignette", "effect.filmGrain", "effect.trail",
  "transition.fade", "transition.slide", "transition.wipe",
  ...PARTICLE_RENDER_FEATURES, "points.viewport-batched", "camera.2d", "camera.depth", "shader.restricted-glsl",
  "scene3d.fixed-primitives", "scene3d.gltf-mesh",
  "environment.rain.fixed-simulation", "environment.water.fixed-simulation",
  "environment.snow.fixed-simulation", "environment.fog.fixed-simulation"
] as const;
