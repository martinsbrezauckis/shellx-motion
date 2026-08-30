/**
 * Regression coverage for render receipt persistence.
 *
 * The defect these guard: `render` used to reach its receipt-writing code only through the
 * browser-workflow catalog path, so an ordinary render produced media and no receipt file at
 * all — the receipt existed only as transient stdout JSON. Every lane is asserted separately
 * because each resolves its receipt path differently.
 */
import { lstat, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OperationReceipt } from "@shellx-motion/core";
import { writeTinyNativePackage } from "./main.fixtures-packages";
import { runCli as runCliRaw, type RunCliOptions } from "./main";
import { renderReceiptPathForOutput, writeRenderReceiptFile } from "./render-receipt-file";

const runCli = (argv: string[], options: RunCliOptions = {}) => runCliRaw(argv, { trustedLocalTier: true, ...options });

/** The id declared by `writeTinyNativePackage`; receipts still bind it, but the sidecar follows --out. */
const PACKAGE_ID = "pkg_cli_ffmpeg_sequence";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempRoot(label: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `shellx-motion-render-receipt-${label}-`));
  tempDirs.push(dir);
  return dir;
}

/** Read a receipt file and fail loudly with the directory listing when it is missing. */
async function readReceiptFile(receiptPath: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await readFile(receiptPath, "utf8");
  } catch {
    const listing = await readdir(dirname(receiptPath)).catch(() => ["<unreadable>"]);
    throw new Error(`No render receipt at ${receiptPath}. Directory contains: ${listing.join(", ")}`);
  }
  return JSON.parse(raw) as Record<string, unknown>;
}

function testReceipt(id: string): OperationReceipt {
  return {
    schema: "shellx-motion/receipt@1",
    id,
    operation: "render.final",
    status: "passed",
    packageId: PACKAGE_ID,
    inputHashes: {},
    createdAt: "2026-08-12T00:00:00.000Z",
    lane: "ffmpeg",
    output: {},
    warnings: []
  };
}

describe("render writes its receipt to disk", () => {
  it("writes a receipt beside the delivered file for the image-sequence lane", async () => {
    const outRoot = await tempRoot("sequence");
    const packageRoot = await writeTinyNativePackage();
    tempDirs.push(packageRoot);
    const outDir = join(outRoot, "frames");

    const result = await runCli([
      "render", packageRoot, "--lane", "ffmpeg", "--preset", "png-sequence", "--frame-lane", "native", "--out", outDir
    ]);

    expect(result).toMatchObject({ ok: true, command: "render", lane: "image-sequence" });
    // The sequence lane delivers into a directory, so the receipt belongs inside it.
    const receiptPath = renderReceiptPathForOutput(PACKAGE_ID, outDir, "image-sequence");
    expect(result.receiptPath).toBe(receiptPath);
    const receipt = await readReceiptFile(receiptPath);
    expect(receipt.id).toEqual(expect.any(String));
    expect(receipt.artifacts).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "render_receipt", path: receiptPath })])
    );
  });

  it("writes a receipt beside the delivered file for the still-image lane", async () => {
    const outRoot = await tempRoot("still");
    const packageRoot = await writeTinyNativePackage();
    tempDirs.push(packageRoot);
    const outPath = join(outRoot, "still.png");

    const result = await runCli([
      "render", packageRoot, "--lane", "ffmpeg", "--preset", "png-frame", "--frame-lane", "native", "--out", outPath
    ]);

    expect(result).toMatchObject({ ok: true, command: "render", lane: "image" });
    // A file delivery puts the receipt next to the file, not inside it.
    const receiptPath = renderReceiptPathForOutput(PACKAGE_ID, outPath, "image");
    expect(receiptPath).toBe(join(outRoot, "still.png.receipt.json"));
    expect(result.receiptPath).toBe(receiptPath);
    await readReceiptFile(receiptPath);
  });

  it("records the receipt path in the envelope so an agent never has to guess it", async () => {
    const outRoot = await tempRoot("envelope");
    const packageRoot = await writeTinyNativePackage();
    tempDirs.push(packageRoot);
    const outDir = join(outRoot, "frames");

    const result = await runCli([
      "render", packageRoot, "--lane", "ffmpeg", "--preset", "png-sequence", "--frame-lane", "native", "--out", outDir
    ]);

    // The envelope path and the on-disk receipt must be the same file: the whole point is that a
    // caller which only kept the envelope can still find the evidence later.
    expect(typeof result.receiptPath).toBe("string");
    const onDisk = await readReceiptFile(result.receiptPath as string);
    expect(onDisk.id).toBe((result.receipt as Record<string, unknown>).id);
  });
});

describe("renderReceiptPathForOutput", () => {
  it("derives a deterministic output-specific receipt sidecar for every delivery lane", () => {
    const outRoot = join(process.cwd(), "out");
    expect(renderReceiptPathForOutput("pkg_a", join(outRoot, "frames"), "image-sequence"))
      .toBe(join(outRoot, "frames", "frames.receipt.json"));
    expect(renderReceiptPathForOutput("pkg_a", join(outRoot, "clip.mp4"), "ffmpeg"))
      .toBe(join(outRoot, "clip.mp4.receipt.json"));
    expect(renderReceiptPathForOutput("pkg_a", join(outRoot, "still.png"), "image"))
      .toBe(join(outRoot, "still.png.receipt.json"));
  });

  it("does not collide when one package names two distinct final outputs in one directory", () => {
    const outRoot = join(process.cwd(), "out");
    const first = renderReceiptPathForOutput("pkg_a", join(outRoot, "take-one.mp4"), "ffmpeg");
    const second = renderReceiptPathForOutput("pkg_a", join(outRoot, "take-two.mp4"), "ffmpeg");

    expect(first).toBe(join(outRoot, "take-one.mp4.receipt.json"));
    expect(second).toBe(join(outRoot, "take-two.mp4.receipt.json"));
    expect(second).not.toBe(first);
  });
});

describe("render receipt publication", () => {
  it.skipIf(process.platform === "win32")("never follows a pre-created receipt symlink", async () => {
    const root = await tempRoot("receipt-symlink");
    const receiptPath = join(root, "pkg-render.receipt.json");
    const sentinelPath = join(root, "sentinel.json");
    await writeFile(sentinelPath, "keep this target", "utf8");
    await symlink(sentinelPath, receiptPath, "file");

    await expect(writeRenderReceiptFile(testReceipt("symlink-attempt"), receiptPath))
      .rejects.toMatchObject({ code: "derived_output_exists" });

    expect(await readFile(sentinelPath, "utf8")).toBe("keep this target");
    expect((await lstat(receiptPath)).isSymbolicLink()).toBe(true);
  });

  it("requires explicit replacement authority for an existing regular receipt", async () => {
    const root = await tempRoot("receipt-force");
    const receiptPath = join(root, "pkg-render.receipt.json");
    await writeFile(receiptPath, "old attestation", "utf8");

    await expect(writeRenderReceiptFile(testReceipt("without-force"), receiptPath))
      .rejects.toMatchObject({ code: "derived_output_exists" });
    expect(await readFile(receiptPath, "utf8")).toBe("old attestation");

    await writeRenderReceiptFile(testReceipt("with-force"), receiptPath, { force: true });
    expect(await readReceiptFile(receiptPath)).toMatchObject({ id: "with-force" });
  });

  it("preserves a regular receipt substituted after forced staging", async () => {
    const root = await tempRoot("receipt-force-swap");
    const receiptPath = join(root, "pkg-render.receipt.json");
    await writeFile(receiptPath, "observed receipt", "utf8");

    await expect(writeRenderReceiptFile(testReceipt("forced-swap"), receiptPath, {
      force: true,
      afterStageVerified: async () => {
        await rm(receiptPath);
        await writeFile(receiptPath, "competing receipt", "utf8");
      }
    })).rejects.toMatchObject({ code: "derived_output_exists" });

    expect(await readFile(receiptPath, "utf8")).toBe("competing receipt");
  });
});
