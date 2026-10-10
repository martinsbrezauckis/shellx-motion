import { createHash } from "node:crypto";
import { mkdir, unlink } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import {
  captureOutputDirectoryIdentity,
  OutputPathTopology,
  type OutputPathIdentity,
  type OutputPathLeafIdentity
} from "./output-path-topology";
import {
  createPrivateDirectoryStage,
  createPrivateFileAnchor,
  createPrivateFileStage,
  assertRegularFileIdentity,
  removeExactPrivateDirectory,
  stableRegularFile,
  type PrivateFileAnchor
} from "./derived-output-publication-private";
import { DerivedOutputPublicationError, type DerivedOutputKind, type DerivedOutputPublicationInput } from "./derived-output-publication-types";
import { assertDestination, unsafeParentError } from "./derived-output-publication-admission";

/** Identity-bound reservation state constructed before a producer receives its private stage. */
export interface DerivedOutputPublicationPreparation {
  outputPath: string;
  rootPath: string;
  stagingPath: string;
  kind: DerivedOutputKind;
  force: boolean;
  replaceEmptyDirectory: boolean;
  topology: OutputPathTopology;
  lockPath: string;
  lockIdentity: OutputPathIdentity;
  stageIdentity: OutputPathIdentity;
  /** The private stage is pinned by its Core-created anchor link as well as dev/inode. */
  stageLinkCount: number | undefined;
  stageAnchor: PrivateFileAnchor | undefined;
  destinationIdentity: OutputPathLeafIdentity;
  destinationAnchor: PrivateFileAnchor | undefined;
}

export async function prepareDerivedOutputPublication(input: DerivedOutputPublicationInput): Promise<DerivedOutputPublicationPreparation> {
  const outputPath = resolve(input.outputPath);
  let topology: OutputPathTopology;
  let stage: { path: string; identity: OutputPathIdentity } | undefined;
  let stageAnchor: PrivateFileAnchor | undefined;
  let destinationAnchor: PrivateFileAnchor | undefined;
  try {
    topology = await OutputPathTopology.acquire(outputPath, { heldDirectoryAuthority: input.internalHeldDirectoryAuthority });
  } catch (error) {
    throw unsafeParentError(outputPath, error);
  }
  const rootPath = topology.parentPath;
  const fingerprint = createHash("sha256").update(outputPath).digest("hex").slice(0, 32);
  const lockPath = join(rootPath, `.shellx-motion-final-${fingerprint}.lock`);
  let lockIdentity: OutputPathIdentity;
  try {
    await topology.assertCurrent();
    await mkdir(lockPath, { mode: 0o700 });
    lockIdentity = await captureOutputDirectoryIdentity(lockPath, "Final output reservation", { private: true, heldDirectoryAuthority: input.internalHeldDirectoryAuthority });
  } catch (error: any) {
    if (error?.code === "EEXIST") {
      throw new DerivedOutputPublicationError(
        "derived_output_busy",
        "Another final render already owns this output path. Wait for it to finish; Motion does not break retained publication locks automatically.",
        outputPath
      );
    }
    throw unsafeParentError(outputPath, error);
  }

  try {
    const replaceEmptyDirectory = input.replaceEmptyDirectory === true;
    if (replaceEmptyDirectory && input.kind !== "directory") {
      throw new DerivedOutputPublicationError("derived_output_exists", "Only directory publications may replace an admitted empty directory.", outputPath);
    }
    const destinationIdentity = await assertDestination(input.kind, outputPath, input.force === true, replaceEmptyDirectory);
    await topology.assertCurrent();
    stage = input.kind === "file"
      ? await createPrivateFileStage(lockPath, fingerprint, extname(outputPath), input.internalPrivateFileMaxBytes)
      : await createPrivateDirectoryStage(lockPath, fingerprint);
    stageAnchor = input.kind === "file"
      ? await createPrivateFileAnchor(lockPath, "stage-anchor", stage.path, stage.identity, input.internalPrivateFileMaxBytes)
      : undefined;
    const stageLinkCount = stageAnchor
      ? (await stableRegularFile(stage.path, "Final output staging file", stage.identity, input.internalPrivateFileMaxBytes)).nlink
      : undefined;
    destinationAnchor = destinationIdentity.kind === "file"
      ? await createPrivateFileAnchor(lockPath, "destination-anchor", outputPath, destinationIdentity, input.internalPrivateFileMaxBytes)
      : undefined;
    return {
      outputPath,
      rootPath,
      stagingPath: stage.path,
      kind: input.kind,
      force: input.force === true,
      replaceEmptyDirectory,
      topology,
      lockPath,
      lockIdentity,
      stageIdentity: stage.identity,
      stageLinkCount,
      stageAnchor,
      destinationIdentity,
      destinationAnchor
    };
  } catch (error) {
    try {
      // Reverse-order transactional rollback: only unlink leaves whose captured inode still
      // matches.  A replacement is preserved and reported busy rather than poisoning retries.
      for (const leaf of [destinationAnchor, stageAnchor].filter((value): value is PrivateFileAnchor => Boolean(value))) {
        await assertRegularFileIdentity(leaf.path, "Final output rollback identity anchor", leaf.identity);
        await unlink(leaf.path);
      }
      if (stage && input.kind === "file") {
        await assertRegularFileIdentity(stage.path, "Final output rollback stage", stage.identity);
        await unlink(stage.path);
      }
      await removeExactPrivateDirectory(topology, lockPath, lockIdentity, input.internalHeldDirectoryAuthority);
    } catch {
      // Do not silently leave an identity-bound lock that makes a later owner permanently busy.
      throw new DerivedOutputPublicationError("derived_output_busy", "Final output reservation cleanup could not prove removal; retained recovery evidence was preserved.", outputPath);
    }
    throw error;
  }
}
