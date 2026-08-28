import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  batchQualityInputEvidence,
  prepareBatchQualityManifestSnapshot,
  publishBatchQualityManifestSnapshot,
} from "./batch-quality-manifest-snapshot";
import { BoundedResourceBudget } from "./stable-file-read";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("batch quality manifest snapshots", () => {
  it("binds row-materialized policy and baseline bytes before later path mutation", async () => {
    const root = await privateRoot("shellx-motion-batch-quality-snapshot-");
    const manifestPath = join(root, "quality.json");
    const baselinePath = join(root, "baselines", "ada.png");
    await mkdir(dirname(baselinePath), { recursive: true, mode: 0o700 });
    await writeFile(baselinePath, Buffer.from("BASELINE_A"));
    await writeFile(manifestPath, manifest("baselines/{{rowId}}.png", 7));

    const first = await prepareBatchQualityManifestSnapshot({
      sourcePath: manifestPath,
      context: context("ada"),
    });
    await writeFile(baselinePath, Buffer.from("BASELINE_B"));
    await writeFile(manifestPath, manifest("baselines/{{rowId}}.png", 99));
    const published = await publishBatchQualityManifestSnapshot({
      snapshot: first,
      targetRoot: join(root, "private-snapshot", first.closureSha256),
    });
    const applied = JSON.parse(await readFile(published.path, "utf8")) as {
      samples: Array<{ baseline: string; minBrightPixels: number }>;
    };

    expect(applied.samples[0].minBrightPixels).toBe(7);
    expect(await readFile(applied.samples[0].baseline, "utf8")).toBe("BASELINE_A");
    expect(batchQualityInputEvidence(first)).toMatchObject({
      manifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      baselinesSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      closureSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });

    const second = await prepareBatchQualityManifestSnapshot({ sourcePath: manifestPath, context: context("ada") });
    expect(second.sourceSha256).not.toBe(first.sourceSha256);
    expect(second.baselinesSha256).not.toBe(first.baselinesSha256);
    expect(second.closureSha256).not.toBe(first.closureSha256);
  });

  it("reuses only byte-identical content-addressed publications", async () => {
    const root = await privateRoot("shellx-motion-batch-quality-reuse-");
    const manifestPath = join(root, "quality.json");
    await writeFile(manifestPath, manifest(undefined, 1));
    const snapshot = await prepareBatchQualityManifestSnapshot({ sourcePath: manifestPath, context: context("ada") });
    const targetRoot = join(root, "snapshot", snapshot.closureSha256);
    const first = await publishBatchQualityManifestSnapshot({ snapshot, targetRoot });
    const second = await publishBatchQualityManifestSnapshot({ snapshot, targetRoot });
    expect(second).toEqual(first);
  });

  it("preserves literal template tokens for single-render snapshots", async () => {
    const root = await privateRoot("shellx-motion-single-quality-tokens-");
    const manifestPath = join(root, "quality.json");
    await writeFile(manifestPath, manifest(undefined, 1));
    const snapshot = await prepareBatchQualityManifestSnapshot({
      sourcePath: manifestPath,
      context: context("ada"),
      interpolate: false,
    });
    expect((snapshot.materializedManifest.samples as Array<{ id: string }>)[0]?.id).toBe("{{rowId}}");
  });

  it("refuses escaping baselines", async () => {
    const root = await privateRoot("shellx-motion-batch-quality-refusal-");
    const outside = await privateRoot("shellx-motion-batch-quality-outside-");
    const outsideBaseline = join(outside, "outside.png");
    const manifestPath = join(root, "quality.json");
    await writeFile(outsideBaseline, Buffer.from("outside"));
    await writeFile(manifestPath, manifest(outsideBaseline, 1));
    await expect(prepareBatchQualityManifestSnapshot({ sourcePath: manifestPath, context: context("ada") }))
      .rejects.toThrow(/escapes|root/i);
  });

  it.skipIf(process.platform === "win32")("refuses symlinked baselines", async () => {
    const root = await privateRoot("shellx-motion-batch-quality-refusal-");
    const outside = await privateRoot("shellx-motion-batch-quality-outside-");
    const outsideBaseline = join(outside, "outside.png");
    const manifestPath = join(root, "quality.json");
    await writeFile(outsideBaseline, Buffer.from("outside"));
    const linked = join(root, "linked.png");
    await symlink(outsideBaseline, linked);
    await writeFile(manifestPath, manifest("linked.png", 1));
    await expect(prepareBatchQualityManifestSnapshot({ sourcePath: manifestPath, context: context("ada") }))
      .rejects.toThrow(/regular non-symlink|symbolic|symlink/i);
  });

  it("shares one aggregate request budget across row snapshots", async () => {
    const root = await privateRoot("shellx-motion-batch-quality-budget-");
    const firstPath = join(root, "first.json");
    const secondPath = join(root, "second.json");
    const firstBytes = Buffer.from(manifest(undefined, 1));
    const secondBytes = Buffer.from(manifest(undefined, 2));
    await writeFile(firstPath, firstBytes);
    await writeFile(secondPath, secondBytes);
    const budget = new BoundedResourceBudget({
      maxFileBytes: Math.max(firstBytes.byteLength, secondBytes.byteLength),
      maxFiles: 2,
      maxPathDepth: 4,
      maxAggregateBytes: firstBytes.byteLength + secondBytes.byteLength - 1,
      maxConcurrentReads: 1,
    }, "test batch quality request");

    await prepareBatchQualityManifestSnapshot({ sourcePath: firstPath, context: context("ada"), requestBudget: budget });
    await expect(prepareBatchQualityManifestSnapshot({ sourcePath: secondPath, context: context("grace"), requestBudget: budget }))
      .rejects.toThrow(/aggregate limit/i);
  });
});

function manifest(baseline: string | undefined, minBrightPixels: number): string {
  return `${JSON.stringify({
    schema: "shellx-motion/quality-manifest@1",
    samples: [{ id: "{{rowId}}", atMs: 0, ...(baseline ? { baseline } : {}), minBrightPixels }],
  }, null, 2)}\n`;
}

function context(rowId: string) {
  return {
    values: {}, rowId, rowIndex: 0, rowHash: "a".repeat(64), rowKey: rowId,
    packageId: `pkg_${rowId}`, packageDir: `/private/packages/pkg_${rowId}`, outputPath: `/private/render/pkg_${rowId}.mp4`,
  };
}

async function privateRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}
