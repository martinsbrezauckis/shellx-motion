/** Every optional hostile-data root must be descriptor-checked before generic enumeration. */
import { motionLayoutGapAnimationRootPreflight } from "./motion-layout-gap-animation-root-preflight";
import { motionScene3DAnimationRootPreflight } from "./motion-scene3d-animation-root-preflight";

export function motionDocumentRootPreflight(value: unknown): { path: string; message: string } | undefined {
  return motionScene3DAnimationRootPreflight(value) ?? motionLayoutGapAnimationRootPreflight(value);
}
