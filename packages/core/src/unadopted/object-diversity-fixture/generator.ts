import type { MotionDocument } from "../../types";
import { OBJECT_DIVERSITY_SOURCE } from "./object-diversity-fixture";

/**
 * Produces an independent, deterministic Motion value from the checked-in
 * source fixture. `structuredClone` preserves only ordinary data here and
 * prevents a caller from changing the canonical source for a later request.
 */
export function generateObjectDiversityFixture(): MotionDocument {
  return structuredClone(OBJECT_DIVERSITY_SOURCE);
}
