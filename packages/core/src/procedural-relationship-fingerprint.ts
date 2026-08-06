import { canonicalJsonSha256 } from "./canonical-json";
import type { MotionProceduralGraph } from "./procedural-relationship-types";

/**
 * Canonical graph identity independent of JSON object key ordering, host locale, and ICU build.
 *
 * Serialization is delegated to `canonicalJsonSha256` rather than reimplemented here. The local
 * copy this replaced was byte-compatible, but keeping it meant the rule had two implementations
 * to stay true in — and the five other copies that existed alongside it did NOT all stay true.
 */
export function proceduralRelationshipGraphFingerprint(graph: MotionProceduralGraph): string {
  return canonicalJsonSha256(graph);
}
