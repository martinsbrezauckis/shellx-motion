/**
 * CLI regression suite for the text-delivery invariant: the native frame lane must not produce a DELIVERY render whose
 * text it cannot draw faithfully.
 *
 * Role: drives `runCli` end to end over temp packages and asserts the three halves of the fix —
 *   1. delivery renders (`--preset png-sequence` / encoded video) through `--frame-lane native`
 *      refuse with the typed `native_text_not_deliverable` error and write no frames,
 *   2. preview and still-frame renders through the same lane keep working (its declared render
 *      targets) and report the unfaithful text as receipt warnings instead of silence,
 *   3. non-ASCII text is refused by the capability gate on every target, including preview, because
 *      the block-glyph fallback would draw codepoint noise rather than an approximation.
 *
 * Lives in its own file rather than in `main.test.ts` to keep that file under the module-size gate.
 *
 * Dependencies: `./main` (`runCli`), node fs/os/path built-ins. Self-contained fixtures — no shared
 * temp-dir registry, each test cleans up its own directory.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli as runCliRaw, type RunCliOptions } from "./main";

const runCli = (argv: string[], options: RunCliOptions = {}) => runCliRaw(argv, { trustedLocalTier: true, ...options });

const created: string[] = [];

afterEach(async () => {
  for (const dir of created.splice(0, created.length)) {
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * Write a 3-frame package whose single text layer says `text`.
 *
 * @param text Layer text under test.
 * @param style Extra style keys merged into the text layer (used for the fontFamily case).
 */
async function writeTextPackage(text: string, style: Record<string, unknown> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-native-text-delivery-"));
  created.push(root);
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_native_text_delivery",
      name: "Native Text Delivery",
      motion: "motion.json",
      assets: [],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["native", "ffmpeg"], hosts: ["motion"] }
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: "motion_native_text_delivery",
      name: "Native Text Delivery",
      durationMs: 300,
      fps: 10,
      width: 64,
      height: 36,
      background: "#102030",
      layers: [{
        id: "title",
        type: "text",
        text,
        startMs: 0,
        durationMs: 300,
        transform: { x: 4, y: 4, scale: 1 },
        style: { color: "#ffffff", fontSize: 14, ...style }
      }],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    }, null, 2)}\n`
  );
  return root;
}

async function makeOutDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "shellx-motion-native-text-delivery-out-"));
  created.push(dir);
  return dir;
}

describe("native frame lane delivery text gate", () => {
  it("refuses a native PNG-sequence delivery of lowercase text and writes no frames", async () => {
    const packageRoot = await writeTextPackage("Sveiks");
    const outDir = await makeOutDir();
    const framesDir = join(outDir, "frames");

    const result = await runCli([
      "render", packageRoot, "--lane", "ffmpeg", "--preset", "png-sequence",
      "--frame-lane", "native", "--out", framesDir
    ]);

    expect(result).toMatchObject({
      ok: false,
      command: "render",
      lane: "image-sequence",
      frameLane: "native",
      error: {
        code: "native_text_not_deliverable",
        message: expect.stringContaining("--frame-lane browser"),
        unsupported: [{
          layerId: "title",
          feature: "text.case.preserved",
          reason: "Lane native would case-fold delivered text on layer title: veiks have no lowercase block glyph."
        }]
      },
      frames: { dir: framesDir, count: 0 }
    });
    // The refusal happens before the first frame is encoded, so nothing lands in the deliverable dir.
    expect(await readdir(framesDir)).toEqual([]);
  });

  it("refuses a native final-encode delivery and never invokes FFmpeg", async () => {
    const packageRoot = await writeTextPackage("Sveiks");
    const outDir = await makeOutDir();
    const ffmpegCalls: string[][] = [];

    const result = await runCli([
      "render", packageRoot, "--lane", "ffmpeg", "--preset", "mp4-h264",
      "--frame-lane", "native", "--out", join(outDir, "final.mp4"),
      "--frames-dir", join(outDir, "scratch")
    ], {
      ffmpegRunner: async (command) => {
        ffmpegCalls.push(command.args);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    });

    expect(result).toMatchObject({
      ok: false,
      command: "render",
      lane: "ffmpeg",
      frameLane: "native",
      error: { code: "native_text_not_deliverable" }
    });
    // Only the ffmpeg health probe may run; no encode command is issued and no MP4 exists.
    expect(ffmpegCalls.every((args) => args.includes("-version"))).toBe(true);
    await expect(readFile(join(outDir, "final.mp4"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a native delivery whose text requests a font family the lane ignores", async () => {
    const packageRoot = await writeTextPackage("BRAND", { fontFamily: "Inter" });
    const outDir = await makeOutDir();

    const result = await runCli([
      "render", packageRoot, "--lane", "ffmpeg", "--preset", "png-sequence",
      "--frame-lane", "native", "--out", join(outDir, "frames")
    ]);

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "native_text_not_deliverable",
        unsupported: [{
          layerId: "title",
          feature: "text.font.family",
          reason: "Lane native ignores the requested font family 'Inter' on layer title; delivered text would not use it."
        }]
      }
    });
  });

  it("still delivers a native PNG sequence for text the block-glyph set covers", async () => {
    // The demotion is scoped to text the lane cannot draw: uppercase ASCII delivery still works, so
    // native remains the fast CI/fixture-smoke lane.
    const packageRoot = await writeTextPackage("SHIP IT 2026");
    const outDir = await makeOutDir();
    const framesDir = join(outDir, "frames");

    const result = await runCli([
      "render", packageRoot, "--lane", "ffmpeg", "--preset", "png-sequence",
      "--frame-lane", "native", "--out", framesDir
    ]);

    expect(result).toMatchObject({ ok: true, lane: "image-sequence", frameLane: "native", frames: { dir: framesDir, count: 3 } });
    expect(await readdir(framesDir)).toContain("000001.png");
  });

  it("keeps native preview and still-frame renders working and reports the case fold as a warning", async () => {
    const packageRoot = await writeTextPackage("Sveiks");
    const outDir = await makeOutDir();
    // Each render keeps an immutable output-specific receipt beside the output. Separate parents
    // keep this text-capability test independent from receipt replacement policy.
    const previewPath = join(outDir, "preview", "frame.png");
    const stillPath = join(outDir, "still", "frame.png");
    await mkdir(join(outDir, "preview"), { recursive: true, mode: 0o700 });
    await mkdir(join(outDir, "still"), { recursive: true, mode: 0o700 });

    const preview = await runCli(["render", packageRoot, "--lane", "native", "--out", previewPath]);
    const still = await runCli([
      "render", packageRoot, "--lane", "ffmpeg", "--preset", "png-frame",
      "--frame-lane", "native", "--out", stillPath
    ]);

    expect(preview).toMatchObject({
      ok: true,
      lane: "native",
      receipt: {
        operation: "preview.frame",
        status: "warning",
        warnings: ["Native renderer case-folded lowercase text to uppercase block glyphs on layer title: veiks."]
      }
    });
    expect(still).toMatchObject({ ok: true, lane: "image", frameLane: "native", preset: "png-frame" });
    expect((await readFile(previewPath)).subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect((await readFile(stillPath)).subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  });

  it("refuses non-ASCII text on the native lane at every render target, preview included", async () => {
    // Latin-Extended, Cyrillic, CJK, emoji and typographic punctuation used to reach the block-glyph
    // fallback and render as codepoint-derived noise boxes. They are now a capability miss.
    for (const text of ["ZIEMEĻU ZIBENS", "МОСКВА", "東京", "SHIP \u{1F680}", "IT’S FINE"]) {
      const packageRoot = await writeTextPackage(text);
      const outDir = await makeOutDir();

      const preview = await runCli(["render", packageRoot, "--lane", "native", "--out", join(outDir, "preview.png")]);

      expect(preview).toMatchObject({
        ok: false,
        lane: "native",
        error: {
          code: "unsupported_layer",
          unsupported: expect.arrayContaining([
            expect.objectContaining({ layerId: "title", feature: "text.charset.non-ascii" })
          ])
        }
      });
    }
  });

  it("renders the same non-ASCII package correctly on the browser lane it points to", async () => {
    const packageRoot = await writeTextPackage("ZIEMEĻU ZIBENS");
    const outDir = await makeOutDir();
    const outputPath = join(outDir, "browser.png");

    const result = await runCli([
      "render", packageRoot, "--lane", "ffmpeg", "--preset", "png-frame",
      "--frame-lane", "browser", "--out", outputPath
    ]);

    expect(result).toMatchObject({ ok: true, lane: "image", frameLane: "browser", preset: "png-frame" });
    expect((await readFile(outputPath)).subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  }, 120000);
});
