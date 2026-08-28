/** Native PNG materialization through Core's verified no-clobber authority. */
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { acquireDerivedOutputPublication, type DerivedOutputPublication } from "@shellx-motion/core";
import { isCoreDerivedOutputPublication } from "@shellx-motion/core/internal/derived-output-publication-authenticity";

export async function publishNativeOutput(
  outputPath: string,
  png: Buffer,
  privateOutputPublication?: DerivedOutputPublication
): Promise<string> {
  if (privateOutputPublication) {
    if (!isCoreDerivedOutputPublication(privateOutputPublication)) {
      throw new Error("Native private output publication requires a Core-minted publication.");
    }
    if (resolve(outputPath) !== resolve(privateOutputPublication.stagingPath)) {
      throw new Error("Native private output publication does not match the requested staging path.");
    }
    await writeFile(privateOutputPublication.stagingPath, png);
    return (await privateOutputPublication.verifyFile()).sha256;
  }
  const publication = await acquireDerivedOutputPublication({ outputPath, kind: "file" });
  try {
    await writeFile(publication.stagingPath, png);
    const evidence = await publication.verifyFile();
    await publication.publishFile(evidence);
    return evidence.sha256;
  } catch (error) {
    await publication.abort();
    throw error;
  }
}
