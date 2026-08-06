/**
 * Timeline animation-preset and easing catalog for ShellX Motion.
 *
 * Role: the "presets" slice of the timeline domain — the animation preset types, the named-easing list,
 * the easing-preset catalog (MOTION_EASING_PRESETS), and the animation-preset catalog
 * (MOTION_ANIMATION_PRESETS) with its id lookup. Extracted verbatim from `timeline.ts` so the timeline
 * model and mutation logic no longer carry the static preset data, satisfying the module-size architecture gate.
 * Types + data only, no runtime logic; behavior is unchanged.
 *
 * Dependencies: the `MotionEasing` and `MotionKeyframeTarget` types from `./types`.
 *
 * Primary callers: `packages/core/src/timeline.ts` (preset application, easing validation, easing-preset
 * listing), which re-exports the public preset types/list so `@shellx-motion/core` consumers are unchanged.
 */
import type { MotionEasing, MotionKeyframeTarget } from "./types";

export type MotionAnimationPresetId =
  | "fade-in"
  | "fade-out"
  | "slide-up-in"
  | "slide-down-out"
  | "lower-third-in"
  | "lower-third-out";

export type MotionAnimationPresetKind = "entrance" | "exit" | "emphasis";

export interface MotionAnimationPreset {
  id: MotionAnimationPresetId;
  name: string;
  kind: MotionAnimationPresetKind;
  targets: MotionKeyframeTarget[];
  defaultDurationMs: number;
  defaultDistancePx?: number;
  easing: MotionEasing;
  description: string;
}

export interface MotionEasingPreset {
  id: string;
  name: string;
  easing: MotionEasing;
  kind: "named" | "cubic-bezier" | "steps" | "spring";
  description: string;
}

/**
 * Named easing identifiers accepted by {@link isSupportedEasing} (alongside the parametric
 * `cubic-bezier(...)` and `steps(...)` forms). Exported so the published motion schema's easing
 * enum can be pinned to the validator's real set by the schema drift test.
 */
export const NAMED_EASINGS_LIST = [
  "linear", "hold", "ease-in", "ease-out", "ease-in-out", "back-out", "bounce-out", "step-start", "step-end"
] as const;
export const NAMED_EASINGS = new Set<string>(NAMED_EASINGS_LIST);
export const MOTION_EASING_PRESETS: MotionEasingPreset[] = [
  { id: "linear", name: "Linear", easing: "linear", kind: "named", description: "Constant interpolation." },
  { id: "hold", name: "Hold", easing: "hold", kind: "named", description: "Hold the previous value until the next keyframe." },
  { id: "ease-in", name: "Ease In", easing: "ease-in", kind: "named", description: "Slow start with faster finish." },
  { id: "ease-out", name: "Ease Out", easing: "ease-out", kind: "named", description: "Fast start with slower finish." },
  { id: "ease-in-out", name: "Ease In Out", easing: "ease-in-out", kind: "named", description: "Smooth acceleration and deceleration." },
  { id: "back-out", name: "Back Out", easing: "back-out", kind: "named", description: "Overshoot the target slightly before settling." },
  { id: "bounce-out", name: "Bounce Out", easing: "bounce-out", kind: "named", description: "Decelerate with a landing bounce." },
  { id: "smooth", name: "Smooth", easing: "cubic-bezier(0.16, 1, 0.3, 1)", kind: "cubic-bezier", description: "Soft motion with a gentle settle." },
  { id: "snappy", name: "Snappy", easing: "cubic-bezier(0.2, 0.8, 0.2, 1)", kind: "cubic-bezier", description: "Responsive UI-style motion." },
  { id: "step-start", name: "Step Start", easing: "step-start", kind: "steps", description: "Jump to the next value at the start of the segment." },
  { id: "step-end", name: "Step End", easing: "step-end", kind: "steps", description: "Hold the current value until the end of the segment." },
  { id: "steps-4-end", name: "Steps 4 End", easing: "steps(4, end)", kind: "steps", description: "Four discrete timeline steps with end-aligned jumps." },
  { id: "spring-gentle", name: "Spring Gentle", easing: "spring-gentle", kind: "spring", description: "Near-critical damped spring; smooth settle with no perceptible overshoot." },
  { id: "spring-snappy", name: "Spring Snappy", easing: "spring-snappy", kind: "spring", description: "Quick damped spring with a small confident overshoot." },
  { id: "spring-bouncy", name: "Spring Bouncy", easing: "spring-bouncy", kind: "spring", description: "Under-damped spring with pronounced overshoot and visible bounce." }
];
export const MOTION_ANIMATION_PRESETS: MotionAnimationPreset[] = [
  {
    id: "fade-in",
    name: "Fade In",
    kind: "entrance",
    targets: ["opacity"],
    defaultDurationMs: 300,
    easing: "ease-out",
    description: "Fade a layer from transparent to its current opacity."
  },
  {
    id: "fade-out",
    name: "Fade Out",
    kind: "exit",
    targets: ["opacity"],
    defaultDurationMs: 300,
    easing: "ease-in",
    description: "Fade a layer from its current opacity to transparent."
  },
  {
    id: "slide-up-in",
    name: "Slide Up In",
    kind: "entrance",
    targets: ["transform.y"],
    defaultDurationMs: 350,
    defaultDistancePx: 48,
    easing: "ease-out",
    description: "Move a layer upward from below into its current y position."
  },
  {
    id: "slide-down-out",
    name: "Slide Down Out",
    kind: "exit",
    targets: ["transform.y"],
    defaultDurationMs: 350,
    defaultDistancePx: 48,
    easing: "ease-in",
    description: "Move a layer downward from its current y position."
  },
  {
    id: "lower-third-in",
    name: "Lower Third In",
    kind: "entrance",
    targets: ["opacity", "transform.y"],
    defaultDurationMs: 400,
    defaultDistancePx: 48,
    easing: "ease-out",
    description: "Fade and slide a lower-third layer up into place."
  },
  {
    id: "lower-third-out",
    name: "Lower Third Out",
    kind: "exit",
    targets: ["opacity", "transform.y"],
    defaultDurationMs: 300,
    defaultDistancePx: 48,
    easing: "ease-in",
    description: "Fade and slide a lower-third layer down out of frame."
  }
];
export const MOTION_ANIMATION_PRESET_BY_ID = new Map(MOTION_ANIMATION_PRESETS.map((preset) => [preset.id, preset]));
