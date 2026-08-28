import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const race = vi.hoisted(() => ({ target: "", outsidePath: "" }));

// This replacement occurs after `loadMotionPackage()` has parsed manifest.json and motion.json.
// The legacy copyFile path never lstat'ed the source, so it would silently stage the outside bytes.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const info = await actual.lstat(...args);
      if (race.target && String(args[0]) === race.target) {
        const target = race.target;
        race.target = "";
        await actual.rm(target);
        await actual.symlink(race.outsidePath, target);
      }
      return info;
    }
  };
});

import { dispatchDebugCommand } from "./index.js";

const tempDirs: string[] = [];

describe("Debug batch asset snapshots", () => {
  afterEach(async () => {
    race.target = "";
    race.outsidePath = "";
    await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("copies verified asset bytes and records their hash in the Debug row receipt", async () => {
    const { packageRoot, bytes } = await createBatchPackage();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-batch-snapshot-out-"));
    tempDirs.push(outDir);

    const result = await dispatchDebugCommand("motion.render.batch", { packageRoot, outDir, dryRun: true }, { tier: "render_motion" });

    expect(result.ok).toBe(true);
    const staged = await readFile(join(outDir, "packages", "pkg_batch_card_ada", "assets", "brand.bin"));
    expect(staged).toEqual(bytes);
    const receipt = JSON.parse(await readFile(join(outDir, "receipts", "pkg_batch_card_ada.batch-row.receipt.json"), "utf8")) as { inputHashes: Record<string, string> };
    expect(receipt.inputHashes["assets/brand.bin"]).toBe(sha256(bytes));
  });

  it.skipIf(process.platform === "win32")("refuses a post-load outside symlink instead of staging it", async () => {
    const { packageRoot, assetPath } = await createBatchPackage();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-batch-snapshot-race-out-"));
    const outsideRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-batch-snapshot-outside-"));
    tempDirs.push(outDir, outsideRoot);
    const outsidePath = join(outsideRoot, "brand.bin");
    await writeFile(outsidePath, "outside bytes");
    race.target = assetPath;
    race.outsidePath = outsidePath;

    const result = await dispatchDebugCommand("motion.render.batch", { packageRoot, outDir, dryRun: true }, { tier: "render_motion" });

    expect(result.ok).toBe(false);
    expect(race.target, "a pathname copy would not observe this post-load source replacement").toBe("");
    await expect(readFile(join(outDir, "packages", "pkg_batch_card_ada", "assets", "brand.bin"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains template, declared assets, and the template quality-manifest sidecar", async () => {
    const sourceRoot = resolve("../../templates/shellx-product-pack/product-metric-card");
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-batch-template-snapshot-"));
    tempDirs.push(outDir);
    const sourceTemplate = JSON.parse(await readFile(join(sourceRoot, "template.json"), "utf8")) as { metadata?: { qualityTargets?: { manifest?: string } } };
    const qualityRef = sourceTemplate.metadata?.qualityTargets?.manifest;
    expect(qualityRef).toBeTruthy();

    const result = await dispatchDebugCommand("motion.render.batch", { packageRoot: sourceRoot, outDir, dryRun: true }, { tier: "render_motion" });

    expect(result.ok).toBe(true);
    const firstPackage = join(outDir, "packages", "pkg_shellx_product_metric_card_motion_renderer_lane");
    const [template, quality, font] = await Promise.all([
      readFile(join(firstPackage, "template.json")),
      readFile(join(firstPackage, qualityRef!)),
      readFile(join(firstPackage, "assets", "fonts", "inter-latin-600-normal.woff2"))
    ]);
    expect(template.byteLength).toBeGreaterThan(0);
    expect(quality.byteLength).toBeGreaterThan(0);
    expect(font.byteLength).toBeGreaterThan(0);
  });
});

async function createBatchPackage(): Promise<{ packageRoot: string; assetPath: string; bytes: Buffer }> {
  const packageRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-batch-snapshot-package-"));
  tempDirs.push(packageRoot);
  await cp(resolve("../../fixtures/packages/batch-card"), packageRoot, { recursive: true });
  const manifestPath = join(packageRoot, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.assets = ["assets/brand.bin"];
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
  const assetPath = join(packageRoot, "assets", "brand.bin");
  const bytes = Buffer.from("verified Debug batch asset\n");
  await mkdir(join(packageRoot, "assets"), { recursive: true, mode: 0o700 });
  await writeFile(assetPath, bytes);
  return { packageRoot, assetPath, bytes };
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
