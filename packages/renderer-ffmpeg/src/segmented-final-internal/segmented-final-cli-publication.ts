/**
 * The CLI alone may defer the final segmented bytes into a governed private stage. A WeakMap
 * capability keeps that authority out of the public segmented-final request shape: structural
 * objects supplied by JavaScript callers never resolve to a Core publication.
 */
import type { DerivedOutputPublication } from "@shellx-motion/core";
import { isCoreDerivedOutputPublication } from "@shellx-motion/core/internal/derived-output-publication-authenticity";

const publications = new WeakMap<object, DerivedOutputPublication>();

/** Attach an opaque renderer-internal delivery capability without widening the public input. */
export function withSegmentedFinalCliPublication<T extends object>(
  input: T,
  publication: DerivedOutputPublication
): T {
  if (!isCoreDerivedOutputPublication(publication)) {
    throw new Error("Segmented final deferred delivery requires a Core-minted publication.");
  }
  const capability = Object.freeze({});
  publications.set(capability, publication);
  return Object.assign({}, input, { privateOutputPublication: capability }) as T;
}

/** Resolve only a capability minted above; arbitrary `{ outputPath, stagingPath }` objects fail. */
export function resolveSegmentedFinalCliPublication(value: unknown): DerivedOutputPublication | undefined {
  return value && typeof value === "object" ? publications.get(value) : undefined;
}
