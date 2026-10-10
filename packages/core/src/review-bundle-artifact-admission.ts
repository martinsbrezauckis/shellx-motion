import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { copyFile, link, mkdir, realpath, stat, unlink } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import {
  artifactCandidates,
  hasProtocolScheme
} from "./review-bundle-receipt-data";
import {
  assertCompatibleProducerIdentity,
  assertObservedProducerIdentity,
  expectedProducerIdentityFor,
  openApprovedArtifact,
  type OpenApprovedArtifact,
  type ReviewBundleArtifactAdmissionHooks
} from "./review-bundle-artifact-integrity";
import { hashFile } from "./receipts";
import type {
  ReviewBundleCopiedArtifact,
  ReviewBundleOmittedArtifact,
  ReviewBundleReceiptEntry,
  WriteReviewBundleInput
} from "./review-bundle-types";

/** Receipt data may describe at most this many artifact attributions in one bundle. */
export const MAX_REVIEW_BUNDLE_CANDIDATE_ATTRIBUTIONS = 1024;
/** A bundle may copy bytes from at most this many distinct canonical source files. */
export const MAX_REVIEW_BUNDLE_DISTINCT_SOURCES = 256;
/** No one physical source file may exceed 4 GiB. */
export const MAX_REVIEW_BUNDLE_SOURCE_BYTES = 4 * 1024 * 1024 * 1024;
/** The aggregate of distinct physical source files may not exceed 16 GiB. */
export const MAX_REVIEW_BUNDLE_AGGREGATE_SOURCE_BYTES = 16 * 1024 * 1024 * 1024;

interface CandidateAttribution {
  entry: ReviewBundleReceiptEntry;
  artifact: ReturnType<typeof artifactCandidates>[number];
}

interface PendingAttribution extends CandidateAttribution {
  sourcePath: string;
}

interface PendingSource {
  firstAttribution: PendingAttribution;
  opened: OpenApprovedArtifact;
  attributions: PendingAttribution[];
}

/**
 * Canonicalizes the directories receipt-referenced artifacts may be copied from. Roots are
 * realpath-resolved so containment below is checked against what the filesystem actually serves —
 * a lexical prefix check alone would let a symlink placed under an approved root smuggle
 * out-of-root files into the bundle. A root that is missing or not a directory is dropped rather
 * than kept as a phantom prefix: it can contain no real file, so keeping it would only widen the
 * boundary for no benefit.
 */
export async function canonicalApprovedArtifactRoots(
  roots: (string | undefined)[],
  retainedAuthorities: WriteReviewBundleInput["artifactRootAuthorities"] = []
): Promise<string[]> {
  await assertRetainedAuthorities(retainedAuthorities);
  const canonical: string[] = [];
  for (const root of roots) {
    if (!root) continue;
    try {
      const canonicalRoot = await realpath(resolve(root));
      if ((await stat(canonicalRoot)).isDirectory() && !canonical.includes(canonicalRoot)) canonical.push(canonicalRoot);
    } catch {
      // ENOENT and friends: an unreachable root approves nothing.
    }
  }
  await assertRetainedAuthorities(retainedAuthorities);
  return canonical;
}

export async function copyReviewArtifacts(
  entries: ReviewBundleReceiptEntry[],
  outDir: string,
  approvedRoots: string[],
  retainedAuthorities: WriteReviewBundleInput["artifactRootAuthorities"] = [],
  hooks: ReviewBundleArtifactAdmissionHooks = {}
): Promise<{ copiedArtifacts: ReviewBundleCopiedArtifact[]; omittedArtifacts: ReviewBundleOmittedArtifact[] }> {
  const copied: ReviewBundleCopiedArtifact[] = [];
  const omitted: ReviewBundleOmittedArtifact[] = [];
  const pendingSources = new Map<string, PendingSource>();
  const assignedTargets = new Map<string, { sha256: string; byteLength: number }>();
  let aggregateSourceBytes = 0;
  try {
    // Do this before opening, hashing, or copying any source. A receipt is control-plane input,
    // so crossing the attribution cap is a failed bundle, not an omission or a partial result.
    for (const { entry, artifact } of boundedReviewArtifactAttributions(entries)) {
      const declaredPath = typeof artifact.path === "string" ? artifact.path : "";
      // An artifact that cannot enter the bundle is recorded, never silently dropped: a reviewer
      // reading the bundle must be able to tell "this render never had evidence" apart from
      // "evidence existed but was withheld", or a hostile receipt could hide a failed artifact
      // simply by pointing its path somewhere unreadable. `sourceName` is always a portable leaf,
      // so nothing about host layout leaks into the shared bundle.
      const omission = (reason: ReviewBundleOmittedArtifact["reason"], sourceName: string): void => {
        omitted.push({
          role: artifact.role,
          sourceName,
          reason,
          receiptId: entry.receipt.id,
          operation: entry.receipt.operation
        });
      };
      // These three used to be a bare `continue` that predated the ledger, which is exactly the
      // hole the ledger exists to close: `status`, and the shape of `path`, are receipt-controlled,
      // so a crafted receipt could withhold an artifact and still report omittedArtifactCount: 0.
      // They are disclosed here with their own reasons instead. Do not dedupe attributions: the
      // receipt/role association is evidence, even when several associations resolve to one file.
      // A non-local path must never be run through `resolve`, which would splice the bundler's cwd
      // onto attacker-chosen text.
      if (artifact.status !== "available" || !declaredPath || hasProtocolScheme(declaredPath)) {
        const declaredName = declaredPath ? reviewArtifactSourceName(declaredPath) : artifact.role;
        if (artifact.status !== "available") omission("declared_unavailable", declaredName);
        else if (!declaredPath) omission("missing_path", artifact.role);
        else omission("non_local_path", declaredName);
        continue;
      }
      const sourcePath = resolve(declaredPath);
      // realpath does double duty: it proves the source exists and yields the canonical path the
      // root binding must run against. Binding the declared path instead would let a symlink
      // under an approved root read any file on the host into the bundle.
      let canonicalSource: string;
      await assertRetainedAuthorities(retainedAuthorities);
      try {
        canonicalSource = await realpath(sourcePath);
      } catch {
        omission("unreadable_source", reviewArtifactSourceName(sourcePath));
        continue;
      }
      await assertRetainedAuthorities(retainedAuthorities);
      // The security boundary of this module: receipts are data, and data must not carry read
      // capability. Only files whose canonical location the caller approved (packageRoot,
      // receiptsRoot, or an explicit artifact root) may enter a bundle built to be shared.
      if (!approvedRoots.some((root) => isPathInsideOrEqual(root, canonicalSource))) {
        omission("outside_approved_roots", reviewArtifactSourceName(sourcePath));
        continue;
      }
      const attribution: PendingAttribution = { entry, artifact, sourcePath };
      const existing = pendingSources.get(canonicalSource);
      if (existing) {
        assertCompatibleProducerIdentity(existing.attributions, attribution);
        existing.attributions.push(attribution);
        continue;
      }

      // Retain one descriptor for the physical source while every receipt/role attribution points
      // at it. Its descriptor size is checked before any byte is hashed or copied, so sparse or
      // hostile receipt inputs cannot turn this into an unbounded read.
      let opened: OpenApprovedArtifact;
      await assertRetainedAuthorities(retainedAuthorities);
      try {
        opened = await openApprovedArtifact(canonicalSource, hooks);
      } catch {
        omission("unreadable_source", reviewArtifactSourceName(sourcePath));
        continue;
      }
      await assertRetainedAuthorities(retainedAuthorities);
      try {
        if (opened.size > MAX_REVIEW_BUNDLE_SOURCE_BYTES) {
          throw new Error(`Review bundle artifact source exceeds the ${formatBytes(MAX_REVIEW_BUNDLE_SOURCE_BYTES)} per-source limit.`);
        }
        if (pendingSources.size >= MAX_REVIEW_BUNDLE_DISTINCT_SOURCES) {
          throw new Error(`Review bundle exceeds the ${MAX_REVIEW_BUNDLE_DISTINCT_SOURCES} distinct-source limit.`);
        }
        if (aggregateSourceBytes + opened.size > MAX_REVIEW_BUNDLE_AGGREGATE_SOURCE_BYTES) {
          throw new Error(`Review bundle artifact sources exceed the ${formatBytes(MAX_REVIEW_BUNDLE_AGGREGATE_SOURCE_BYTES)} aggregate limit.`);
        }
        aggregateSourceBytes += opened.size;
        pendingSources.set(canonicalSource, {
          firstAttribution: attribution,
          opened,
          attributions: [attribution]
        });
      } catch (error) {
        await opened.close();
        throw error;
      }
    }

    if (pendingSources.size === 0) return { copiedArtifacts: copied, omittedArtifacts: omitted };
    await mkdir(join(outDir, "artifacts"), { recursive: true });
    let stagedFileIndex = 0;
    for (const source of pendingSources.values()) {
      const { artifact, sourcePath } = source.firstAttribution;
      const temporaryPath = join(outDir, "artifacts", `.review-bundle-${stagedFileIndex++}.part`);
      try {
        await assertRetainedAuthorities(retainedAuthorities);
        const observed = await source.opened.copyAndHash(temporaryPath);
        await assertRetainedAuthorities(retainedAuthorities);
        const expectedSourceIdentity = expectedProducerIdentityFor(source.attributions);
        assertObservedProducerIdentity(expectedSourceIdentity, observed);
        // Display names stay receipt-declared so reviewers see familiar names. Every attribution
        // of this canonical source uses this one relative bundle file.
        const fileName = safeFileName(reviewArtifactSourceName(sourcePath) || `${artifact.role}${extname(sourcePath)}`);
        const relativePath = `artifacts/${reviewArtifactTargetName(artifact.role, observed.sha256, fileName)}`;
        const targetPath = join(outDir, ...relativePath.split("/"));
        const assigned = assignedTargets.get(relativePath);
        if (assigned) {
          // Distinct approved sources with identical bytes may legitimately share one portable
          // target. Verify its full identity before reusing it for another receipt attribution.
          if (assigned.sha256 !== observed.sha256 || assigned.byteLength !== observed.byteLength
            || await hashFile(targetPath) !== observed.sha256) {
            throw new Error("Review bundle artifact target collision between distinct source identities.");
          }
        } else {
          // The staged tree is private, but a destination must still never replace an earlier copy.
          // link is exclusive at the target; both files are on the same staging filesystem.
          try {
            await link(temporaryPath, targetPath);
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === "EEXIST") {
              throw new Error("Review bundle artifact target already exists; refusing to replace it.");
            }
            // Some approved output filesystems do not support hard links. An exclusive copy keeps
            // their existing bundle behavior without opening an overwrite path.
            if (code !== "ENOSYS" && code !== "EOPNOTSUPP" && code !== "ENOTSUP" && code !== "EPERM") throw error;
            try {
              await copyFile(temporaryPath, targetPath, fsConstants.COPYFILE_EXCL);
            } catch (copyError) {
              if ((copyError as NodeJS.ErrnoException).code === "EEXIST") {
                throw new Error("Review bundle artifact target already exists; refusing to replace it.");
              }
              throw copyError;
            }
          }
          assignedTargets.set(relativePath, { sha256: observed.sha256, byteLength: observed.byteLength });
        }
        await unlink(temporaryPath);
        for (const attribution of source.attributions) {
          const expectedAttributionIdentity = expectedProducerIdentityFor([attribution]);
          copied.push({
            role: attribution.artifact.role,
            sourceName: reviewArtifactSourceName(attribution.sourcePath),
            path: targetPath,
            relativePath,
            ...(attribution.artifact.mediaType ? { mediaType: attribution.artifact.mediaType } : {}),
            ...(attribution.artifact.primary ? { primary: attribution.artifact.primary } : {}),
            receiptId: attribution.entry.receipt.id,
            operation: attribution.entry.receipt.operation,
            sha256: observed.sha256,
            observedSha256: observed.sha256,
            observedByteLength: observed.byteLength,
            ...(expectedAttributionIdentity.expectedProducerSha256 ? { expectedProducerSha256: expectedAttributionIdentity.expectedProducerSha256 } : {}),
            ...(expectedAttributionIdentity.expectedProducerByteLength !== undefined ? { expectedProducerByteLength: expectedAttributionIdentity.expectedProducerByteLength } : {}),
            producerIdentity: expectedAttributionIdentity.expectedProducerSha256 ? "producer_verified" : "unattested"
          });
        }
      } finally {
        await source.opened.close();
      }
    }
    return { copiedArtifacts: copied, omittedArtifacts: omitted };
  } finally {
    await Promise.all([...pendingSources.values()].map(async (source) => await source.opened.close()));
  }
}

/** Reconcile each published claim against the final staged leaf before writing review claims. */
export async function assertCopiedReviewArtifactIdentities(copied: readonly ReviewBundleCopiedArtifact[]): Promise<void> {
  const checked = new Map<string, string>();
  for (const artifact of copied) {
    const previous = checked.get(artifact.path);
    if (previous !== undefined) {
      if (previous !== artifact.observedSha256) throw new Error("Review bundle artifact target has conflicting claimed identities.");
      continue;
    }
    if (await hashFile(artifact.path) !== artifact.observedSha256) {
      throw new Error("Review bundle artifact target changed before publication.");
    }
    checked.set(artifact.path, artifact.observedSha256);
  }
}

export function boundedReviewArtifactAttributions(entries: ReviewBundleReceiptEntry[]): CandidateAttribution[] {
  const candidates: CandidateAttribution[] = [];
  for (const entry of entries) {
    for (const artifact of artifactCandidates(entry.receipt)) {
      if (candidates.length >= MAX_REVIEW_BUNDLE_CANDIDATE_ATTRIBUTIONS) {
        throw new Error(`Review bundle exceeds the ${MAX_REVIEW_BUNDLE_CANDIDATE_ATTRIBUTIONS} candidate-attribution limit.`);
      }
      candidates.push({ entry, artifact });
    }
  }
  return candidates;
}

async function assertRetainedAuthorities(authorities: WriteReviewBundleInput["artifactRootAuthorities"]): Promise<void> {
  for (const authority of authorities ?? []) await authority.assertCurrent();
}

function formatBytes(bytes: number): string {
  return `${bytes / (1024 * 1024 * 1024)} GiB`;
}

function isPathInsideOrEqual(parent: string, candidate: string): boolean {
  const relation = relative(resolve(parent), resolve(candidate));
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

function safeToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "artifact";
}

function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-") || "artifact";
}

function reviewArtifactTargetName(role: string, sha256: string, fileName: string): string {
  const roleName = safeToken(role);
  const unbounded = `${roleName}-${sha256}-${fileName}`;
  if (unbounded.length <= 255) return unbounded;
  // A full digest must not make a previously valid long source leaf fail on 255-byte filesystems.
  // Fingerprint truncated display parts so different names do not silently converge on one key.
  const boundedRole = roleName.length <= 48 ? roleName : `${roleName.slice(0, 16)}-${nameDigest(roleName)}`;
  const availableLeaf = 255 - boundedRole.length - sha256.length - 2;
  if (fileName.length <= availableLeaf) return `${boundedRole}-${sha256}-${fileName}`;
  const extension = extname(fileName);
  const suffix = extension.length <= 16 ? extension : "";
  const shortenedLeaf = `${fileName.slice(0, availableLeaf - 65 - suffix.length)}-${nameDigest(fileName)}${suffix}`;
  return `${boundedRole}-${sha256}-${shortenedLeaf}`;
}

function nameDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function reviewArtifactSourceName(path: string): string {
  return path.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "artifact";
}
