/**
 * Motion-document entry points must inspect this optional root without invoking
 * a caller-owned accessor before generic object enumeration begins.
 */
export function motionScene3DAnimationRootPreflight(value: unknown): { path: "/scene3dAnimation"; message: string } | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  let descriptor: PropertyDescriptor | undefined;
  try { descriptor = Object.getOwnPropertyDescriptor(value, "scene3dAnimation"); }
  catch { return { path: "/scene3dAnimation", message: "descriptor reflection failed" }; }
  if (!descriptor || ("value" in descriptor && descriptor.enumerable)) return undefined;
  return { path: "/scene3dAnimation", message: "must be an enumerable data property; accessors are not accepted" };
}

export function isMotionPublishedSchema(schema: Record<string, unknown>): boolean {
  return schema.$id === "shellx-motion/motion@1";
}
