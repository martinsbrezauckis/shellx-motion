/**
 * Publish CLI-generated JSON sidecars without treating a caller-selected output directory as
 * continuing authority. Preview/capture frames have their own publication paths; their receipts
 * and workflow traces need the same no-follow, no-clobber transaction before we advertise them.
 */
import { writeFile } from "node:fs/promises";
import { acquireDerivedOutputPublication } from "@shellx-motion/core";

export interface JsonSidecarPublicationOptions {
  /**
   * Internal deterministic-test seam. The CLI never supplies this; it proves that a parent
   * replacement after staging is refused before the sidecar gains its public name.
   */
  afterStageVerified?: () => Promise<void> | void;
}

export async function publishJsonSidecar(
  outputPath: string,
  value: unknown,
  options: JsonSidecarPublicationOptions = {}
): Promise<void> {
  const publication = await acquireDerivedOutputPublication({ outputPath, kind: "file" });
  try {
    await writeFile(publication.stagingPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    const evidence = await publication.verifyFile();
    await options.afterStageVerified?.();
    await publication.publishFile(evidence);
  } catch (error) {
    await publication.abort();
    throw error;
  }
}

/** Classifies optional template media before it is recorded in a published CLI sidecar. */
export function mediaTypeForPath(path: string): string | undefined {
  const lower = path.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".mov")) return "video/quicktime";
  return undefined;
}
