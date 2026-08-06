import { CUT_EDITABLE_RECEIVER_SLICE } from "@shellx-motion/adapters-cut";
import type { CutImportMode, CutTargetCapabilities } from "@shellx-motion/adapters-cut";

export type CutImportModeRequest = CutImportMode | "auto";

export const SHELLX_CUT_LOWERABLE_LAYER_TYPES = ["text", "shape", "video", "audio"] as const;

export const SHELLX_CUT_LOWERABLE_FEATURES = [
  "document.background",
  "layer.opacity",
  "keyframe.opacity",
  "keyframe.transform.x",
  "keyframe.transform.y",
  "transition.fade",
  "video.trim",
  "audio.trim",
  "shape.rect",
  "shape.rounded-rect",
  "shape.ellipse",
  "shape.circle",
  "shape.line",
  "shape.stroke",
  "shape.radius"
] as const;

export function readCutImportModeRequest(value: string): CutImportModeRequest | null {
  if (value === "auto") return "auto";
  if (value === "editable_lowering") return "editable_lowering";
  if (value === "live_overlay") return "live_overlay";
  if (value === "rendered_media") return "rendered_media";
  return null;
}

export function cutTargetCapabilitiesForMode(input: {
  targetId: string;
  mode: CutImportModeRequest;
}): CutTargetCapabilities {
  return {
    targetId: input.targetId,
    modes: input.mode === "auto" ? ["editable_lowering", "rendered_media"] : [input.mode],
    lowerableLayerTypes: [...SHELLX_CUT_LOWERABLE_LAYER_TYPES],
    lowerableFeatures: [...SHELLX_CUT_LOWERABLE_FEATURES],
    // Every real ShellX Cut target runs the allow-list editable receiver, so a plan is checked
    // against the exact field set Cut accepts before it claims editable_lowering.
    editableReceiver: CUT_EDITABLE_RECEIVER_SLICE
  };
}
