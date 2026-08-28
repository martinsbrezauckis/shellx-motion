import assert from "node:assert/strict";
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { encodeRgbaPng } from "../packages/core/src/quality";
import { hashBuffer, hashFile, hashFramePaths } from "../packages/core/src/receipts";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "../packages/core/src/output-path-trusted-workspace";
import { PUBLIC_PRODUCT_TEMPLATE_DIRS } from "./template-product-pack-catalog";
import {
  writeRepresentativeFrameReviewSet,
  type RepresentativeFrameReviewInput,
  type RepresentativeFrameReviewResult
} from "./representative-frame-review-sheet";

const tempRoots: string[] = [];
const SAMPLE_TIMES = [0, 250, 500, 750];
const BATCH_ROWS = ["motion_renderer_lane", "cut_generate_lane", "canvas_export_lane"] as const;

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })));
});

describe.skipIf(process.platform !== "linux")("representative-frame review sheets", () => {
  it("orders all 60 declared review cells and persists source, policy, artifact, and receipt identities", async () => {
    const fixture = await writeFixture();
    const result = await fixture.writeReview({
      sourceRevision: "a".repeat(40),
      proofRoot: fixture.proofRoot,
      batchRoot: fixture.batchRoot,
      outRoot: fixture.outRoot,
      extractBatchFrame: fixture.extractBatchFrame
    });

    expect(result.coverage).toEqual({
      promotedFamilies: 12,
      promotedCells: 48,
      productMetricBatchRows: 3,
      productMetricBatchCells: 12,
      totalCells: 60
    });
    const metadata = JSON.parse(await readFile(join(fixture.outRoot, result.metadataPath), "utf8"));
    expect(metadata.source).toEqual({ revision: "a".repeat(40) });
    expect(metadata.scope.humanReview.status).toBe("pending");
    expect(metadata.scope.automaticVisualAcceptance).toBe("absent");
    expect(metadata.promotedProof.policy).toEqual({ source: "fixtures/template-moving-proof-policy.json", sha256: "b".repeat(64) });
    expect(metadata.promotedProof.families.map((family: { family: string }) => family.family)).toEqual([...PUBLIC_PRODUCT_TEMPLATE_DIRS]);
    expect(metadata.productMetricBatch.rows.map((row: { rowId: string }) => row.rowId)).toEqual([...BATCH_ROWS]);
    expect(metadata.promotedProof.families[0].representativeFrames.map((frame: { atMs: number; deliveryFrameIndex: number }) => [frame.atMs, frame.deliveryFrameIndex]))
      .toEqual([[0, 0], [250, 1], [500, 2], [750, 3]]);
    expect(metadata.productMetricBatch.rows[0].representativeFrames.map((frame: { atMs: number; deliveryFrameIndex: number }) => [frame.atMs, frame.deliveryFrameIndex]))
      .toEqual([[0, 0], [250, 1], [500, 2], [750, 3]]);
    expect(metadata.promotedProof.families[0].finalArtifact.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(metadata.promotedProof.families[0].finalReceipt.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(metadata.productMetricBatch.rows[2].package.qualityManifest.sha256).toMatch(/^[a-f0-9]{64}$/);

    const promotedSheet = await readFile(join(fixture.outRoot, "sheets", "promoted-template-representative-review.svg"), "utf8");
    const batchSheet = await readFile(join(fixture.outRoot, "sheets", "product-metric-batch-representative-review.svg"), "utf8");
    expect(promotedSheet.match(/<image /g)).toHaveLength(48);
    expect(batchSheet.match(/<image /g)).toHaveLength(12);
    expect(promotedSheet.indexOf("audio-launch · 0ms")).toBeLessThan(promotedSheet.indexOf("tracked-callout-overlay · 750ms"));
  });

  it("publishes only self-contained, receipt-governed PNGs named by the review cells", async () => {
    const fixture = await writeFixture();
    await fixture.writeReview({
      sourceRevision: "a".repeat(40),
      proofRoot: fixture.proofRoot,
      batchRoot: fixture.batchRoot,
      outRoot: fixture.outRoot,
      extractBatchFrame: fixture.extractBatchFrame
    });
    const metadata = JSON.parse(await readFile(join(fixture.outRoot, "representative-review.json"), "utf8"));
    const expectedSources = new Map<string, string>();
    for (const family of metadata.promotedProof.families) {
      for (const frame of family.representativeFrames) {
        const sourcePath = join(fixture.proofRoot, "frames", family.family, `pkg_${family.family.replaceAll("-", "_")}`,
          `${String(frame.deliveryFrameIndex + 1).padStart(6, "0")}.png`);
        expectedSources.set(frame.path, sourcePath);
        expect(frame.sha256).toBe(await hashFile(sourcePath));
      }
    }
    for (const row of metadata.productMetricBatch.rows) {
      for (const frame of row.representativeFrames) {
        const sourcePath = join(dirname(fixture.proofRoot), "batch-source-frames", row.rowId,
          `${String(frame.deliveryFrameIndex + 1).padStart(6, "0")}.png`);
        expectedSources.set(frame.path, sourcePath);
        expect(frame.sha256).toBe(await hashFile(sourcePath));
      }
    }

    expect(expectedSources.size).toBe(60);
    expect([...expectedSources.keys()].every((path) => !path.startsWith("/") && !path.includes(".."))).toBe(true);
    expect(JSON.stringify(metadata)).not.toContain(fixture.proofRoot);
    expect(JSON.stringify(metadata)).not.toContain(fixture.batchRoot);

    const referenced = new Set<string>();
    for (const sheetName of ["promoted-template-representative-review.svg", "product-metric-batch-representative-review.svg"]) {
      const sheetPath = join(fixture.outRoot, "sheets", sheetName);
      const sheet = await readFile(sheetPath, "utf8");
      const hrefs = [...sheet.matchAll(/<image href="([^"]+)"/g)].map(([, href]) => href);
      const expectedDirectory = sheetName.startsWith("promoted-") ? "../promoted-delivered-frames/" : "../batch-delivered-frames/";
      expect(hrefs).toHaveLength(sheetName.startsWith("promoted-") ? 48 : 12);
      expect(hrefs.every((href) => href.startsWith(expectedDirectory))).toBe(true);
      for (const href of hrefs) {
        referenced.add(relative(fixture.outRoot, resolve(dirname(sheetPath), href)));
      }
    }
    expect([...referenced].sort()).toEqual([...expectedSources.keys()].sort());

    for (const [path, sourcePath] of expectedSources) {
      const deliveredPath = join(fixture.outRoot, path);
      const facts = await lstat(deliveredPath);
      expect(facts.isFile()).toBe(true);
      expect(facts.isSymbolicLink()).toBe(false);
      expect(await readFile(deliveredPath)).toEqual(await readFile(sourcePath));
      expect(await hashFile(deliveredPath)).toBe(await hashFile(sourcePath));
    }

    expect(await regularFilesBelow(fixture.outRoot)).toEqual([
      ...expectedSources.keys(),
      "representative-review.json",
      "sheets/product-metric-batch-representative-review.svg",
      "sheets/promoted-template-representative-review.svg"
    ].sort());
  });

  it("accepts Product Metric warning receipts only when their quality-passed evidence names the motion-density advisory", async () => {
    const fixture = await writeFixture({ productMetricWarnings: true });

    await expect(fixture.writeReview({
      sourceRevision: "a".repeat(40),
      proofRoot: fixture.proofRoot,
      batchRoot: fixture.batchRoot,
      outRoot: fixture.outRoot,
      extractBatchFrame: fixture.extractBatchFrame
    })).resolves.toMatchObject({ coverage: { productMetricBatchRows: 3, productMetricBatchCells: 12 } });
  });

  it("refuses failed, cancelled, undeclared-warning, and failed-quality Product Metric batch evidence", async () => {
    for (const [label, mutate] of [
      ["failed status", (receipt: Record<string, any>) => { receipt.status = "failed"; }],
      ["cancelled status", (receipt: Record<string, any>) => { receipt.status = "cancelled"; }],
      ["undeclared warning", (receipt: Record<string, any>) => {
        receipt.status = "warning";
        receipt.warnings = ["Delivered MP4 colour metadata does not match the declared profile."];
      }],
      ["failed quality check", (receipt: Record<string, any>) => { receipt.output.jobs[0].qualityCheck.status = "failed"; }]
    ] as const) {
      const fixture = await writeFixture();
      const aggregateReceiptPath = join(fixture.batchRoot, "receipts", "batch-render.receipt.json");
      const aggregateReceipt = JSON.parse(await readFile(aggregateReceiptPath, "utf8"));
      mutate(aggregateReceipt);
      await writeJson(aggregateReceiptPath, aggregateReceipt);

      await expect(fixture.writeReview({
        sourceRevision: "a".repeat(40),
        proofRoot: fixture.proofRoot,
        batchRoot: fixture.batchRoot,
        outRoot: fixture.outRoot,
        extractBatchFrame: fixture.extractBatchFrame
      }), label).rejects.toThrow();
    }
  });

  it("refuses a Product Metric child receipt whose quality check failed", async () => {
    const fixture = await writeFixture();
    const aggregateReceiptPath = join(fixture.batchRoot, "receipts", "batch-render.receipt.json");
    const aggregateReceipt = JSON.parse(await readFile(aggregateReceiptPath, "utf8"));
    const childReceiptPath = aggregateReceipt.output.jobs[0].receiptPath;
    const childReceipt = JSON.parse(await readFile(childReceiptPath, "utf8"));
    childReceipt.output.qualityCheck.status = "failed";
    await writeJson(childReceiptPath, childReceipt);

    await expect(fixture.writeReview({
      sourceRevision: "a".repeat(40),
      proofRoot: fixture.proofRoot,
      batchRoot: fixture.batchRoot,
      outRoot: fixture.outRoot,
      extractBatchFrame: fixture.extractBatchFrame
    })).rejects.toThrow("quality check must be passed");
  });

  it("refuses when a retained promoted proof frame is missing", async () => {
    const fixture = await writeFixture();
    await rm(join(fixture.proofRoot, "frames", "audio-launch", "pkg_audio_launch", "000003.png"));

    await expect(fixture.writeReview({
      sourceRevision: "a".repeat(40),
      proofRoot: fixture.proofRoot,
      batchRoot: fixture.batchRoot,
      outRoot: fixture.outRoot,
      extractBatchFrame: fixture.extractBatchFrame
    })).rejects.toThrow("retained frame count no longer matches");
    expect(await lstat(fixture.outRoot).catch(() => undefined)).toBeUndefined();
  });

  it("does not publish a staged review tree when a delivered frame is invalid", async () => {
    const fixture = await writeFixture();

    await expect(fixture.writeReview({
      sourceRevision: "a".repeat(40),
      proofRoot: fixture.proofRoot,
      batchRoot: fixture.batchRoot,
      outRoot: fixture.outRoot,
      extractBatchFrame: async ({ outputPath }) => await writeFile(outputPath, "not a PNG", "utf8")
    })).rejects.toThrow("not a readable PNG");
    expect(await lstat(fixture.outRoot).catch(() => undefined)).toBeUndefined();
  });

  it("refuses a non-empty review destination instead of overwriting prior evidence", async () => {
    const fixture = await writeFixture();
    await mkdir(fixture.outRoot, { recursive: true, mode: 0o700 });
    await writeFile(join(fixture.outRoot, "prior-evidence.txt"), "keep", "utf8");

    await expect(fixture.writeReview({
      sourceRevision: "a".repeat(40),
      proofRoot: fixture.proofRoot,
      batchRoot: fixture.batchRoot,
      outRoot: fixture.outRoot,
      extractBatchFrame: fixture.extractBatchFrame
    })).rejects.toThrow("absent or empty");
  });
});

async function writeFixture(options: { productMetricWarnings?: boolean } = {}): Promise<{
  proofRoot: string;
  batchRoot: string;
  outRoot: string;
  extractBatchFrame: (input: { artifactPath: string; frameIndex: number; outputPath: string }) => Promise<void>;
  writeReview: (input: RepresentativeFrameReviewInput) => Promise<RepresentativeFrameReviewResult>;
}> {
  // macOS exposes /var as a symlink to /private/var. Trusted workspace anchors require the
  // canonical spelling so the same fixture proves the same topology on every Unix host.
  const root = await mkdtemp(join(await realpath(tmpdir()), "shellx-motion-representative-review-"));
  tempRoots.push(root);
  const proofRoot = join(root, "proof");
  const batchRoot = join(root, "batch");
  const outRoot = join(root, "review");
  // CI and native qualification hosts do not share one umask. These are authority fixtures, so
  // their governed roots must be private by construction instead of inheriting a host's 0002.
  await mkdir(proofRoot, { mode: 0o700 });
  await mkdir(batchRoot, { mode: 0o700 });
  const workspaceAuthority = await createTrustedWorkspaceAnchor(root);
  const evidenceTemplates: unknown[] = [];
  const frameSources = new Map<string, string[]>();

  for (const family of [...PUBLIC_PRODUCT_TEMPLATE_DIRS].reverse()) {
    const packageId = `pkg_${family.replaceAll("-", "_")}`;
    const packageRoot = join(proofRoot, "packages", family);
    await writePackage({ packageRoot, packageId, width: 4, height: 2 });
    const framesDir = join(proofRoot, "frames", family, packageId);
    const sequenceFrames = await writeFrameSequence(framesDir, family.charCodeAt(0));
    const qualityManifestPath = join(packageRoot, "quality", "representative-frames.json");
    const artifactPath = join(proofRoot, "renders", `${family}.mp4`);
    await mkdir(join(proofRoot, "renders"), { recursive: true, mode: 0o700 });
    await writeFile(artifactPath, `final ${family}`, "utf8");
    const artifactSha256 = await hashFile(artifactPath);
    const framesSha256 = await frameSequenceSha256({ framesDir, sequenceFrames });
    const receiptPath = join(proofRoot, "receipts", `${family}.render.receipt.json`);
    const receipt = {
      schema: "shellx-motion/receipt@1",
      id: `render-${family}`,
      operation: "render.final",
      status: "passed",
      packageId,
      inputHashes: { frames: framesSha256, qualityManifest: await hashFile(qualityManifestPath) },
      output: { path: artifactPath, sha256: artifactSha256 },
      warnings: []
    };
    await writeJson(receiptPath, receipt);
    evidenceTemplates.push({
      packageDirName: family,
      outputPath: join("renders", `${family}.mp4`),
      receiptPath: join("receipts", `${family}.render.receipt.json`),
      receiptSha256: await hashFile(receiptPath)
    });
  }
  await writeJson(join(proofRoot, "evidence.json"), {
    schema: "shellx-motion/template-moving-proof@1",
    ok: true,
    proofProfile: { selectedTemplateDirs: [...PUBLIC_PRODUCT_TEMPLATE_DIRS] },
    retention: { state: "retained" },
    policy: { source: "fixtures/template-moving-proof-policy.json", sha256: "b".repeat(64) },
    templates: evidenceTemplates
  });

  const jobs: unknown[] = [];
  const productMetricWarnings = options.productMetricWarnings
    ? ["Rendered motion is static for 59.4% of its duration (3.566s of 6.000s across 2 frozen runs, longest 2.433s). Frozen (s): 1.767-2.900, 3.567-6.000. Verify this is intentional; measured when reference-frame mean absolute difference <= 0.003000 and adjacent changed-pixel ratio <= 0.001000 over runs of at least 0.300s."]
    : [];
  for (const [index, rowId] of BATCH_ROWS.entries()) {
    const packageId = `pkg_shellx_product_metric_card_${rowId}`;
    const packageRoot = join(batchRoot, "packages", packageId);
    const width = rowId === "canvas_export_lane" ? 1080 : 1920;
    const height = 1080;
    await writePackage({ packageRoot, packageId, width, height });
    const artifactPath = join(batchRoot, "render", `${packageId}.mp4`);
    await mkdir(join(batchRoot, "render"), { recursive: true, mode: 0o700 });
    await writeFile(artifactPath, `batch ${rowId}`, "utf8");
    const receiptPath = join(batchRoot, "receipts", `${packageId}.render.receipt.json`);
    await writeJson(receiptPath, {
      schema: "shellx-motion/receipt@1",
      id: `render-${rowId}`,
      operation: "render.final",
      status: options.productMetricWarnings ? "warning" : "passed",
      packageId,
      output: {
        path: artifactPath,
        sha256: await hashFile(artifactPath),
        width,
        height,
        qualityCheck: { status: "passed" }
      },
      warnings: productMetricWarnings
    });
    const sourceFrames = await writeFrameSequence(join(root, "batch-source-frames", rowId), 65 + index);
    frameSources.set(artifactPath, sourceFrames);
    jobs.push({
      rowId,
      rowHash: hashBuffer(Buffer.from(rowId, "utf8")),
      packageId,
      outputPath: artifactPath,
      receiptPath,
      status: options.productMetricWarnings ? "warning" : "passed",
      frameLane: "browser",
      qualityCheck: { status: "passed" },
      warnings: productMetricWarnings
    });
  }
  await writeJson(join(batchRoot, "receipts", "batch-render.receipt.json"), {
    schema: "shellx-motion/receipt@1",
    id: "batch-product-metric",
    operation: "render.batch",
    status: options.productMetricWarnings ? "warning" : "passed",
    inputHashes: { motion: hashBuffer(Buffer.from("product-metric", "utf8")) },
    output: { rows: 3, jobs },
    warnings: productMetricWarnings
  });

  return {
    proofRoot,
    batchRoot,
    outRoot,
    extractBatchFrame: async ({ artifactPath, frameIndex, outputPath }) => {
      const source = frameSources.get(artifactPath)?.[frameIndex];
      assert(source, `missing fake extraction source for ${artifactPath}`);
      await copyFile(source, outputPath);
    },
    writeReview: async (input) => await withTrustedWorkspaceAnchor(workspaceAuthority,
      async () => await writeRepresentativeFrameReviewSet(input))
  };
}

async function writePackage(input: { packageRoot: string; packageId: string; width: number; height: number }): Promise<void> {
  await writeJson(join(input.packageRoot, "manifest.json"), { schema: "shellx-motion/package@1", id: input.packageId, template: "template.json" });
  await writeJson(join(input.packageRoot, "motion.json"), { width: input.width, height: input.height, durationMs: 1000, fps: 4 });
  await writeJson(join(input.packageRoot, "template.json"), {
    schema: "shellx-motion/template@1",
    metadata: { qualityTargets: { manifest: "quality/representative-frames.json", representativeFramesMs: SAMPLE_TIMES } }
  });
  await writeJson(join(input.packageRoot, "quality", "representative-frames.json"), { schema: "shellx-motion/quality-manifest@1", samples: [] });
}

async function writeFrameSequence(root: string, shade: number): Promise<string[]> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const paths: string[] = [];
  for (let index = 0; index < 4; index += 1) {
    const path = join(root, `${String(index + 1).padStart(6, "0")}.png`);
    const rgba = Buffer.from([shade, index * 20, 255 - shade, 255, shade, index * 20, 255 - shade, 255]);
    await writeFile(path, encodeRgbaPng(2, 1, rgba));
    paths.push(path);
  }
  return paths;
}

async function frameSequenceSha256(input: { framesDir: string; sequenceFrames: string[] }): Promise<string> {
  return hashBuffer(Buffer.from(JSON.stringify({
    framesDir: input.framesDir,
    framePattern: "%06d.png",
    frameCount: input.sequenceFrames.length,
    frameHashes: await hashFramePaths(input.sequenceFrames),
    fps: 4,
    width: 4,
    height: 2,
    durationMs: 1000
  }), "utf8"));
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function regularFilesBelow(root: string, directory: string = root): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await regularFilesBelow(root, path));
    else if (entry.isFile()) files.push(relative(root, path));
  }
  return files.sort();
}
