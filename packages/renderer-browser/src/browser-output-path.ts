import { join, resolve } from "node:path";
import { isPathInsideOrEqual } from "./browser-package-safety";

export type BrowserOutputFormat = "png" | "jpeg";

export function browserScreenshotOptions(path: string, format: BrowserOutputFormat | undefined) {
  return {
    path,
    animations: "disabled" as const,
    caret: "hide" as const,
    ...(format ? { type: format } : {}),
    ...(format === "jpeg" ? { quality: 92 } : { omitBackground: true })
  };
}

export function browserOutputPathFor(
  pkg: { manifest: { id: string } },
  options: { atMs: number; outDir: string; outputPath?: string; format?: BrowserOutputFormat },
  authenticatedPrivateRoot?: string
): string {
  const extension = options.format === "jpeg" ? "jpg" : "png";
  const outputPath = resolve(options.outputPath ?? join(options.outDir, `${pkg.manifest.id}-browser-${options.atMs}.${extension}`));
  if (!isPathInsideOrEqual(options.outDir, outputPath)
    && !(authenticatedPrivateRoot && isPathInsideOrEqual(authenticatedPrivateRoot, outputPath))) {
    throw new Error("Browser output path must be inside outDir or its authenticated private publication root.");
  }
  return outputPath;
}
