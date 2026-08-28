import { canonicalJsonSha256 } from "./canonical-json";
import { compileMotionLayoutInstance, expandMotionLayoutSlots, solveMotionLayout } from "./motion-layout-solver";
import {
  MAX_MOTION_LAYOUT_DIMENSION,
  MAX_MOTION_LAYOUT_ROTATION,
  MOTION_LAYOUT_PLAN_SCHEMA,
  type MotionLayoutCompiledInstance,
  type MotionLayoutCompileResult,
  type MotionLayoutOwnershipInput,
} from "./motion-layout-types";
import { validateMotionLayoutCompileRequest } from "./motion-layout-validate";
import { issue } from "./motion-layout-safety";

export * from "./motion-layout-types";
export { validateMotionLayoutCompileRequest } from "./motion-layout-validate";

/**
 * Expand bounded repeaters, solve the selected layout, and emit only ordinary child transform
 * intent. This pure function neither mutates the request nor creates a document structure.
 */
export function compileMotionLayout(value: unknown): MotionLayoutCompileResult {
  const validation = validateMotionLayoutCompileRequest(value);
  if (!validation.ok) return { status: "refused", issues: validation.issues };
  const slots = expandMotionLayoutSlots(validation.request.children, validation.request.repeaters);
  const boxes = solveMotionLayout(validation.request.layout, slots);
  const instances = slots.map((slot, index) => compileMotionLayoutInstance(validation.request.layout, boxes[index], slot));
  const compiledIssue = compiledTransformIssue(instances);
  if (compiledIssue) return { status: "refused", issues: [compiledIssue] };
  return {
    status: "ok",
    plan: {
      schema: MOTION_LAYOUT_PLAN_SCHEMA,
      ownership: copyOwnership(validation.request.ownership),
      ownershipJoin: "external-adapter-required",
      instances,
      budget: validation.budget,
      fingerprintInput: validation.fingerprintInput,
      fingerprint: canonicalJsonSha256(validation.request),
    },
  };
}

function compiledTransformIssue(instances: MotionLayoutCompiledInstance[]) {
  for (const [index, instance] of instances.entries()) {
    const { x, y, rotation } = instance.transform;
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < -MAX_MOTION_LAYOUT_DIMENSION || x > MAX_MOTION_LAYOUT_DIMENSION
      || y < -MAX_MOTION_LAYOUT_DIMENSION || y > MAX_MOTION_LAYOUT_DIMENSION) {
      return issue(`/instances/${index}/transform`, "compiled.position", "resolved x and y must remain within layout coordinate bounds");
    }
    if (!Number.isFinite(rotation) || rotation < -MAX_MOTION_LAYOUT_ROTATION || rotation > MAX_MOTION_LAYOUT_ROTATION) {
      return issue(`/instances/${index}/transform/rotation`, "compiled.rotation", "resolved rotation must remain within layout rotation bounds");
    }
  }
  return null;
}

function copyOwnership(ownership: MotionLayoutOwnershipInput): MotionLayoutOwnershipInput {
  return { schema: ownership.schema, ownerId: ownership.ownerId, childIds: [...ownership.childIds] };
}
