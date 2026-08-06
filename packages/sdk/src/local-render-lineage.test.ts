import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  attestArtifactReceipt,
  createAttestedArtifactHandle,
  hashBuffer,
  writeAttestedArtifactHandle,
  type OperationReceipt,
} from "@shellx-motion/core";
import {
  assertRenderPackageLineage,
  loadStableRenderPackage,
  readCachedRenderArtifact,
  renderReceiptInputHashes,
} from "./local-render-lineage.js";

const roots: string[] = [];
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const OPERATION_HASH = "a".repeat(64);

describe("local render lineage", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("uses the canonical exact render hash keys and detects package drift", async () => {
    const fixture = await packageFixture();
    const { lineage } = await loadStableRenderPackage(fixture.packageRoot);

    expect(renderReceiptInputHashes(OPERATION_HASH, lineage)).toEqual({
      operationHash: OPERATION_HASH,
      manifestSha256: lineage.manifestSha256,
      motionSha256: lineage.motionSha256,
    });

    const motionPath = join(fixture.packageRoot, "motion.json");
    const motion = JSON.parse(await readFile(motionPath, "utf8"));
    motion.name = "changed after render start";
    await writeFile(motionPath, `${JSON.stringify(motion, null, 2)}\n`);
    await expect(assertRenderPackageLineage(fixture.packageRoot, lineage)).rejects.toThrow("changed during");
  });

  it("verifies cache lineage and rejects a tampered descriptor identity", async () => {
    const fixture = await packageFixture();
    const { pkg, lineage } = await loadStableRenderPackage(fixture.packageRoot);
    const artifactRoot = join(fixture.root, "artifacts");
    const artifactPath = join(artifactRoot, "output.png");
    const receiptPath = join(artifactRoot, "receipts", "render.receipt.json");
    const descriptorPath = join(artifactRoot, "handles", "render.artifact.json");
    await mkdir(dirname(receiptPath), { recursive: true });
    await writeFile(artifactPath, PNG);
    const receipt: OperationReceipt = {
      schema: "shellx-motion/receipt@1",
      id: "render-lineage-cache",
      operation: "render.final",
      status: "passed",
      packageId: pkg.manifest.id,
      inputHashes: renderReceiptInputHashes(OPERATION_HASH, lineage),
      createdAt: "2026-07-15T00:00:00.000Z",
      lane: "ffmpeg",
      output: { path: artifactPath, sha256: hashBuffer(PNG), preset: "png" },
      warnings: [],
    };
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    const attestation = await attestArtifactReceipt(artifactRoot, receiptPath, "render");
    const handle = await createAttestedArtifactHandle({
      root: artifactRoot,
      artifactPath,
      packageId: pkg.manifest.id,
      motionId: pkg.motion.id,
      operationHash: OPERATION_HASH,
      preset: "png",
      mediaType: "image/png",
      receipts: [attestation],
      packageLineage: lineage,
      qualityEvidence: { sdkCacheKey: OPERATION_HASH },
    });
    await writeAttestedArtifactHandle(descriptorPath, handle);
    const cacheInput = {
      root: artifactRoot, path: descriptorPath, pkg, preset: "png",
      operationHash: OPERATION_HASH, sdkCacheKey: OPERATION_HASH, lineage,
    };
    await expect(readCachedRenderArtifact(cacheInput)).resolves.toMatchObject({ id: handle.id, packageLineage: lineage });

    const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
    descriptor.packageLineage.motionSha256 = "f".repeat(64);
    await writeFile(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);
    await expect(readCachedRenderArtifact(cacheInput)).rejects.toThrow("id does not bind");
  });
});

async function packageFixture(): Promise<{ root: string; packageRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-sdk-lineage-"));
  roots.push(root);
  const packageRoot = join(root, "package");
  await cp(resolve("../../fixtures/packages/lower-third"), packageRoot, { recursive: true });
  return { root, packageRoot };
}
