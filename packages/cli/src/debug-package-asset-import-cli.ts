/** CLI projection for the general copy-on-write package asset import command. */
export function debugPackageAssetImportArgs(
  argv: string[],
  packageRoot: (argv: string[]) => string | undefined,
  option: (argv: string[], name: string) => string | undefined,
): Record<string, unknown> {
  return {
    packageRoot: packageRoot(argv), outDir: option(argv, "--out") ?? option(argv, "--package-dir"),
    assetPath: option(argv, "--asset") ?? option(argv, "--source") ?? option(argv, "--asset-path"), assetRef: option(argv, "--asset-ref"),
    receiptsRoot: option(argv, "--receipts-root"), createdBy: option(argv, "--created-by"), createdAt: option(argv, "--created-at"),
  };
}
