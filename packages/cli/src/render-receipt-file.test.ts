/**
 * Regression coverage for render receipt persistence.
 *
 * The defect these guard: `render` used to reach its receipt-writing code only through the
 * browser-workflow catalog path, so an ordinary render produced media and no receipt file at
 * all — the receipt existed only as transient stdout JSON. Every lane is asserted separately
 * because each resolves its receipt path differently.
 */
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeTinyNativePackage } from "./main.fixtures-packages";
import { runCli as runCliRaw, type RunCliOptions } from "./main";
import { renderReceiptPathForOutput } from "./render-receipt-file";

const runCli = (argv: string[], options: RunCliOptions = {}) => runCliRaw(argv, { trustedLocalTier: true, ...options });

/** The id declared by `writeTinyNativePackage`; the receipt file name is derived from it. */
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
    expect(receiptPath).toBe(join(outRoot, `${PACKAGE_ID}-render.receipt.json`));
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
  it("puts the receipt inside a sequence directory and beside a delivered file", () => {
    const outRoot = join(process.cwd(), "out");
    expect(renderReceiptPathForOutput("pkg_a", join(outRoot, "frames"), "image-sequence"))
      .toBe(join(outRoot, "frames", "pkg_a-render.receipt.json"));
    expect(renderReceiptPathForOutput("pkg_a", join(outRoot, "clip.mp4"), "ffmpeg"))
      .toBe(join(outRoot, "pkg_a-render.receipt.json"));
    expect(renderReceiptPathForOutput("pkg_a", join(outRoot, "still.png"), "image"))
      .toBe(join(outRoot, "pkg_a-render.receipt.json"));
  });
});
