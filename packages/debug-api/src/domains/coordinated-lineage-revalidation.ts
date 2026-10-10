/** Coordinator-only stable-source guard kept outside public render request vocabulary. */
export type CoordinatedLineageRevalidation = () => Promise<void>;

export async function coordinatedLineageRevalidationFailure(
  revalidate: CoordinatedLineageRevalidation | undefined,
): Promise<{ code: "render_failed"; message: string } | undefined> {
  if (!revalidate) return undefined;
  try {
    await revalidate();
    return undefined;
  } catch (error) {
    return {
      code: "render_failed",
      message: error instanceof Error ? error.message : "Coordinated render package lineage could not be revalidated.",
    };
  }
}
