/**
 * local-render-tool-provenance.test.ts — the local SDK's share of FFprobe receipt provenance.
 *
 * the tool-provenance invariant named three surfaces that must record the same evidence: the CLI, the
 * debug/MCP transport, and the local SDK. The SDK's render path is not a fourth implementation — it
 * dispatches `motion.render.final` and persists the receipt that command returns — so the fix lands
 * there by inheritance. Inheritance is exactly the kind of claim that quietly stops being true, so
 * it is asserted here on the RECEIPT FILE the SDK writes to disk, which is the artefact a host or
 * ShellX Cut actually reads.
 *
 * No real FFmpeg or FFprobe runs: the SDK's `ffmpegRunner` seam answers every command.
 *
 * Dependencies: `./local` (SDK), the debug API it dispatches into. Primary caller: vitest.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashFile } from "@shellx-motion/core";
import { createLocalMotionSdk } from "./local";

const tempDirs: string[] = [];

/** A 2×1 PNG with one bright and one dark pixel — enough to satisfy a `minBrightPixels` sample. */
const CONTRAST_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGYktHRAD/AP8A/6C9p5MAAAAHdElNRQfqBh4KOQqnS6Y6AAAAEGNhTnYAAAABAAAAAQAAAAAAAAAAmdvqagAAABFJREFUCNdjZGBg+P///38GAA4EA/75rp4uAAAAAElFTkSuQmCC",
  "base64"
);

/** Read the single render receipt the SDK persisted under `receiptsRoot`. */
async function readRenderReceipt(receiptsRoot: string, receiptId: string): Promise<Record<string, unknown>> {
  const files = await readdir(receiptsRoot);
  const match = files.find((file) => file.includes(receiptId.replace(/[^a-zA-Z0-9_.-]/g, "_")));
  expect(match, `no receipt file for ${receiptId} in ${files.join(", ")}`).toBeDefined();
  return JSON.parse(await readFile(join(receiptsRoot, match as string), "utf8")) as Record<string, unknown>;
}

function sdkFor(counters: { encodes: number; ffprobeVersionProbes: number }) {
  return createLocalMotionSdk({
    browserFrameRenderer: async (pkg, options) => {
      const path = options.outputPath ?? join(options.outDir, "frame.png");
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, CONTRAST_PNG);
      const output = {
        path,
        sha256: await hashFile(path),
        format: "png" as const,
        width: pkg.motion.width,
        height: pkg.motion.height,
        atMs: options.atMs,
        browser: { name: "chromium", version: "sdk-test" },
        viewport: { width: pkg.motion.width, height: pkg.motion.height, deviceScaleFactor: 1 }
      };
      return {
        ok: true as const,
        output,
        receipt: {
          schema: "shellx-motion/receipt@1",
          id: `preview-${options.atMs}`,
          operation: "preview.frame",
          status: "passed",
          packageId: pkg.manifest.id,
          inputHashes: { motion: "d".repeat(64) },
          createdAt: "2026-07-01T00:00:00.000Z",
          lane: "browser",
          output,
          warnings: []
        }
      };
    },
    ffmpegRunner: async (command) => {
      if (command.executable.includes("ffprobe")) {
        if (command.args[0] === "-version") {
          counters.ffprobeVersionProbes += 1;
          return { exitCode: 0, stdout: "ffprobe version sdk-fixture", stderr: "" };
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            streams: [{ codec_type: "video", codec_name: "h264", width: 960, height: 540, avg_frame_rate: "24/1" }],
            format: { duration: "2.000000", format_name: "mov,mp4,m4a,3gp,3g2,mj2" }
          }),
          stderr: ""
        };
      }
      if (command.args[0] === "-version") return { exitCode: 0, stdout: "ffmpeg version sdk-fixture", stderr: "" };
      if (command.args.includes("-encoders")) return { exitCode: 0, stdout: "", stderr: "" };
      const outputPath = command.args.at(-1) as string;
      await mkdir(dirname(outputPath), { recursive: true });
      // Branch on the OUTPUT EXTENSION, not on `-frames:v`: the image-sequence encode itself carries
      // `-frames:v` to bound the muxed output, so keying on the flag wrote PNG bytes into the .mp4
      // and the artifact magic-byte check rejected it.
      if (outputPath.endsWith(".png")) await writeFile(outputPath, CONTRAST_PNG);
      else {
        counters.encodes += 1;
        await writeFile(outputPath, Buffer.from([0, 0, 0, 24, ...Buffer.from("ftypisom sdk local", "ascii")]));
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    }
  });
}

describe("local SDK render — FFprobe provenance parity", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("persists output.tools.ffprobe on the receipt when a quality manifest read the encode back", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-sdk-tool-provenance-"));
    tempDirs.push(root);
    const artifactRoot = join(root, "run");
    const receiptsRoot = join(artifactRoot, ".shellx-motion", "receipts");
    const manifestPath = join(root, "quality-manifest.json");
    await writeFile(manifestPath, `${JSON.stringify({
      schema: "shellx-motion/quality-manifest@1",
      samples: [{ id: "sample", atMs: 0, minBrightPixels: 1, minEdgePixels: 0, maxChangedPixels: 0, maxMeanDiff: 0 }]
    }, null, 2)}\n`, "utf8");
    const counters = { encodes: 0, ffprobeVersionProbes: 0 };

    const rendered = await sdkFor(counters).render({
      packageRoot: resolve("../../fixtures/packages/lower-third"),
      outputPath: join(artifactRoot, "final.mp4"),
      artifactRoot,
      receiptsRoot,
      preset: "mp4-h264",
      qualityManifestPath: manifestPath
    });
    if (!rendered.ok) throw new Error(`local SDK render failed: ${JSON.stringify(rendered.error)}`);

    const receipt = await readRenderReceipt(receiptsRoot, rendered.output.receiptId as string);
    const tools = (receipt.output as Record<string, unknown>).tools as Record<string, unknown>;

    // The SDK does not re-implement the rule; it inherits the debug API's. Asserted on the persisted
    // file because that is what a host and ShellX Cut read.
    expect(tools.ffprobe).toMatchObject({ tool: "ffprobe", version: "ffprobe version sdk-fixture" });
    expect(tools.ffmpeg).toMatchObject({ tool: "ffmpeg" });
    expect(counters.ffprobeVersionProbes).toBe(1);
    // Additive: the fields a receipt consumer already binds to are untouched.
    expect(receipt).toMatchObject({ schema: "shellx-motion/receipt@1", operation: "render.final", lane: "ffmpeg" });
  }, 120000);

  it("leaves FFprobe unnamed, and unprobed, on a render with no quality manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-sdk-tool-provenance-absent-"));
    tempDirs.push(root);
    const artifactRoot = join(root, "run");
    const receiptsRoot = join(artifactRoot, ".shellx-motion", "receipts");
    const counters = { encodes: 0, ffprobeVersionProbes: 0 };

    const rendered = await sdkFor(counters).render({
      packageRoot: resolve("../../fixtures/packages/lower-third"),
      outputPath: join(artifactRoot, "final.mp4"),
      artifactRoot,
      receiptsRoot,
      preset: "mp4-h264"
    });
    if (!rendered.ok) throw new Error(`local SDK render failed: ${JSON.stringify(rendered.error)}`);

    const receipt = await readRenderReceipt(receiptsRoot, rendered.output.receiptId as string);
    const tools = (receipt.output as Record<string, unknown>).tools as Record<string, unknown>;

    expect(tools.ffmpeg).toBeDefined();
    // Nothing read the file back, so nothing claims to have — and no process was spawned to ask.
    expect(tools.ffprobe).toBeUndefined();
    expect(counters.ffprobeVersionProbes).toBe(0);
  }, 120000);
});
