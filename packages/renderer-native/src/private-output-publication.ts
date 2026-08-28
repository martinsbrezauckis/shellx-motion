/**
 * Opaque Native renderer handoff for a Core-owned private output reservation.
 *
 * The public Native options contain no structural publication object.  A trusted
 * renderer host attaches an authentic Core reservation to one exact input object;
 * the renderer resolves it from this process-local WeakMap before any private write.
 */
import type { DerivedOutputPublication } from "@shellx-motion/core";
import { isCoreDerivedOutputPublication } from "@shellx-motion/core/internal/derived-output-publication-authenticity";

const publications = new WeakMap<object, DerivedOutputPublication>();
const LEGACY_FIELD = "privateOutputPublication";

export function withNativePrivateOutputPublication<T extends object>(
  input: T,
  publication: DerivedOutputPublication
): T {
  assertNoStructuralNativePrivatePublication(input);
  if (!isCoreDerivedOutputPublication(publication)) {
    throw new Error("Native private output publication requires a Core-minted publication.");
  }
  const capability = Object.assign({}, input);
  publications.set(capability, publication);
  return capability;
}

/** Resolve only a capability minted above; plain objects and prototypes cannot resolve. */
export function resolveNativePrivateOutputPublication(value: unknown): DerivedOutputPublication | undefined {
  return value && typeof value === "object" ? publications.get(value) : undefined;
}

/** Refuse legacy own or inherited structural publication fields at public entry points. */
export function assertNoStructuralNativePrivatePublication(value: unknown): void {
  if (value && typeof value === "object" && LEGACY_FIELD in value) {
    throw new Error("Native private output publication must be a renderer-minted capability; structural privateOutputPublication is refused.");
  }
}
