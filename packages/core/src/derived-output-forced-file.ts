import { unlink } from "node:fs/promises";
import type { OutputPathLeafIdentity } from "./output-path-topology";
import { DerivedOutputPublicationError } from "./derived-output-publication-types";

type ForcedFileGuards = {
  assertTopology(): Promise<void>;
  assertDestinationIdentity(): Promise<OutputPathLeafIdentity>;
};

/** Remove only the exact admitted regular file after explicit force intent. */
export async function removeForcedFileDestination(
  force: boolean,
  outputPath: string,
  guards: ForcedFileGuards
): Promise<{ destinationIdentity: OutputPathLeafIdentity; removed: boolean } | undefined> {
  if (!force) return undefined;
  await guards.assertTopology();
  const current = await guards.assertDestinationIdentity();
  if (current.kind === "missing") return { destinationIdentity: current, removed: false };
  if (current.kind !== "file") {
    throw new DerivedOutputPublicationError("derived_output_exists", "Forced final publication may replace only the regular file observed at acquisition; directories, symbolic links, and substituted entries are preserved.", outputPath);
  }
  await guards.assertTopology();
  await guards.assertDestinationIdentity();
  await unlink(outputPath);
  return { destinationIdentity: { kind: "missing" }, removed: true };
}
