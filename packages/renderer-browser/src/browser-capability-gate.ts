import {
  BROWSER_CAPABILITY,
  isAudioOnlyFrameLaneUnsupported,
  matchRendererCapability,
  type MotionPackage,
} from "@shellx-motion/core";

/** Fail closed before launch when the browser frame lane would drop visual content. */
export function assertBrowserLaneCapability(pkg: MotionPackage): void {
  const capability = matchRendererCapability(pkg.motion, BROWSER_CAPABILITY);
  if (capability.ok) return;
  const blocking = capability.unsupported.filter((item) => !isAudioOnlyFrameLaneUnsupported(item.feature));
  if (blocking.length === 0) return;
  const unsupportedLayerCount = new Set(blocking.map((item) => item.layerId)).size;
  throw new Error(
    `Browser lane cannot render ${blocking.length} unsupported ${blocking.length === 1 ? "feature" : "features"} `
    + `across ${unsupportedLayerCount} ${unsupportedLayerCount === 1 ? "layer" : "layers"}: `
    + `${blocking.map((item) => item.reason).join("; ")}`,
  );
}
