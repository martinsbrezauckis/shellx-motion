import { describe, expect, it } from "vitest";
import { validRenderArtifact, validRequestedCutHandoff } from "./render-client-guards.js";

const lineage = {
  schema: "shellx-motion/package-render-lineage@1",
  manifestSha256: "a".repeat(64),
  motionSha256: "b".repeat(64),
};

describe("render client lineage guards", () => {
  it("accepts matched lineage and rejects incomplete or swapped lineage", () => {
    const artifact = {
      schema: "shellx-motion/artifact-handle@1",
      id: "artifact-0123456789abcdef01234567",
      packageId: "pkg",
      motionId: "motion",
      operationHash: "c".repeat(64),
      preset: "mp4-h264",
      mediaType: "video/mp4",
      byteLength: 24,
      sha256: "d".repeat(64),
      createdAt: "2026-07-15T00:00:00.000Z",
      packageLineage: lineage,
    };
    const output = { packageId: "pkg", motionId: "motion", preset: "mp4-h264", artifact };
    expect(validRenderArtifact(artifact, output)).toBe(true);
    expect(validRenderArtifact({
      ...artifact,
      packageLineage: { ...lineage, adapterId: "adapter.gltf", sourceSha256: "e".repeat(64) },
    }, output)).toBe(false);

    const request = { cutHandoff: { target: "shellx-cut", mode: "rendered_media" } };
    const reference = {
      schema: "shellx-motion/artifact-handle-ref@1",
      id: artifact.id,
      operationHash: artifact.operationHash,
      rootRelativePath: "artifacts/rendered.artifact.json",
      sha256: "f".repeat(64),
      packageLineage: lineage,
    };
    const cut = {
      schema: "shellx-motion/cut-handoff@1",
      target: "shellx-cut",
      mode: "rendered_media",
      path: "/tmp/cut.json",
      sha256: "0".repeat(64),
      packageId: "pkg",
      motionId: "motion",
      artifactHandleId: artifact.id,
    };
    expect(validRequestedCutHandoff({ ...output, artifactReference: reference, cutHandoff: cut }, request)).toBe(true);
    expect(validRequestedCutHandoff({
      ...output,
      artifactReference: { ...reference, packageLineage: { ...lineage, motionSha256: "1".repeat(64) } },
      cutHandoff: cut,
    }, request)).toBe(false);
  });
});
