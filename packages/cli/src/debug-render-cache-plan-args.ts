/** Compact CLI argument projection for the non-mutating v2 render-cache observation. */
export function debugRenderCachePlanArgs(
  argv: string[],
  packageRoot: (argv: string[]) => string | undefined,
  option: (argv: string[], name: string) => string | undefined,
  resolveInput: (value: string) => string,
): Record<string, unknown> {
  const atMs = option(argv, "--at-ms");
  const minUniqueFrameHashes = option(argv, "--min-unique-frames") ?? option(argv, "--min-unique-frame-hashes");
  const workflowPath = option(argv, "--workflow") ?? option(argv, "--workflow-path");
  const qualityManifestPath = option(argv, "--quality-manifest") ?? option(argv, "--quality-manifest-path");
  return {
    packageRoot: packageRoot(argv),
    outputPath: option(argv, "--output") ?? option(argv, "--output-path") ?? option(argv, "--out"),
    frameLane: option(argv, "--frame-lane"), preset: option(argv, "--preset"),
    ...(atMs !== undefined ? { atMs: Number(atMs) } : {}),
    ...(minUniqueFrameHashes !== undefined ? { minUniqueFrameHashes: Number(minUniqueFrameHashes) } : {}),
    ...(workflowPath ? { workflowPath: resolveInput(workflowPath) } : {}),
    ...(qualityManifestPath ? { qualityManifestPath: resolveInput(qualityManifestPath) } : {}),
  };
}
