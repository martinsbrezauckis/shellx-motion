/**
 * Capability-card facts required before a renderer can describe its typography faithfully.
 *
 * Browser has only manifest-bound fallback-attestation proof today. A new renderer (including GPU)
 * must not borrow that narrower claim: it needs its own complete shaping proof before listing text.
 */
export interface RendererTypographyCapability {
  mode: "manifest-bound-fallback-attested" | "manifest-bound-shaping" | "block-glyph-preview";
  /** Required for browser/fallback or full shaping: bytes originate from package-declared font assets. */
  fontProvenance?: "manifest-bound";
  /** Required for browser/fallback or full shaping: the runtime waits for declared faces before capture. */
  fontLoading?: "runtime-verified";
  /** Required for browser/fallback or full shaping: fallback is observed rather than inferred. */
  fallbackEvidence?: "metric-probe";
  /** Full shaping requires an executable manifest-font complex-script conformance fixture. */
  complexShaping?: "fixture-proven";
  /** Stable fixture identifiers; a new lane must add its own proof rather than borrow a claim. */
  conformanceFixtureIds: string[];
}
