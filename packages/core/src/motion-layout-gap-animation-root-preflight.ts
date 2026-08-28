/** Descriptor-only C2 root guard that runs before generic object enumeration. */
export function motionLayoutGapAnimationRootPreflight(value: unknown): { path: "/layoutGapAnimation"; message: string } | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  let descriptor: PropertyDescriptor | undefined;
  try { descriptor = Object.getOwnPropertyDescriptor(value, "layoutGapAnimation"); }
  catch { return { path: "/layoutGapAnimation", message: "descriptor reflection failed" }; }
  if (!descriptor || ("value" in descriptor && descriptor.enumerable)) return undefined;
  return { path: "/layoutGapAnimation", message: "must be an enumerable data property; accessors are not accepted" };
}
