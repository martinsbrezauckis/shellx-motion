/** Internal durable-artifact readback helpers shared by checkpoint commit and resume. */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { canonicalJson } from "@shellx-motion/core";
import type {
  RenderSegmentCheckpoint,
  RenderSegmentReadbackVerifier,
  RenderSegmentStoreManifest
} from "./render-segment-store-types.js";
import { RenderSegmentStoreError } from "./render-segment-store-types.js";

export async function observeRegularSegmentArtifact(path: string, label: string): Promise<{ byteLength: number; sha256: string }> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("not a regular file");
    return { byteLength: stat.size, sha256: await sha256File(path) };
  } catch (error) {
    if (error instanceof RenderSegmentStoreError) throw error;
    throw new RenderSegmentStoreError("segment_integrity_failed", `${label} must be an existing regular file: ${safeMessage(error)}`);
  }
}

export async function verifyCompletedRenderSegmentPrefix(
  rootPath: string,
  manifest: RenderSegmentStoreManifest,
  verifier: RenderSegmentReadbackVerifier
): Promise<void> {
  for (const entry of manifest.completed) {
    const artifactPath = resolve(rootPath, entry.artifact.path);
    if (!isWithin(rootPath, artifactPath)) throw new RenderSegmentStoreError("segment_entry_invalid", "Segment artifact path escapes the owned store root.");
    const before = await observeRegularSegmentArtifact(artifactPath, "Segment artifact");
    if (before.byteLength !== entry.artifact.byteLength || before.sha256 !== entry.artifact.sha256) {
      throw new RenderSegmentStoreError("segment_integrity_failed", "Segment artifact bytes or SHA-256 do not match its verified checkpoint.");
    }
    const observed = await verifyRenderSegmentReadback(verifier, { range: entry.range, artifactPath, expected: expectedReadbackFacts(manifest) });
    const after = await observeRegularSegmentArtifact(artifactPath, "Segment artifact");
    if (before.byteLength !== after.byteLength || before.sha256 !== after.sha256) {
      throw new RenderSegmentStoreError("segment_integrity_failed", "Segment artifact changed during readback verification.");
    }
    if (canonicalJson(observed) !== canonicalJson(entry.readback)) {
      throw new RenderSegmentStoreError("segment_readback_verification_failed", "Segment readback no longer matches its verified checkpoint.");
    }
  }
}

export async function verifyRenderSegmentReadback(
  verifier: RenderSegmentReadbackVerifier,
  input: Parameters<RenderSegmentReadbackVerifier>[0]
): Promise<RenderSegmentCheckpoint["readback"]> {
  try {
    const result = await verifier({
      range: { ...input.range },
      artifactPath: input.artifactPath,
      expected: {
        timeline: { ...input.expected.timeline },
        intermediate: { ...input.expected.intermediate }
      }
    });
    if (!result.ok) throw new RenderSegmentStoreError("segment_readback_verification_failed", result.message || "Segment readback verification failed.");
    return { ...result.readback };
  } catch (error) {
    if (error instanceof RenderSegmentStoreError) throw error;
    throw new RenderSegmentStoreError(
      "segment_readback_verification_failed",
      `Segment readback verification failed: ${safeMessage(error)}`,
      { cause: error }
    );
  }
}

export function expectedReadbackFacts(manifest: RenderSegmentStoreManifest): Parameters<RenderSegmentReadbackVerifier>[0]["expected"] {
  return {
    timeline: { ...manifest.timeline },
    intermediate: { ...manifest.intermediate }
  };
}

function isWithin(rootPath: string, candidate: string): boolean {
  const value = relative(rootPath, candidate);
  return !isAbsolute(value) && value !== "" && value !== ".." && !value.startsWith(`..${sep}`);
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
