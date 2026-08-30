import { createHash } from "node:crypto";
import { createWriteStream, constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { ReviewBundleArtifactCandidate } from "./review-bundle-receipt-data";

interface AttributionWithProducerIdentity {
  artifact: ReviewBundleArtifactCandidate;
}

export interface ExpectedProducerIdentity {
  expectedProducerSha256?: string;
  expectedProducerByteLength?: number;
}

export interface ObservedArtifactIdentity {
  sha256: string;
  byteLength: number;
}

/**
 * A deliberately narrow admission seam for exercising the descriptor revalidation boundary.
 * It is not supplied by normal bundle publication; callers may use it only when they need to
 * observe the moment after a source stream completes and before the retained descriptor is
 * re-statted.
 */
export interface ReviewBundleArtifactAdmissionHooks {
  afterSourceStreamBeforeStat?: (sourcePath: string) => Promise<void> | void;
}

export interface OpenApprovedArtifact {
  size: number;
  copyAndHash: (targetPath: string) => Promise<ObservedArtifactIdentity>;
  close: () => Promise<void>;
}

type ArtifactStats = Pick<Awaited<ReturnType<typeof lstat>>, "dev" | "ino" | "size" | "mtimeMs" | "ctimeMs" | "isFile" | "isSymbolicLink">;

/**
 * Opens an approved artifact once and returns its retained descriptor, descriptor size, and a
 * single-pass copy-and-hash operation. The caller checks size/count/aggregate caps before asking
 * this object to read any bytes.
 *
 * `O_NOFOLLOW` (a no-op on Windows, where the constant is undefined and the bitwise OR coerces it
 * to 0) plus the dev/ino comparison against an `lstat` of the same canonical path rejects a
 * symlink or regular-file swap landing between the caller's `realpath` containment check and this
 * open. Mirrors the identity re-verification `hashFile` already performs.
 *
 * @param canonicalSource Realpath-resolved, root-bound path of the artifact to ship.
 * @returns `size` from the retained descriptor, `copyAndHash` (stream it once to a target path
 *   while calculating its sha256), and `close` (release the descriptor; the caller must always
 *   call it).
 * @throws When the path cannot be opened as the same regular file it was checked as.
 */
export async function openApprovedArtifact(
  canonicalSource: string,
  hooks: ReviewBundleArtifactAdmissionHooks
): Promise<OpenApprovedArtifact> {
  const linkInfo = await lstat(canonicalSource);
  if (!linkInfo.isFile() || linkInfo.isSymbolicLink()) throw new Error("Review bundle artifact must be a regular file.");
  const handle = await open(canonicalSource, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!sameArtifactStats(linkInfo, opened)) {
      throw new Error("Review bundle artifact changed before it could be read.");
    }
    return {
      size: opened.size,
      copyAndHash: async (targetPath: string) => {
        const hash = createHash("sha256");
        let byteLength = 0;
        const hashAndCopy = new Transform({
          transform(chunk, _encoding, callback) {
            const bytes = chunk as Buffer;
            hash.update(bytes);
            byteLength += bytes.byteLength;
            callback(null, chunk);
          }
        });
        const source = opened.size === 0
          ? Readable.from([])
          : handle.createReadStream({ start: 0, end: opened.size - 1, autoClose: false });
        await pipeline(
          source,
          hashAndCopy,
          createWriteStream(targetPath, { flags: "wx" })
        );
        await hooks.afterSourceStreamBeforeStat?.(canonicalSource);
        const after = await handle.stat();
        if (!sameArtifactStats(opened, after)) {
          throw new Error("Review bundle artifact changed while it was copied.");
        }
        return { sha256: hash.digest("hex"), byteLength };
      },
      close: async () => { await handle.close().catch(() => undefined); }
    };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

export function expectedProducerIdentityFor(attributions: readonly AttributionWithProducerIdentity[]): ExpectedProducerIdentity {
  const sha256 = attributions.find((attribution) => attribution.artifact.expectedProducerSha256)?.artifact.expectedProducerSha256;
  const byteLength = attributions.find((attribution) => attribution.artifact.expectedProducerByteLength !== undefined)?.artifact.expectedProducerByteLength;
  return {
    ...(sha256 ? { expectedProducerSha256: sha256 } : {}),
    ...(byteLength !== undefined ? { expectedProducerByteLength: byteLength } : {})
  };
}

export function assertCompatibleProducerIdentity(
  existing: readonly AttributionWithProducerIdentity[],
  candidate: AttributionWithProducerIdentity
): void {
  const expected = expectedProducerIdentityFor(existing);
  const actual = expectedProducerIdentityFor([candidate]);
  if (expected.expectedProducerSha256 && actual.expectedProducerSha256 && expected.expectedProducerSha256 !== actual.expectedProducerSha256) {
    throw new Error("Review bundle receipt attributions conflict on the producer SHA-256 for one artifact source.");
  }
  if (expected.expectedProducerByteLength !== undefined && actual.expectedProducerByteLength !== undefined && expected.expectedProducerByteLength !== actual.expectedProducerByteLength) {
    throw new Error("Review bundle receipt attributions conflict on the producer byte length for one artifact source.");
  }
}

export function assertObservedProducerIdentity(expected: ExpectedProducerIdentity, observed: ObservedArtifactIdentity): void {
  if (expected.expectedProducerSha256 && expected.expectedProducerSha256 !== observed.sha256) {
    throw new Error("Review bundle artifact bytes do not match the receipt producer SHA-256.");
  }
  if (expected.expectedProducerByteLength !== undefined && expected.expectedProducerByteLength !== observed.byteLength) {
    throw new Error("Review bundle artifact bytes do not match the receipt producer byte length.");
  }
}

function sameArtifactStats(left: ArtifactStats, right: ArtifactStats): boolean {
  return left.isFile()
    && !left.isSymbolicLink()
    && right.isFile()
    && !right.isSymbolicLink()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}
