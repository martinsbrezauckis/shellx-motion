/**
 * Regression coverage for frame-lane warning propagation.
 *
 * The defect these guard: a render whose frame receipts reported `status:"warning"` with
 * font-fallback warnings produced a final receipt reporting `status:"passed"` with none of them,
 * so an agent reading the receipt would conclude the render used the fonts it asked for.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OperationReceipt } from "@shellx-motion/core";
import type { BrowserFrameRenderer } from "@shellx-motion/debug-api";
import type { FfmpegCommand, FfmpegRunner } from "@shellx-motion/renderer-ffmpeg";
import { FrameLaneWarnings } from "./frame-lane-warnings";
import { writeTinyNativePackage } from "./main.fixtures-packages";
import { cliDebugReceipt, rgbaPng } from "./main.test-support";
import { runCli as runCliRaw, type RunCliOptions } from "./main";
import { renderReceiptPathForOutput } from "./render-receipt-file";

const runCli = (argv: string[], options: RunCliOptions = {}) => runCliRaw(argv, { trustedLocalTier: true, ...options });
const PACKAGE_ID = "pkg_cli_ffmpeg_sequence";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function receipt(status: OperationReceipt["status"], warnings: string[] = []): OperationReceipt {
  return { schema: "shellx-motion/receipt@1", id: "r", operation: "render.final", status, packageId: "p", inputHashes: {}, createdAt: "2026-08-02T00:00:00.000Z", lane: "ffmpeg", output: {}, warnings };
}

describe("FrameLaneWarnings resolves the frame lane's audio handoff", () => {
  // The browser frame lane does not draw audio layers (FFmpeg muxes them downstream), so the
  // handoff must be structured evidence rather than an ordinary warning. A frame receipt's status is
  // derived from `warnings.length`, so a completely successful audio render came out `warning` and
  // failed the `audio-launch` product-pack proof. The handoff is now structured evidence, and the
  // delivery lane is what decides whether it was honoured.
  const frameWithHandoff = {
    status: "passed",
    warnings: [],
    output: { audioHandoff: { status: "handled_downstream", handledBy: "ffmpeg", layers: [{ id: "music-bed", type: "audio" }] } }
  };

  it("keeps a delivered audio render passed and records the handoff as resolved evidence", () => {
    const accumulator = new FrameLaneWarnings();
    accumulator.observe(frameWithHandoff);
    accumulator.observe(frameWithHandoff);
    const delivered = receipt("passed");
    delivered.output = { path: "out.mp4", audio: { codec: "aac" } };

    accumulator.applyTo(delivered);

    expect(delivered.status).toBe("passed");
    expect(delivered.warnings).toEqual([]);
    expect((delivered.output as any).audioHandoff).toEqual({
      status: "handled_downstream",
      handledBy: "ffmpeg",
      // Deduplicated across frames — every frame reports the same layer.
      layers: [{ id: "music-bed", type: "audio" }],
      resolution: "muxed"
    });
  });

  it("warns for real when the handed-off audio reached no deliverable", () => {
    // A PNG sequence, a still frame, or a preset with no audio codec: the audio genuinely is not in
    // the artifact, and saying so is the whole point of tracking the handoff instead of ignoring it.
    const accumulator = new FrameLaneWarnings();
    accumulator.observe(frameWithHandoff);
    const delivered = receipt("passed");
    delivered.output = { framesDir: "frames" };

    accumulator.applyTo(delivered);

    expect(delivered.status).toBe("warning");
    expect(delivered.warnings.join(" ")).toContain("music-bed");
    expect(delivered.warnings.join(" ")).toContain("carries no audio track");
    expect((delivered.output as any).audioHandoff.resolution).toBe("not_delivered");
  });

  it("never softens a failed delivery into a warning", () => {
    const accumulator = new FrameLaneWarnings();
    accumulator.observe(frameWithHandoff);
    const delivered = receipt("failed");
    delivered.output = { framesDir: "frames" };

    accumulator.applyTo(delivered);

    expect(delivered.status).toBe("failed");
  });

  it("ignores a malformed handoff rather than trusting it", () => {
    const accumulator = new FrameLaneWarnings();
    accumulator.observe({ status: "passed", warnings: [], output: { audioHandoff: { status: "something-else", layers: [{ id: "x", type: "audio" }] } } });
    accumulator.observe({ status: "passed", warnings: [], output: { audioHandoff: { status: "handled_downstream", layers: ["not-a-layer"] } } });

    expect(accumulator.audioHandoffLayers()).toEqual([]);
  });
});

describe("FrameLaneWarnings", () => {
  it("collects warnings from every frame, not only the last one", () => {
    const accumulator = new FrameLaneWarnings();
    accumulator.observe({ status: "warning", warnings: ["frame 1 fell back to a system font"] });
    accumulator.observe({ status: "passed", warnings: [] });
    accumulator.observe({ status: "passed", warnings: [] });

    // The old code kept only the final frame's receipt, so this warning disappeared entirely.
    expect(accumulator.list()).toEqual(["frame 1 fell back to a system font"]);
  });

  it("deduplicates the same warning raised on many frames", () => {
    const accumulator = new FrameLaneWarnings();
    for (let frame = 0; frame < 270; frame += 1) {
      accumulator.observe({ status: "warning", warnings: ["font fallback for text layer headline"] });
    }
    expect(accumulator.list()).toEqual(["font fallback for text layer headline"]);
  });

  it("carries bounded all-frame browser typography evidence into the final receipt", () => {
    const accumulator = new FrameLaneWarnings();
    const browserTypography = {
      schema: "shellx-motion/browser-typography@1",
      authority: "chromium",
      attestation: "verified",
      fontProbe: "canvas-metric",
      scopes: [{ kind: "motion-ir", attestation: "verified", layerIds: ["headline"] }],
      layers: [{
        layerId: "headline",
        direction: "ltr",
        lang: "en",
        requestedFontFamily: "Brand Sans",
        resolvedFontFamily: "Brand Sans",
        primaryFontAvailable: true,
        fontProvenance: "manifest-bound"
      }],
      fontAssets: [{
        id: "font-brand-sans",
        family: "Brand Sans",
        sha256: "a".repeat(64)
      }],
      fallbackLayerIds: []
    };
    accumulator.observe({ status: "passed", output: { typography: browserTypography } });
    accumulator.observe({ status: "passed", output: { typography: browserTypography } });
    const delivered = receipt("passed");

    accumulator.applyTo(delivered);

    expect((delivered.output as any).typography).toEqual({
      schema: "shellx-motion/browser-typography-delivery@1",
      authority: "chromium",
      coverage: "all-rasterized-frames",
      rasterizedFrameCount: 2,
      evidenceFrameCount: 2,
      attestation: "verified",
      fontProbe: "canvas-metric",
      scopes: browserTypography.scopes,
      layers: browserTypography.layers,
      fontAssets: browserTypography.fontAssets,
      fallbackLayerIds: []
    });
  });

  it("fails closed when only part of the rasterized sequence supplied typography evidence", () => {
    const accumulator = new FrameLaneWarnings();
    accumulator.observe({
      status: "passed",
      output: {
        typography: {
          schema: "shellx-motion/browser-typography@1",
          authority: "chromium",
          attestation: "verified",
          fontProbe: "canvas-metric",
          scopes: [],
          layers: [],
          fontAssets: [],
          fallbackLayerIds: []
        }
      }
    });
    accumulator.observe({ status: "passed", output: {} });
    const delivered = receipt("passed");

    accumulator.applyTo(delivered);

    expect((delivered.output as any).typography).toMatchObject({
      coverage: "partial",
      rasterizedFrameCount: 2,
      evidenceFrameCount: 1,
      attestation: "unverified"
    });
  });

  it("escalates a passed receipt to warning and puts frame warnings first", () => {
    const accumulator = new FrameLaneWarnings();
    accumulator.observe({ status: "warning", warnings: ["font fallback"] });
    const target = receipt("passed", ["encoder chatter"]);

    accumulator.applyTo(target);

    expect(target.status).toBe("warning");
    // Frame warnings describe what was drawn — the thing a reader is looking for — so they lead.
    expect(target.warnings).toEqual(["font fallback", "encoder chatter"]);
  });

  it("never softens a failed receipt", () => {
    const accumulator = new FrameLaneWarnings();
    accumulator.observe({ status: "warning", warnings: ["font fallback"] });
    const target = receipt("failed", ["encode failed"]);

    accumulator.applyTo(target);

    expect(target.status).toBe("failed");
    expect(target.warnings).toContain("font fallback");
  });

  it("escalates to failed when a frame failed", () => {
    const accumulator = new FrameLaneWarnings();
    accumulator.observe({ status: "failed", warnings: ["frame could not be drawn"] });
    const target = receipt("passed");

    accumulator.applyTo(target);

    expect(target.status).toBe("failed");
  });

  it("leaves a clean receipt untouched", () => {
    const accumulator = new FrameLaneWarnings();
    accumulator.observe({ status: "passed", warnings: [] });
    const target = receipt("passed", ["encoder chatter"]);

    accumulator.applyTo(target);

    expect(target.status).toBe("passed");
    expect(target.warnings).toEqual(["encoder chatter"]);
  });

  it("ignores frame receipts that are not records or carry no warnings array", () => {
    const accumulator = new FrameLaneWarnings();
    accumulator.observe(null);
    accumulator.observe("not a receipt");
    accumulator.observe([]);
    accumulator.observe({ status: "passed" });
    expect(accumulator.list()).toEqual([]);
  });
});

describe("render carries frame-lane warnings into the delivered receipt", () => {
  it("surfaces a browser-lane warning in the final receipt and on disk", async () => {
    const outRoot = await mkdtemp(join(tmpdir(), "shellx-motion-frame-warning-"));
    const packageRoot = await writeTinyNativePackage();
    tempDirs.push(outRoot, packageRoot);
    const outDir = join(outRoot, "frames");
    const FALLBACK = "Browser renderer used a font fallback for text layer title.";

    // Warn on the FIRST frame only. Under the old code this was the invisible case: the final
    // receipt was built from the last frame, which was clean.
    let frameIndex = 0;
    const browserFrameRenderer: BrowserFrameRenderer = async (pkg, options) => {
      const warnOnThisFrame = frameIndex === 0;
      frameIndex += 1;
      // The sequence lane inspects the delivered frames on disk, so the stub writes real PNGs.
      // Each frame gets a distinct colour: identical frames trip the unique-frame quality gate.
      const framePath = options.outputPath ?? join(options.outDir, `frame-${options.atMs}.png`);
      await mkdir(options.outDir, { recursive: true });
      await writeFile(framePath, rgbaPng(2, 1, [[frameIndex * 40, 20, 30, 255], [10, frameIndex * 30, 60, 255]]));
      const output = {
        path: framePath,
        sha256: `${String(options.atMs).padStart(4, "0")}${"b".repeat(60)}`.slice(0, 64),
        format: "png" as const,
        width: pkg.motion.width,
        height: pkg.motion.height,
        atMs: options.atMs,
        browser: { name: "chromium", version: "test" },
        viewport: { width: pkg.motion.width, height: pkg.motion.height, deviceScaleFactor: 1 }
      };
      return {
        ok: true as const,
        output,
        receipt: cliDebugReceipt({
          id: `frame-${options.atMs}`,
          operation: "preview.frame",
          status: warnOnThisFrame ? "warning" : "passed",
          packageId: pkg.manifest.id,
          lane: "browser",
          output,
          ...(warnOnThisFrame ? { warnings: [FALLBACK] } : {})
        })
      };
    };
    const commands: FfmpegCommand[] = [];
    const ffmpegRunner: FfmpegRunner = async (command) => {
      commands.push(command);
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const result = await runCli(
      ["render", packageRoot, "--lane", "ffmpeg", "--preset", "png-sequence", "--frame-lane", "browser", "--out", outDir],
      { browserFrameRenderer, ffmpegRunner }
    );

    expect(result.ok).toBe(true);
    const finalReceipt = result.receipt as OperationReceipt;
    expect(finalReceipt.warnings).toContain(FALLBACK);
    expect(finalReceipt.status).toBe("warning");

    // The persisted receipt is what an agent reads after the process exits, so it must agree.
    const onDisk = JSON.parse(
      await readFile(renderReceiptPathForOutput(PACKAGE_ID, outDir, "image-sequence"), "utf8")
    ) as OperationReceipt;
    expect(onDisk.warnings).toContain(FALLBACK);
    expect(onDisk.status).toBe("warning");
  });

  it("keeps a delivered audio render passed and records the resolved handoff on disk", async () => {
    // End-to-end audio-handoff contract through the real render command:
    // the frame lane hands an audio layer downstream, the delivery lane muxes it, and the receipt
    // an agent reads must say `passed` with structured evidence rather than `warning` with a note.
    const outRoot = await mkdtemp(join(tmpdir(), "shellx-motion-audio-handoff-"));
    const packageRoot = await writeTinyNativePackage();
    tempDirs.push(outRoot, packageRoot);
    const outDir = join(outRoot, "frames");
    const HANDOFF = { status: "handled_downstream", handledBy: "ffmpeg", layers: [{ id: "music-bed", type: "audio" }] };

    let frameIndex = 0;
    const browserFrameRenderer: BrowserFrameRenderer = async (pkg, options) => {
      frameIndex += 1;
      const framePath = options.outputPath ?? join(options.outDir, `frame-${options.atMs}.png`);
      await mkdir(options.outDir, { recursive: true });
      await writeFile(framePath, rgbaPng(2, 1, [[frameIndex * 40, 20, 30, 255], [10, frameIndex * 30, 60, 255]]));
      const output = {
        path: framePath,
        sha256: `${String(options.atMs).padStart(4, "0")}${"c".repeat(60)}`.slice(0, 64),
        format: "png" as const,
        width: pkg.motion.width,
        height: pkg.motion.height,
        atMs: options.atMs,
        browser: { name: "chromium", version: "test" },
        viewport: { width: pkg.motion.width, height: pkg.motion.height, deviceScaleFactor: 1 },
        // The frame lane's claim: it did not draw the audio, ffmpeg owns it.
        audioHandoff: HANDOFF
      };
      return {
        ok: true as const,
        output,
        // The frame receipt itself stays `passed` — a handoff is not a defect.
        receipt: cliDebugReceipt({ id: `frame-${options.atMs}`, operation: "preview.frame", status: "passed", packageId: pkg.manifest.id, lane: "browser", output })
      };
    };
    const ffmpegRunner: FfmpegRunner = async (command) => {
      const target = command.args.at(-1);
      // Write the delivered artifact so the mp4 lane has real bytes to hash.
      if (typeof target === "string" && target.endsWith(".mp4")) await writeFile(target, "fake mp4 bytes");
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    // A real audio input on disk: the encoder hashes it into the receipt's input hashes, and its
    // presence is what makes the delivery carry `output.audio` for the handoff to resolve against.
    const audioPath = join(packageRoot, "assets", "tone.wav");
    await mkdir(join(packageRoot, "assets"), { recursive: true });
    await writeFile(audioPath, Buffer.from("RIFF....WAVEfmt ", "utf8"));

    const result = await runCli(
      ["render", packageRoot, "--lane", "ffmpeg", "--frame-lane", "browser", "--out", join(outDir, "out.mp4"), "--audio", audioPath],
      { browserFrameRenderer, ffmpegRunner }
    );

    expect(result.ok).toBe(true);
    const finalReceipt = result.receipt as OperationReceipt;
    // What this test is about is the AUDIO HANDOFF, and the handoff contributes nothing: it appears
    // as structured `output.audioHandoff` evidence and raises no warning. The receipt's status is
    // `warning` only because this 300ms fixture is below the product-review length — an unrelated,
    // genuine advisory that (under the unified status rule) escalates like any other.
    // Asserted as the exact warnings array rather than `toBe("passed")` so a handoff warning
    // creeping back in would fail here just as loudly as it used to.
    expect(finalReceipt.status).toBe("warning");
    expect(finalReceipt.warnings).toEqual(["Rendered video is 300ms; product review clips should be at least 1500ms."]);
    expect(finalReceipt.warnings.join(" ")).not.toContain("music-bed");
    expect((finalReceipt.output as Record<string, any>).audioHandoff).toMatchObject({ ...HANDOFF, resolution: "muxed" });
    // Encoder provenance (the tool-identity invariant) — which build produced this artifact.
    const ffmpegTool = (finalReceipt.output as Record<string, any>).tools.ffmpeg;
    expect(ffmpegTool.tool).toBe("ffmpeg");
    expect(ffmpegTool.executable).toMatch(/(?:^|[\\/])ffmpeg(?:\.exe)?$/i);
  });
});
