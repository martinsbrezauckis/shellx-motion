import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const race = vi.hoisted(() => ({ target: "", outsidePath: "" }));

// The source package is loaded before its declared asset is copied. Replacing that asset at the
// first bounded-read admission point is deterministic: the old `copyFile(resolvePackageAsset())`
// path never observed it, while a verified snapshot refuses the new symlink before publication.
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

import { runCli } from "./main.js";

const tempDirs: string[] = [];

describe("CLI batch asset snapshots", () => {
  afterEach(async () => {
    race.target = "";
    race.outsidePath = "";
    await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("copies the verified bytes and carries their source hash into the row receipt", async () => {
    const { packageRoot, assetPath, bytes } = await createBatchPackage();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-batch-snapshot-out-"));
    tempDirs.push(outDir);

    const result = await runCli(["render-batch", packageRoot, "--out", outDir, "--dry-run"]);

    expect(result).toMatchObject({ ok: true, command: "render-batch" });
    const staged = await readFile(join(outDir, "packages", "pkg_batch_card_ada", "assets", "brand.bin"));
    expect(staged).toEqual(bytes);
    const receipt = JSON.parse(await readFile(join(outDir, "receipts", "pkg_batch_card_ada.batch-row.receipt.json"), "utf8")) as { inputHashes: Record<string, string> };
    expect(receipt.inputHashes["assets/brand.bin"]).toBe(sha256(bytes));
    expect(await readFile(assetPath)).toEqual(bytes);
  });

  it.skipIf(process.platform === "win32")("refuses a source asset replaced by an outside symlink after package load", async () => {
    const { packageRoot, assetPath } = await createBatchPackage();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-cli-batch-snapshot-race-out-"));
    const outsideRoot = await mkdtemp(join(tmpdir(), "shellx-motion-cli-batch-snapshot-outside-"));
    tempDirs.push(outDir, outsideRoot);
    const outsidePath = join(outsideRoot, "brand.bin");
    await writeFile(outsidePath, "outside bytes");
    race.target = assetPath;
    race.outsidePath = outsidePath;

    await expect(runCli(["render-batch", packageRoot, "--out", outDir, "--dry-run"])).rejects.toThrow(/escapes its approved root/);
    expect(race.target, "a pathname copy would not observe this post-load source replacement").toBe("");
    await expect(readFile(join(outDir, "packages", "pkg_batch_card_ada", "assets", "brand.bin"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function createBatchPackage(): Promise<{ packageRoot: string; assetPath: string; bytes: Buffer }> {
  const packageRoot = await mkdtemp(join(tmpdir(), "shellx-motion-cli-batch-snapshot-package-"));
  tempDirs.push(packageRoot);
  await cp(resolve("../../fixtures/packages/batch-card"), packageRoot, { recursive: true });
  const manifestPath = join(packageRoot, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.assets = ["assets/brand.bin"];
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
  const assetPath = join(packageRoot, "assets", "brand.bin");
  const bytes = Buffer.from("verified CLI batch asset\n");
  await mkdir(join(packageRoot, "assets"), { recursive: true, mode: 0o700 });
  await writeFile(assetPath, bytes);
  return { packageRoot, assetPath, bytes };
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
