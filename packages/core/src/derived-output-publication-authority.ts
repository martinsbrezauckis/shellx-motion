/** Process-local provenance for publications created by Core's private constructor. */
const mintedPublications = new WeakSet<object>();

export function rememberCoreDerivedOutputPublication(publication: object): void {
  mintedPublications.add(publication);
}

export function isRememberedCoreDerivedOutputPublication(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && mintedPublications.has(value));
}
