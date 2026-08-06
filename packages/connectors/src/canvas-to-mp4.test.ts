import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIntegrationEnvelope, loadMotionPackage } from "@shellx-motion/core";
import { clearDefaultEncodePolicyCache, resolveFfmpegExecutable, type FfmpegCommand, type FfmpegRunner } from "@shellx-motion/renderer-ffmpeg";
import { runCanvasMp4Export } from "./canvas-to-mp4";
import {
  ffprobeReadbackStdout,
  isDeliveredColorReadback,
  UNTAGGED_TRANSFER_DELIVERED_TAGS
} from "./ffprobe-readback.test-support";

const tempDirs: string[] = [];

/**
 * A stale frame from a longer previous render. Real PNG bytes on purpose: the frames guard proves
 * ownership from CONTENT, so a text file named `000003.png` is (correctly) refused rather than
 * wiped. This preserves the directory-entry ownership contract without changing the test's focus.
 */
const STALE_FRAME_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("stale", "utf8")]);


// Clear the shared encode-policy probe cache before each test so the per-host hardware probe
// runs deterministically (and once) per render regardless of test order.
beforeEach(clearDefaultEncodePolicyCache);

describe("Canvas independent MP4 export connector", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("writes a Motion package, resource catalog, dry-run render receipt, and export receipt", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-canvas-mp4-dry-"));
    tempDirs.push(outDir);
    const selectionPath = join(outDir, "frame-selection.json");
    await writeFile(selectionPath, JSON.stringify(shapeTextFrameSelection(), null, 2), "utf8");

    const result = await runCanvasMp4Export({
      canvasSelectionPath: selectionPath,
      outDir,
      dryRunRender: true,
      now: () => "2026-06-30T03:30:00.000Z"
    });
    const pkg = await loadMotionPackage(result.packageDir);
    const renderReceipt = JSON.parse(await readFile(result.render.receiptPath, "utf8")) as Record<string, unknown>;
    const exportReceipt = JSON.parse(await readFile(result.receiptPath, "utf8")) as Record<string, unknown>;
    const resourceCatalog = JSON.parse(await readFile(result.resourceCatalogPath, "utf8")) as Record<string, unknown>;

    expect(result).toMatchObject({
      ok: true,
      packageDir: join(outDir, "package"),
      resourceCatalogPath: join(outDir, "package", "resource-catalog.json"),
      render: {
        ok: true,
        dryRun: true,
        lane: "ffmpeg",
        receiptPath: join(outDir, "receipts", "ffmpeg-render.receipt.json"),
        outputPath: join(outDir, "render", "pkg_canvas_motion_export_frame_intro.mp4")
      },
      artifacts: expect.arrayContaining([
        expect.objectContaining({ role: "motion_package", path: join(outDir, "package"), status: "available" }),
        expect.objectContaining({ role: "rendered_media", path: join(outDir, "render", "pkg_canvas_motion_export_frame_intro.mp4"), status: "planned", mediaType: "video/mp4", primary: true }),
        expect.objectContaining({ role: "connector_receipt", path: join(outDir, "canvas-mp4-export.receipt.json"), status: "available" })
      ]),
      warnings: []
    });
    expect(pkg.manifest.id).toBe("pkg_canvas_motion_export_frame_intro");
    expect(renderReceipt).toMatchObject({
      operation: "render.final",
      status: "not_run",
      lane: "ffmpeg",
      packageId: "pkg_canvas_motion_export_frame_intro",
      output: { dryRun: true }
    });
    expect(exportReceipt).toMatchObject({
      operation: "connector.canvas_to_mp4",
      status: "passed",
      lane: "connector",
      packageId: "pkg_canvas_motion_export_frame_intro",
      output: {
        packageDir: result.packageDir,
        artifacts: expect.arrayContaining([
          expect.objectContaining({ role: "rendered_media", path: result.render.outputPath, status: "planned", primary: true })
        ]),
        render: { ok: true, dryRun: true, lane: "ffmpeg", receiptPath: result.render.receiptPath },
        resourceCatalogPath: result.resourceCatalogPath
      }
    });
    expect(resourceCatalog).toMatchObject({
      schema: "shellx-motion/resource-catalog@1",
      packageId: "pkg_canvas_motion_export_frame_intro",
      resources: [
        {
          id: "pkg_canvas_motion_export_frame_intro",
          ref: ".",
          kind: "motion_package",
          source: {
            app: "shellx-canvas",
            sourceFrameId: "frame_intro",
            receiptId: "receipt_canvas_export_frame_intro"
          }
        }
      ]
    });
  });

  it("records the explicit MP4 H.264 preset in dry-run render and connector receipts", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-canvas-mp4-preset-dry-"));
    tempDirs.push(outDir);
    const selectionPath = join(outDir, "frame-selection.json");
    await writeFile(selectionPath, JSON.stringify(shapeTextFrameSelection(), null, 2), "utf8");

    const result = await runCanvasMp4Export({
      canvasSelectionPath: selectionPath,
      outDir,
      dryRunRender: true,
      preset: "mp4-h264",
      now: () => "2026-06-30T03:45:00.000Z"
    } as Parameters<typeof runCanvasMp4Export>[0] & { preset: "mp4-h264" });
    const renderReceipt = JSON.parse(await readFile(result.render.receiptPath, "utf8")) as Record<string, unknown>;
    const exportReceipt = JSON.parse(await readFile(result.receiptPath, "utf8")) as Record<string, unknown>;

    expect(result.render).toMatchObject({
      preset: "mp4-h264",
      outputPath: join(outDir, "render", "pkg_canvas_motion_export_frame_intro.mp4")
    });
    expect(renderReceipt).toMatchObject({
      output: {
        dryRun: true,
        preset: "mp4-h264",
        command: {
          args: expect.arrayContaining(["-pix_fmt", "yuv420p", "-movflags", "+faststart"])
        }
      }
    });
    expect(exportReceipt).toMatchObject({
      output: {
        render: {
          preset: "mp4-h264",
          outputPath: result.render.outputPath
        }
      }
    });
  });

  it("records WebM VP9 preset exports with the matching extension and media type", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-canvas-mp4-webm-preset-"));
    tempDirs.push(outDir);
    const selectionPath = join(outDir, "frame-selection.json");
    await writeFile(selectionPath, JSON.stringify(shapeTextFrameSelection(), null, 2), "utf8");

    const result = await runCanvasMp4Export({
      canvasSelectionPath: selectionPath,
      outDir,
      dryRunRender: true,
      preset: "webm-vp9",
      now: () => "2026-06-30T04:00:00.000Z"
    });
    const renderReceipt = JSON.parse(await readFile(result.render.receiptPath, "utf8")) as Record<string, any>;
    const exportReceipt = JSON.parse(await readFile(result.receiptPath, "utf8")) as Record<string, any>;

    expect(result.render).toMatchObject({
      preset: "webm-vp9",
      outputPath: join(outDir, "render", "pkg_canvas_motion_export_frame_intro.webm")
    });
    expect(result.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "rendered_media",
        path: result.render.outputPath,
        status: "planned",
        mediaType: "video/webm",
        primary: true
      })
    ]));
    expect(renderReceipt).toMatchObject({
      output: {
        dryRun: true,
        preset: "webm-vp9",
        command: {
          args: expect.arrayContaining(["-c:v", "libvpx-vp9", "-crf", "32", result.render.outputPath])
        }
      }
    });
    expect(exportReceipt).toMatchObject({
      output: {
        render: {
          preset: "webm-vp9",
          outputPath: result.render.outputPath
        }
      }
    });
  });

  it.each([
    ["mp4-hevc", "mp4", "video/mp4", ["-c:v", "libx265", "-tag:v", "hvc1"]],
    ["webm-av1", "webm", "video/webm", ["-c:v", "libsvtav1", "-crf", "30"]]
  ] as const)("carries %s selection through Canvas independent export receipts", async (preset, extension, mediaType, expectedArgs) => {
    const outDir = await mkdtemp(join(tmpdir(), `shellx-motion-canvas-modern-${preset}-`));
    tempDirs.push(outDir);
    const selectionPath = join(outDir, "frame-selection.json");
    await writeFile(selectionPath, JSON.stringify(shapeTextFrameSelection(), null, 2), "utf8");

    const result = await runCanvasMp4Export({
      canvasSelectionPath: selectionPath,
      outDir,
      dryRunRender: true,
      preset,
      now: () => "2026-07-12T05:00:00.000Z"
    });
    const renderReceipt = JSON.parse(await readFile(result.render.receiptPath, "utf8")) as Record<string, any>;
    const expectedPath = join(outDir, "render", `pkg_canvas_motion_export_frame_intro.${extension}`);

    expect(result.render).toMatchObject({ preset, outputPath: expectedPath });
    expect(result.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "rendered_media", path: expectedPath, status: "planned", mediaType, primary: true })
    ]));
    expect(renderReceipt).toMatchObject({
      output: {
        dryRun: true,
        preset,
        command: { args: expect.arrayContaining([...expectedArgs, expectedPath]) }
      }
    });
  });

  it("renders a real MP4 artifact and reuses its handle in the Cut import plan", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-canvas-mp4-real-"));
    tempDirs.push(outDir);
    const selectionPath = join(outDir, "frame-selection.json");
    await writeFile(selectionPath, JSON.stringify(shapeTextFrameSelection(), null, 2), "utf8");
    const staleFrame = join(outDir, "frames", "pkg_canvas_motion_export_frame_intro", "000003.png");
    await mkdir(join(outDir, "frames", "pkg_canvas_motion_export_frame_intro"), { recursive: true });
    await writeFile(staleFrame, STALE_FRAME_BYTES);
    const commands: FfmpegCommand[] = [];
    const runner: FfmpegRunner = async (command) => {
      if (command.args.includes("-encoders")) return { exitCode: 0, stdout: "", stderr: "" }; // Hardware-probe discovery; empty means software.
      commands.push(command);
      // The delivered-colour readback READS the artifact the encode just wrote; it must not be
      // answered as another encode (which would rewrite that artifact). See
      // ./ffprobe-readback.test-support.
      if (isDeliveredColorReadback(command)) return { exitCode: 0, stdout: ffprobeReadbackStdout(), stderr: "" };
      await writeFile(command.args.at(-1) as string, fakeMp4Bytes("canvas export"));
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const result = await runCanvasMp4Export({
      canvasSelectionPath: selectionPath,
      outDir,
      dryRunRender: false,
      ffmpegRunner: runner,
      now: () => "2026-06-30T04:30:00.000Z"
    });
    const renderReceipt = JSON.parse(await readFile(result.render.receiptPath, "utf8")) as Record<string, unknown>;
    const exported = await readFile(result.render.outputPath);
    const firstFrame = await readFile(join(outDir, "frames", "pkg_canvas_motion_export_frame_intro", "000001.png"));
    const cutPlan = JSON.parse(await readFile(result.cutPlanPath as string, "utf8")) as Record<string, any>;

    expect(result).toMatchObject({
      ok: true,
      render: {
        ok: true,
        dryRun: false,
        lane: "ffmpeg",
        frameLane: "browser",
        outputPath: join(outDir, "render", "pkg_canvas_motion_export_frame_intro.mp4")
      },
      artifacts: expect.arrayContaining([
        expect.objectContaining({ role: "rendered_media", path: join(outDir, "render", "pkg_canvas_motion_export_frame_intro.mp4"), status: "available", mediaType: "video/mp4", primary: true })
      ]),
      artifactHandle: {
        path: join(outDir, "artifacts", "rendered-media.artifact.json"),
        reference: {
          schema: "shellx-motion/artifact-handle-ref@1",
          rootRelativePath: "artifacts/rendered-media.artifact.json"
        }
      },
      cutPlanPath: join(outDir, "cut-import-plan.json")
    });
    // Two commands, not one: the encode, then the delivered-colour readback of the file it wrote
    // (`verifyDeliveredColor`, default-on under the current contract). Asserted by shape rather than by count
    // alone, so a future extra subprocess cannot slip in behind a bumped number.
    expect(commands).toHaveLength(2);
    expect(commands[0]).toMatchObject({
      executable: resolveFfmpegExecutable(),
      args: expect.arrayContaining(["-frames:v", "2"]),
      shell: false
    });
    expect(commands[1]).toMatchObject({
      executable: expect.stringContaining("ffprobe"),
      args: expect.arrayContaining(["-show_streams"]),
      shell: false
    });
    // The readback must read the file the encode just wrote — the staged artifact, before it is
    // moved into place. Comparing to the encode's own output argument says that exactly.
    expect(commands[1]?.args.at(-1)).toBe(commands[0]?.args.at(-1));
    expect(exported).toEqual(fakeMp4Bytes("canvas export"));
    expect(firstFrame.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    await expect(stat(staleFrame)).rejects.toMatchObject({ code: "ENOENT" });
    expect(renderReceipt).toMatchObject({
      operation: "render.final",
      // `warning`, not `passed`: this 1000ms export carries the review-length advisory, and since
      //  a render receipt escalates on an actionable warning exactly as the connector
      // receipt aggregating it does. The two surfaces must agree about this warning.
      status: "warning",
      warnings: expect.arrayContaining([
        "Rendered video is 1000ms; product review clips should be at least 1500ms."
      ]),
      lane: "ffmpeg",
      packageId: "pkg_canvas_motion_export_frame_intro",
      output: {
        path: join(outDir, "render", "pkg_canvas_motion_export_frame_intro.mp4"),
        durationMs: 1000,
        width: 640,
        height: 360,
        frameLane: "browser",
        // `color` is the preset's DECLARED intent (frozen — ShellX Cut reads it); `observed` is what
        // ffprobe read back off the delivered file. A receipt that carries only the first is a claim
        // about colour management nothing checked.
        color: {
          profile: "sdr-bt709",
          primaries: "bt709",
          transfer: "bt709",
          matrix: "bt709",
          range: "tv",
          observed: { primaries: "bt709", transfer: "bt709", matrix: "bt709", range: "tv" }
        }
      }
    });
    expect(cutPlan).toMatchObject({
      schema: "shellx-motion/cut-import-plan@1",
      packageId: "pkg_canvas_motion_export_frame_intro",
      motionId: "motion_canvas_frame_intro",
      targetId: "shellx-cut",
      mode: "rendered_media",
      integration: { binding: { protocol: 1, mode: "cut.import.plan", consumer: "shellx-cut" } },
      operations: [{ renderedMedia: { dryRun: false, handle: result.artifactHandle?.reference } }]
    });
  });

  /**
   * Run a successful Canvas MP4 export whose encode prints `stderr`, and return both receipts.
   *
   * The invariant these two cases protect is the same one the success-status invariant broke: a successful
   * connector receipt stays `passed`. What CHANGES between them is whether the encoder actually
   * said anything worth recording.
   */
  async function exportWithEncodeStderr(stderr: string) {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-canvas-mp4-diagnostic-"));
    tempDirs.push(outDir);
    const selectionPath = join(outDir, "frame-selection.json");
    await writeFile(selectionPath, JSON.stringify(reviewLengthShapeTextFrameSelection(), null, 2), "utf8");

    const result = await runCanvasMp4Export({
      canvasSelectionPath: selectionPath,
      outDir,
      dryRunRender: false,
      ffmpegRunner: async (command) => {
        if (command.args.includes("-encoders")) return { exitCode: 0, stdout: "", stderr: "" }; // Hardware-probe discovery; empty means software.
        // Answer the delivered-colour readback as a READ, so it cannot rewrite the staged artifact.
        if (isDeliveredColorReadback(command)) return { exitCode: 0, stdout: ffprobeReadbackStdout(), stderr: "" };
        await writeFile(command.args.at(-1) as string, fakeMp4Bytes("canvas export"));
        return { exitCode: 0, stdout: "", stderr };
      },
      now: () => "2026-07-03T04:30:00.000Z"
    });
    return {
      result,
      renderReceipt: JSON.parse(await readFile(result.render.receiptPath, "utf8")) as Record<string, any>,
      exportReceipt: JSON.parse(await readFile(result.receiptPath, "utf8")) as Record<string, any>
    };
  }

  it("keeps successful connector receipts passed and silent when FFmpeg only prints routine statistics", async () => {
    // These are libx264's ordinary end-of-encode statistics. Recording them as receipt warnings is
    // what made every successful audio render look like it had complained about something and made
    // `warnings.length > 0` useless as a signal (the success-status invariant).
    const { result, renderReceipt, exportReceipt } = await exportWithEncodeStderr(
      "[libx264 @ 0000020c04c68080] ref B L0: 98.0%  2.0%\n[libx264 @ 0000020c04c68080] kb/s:17.48"
    );

    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(renderReceipt).toMatchObject({ operation: "render.final", status: "passed", warnings: [] });
    expect(exportReceipt).toMatchObject({ operation: "connector.canvas_to_mp4", status: "passed", warnings: [] });
  }, 45_000);

  it("keeps successful connector receipts passed while still reporting a real diagnostic", async () => {
    // The other half of the same rule: filtering routine chatter must not hide anything ffmpeg
    // genuinely flagged. The encode succeeded, so status stays `passed` — and the diagnostic rides
    // the warnings a reader actually looks at.
    const diagnostic = "[mp4 @ 0x55f] Non-monotonous DTS in output stream 0:0; previous: 1024, current: 512;";
    // The receipt carries the diagnostic with its instance pointer NORMALISED. FFmpeg prefixes
    // component messages with the live address, which changes every run, so two renders of the same
    // package produced receipts differing only in noise — and byte-comparison of receipts is how a
    // caller proves a re-render is identical. The warning is kept in full; only the unstable part is
    // replaced. See `summarizeSuccessfulEncodeStderr`.
    const asRecorded = diagnostic.replace(/\b0x[0-9a-f]+\b/gi, "[address]");
    const { result, renderReceipt, exportReceipt } = await exportWithEncodeStderr(diagnostic);

    expect(result.ok).toBe(true);
    expect(renderReceipt.status).toBe("passed");
    expect(exportReceipt.status).toBe("passed");
    expect(result.warnings).toContain(asRecorded);
    expect(renderReceipt.warnings).toContain(asRecorded);
    expect(exportReceipt.warnings).toContain(asRecorded);
    // The point of the rule: the diagnostic still SURVIVES. Only the pointer is normalised.
    expect(asRecorded).toContain("Non-monotonous DTS in output stream 0:0");
  }, 45_000);

  it("escalates both receipts when the delivered file lacks the colour its preset promised", async () => {
    // The third case of the same rule, and the one the two above cannot cover: this warning is not
    // FFmpeg narrating itself, it is Motion reporting that the artifact does not carry the colour
    // management the receipt declares. A file missing `transfer` and `primaries` is played
    // differently from the one the preset promised, so it must not ride on a `passed` receipt or be
    // absorbed as an ordinary advisory anywhere downstream. The fixture models an all-null FFprobe
    // colour reading from a successful encode.
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-canvas-mp4-colour-mismatch-"));
    tempDirs.push(outDir);
    const selectionPath = join(outDir, "frame-selection.json");
    await writeFile(selectionPath, JSON.stringify(reviewLengthShapeTextFrameSelection(), null, 2), "utf8");

    const result = await runCanvasMp4Export({
      canvasSelectionPath: selectionPath,
      outDir,
      dryRunRender: false,
      ffmpegRunner: async (command) => {
        if (command.args.includes("-encoders")) return { exitCode: 0, stdout: "", stderr: "" }; // Hardware-probe discovery; empty means software.
        if (isDeliveredColorReadback(command)) {
          return { exitCode: 0, stdout: ffprobeReadbackStdout(UNTAGGED_TRANSFER_DELIVERED_TAGS), stderr: "" };
        }
        await writeFile(command.args.at(-1) as string, fakeMp4Bytes("canvas export"));
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      now: () => "2026-08-03T04:30:00.000Z"
    });
    const renderReceipt = JSON.parse(await readFile(result.render.receiptPath, "utf8")) as Record<string, any>;
    const exportReceipt = JSON.parse(await readFile(result.receiptPath, "utf8")) as Record<string, any>;
    const colourWarning = expect.stringContaining("colour does not match the sdr-bt709 profile the preset declares");

    // The encode succeeded and the media is real, so the operation is not a failure — but neither
    // receipt may call it an unqualified success.
    expect(result.ok).toBe(true);
    expect(renderReceipt.status).toBe("warning");
    expect(exportReceipt.status).toBe("warning");
    expect(renderReceipt.warnings).toEqual(expect.arrayContaining([colourWarning]));
    expect(exportReceipt.warnings).toEqual(expect.arrayContaining([colourWarning]));
    // And the reading itself is recorded, not just complained about: `observed` says which tags the
    // delivered file actually carries, next to the `color` block that says what was intended.
    expect(renderReceipt.output.color).toMatchObject({
      profile: "sdr-bt709",
      transfer: "bt709",
      primaries: "bt709",
      observed: { matrix: "bt709", range: "tv", transfer: null, primaries: null }
    });
  }, 45_000);

  it("returns structured failed receipts when real Canvas MP4 FFmpeg encode fails", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-canvas-mp4-ffmpeg-fail-"));
    tempDirs.push(outDir);
    const selectionPath = join(outDir, "frame-selection.json");
    await writeFile(selectionPath, JSON.stringify(shapeTextFrameSelection(), null, 2), "utf8");

    const result = await runCanvasMp4Export({
      canvasSelectionPath: selectionPath,
      outDir,
      dryRunRender: false,
      ffmpegRunner: async () => ({ exitCode: 1, stdout: "", stderr: "encoder exploded" }),
      now: () => "2026-07-03T02:00:00.000Z"
    });
    const renderReceipt = JSON.parse(await readFile(result.render.receiptPath, "utf8")) as Record<string, any>;
    const exportReceipt = JSON.parse(await readFile(result.receiptPath, "utf8")) as Record<string, any>;

    expect(result).toMatchObject({
      ok: false,
      render: {
        ok: false,
        dryRun: false,
        lane: "ffmpeg",
        frameLane: "browser",
        outputPath: join(outDir, "render", "pkg_canvas_motion_export_frame_intro.mp4")
      },
      artifacts: expect.arrayContaining([
        expect.objectContaining({ role: "rendered_media", path: join(outDir, "render", "pkg_canvas_motion_export_frame_intro.mp4"), status: "failed", primary: true })
      ]),
      warnings: ["encoder exploded"]
    });
    expect(renderReceipt).toMatchObject({
      operation: "render.final",
      status: "failed",
      lane: "ffmpeg",
      output: {
        path: join(outDir, "render", "pkg_canvas_motion_export_frame_intro.mp4"),
        frameLane: "browser",
        error: { code: "ffmpeg_failed", message: "encoder exploded" }
      },
      warnings: ["encoder exploded"]
    });
    expect(exportReceipt).toMatchObject({
      operation: "connector.canvas_to_mp4",
      status: "failed",
      output: {
        render: { ok: false, dryRun: false, frameLane: "browser" }
      },
      warnings: ["encoder exploded"]
    });
  });

  it("muxes Canvas audio layers into real independent MP4 exports", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-canvas-mp4-audio-"));
    tempDirs.push(outDir);
    const selectionPath = join(outDir, "frame-selection.json");
    await mkdir(join(outDir, "assets"), { recursive: true });
    await writeFile(join(outDir, "assets", "voice.wav"), "fake wav bytes", "utf8");
    await writeFile(selectionPath, JSON.stringify(audioShapeTextFrameSelection(), null, 2), "utf8");
    const commands: FfmpegCommand[] = [];

    const result = await runCanvasMp4Export({
      canvasSelectionPath: selectionPath,
      outDir,
      dryRunRender: false,
      ffmpegRunner: async (command) => {
        if (command.args.includes("-encoders")) return { exitCode: 0, stdout: "", stderr: "" }; // Hardware-probe discovery; empty means software.
        commands.push(command);
        await writeFile(command.args.at(-1) as string, fakeMp4Bytes("canvas export audio"));
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      now: () => "2026-07-01T23:30:00.000Z"
    });

    const renderReceipt = JSON.parse(await readFile(result.render.receiptPath, "utf8")) as Record<string, any>;
    const audioPath = join(result.packageDir, "assets", "voice.wav");
    const command = commands[0];
    expect(command).toBeDefined();
    if (!command) throw new Error("expected Canvas MP4 export to invoke FFmpeg");
    expect(command.args).toEqual(expect.arrayContaining([
      "-i",
      audioPath,
      "-map",
      "1:a:0",
      "-c:a",
      "aac"
    ]));
    expect(renderReceipt.output).toMatchObject({
      audio: {
        path: audioPath,
        codec: "aac",
        startMs: 100,
        durationMs: 800,
        volume: 0.4,
        fadeInMs: 120,
        fadeOutMs: 200
      }
    });
  });

  it("rejects static real Canvas MP4 exports before invoking FFmpeg", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-canvas-mp4-static-"));
    tempDirs.push(outDir);
    const selectionPath = join(outDir, "frame-selection.json");
    await writeFile(selectionPath, JSON.stringify(staticShapeTextFrameSelection(), null, 2), "utf8");
    let ffmpegInvoked = false;

    const result = await runCanvasMp4Export({
      canvasSelectionPath: selectionPath,
      outDir,
      dryRunRender: false,
      ffmpegRunner: async (command) => {
        if (command.args.includes("-encoders")) return { exitCode: 0, stdout: "", stderr: "" }; // Hardware-probe discovery; empty means software.
        ffmpegInvoked = true;
        await writeFile(command.args.at(-1) as string, "static output", "utf8");
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      now: () => "2026-06-30T04:45:00.000Z"
    });
    const renderReceipt = JSON.parse(await readFile(result.render.receiptPath, "utf8")) as Record<string, any>;
    const exportReceipt = JSON.parse(await readFile(result.receiptPath, "utf8")) as Record<string, any>;

    expect(ffmpegInvoked).toBe(false);
    expect(result).toMatchObject({
      ok: false,
      render: {
        ok: false,
        dryRun: false,
        lane: "ffmpeg",
        frameLane: "browser",
        outputPath: join(outDir, "render", "pkg_canvas_motion_export_frame_intro.mp4")
      },
      artifacts: expect.arrayContaining([
        expect.objectContaining({ role: "rendered_media", status: "failed", primary: true })
      ]),
      warnings: ["Rendered frame sequence has 1 unique frame; expected at least 2."]
    });
    expect(renderReceipt).toMatchObject({
      operation: "render.final",
      status: "failed",
      output: {
        error: {
          code: "frame_quality_failed",
          message: "Rendered frame sequence has 1 unique frame; expected at least 2."
        }
      }
    });
    expect(exportReceipt).toMatchObject({
      operation: "connector.canvas_to_mp4",
      status: "failed",
      output: {
        render: { ok: false, dryRun: false, frameLane: "browser" }
      }
    });
  });

  it("reports canonical Canvas protocol negotiation in connector output", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-canvas-mp4-protocol-"));
    tempDirs.push(outDir);
    const selectionPath = join(outDir, "frame-selection.json");
    const selection = shapeTextFrameSelection() as Record<string, any>;
    selection.schema = "shellx-motion/canvas-frame-selection@1";
    selection.integration = createIntegrationEnvelope({
      producer: "shellx-canvas",
      consumer: "shellx-motion",
      mode: "canvas.bridge",
      payloadSchema: selection.schema,
      requiredFeatures: ["artifact.attestation"]
    });
    selection.identity = {
      schema: "shellx-motion/package-identity@1",
      packageId: "pkg_canvas_motion_export_frame_intro",
      motionId: "motion_canvas_frame_intro"
    };
    await writeFile(selectionPath, JSON.stringify(selection), "utf8");

    const result = await runCanvasMp4Export({ canvasSelectionPath: selectionPath, outDir, dryRunRender: true });

    expect(result.integration).toMatchObject({
      schema: "shellx-motion/integration-negotiation@1",
      ok: true,
      localHost: "shellx-canvas",
      remoteHost: "shellx-motion",
      selectedProtocol: 1,
      modes: ["canvas.bridge", "package.preview"]
    });
  });

  it("rejects protocol skew before creating connector output state", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-canvas-mp4-skew-"));
    tempDirs.push(root);
    const selectionPath = join(root, "frame-selection.json");
    const outDir = join(root, "out");
    const selection = shapeTextFrameSelection() as Record<string, any>;
    selection.schema = "shellx-motion/canvas-frame-selection@1";
    selection.integration = createIntegrationEnvelope({
      producer: "shellx-canvas",
      consumer: "shellx-motion",
      mode: "canvas.bridge",
      payloadSchema: selection.schema
    });
    selection.identity = {
      schema: "shellx-motion/package-identity@1",
      packageId: "pkg_canvas_motion_export_frame_intro",
      motionId: "motion_canvas_frame_intro"
    };
    selection.integration.binding.protocol = 2;
    await writeFile(selectionPath, JSON.stringify(selection), "utf8");

    await expect(runCanvasMp4Export({ canvasSelectionPath: selectionPath, outDir, dryRunRender: true }))
      .rejects.toThrow("does not match negotiated protocol");
    await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("Canvas MP4 output ownership", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("never deletes a caller's files under <out>/frames", async () => {
    // Reproduced before the fix: this lane opened with a bare
    // `rm(framesDir, { recursive: true, force: true })` while its three sibling connectors called
    // the guard, so files under `<out>/frames/<packageId>` were destroyed by a run reporting ok:true.
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-canvas-mp4-own-"));
    tempDirs.push(outDir);
    const selectionPath = join(outDir, "frame-selection.json");
    await writeFile(selectionPath, JSON.stringify(shapeTextFrameSelection(), null, 2), "utf8");
    const framesDir = join(outDir, "frames", "pkg_canvas_motion_export_frame_intro");
    await mkdir(framesDir, { recursive: true });
    await writeFile(join(framesDir, "keepme.txt"), "user data", "utf8");

    await expect(runCanvasMp4Export({
      canvasSelectionPath: selectionPath,
      outDir,
      dryRunRender: false,
      ffmpegRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      now: () => "2026-08-02T00:00:00.000Z"
    })).rejects.toMatchObject({ code: "output_dir_not_empty", path: framesDir });

    expect(await readFile(join(framesDir, "keepme.txt"), "utf8")).toBe("user data");
  });

  it("never overwrites a caller's <out>/package", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-canvas-mp4-own-"));
    tempDirs.push(outDir);
    const selectionPath = join(outDir, "frame-selection.json");
    await writeFile(selectionPath, JSON.stringify(shapeTextFrameSelection(), null, 2), "utf8");
    await mkdir(join(outDir, "package"), { recursive: true });
    await writeFile(join(outDir, "package", "manifest.json"), '{"mine":true}', "utf8");

    await expect(runCanvasMp4Export({ canvasSelectionPath: selectionPath, outDir, dryRunRender: true }))
      .rejects.toMatchObject({ code: "output_dir_not_empty" });

    expect(await readFile(join(outDir, "package", "manifest.json"), "utf8")).toBe('{"mine":true}');
  });

  it("overwrites only when the caller explicitly asks", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-canvas-mp4-own-"));
    tempDirs.push(outDir);
    const selectionPath = join(outDir, "frame-selection.json");
    await writeFile(selectionPath, JSON.stringify(shapeTextFrameSelection(), null, 2), "utf8");
    await mkdir(join(outDir, "package"), { recursive: true });
    await writeFile(join(outDir, "package", "manifest.json"), '{"mine":true}', "utf8");

    const result = await runCanvasMp4Export({ canvasSelectionPath: selectionPath, outDir, dryRunRender: true, force: true });

    expect(result).toMatchObject({ ok: true });
    expect(await readFile(join(outDir, "package", "manifest.json"), "utf8")).not.toBe('{"mine":true}');
  });
});

function shapeTextFrameSelection(): unknown {
  return {
    schema: "shellx-canvas/frame-selection@1",
    selectedFrameId: "frame_intro",
    project: { id: "canvas_motion_export", name: "Motion Export" },
    brand: { tokens: { color: { accent: "#2563eb", ink: "#101828" } } },
    frames: [
      {
        id: "frame_intro",
        name: "Intro",
        durationMs: 1000,
        fps: 2,
        width: 640,
        height: 360,
        background: "#f8fafc",
        layers: [
          {
            id: "panel",
            kind: "shape",
            shape: "rectangle",
            startMs: 0,
            durationMs: 1000,
            transform: { x: 48, y: 44, width: 250, height: 150, opacity: 1 },
            style: { fill: "#2563eb" },
            ...revealMotion()
          },
          {
            id: "title",
            kind: "text",
            text: "Canvas export",
            startMs: 0,
            durationMs: 1000,
            transform: { x: 64, y: 240, width: 420, height: 60, opacity: 1 },
            style: { fontSize: 36, color: "#101828" },
            ...revealMotion()
          }
        ]
      }
    ],
    imageEditorOutputs: []
  };
}

function fakeMp4Bytes(label: string): Buffer {
  return Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom", "ascii"), Buffer.from(label)]);
}

function staticShapeTextFrameSelection(): unknown {
  const selection = shapeTextFrameSelection() as Record<string, unknown>;
  const frames = selection.frames as Array<Record<string, unknown>>;
  frames[0].layers = (frames[0].layers as Array<Record<string, unknown>>).map((layer) => {
    const copy = { ...layer };
    delete copy.transitions;
    delete copy.keyframes;
    return copy;
  });
  return selection;
}

function reviewLengthShapeTextFrameSelection(): unknown {
  const selection = shapeTextFrameSelection() as Record<string, any>;
  selection.project = { id: "canvas_motion_export_review", name: "Motion Export Review" };
  selection.selectedFrameId = "frame_review";
  const frame = selection.frames[0];
  frame.id = "frame_review";
  frame.durationMs = 2000;
  frame.fps = 4;
  frame.layers = frame.layers.map((layer: Record<string, unknown>) => ({
    ...layer,
    durationMs: 2000,
    keyframes: {
      opacity: [
        { atMs: 0, value: 0, easing: "ease-out" },
        { atMs: 320, value: 1 },
        { atMs: 1740, value: 1, easing: "ease-in" },
        { atMs: 2000, value: 0 }
      ]
    }
  }));
  return selection;
}

function audioShapeTextFrameSelection(): unknown {
  const selection = shapeTextFrameSelection() as Record<string, any>;
  selection.project = { id: "canvas_motion_audio", name: "Motion Audio" };
  selection.frames[0].id = "frame_audio";
  selection.selectedFrameId = "frame_audio";
  selection.frames[0].layers = [
    ...selection.frames[0].layers,
    {
      id: "voiceover",
      kind: "audio",
      assetId: "asset_voice",
      source: "assets/voice.wav",
      startMs: 100,
      durationMs: 800,
      volume: 0.4,
      fadeInMs: 120,
      fadeOutMs: 200
    }
  ];
  selection.imageEditorOutputs = [
    {
      id: "voice_output",
      assetId: "asset_voice",
      kind: "audio",
      path: "assets/voice.wav",
      mimeType: "audio/wav",
      width: 0,
      height: 0,
      sha256: "sample-voice",
      editStack: []
    }
  ];
  return selection;
}

function revealMotion(): Record<string, unknown> {
  return {
    transitions: {
      in: { type: "slide", direction: "down", distance: 24, durationMs: 320, easing: "ease-out" },
      out: { type: "fade", durationMs: 260, easing: "ease-in" }
    },
    keyframes: {
      opacity: [
        { atMs: 0, value: 0, easing: "ease-out" },
        { atMs: 320, value: 1 },
        { atMs: 740, value: 1, easing: "ease-in" },
        { atMs: 1000, value: 0 }
      ]
    }
  };
}
