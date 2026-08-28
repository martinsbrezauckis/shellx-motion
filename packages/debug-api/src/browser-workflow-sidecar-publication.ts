/** Publish Debug browser-workflow evidence through Core's identity-bound no-clobber transaction. */
import { writeFile } from "node:fs/promises";
import { acquireDerivedOutputPublication } from "@shellx-motion/core";

export async function publishBrowserWorkflowJsonSidecar(outputPath: string, value: unknown): Promise<void> {
  const publication = await acquireDerivedOutputPublication({ outputPath, kind: "file" });
  try {
    await writeFile(publication.stagingPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await publication.publishFile(await publication.verifyFile());
  } catch (error) {
    await publication.abort();
    throw error;
  }
}
