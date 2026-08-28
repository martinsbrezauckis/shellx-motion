/**
 * Opaque renderer handoff for a Core-owned private output reservation.
 *
 * A `DerivedOutputPublication` is deliberately not part of any exported Browser/GPU
 * render-option shape.  The owning CLI may attach a Core-minted reservation to the
 * exact options object it passes to this renderer, but structural JavaScript objects
 * cannot manufacture that authority or survive a clone/prototype substitution.
 */
import type { DerivedOutputPublication } from "@shellx-motion/core";
import { isCoreDerivedOutputPublication } from "@shellx-motion/core/internal/derived-output-publication-authenticity";

const publications = new WeakMap<object, DerivedOutputPublication>();
const LEGACY_FIELDS = ["privateOutputPublication", "privateArtifactPublication"] as const;

export function withRendererPrivateOutputPublication<T extends object>(
  options: T,
  publication: DerivedOutputPublication
): T {
  assertNoStructuralPrivatePublication(options);
  if (!isCoreDerivedOutputPublication(publication)) {
    throw new Error("Renderer private output publication requires a Core-minted publication.");
  }
  const capability = Object.assign({}, options);
  publications.set(capability, publication);
  return capability;
}

/** Resolve only the exact renderer-owned options object minted above. */
export function resolveRendererPrivateOutputPublication(value: unknown): DerivedOutputPublication | undefined {
  return value && typeof value === "object" ? publications.get(value) : undefined;
}

/**
 * Legacy structural fields are actively refused (including inherited fields), rather
 * than silently ignored.  That makes an installed JavaScript caller's attempted
 * private-stage handoff fail before browser/GPU resource work or output writes.
 */
export function assertNoStructuralPrivatePublication(value: unknown): void {
  if (!value || typeof value !== "object") return;
  for (const field of LEGACY_FIELDS) {
    if (field in value) {
      throw new Error(`Renderer private output publication must be a renderer-minted capability; structural ${field} is refused.`);
    }
  }
}
