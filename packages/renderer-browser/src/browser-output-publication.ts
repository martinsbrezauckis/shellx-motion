/** Renderer-owned PNG/HTML materialization through Core's private staging authority. */
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  acquireDerivedOutputPublication,
  writeVerifiedBoundedFile,
  type DerivedOutputPublication
} from "@shellx-motion/core";
import { isCoreDerivedOutputPublication } from "@shellx-motion/core/internal/derived-output-publication-authenticity";

const MAX_BROWSER_PRIVATE_OUTPUT_BYTES = 512 * 1024 * 1024;

export async function publishBrowserOutput(
  outputPath: string,
  bytes: Buffer,
  privateOutputPublication?: DerivedOutputPublication
): Promise<string> {
  if (privateOutputPublication) {
    if (!isCoreDerivedOutputPublication(privateOutputPublication)) {
      throw new Error("Browser private output publication requires a Core-minted publication.");
    }
    return await writePrivateBrowserOutput(outputPath, bytes, privateOutputPublication);
  }

  const publication = await acquireDerivedOutputPublication({ outputPath, kind: "file" });
  try {
    await writePrivateBrowserOutput(publication.stagingPath, bytes, publication);
    const evidence = await publication.verifyFile();
    await publication.publishFile(evidence);
    return evidence.sha256;
  } catch (error) {
    await publication.abort();
    throw error;
  }
}

/**
 * A file reservation owns exactly its private leaf; HTML may use only its separately issued,
 * Core-private companion root. A directory reservation is intentionally narrower than a general
 * output directory: the renderer may create only a strict child under the Core-minted stage. The
 * bounded writer pins the whole private route, creates a 0600 leaf exclusively without following
 * links, and re-opens it for a stable hash before the renderer reports any receipt evidence.
 */
async function writePrivateBrowserOutput(
  outputPath: string,
  bytes: Buffer,
  publication: DerivedOutputPublication
): Promise<string> {
  const stagePath = resolve(publication.stagingPath);
  const requestedPath = resolve(outputPath);
  if (publication.kind === "file") {
    if (requestedPath !== stagePath) {
      return (await publication.writePrivateCompanionFile(requestedPath, bytes, {
        label: "Browser private file companion output",
        maxBytes: MAX_BROWSER_PRIVATE_OUTPUT_BYTES
      })).sha256;
    }
    return (await publication.writePrivateFile(bytes, {
      label: "Browser private file output",
      maxBytes: MAX_BROWSER_PRIVATE_OUTPUT_BYTES
    })).sha256;
  }

  if (!strictChildPath(stagePath, requestedPath)) {
    throw new Error("Browser private directory output publication must be a strict child of its governed staging directory.");
  }
  return (await writeVerifiedBoundedFile(requestedPath, bytes, {
    label: "Browser private directory output",
    maxBytes: MAX_BROWSER_PRIVATE_OUTPUT_BYTES,
    withinRoot: stagePath
  })).sha256;
}

function strictChildPath(root: string, path: string): boolean {
  const child = relative(root, path);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}
