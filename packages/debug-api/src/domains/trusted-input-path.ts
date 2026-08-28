export async function isInsideAnyTrustedInputRoot(
  path: string,
  roots: string[],
  contains: (root: string, path: string) => Promise<boolean>,
): Promise<boolean> {
  for (const root of roots) if (await contains(root, path)) return true;
  return false;
}
