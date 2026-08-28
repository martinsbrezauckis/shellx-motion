import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

/** Maps only publication-owned paths after their verified stage has become public. */
export function remapPublicationPaths(value: unknown, stagingPath: string, outputPath: string, qualityDirectory?: string): void {
  if (typeof value !== "object" || value === null) return;
  const record = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(record)) {
    if (typeof child === "string") record[key] = remapPublicationPath(child, stagingPath, outputPath, qualityDirectory);
    else remapPublicationPaths(child, stagingPath, outputPath, qualityDirectory);
  }
}

function remapPublicationPath(path: string, stagingPath: string, outputPath: string, qualityDirectory?: string): string {
  if (path === stagingPath) return outputPath;
  const descendant = relative(stagingPath, path);
  if (descendant && descendant !== ".." && !descendant.startsWith(`..${sep}`) && !isAbsolute(descendant)) return join(outputPath, descendant);
  return remapStageDerivedQualityFrame(path, stagingPath, outputPath, qualityDirectory);
}

function remapStageDerivedQualityFrame(path: string, stagingPath: string, outputPath: string, qualityDirectory?: string): string {
  if (!qualityDirectory || dirname(path) !== qualityDirectory) return path;
  const [stagingStem, outputStem] = [publicationPathStem(stagingPath), publicationPathStem(outputPath)];
  const name = basename(path);
  return name.startsWith(`${stagingStem}-`) && name.endsWith("-frame.png")
    ? join(qualityDirectory, `${outputStem}${name.slice(stagingStem.length)}`)
    : path;
}

function publicationPathStem(path: string): string {
  const name = basename(path);
  const extensionStart = name.lastIndexOf(".");
  return extensionStart > 0 ? name.slice(0, extensionStart) : name;
}
