/** Internal-only authenticity proof for consumers that need a Core-minted publication object. */
import type { DerivedOutputPublication } from "./derived-output-publication.js";
import { isRememberedCoreDerivedOutputPublication } from "./derived-output-publication-authority.js";

export function isCoreDerivedOutputPublication(value: unknown): value is DerivedOutputPublication {
  return isRememberedCoreDerivedOutputPublication(value);
}
