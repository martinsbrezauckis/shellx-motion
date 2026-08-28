/**
 * Publish a package archive and its receipt as one bounded no-clobber outcome.
 *
 * A receipt states that an archive exists, so it must never arrive first. Both targets reserve the
 * existing derived-output authority before either is written. The archive keeps its private hard
 * link until the receipt has published. If receipt publication fails after that point, the archive
 * is deliberately preserved: a portable check-then-unlink rollback could delete a replacement
 * installed by a non-cooperating writer.
 */
import { writeFile } from "node:fs/promises";
import {
  acquireDerivedOutputPublication,
  DerivedOutputPublicationError,
  type DerivedOutputPublication,
} from "./derived-output-publication";
import { isPublicationCommitUncertain } from "./publication-commit-uncertainty";

export type PackageArchiveOutputPublicationErrorCode =
  | "package_archive_output_busy"
  | "package_archive_output_exists"
  | "package_archive_output_unsafe_parent"
  | "package_archive_output_paths_conflict"
  | "package_archive_receipt_publish_failed"
  | "package_archive_output_publish_failed";

export class PackageArchiveOutputPublicationError extends Error {
  constructor(readonly code: PackageArchiveOutputPublicationErrorCode, message: string) {
    super(message);
    this.name = "PackageArchiveOutputPublicationError";
    Object.setPrototypeOf(this, PackageArchiveOutputPublicationError.prototype);
  }
}

export interface PackageArchiveOutputPublicationInput {
  archivePath: string;
  receiptPath: string;
  archiveBytes: Buffer;
  receiptJson: string;
}

/** Bounded fault seam for the paired-publication regression test. Production callers omit it. */
export interface PackageArchiveOutputPublicationServices {
  afterArchivePublished?: () => Promise<void>;
}

/**
 * Publish the archive before its receipt. The two filesystem names cannot become one atomic POSIX
 * operation, so the receipt's ordering keeps it from ever claiming an unpublished archive. If its
 * publication fails, the archive may remain without a receipt and the typed failure says so; this
 * function never deletes a public name after publication.
 */
export async function publishPackageArchiveOutputs(
  input: PackageArchiveOutputPublicationInput,
  services: PackageArchiveOutputPublicationServices = {}
): Promise<void> {
  if (input.archivePath === input.receiptPath) {
    throw new PackageArchiveOutputPublicationError(
      "package_archive_output_paths_conflict",
      "Package archive and receipt paths must differ."
    );
  }

  let archivePublication: DerivedOutputPublication | undefined;
  let receiptPublication: DerivedOutputPublication | undefined;
  let archivePublished = false;
  try {
    archivePublication = await acquireDerivedOutputPublication({ outputPath: input.archivePath, kind: "file" });
    receiptPublication = await acquireDerivedOutputPublication({ outputPath: input.receiptPath, kind: "file" });

    await writeFile(archivePublication.stagingPath, input.archiveBytes);
    await writeFile(receiptPublication.stagingPath, input.receiptJson, "utf8");
    const archiveEvidence = await archivePublication.verifyFile();
    const receiptEvidence = await receiptPublication.verifyFile();

    await archivePublication.publishFile(archiveEvidence, { retainReservation: true });
    archivePublished = true;
    await services.afterArchivePublished?.();
    await receiptPublication.publishFile(receiptEvidence);
    // The receipt now truthfully names an already-published archive. Cleanup cannot change that
    // successful result, so a platform-specific private-stage unlink failure is intentionally inert.
    await archivePublication.abort().catch(() => undefined);
  } catch (error) {
    await receiptPublication?.abort().catch(() => undefined);
    await archivePublication?.abort().catch(() => undefined);
    throw packageArchivePublicationError(error, archivePublished);
  }
}

function packageArchivePublicationError(error: unknown, archivePublished: boolean): PackageArchiveOutputPublicationError {
  // The caller needs Core's canonical public path and verified artifact evidence to reconcile a
  // link that may already be visible. Do not replace it with the paired-output summary below.
  if (isPublicationCommitUncertain(error)) throw error;
  if (archivePublished) {
    return new PackageArchiveOutputPublicationError(
      "package_archive_receipt_publish_failed",
      "Package archive was published, but its receipt could not be published."
    );
  }
  if (error instanceof PackageArchiveOutputPublicationError) return error;
  if (!(error instanceof DerivedOutputPublicationError)) {
    return new PackageArchiveOutputPublicationError(
      "package_archive_output_publish_failed",
      "Package archive output publication failed safely."
    );
  }
  switch (error.code) {
    case "derived_output_busy":
      return new PackageArchiveOutputPublicationError(
        "package_archive_output_busy",
        "Package archive output is already being published."
      );
    case "derived_output_exists":
      return new PackageArchiveOutputPublicationError(
        "package_archive_output_exists",
        "Package archive output already exists."
      );
    case "derived_output_unsafe_parent":
      return new PackageArchiveOutputPublicationError(
        "package_archive_output_unsafe_parent",
        "Package archive output parent is not a canonical non-symlink directory."
      );
    default:
      return new PackageArchiveOutputPublicationError(
        "package_archive_output_publish_failed",
        "Package archive output publication failed safely."
      );
  }
}
