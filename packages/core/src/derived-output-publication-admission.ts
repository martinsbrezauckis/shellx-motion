import { readdir } from "node:fs/promises";
import {
  captureOutputDirectoryIdentity,
  captureOutputLeaf,
  type OutputPathLeafIdentity
} from "./output-path-topology";
import {
  DerivedOutputPublicationError,
  type DerivedOutputKind,
  type DerivedOutputPublicationErrorCode
} from "./derived-output-publication-types";

/** Validate the no-clobber leaf before a private publication stage is created. */
export async function assertDestination(
  kind: DerivedOutputKind,
  path: string,
  force: boolean,
  replaceEmptyDirectory: boolean
): Promise<OutputPathLeafIdentity> {
  const existing = await captureOutputLeaf(path);
  if (existing.kind === "missing") return existing;
  if (kind === "directory" && replaceEmptyDirectory && existing.kind === "directory") {
    const directory = await captureOutputDirectoryIdentity(path, "Final output empty directory", { requiresChildWrite: true });
    if (directory.dev !== existing.dev || directory.ino !== existing.ino || (await readdir(path)).length !== 0) {
      throw new DerivedOutputPublicationError("derived_output_exists", "Final directory output must be absent or an identity-stable empty directory.", path);
    }
    return existing;
  }
  if (existing.kind === "symlink" || !force || kind === "directory" || existing.kind !== "file") {
    throw new DerivedOutputPublicationError("derived_output_exists", "Final output already exists; choose a new path instead of replacing an existing file, directory, or symbolic link.", path);
  }
  return existing;
}

export function unsafeParentError(path: string, error: unknown): DerivedOutputPublicationError {
  const message = error instanceof Error ? error.message : String(error);
  return new DerivedOutputPublicationError("derived_output_unsafe_parent", `Final output parent is unsafe: ${message}`, path);
}

export function publicationError(code: DerivedOutputPublicationErrorCode, path: string, error: unknown): DerivedOutputPublicationError {
  const message = error instanceof Error ? error.message : String(error);
  return new DerivedOutputPublicationError(code, `Final output publication failed safely: ${message}`, path);
}
