import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadMotionPackage } from "@shellx-motion/core";
import { clearDefaultEncodePolicyCache, resolveFfmpegExecutable, type FfmpegCommand } from "@shellx-motion/renderer-ffmpeg";
import { runCanvasToCutConnector } from "./canvas-to-cut";
import { ffprobeReadbackStdout, isDeliveredColorReadback } from "./ffprobe-readback.test-support";

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

describe("Canvas to Cut connector harness", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("writes a Motion package, preview refusal, FFmpeg dry-run receipt, and Cut import plan", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-canvas-to-cut-"));
    tempDirs.push(outDir);

    const result = await runCanvasToCutConnector({
      canvasSelectionPath: resolve("../../fixtures/canvas/frame-selection.json"),
      outDir,
      previewLane: "native",
      renderLane: "ffmpeg",
      dryRunRender: true,
      cutImportMode: "auto",
      now: () => "2026-06-30T00:30:00.000Z"
    });
    const pkg = await loadMotionPackage(result.packageDir);
    const previewReceipt = JSON.parse(await readFile(result.preview.receiptPath, "utf8")) as Record<string, unknown>;
    const renderReceipt = JSON.parse(await readFile(result.render.receiptPath, "utf8")) as Record<string, unknown>;
    const cutPlan = JSON.parse(await readFile(result.cutPlanPath, "utf8")) as Record<string, unknown>;
    const connectorReceipt = JSON.parse(await readFile(result.receiptPath, "utf8")) as Record<string, unknown>;

    expect(result.ok).toBe(false);
    expect(result.preview).toMatchObject({
      ok: false,
      lane: "native",
      failureFatal: true,
      outputPath: null
    });
    expect(result.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "canvas_selection", path: resolve("../../fixtures/canvas/frame-selection.json"), status: "available" }),
      expect.objectContaining({ role: "motion_package", path: result.packageDir, status: "available" }),
      expect.objectContaining({ role: "preview_frame", path: join(outDir, "preview", "native-0.png"), status: "planned", mediaType: "image/png" }),
      expect.objectContaining({ role: "rendered_media", path: join(outDir, "render", "pkg_canvas_launch_campaign_frame_story_hero.mp4"), status: "planned", mediaType: "video/mp4", primary: true }),
      expect.objectContaining({ role: "cut_plan", path: result.cutPlanPath, status: "available" })
    ]));
    expect(pkg.manifest.id).toBe("pkg_canvas_launch_campaign_frame_story_hero");
    expect(pkg.motion.layers.map((layer) => layer.type)).toEqual(["image", "text", "shape"]);
    expect(previewReceipt).toMatchObject({
      operation: "preview.frame",
      status: "failed",
      lane: "native",
      packageId: "pkg_canvas_launch_campaign_frame_story_hero"
    });
    expect(previewReceipt.warnings).toEqual([
      expect.stringContaining("Native renderer failed: ENOENT")
    ]);
    expect(String((previewReceipt.warnings as unknown[])[0]).replaceAll("\\", "/")).toContain("assets/product-retouched.png");
    expect(renderReceipt).toMatchObject({
      operation: "render.final",
      status: "not_run",
      lane: "ffmpeg",
      packageId: "pkg_canvas_launch_campaign_frame_story_hero",
      output: { dryRun: true }
    });
    expect(cutPlan).toMatchObject({
      schema: "shellx-motion/cut-import-plan@1",
      ok: true,
      mode: "rendered_media",
      operations: [
        {
          verb: "cut.media.import_rendered",
          source: { render: "dry_run" },
          renderedMedia: {
            plannedPath: join(outDir, "render", "pkg_canvas_launch_campaign_frame_story_hero.mp4"),
            receiptPath: result.render.receiptPath,
            dryRun: true
          }
        }
      ]
    });
    expect(connectorReceipt).toMatchObject({
      operation: "connector.canvas_to_cut",
      status: "failed",
      lane: "connector",
      packageId: "pkg_canvas_launch_campaign_frame_story_hero",
      createdAt: "2026-06-30T00:30:00.000Z",
      output: {
        packageDir: result.packageDir,
        artifacts: expect.arrayContaining([
          expect.objectContaining({ role: "rendered_media", status: "planned", primary: true }),
          expect.objectContaining({ role: "cut_plan", path: result.cutPlanPath, status: "available" })
        ]),
        preview: { ok: false, lane: "native", failureFatal: true, receiptPath: result.preview.receiptPath },
        render: { ok: true, dryRun: true, lane: "ffmpeg", receiptPath: result.render.receiptPath },
        cut: { ok: true, mode: "rendered_media", planPath: result.cutPlanPath }
      }
    });
    expect(result.warnings).toEqual([
      expect.stringContaining("Native renderer failed: ENOENT"),
      "Canvas asset was not copied into package: assets/product-retouched.png"
    ]);
    expect(result.warnings[0]?.replaceAll("\\", "/")).toContain("assets/product-retouched.png");
  });

  it("renders a real MP4 artifact for shape/text Canvas selections", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-canvas-to-cut-real-"));
    tempDirs.push(outDir);
    const selectionPath = join(outDir, "frame-selection.json");
    await writeFile(selectionPath, JSON.stringify(shapeTextFrameSelection(), null, 2), "utf8");
    const staleFrame = join(outDir, "frames", "pkg_canvas_motion_real_frame_intro", "000003.png");
    await mkdir(join(outDir, "frames", "pkg_canvas_motion_real_frame_intro"), { recursive: true });
    await writeFile(staleFrame, STALE_FRAME_BYTES);

    const result = await runCanvasToCutConnector({
      canvasSelectionPath: selectionPath,
      outDir,
      previewLane: "native",
      renderLane: "ffmpeg",
      dryRunRender: false,
      cutImportMode: "rendered_media",
      ffmpegRunner: async (command) => {
        if (command.args.includes("-encoders")) return { exitCode: 0, stdout: "", stderr: "" }; // Hardware-probe discovery; empty means software.
        // Answered BEFORE the encode expectations below: the delivered-colour readback is an ffprobe
        // READ of the staged artifact, so it satisfies none of them — and `gradeDeliveredColor`
        // deliberately swallows readback failures, which would make a failed expectation here
        // invisible instead of loud. See ./ffprobe-readback.test-support.
        if (isDeliveredColorReadback(command)) return { exitCode: 0, stdout: ffprobeReadbackStdout(), stderr: "" };
        expect(command.shell).toBe(false);
        expect(command.executable).toBe(resolveFfmpegExecutable());
        expect(command.args).toEqual(expect.arrayContaining(["-frames:v", "2"]));
        await writeFile(command.args.at(-1) as string, fakeMp4Bytes("canvas"));
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      now: () => "2026-06-30T01:30:00.000Z"
    });

    const renderReceipt = JSON.parse(await readFile(result.render.receiptPath, "utf8")) as Record<string, unknown>;
    const cutPlan = JSON.parse(await readFile(result.cutPlanPath, "utf8")) as Record<string, unknown>;
    const firstFrame = await readFile(join(outDir, "frames", "pkg_canvas_motion_real_frame_intro", "000001.png"));

    expect(firstFrame.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    await expect(stat(staleFrame)).rejects.toMatchObject({ code: "ENOENT" });
    expect(result.render).toMatchObject({
      ok: true,
      dryRun: false,
      lane: "ffmpeg",
      outputPath: join(outDir, "render", "pkg_canvas_motion_real_frame_intro.mp4")
    });
    expect(renderReceipt).toMatchObject({
      operation: "render.final",
      // `warning`, not `passed`: this 1000ms export carries the review-length advisory. Since
      //  a render receipt escalates on an actionable warning exactly as the connector
      // receipt aggregating this same warning does. Both surfaces must agree.
      status: "warning",
      warnings: expect.arrayContaining([
        "Rendered video is 1000ms; product review clips should be at least 1500ms."
      ]),
      lane: "ffmpeg",
      packageId: "pkg_canvas_motion_real_frame_intro",
      output: {
        path: join(outDir, "render", "pkg_canvas_motion_real_frame_intro.mp4"),
        durationMs: 1000,
        width: 640,
        height: 360,
        // The delivered colour is now OBSERVED off the file, not merely declared from the preset.
        color: expect.objectContaining({
          profile: "sdr-bt709",
          observed: { primaries: "bt709", transfer: "bt709", matrix: "bt709", range: "tv" }
        })
      }
    });
    expect(cutPlan).toMatchObject({
      schema: "shellx-motion/cut-import-plan@1",
      ok: true,
      mode: "rendered_media",
      operations: [
        {
          verb: "cut.media.import_rendered",
          source: { render: "artifact" },
          renderedMedia: {
            dryRun: false,
            handle: {
              schema: "shellx-motion/artifact-handle-ref@1",
              rootRelativePath: "artifacts/rendered-media.artifact.json",
              sha256: expect.stringMatching(/^[a-f0-9]{64}$/)
            }
          }
        }
      ]
    });
  });

  it("binds WebM VP9 output metadata and dry-run commands into Cut handoff artifacts", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-canvas-to-cut-webm-"));
    tempDirs.push(outDir);
    const selectionPath = join(outDir, "frame-selection.json");
    await writeFile(selectionPath, JSON.stringify(shapeTextFrameSelection(), null, 2), "utf8");

    const result = await runCanvasToCutConnector({
      canvasSelectionPath: selectionPath,
      outDir,
      previewLane: "native",
      renderLane: "ffmpeg",
      preset: "webm-vp9",
      dryRunRender: true,
      cutImportMode: "rendered_media",
      now: () => "2026-06-30T01:45:00.000Z"
    });
    const renderReceipt = JSON.parse(await readFile(result.render.receiptPath, "utf8")) as Record<string, any>;
    const cutPlan = JSON.parse(await readFile(result.cutPlanPath, "utf8")) as Record<string, any>;
    const connectorReceipt = JSON.parse(await readFile(result.receiptPath, "utf8")) as Record<string, any>;
    const outputPath = join(outDir, "render", "pkg_canvas_motion_real_frame_intro.webm");

    expect(result).toMatchObject({
      ok: true,
      render: {
        ok: true,
        required: true,
        dryRun: true,
        lane: "ffmpeg",
        preset: "webm-vp9",
        outputPath
      },
      artifacts: expect.arrayContaining([
        expect.objectContaining({
          role: "rendered_media",
          path: outputPath,
          status: "planned",
          mediaType: "video/webm",
          primary: true
        })
      ])
    });
    expect(renderReceipt).toMatchObject({
      operation: "render.final",
      status: "not_run",
      output: {
        dryRun: true,
        preset: "webm-vp9",
        command: {
          args: expect.arrayContaining(["-c:v", "libvpx-vp9", "-crf", "32", outputPath])
        }
      }
    });
    expect(cutPlan).toMatchObject({
      operations: [{ renderedMedia: { plannedPath: outputPath, dryRun: true } }]
    });
    expect(connectorReceipt).toMatchObject({
      output: {
        render: { preset: "webm-vp9", outputPath }
      }
    });
  });

  it("muxes Canvas audio layers into real Canvas-to-Cut renders", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-canvas-to-cut-audio-"));
    tempDirs.push(outDir);
    const selectionPath = join(outDir, "frame-selection.json");
    await mkdir(join(outDir, "assets"), { recursive: true });
    await writeFile(join(outDir, "assets", "voice.wav"), "fake wav bytes", "utf8");
    await writeFile(selectionPath, JSON.stringify(audioShapeTextFrameSelection(), null, 2), "utf8");
    const ffmpegCommands: FfmpegCommand[] = [];

    const result = await runCanvasToCutConnector({
      canvasSelectionPath: selectionPath,
      outDir,
      previewLane: "native",
      renderLane: "ffmpeg",
      dryRunRender: false,
      cutImportMode: "rendered_media",
      ffmpegRunner: async (command) => {
        if (command.args.includes("-encoders")) return { exitCode: 0, stdout: "", stderr: "" }; // Hardware-probe discovery; empty means software.
        ffmpegCommands.push(command);
        // The readback READS the staged artifact; answering it as an encode would rewrite it.
        if (isDeliveredColorReadback(command)) return { exitCode: 0, stdout: ffprobeReadbackStdout(), stderr: "" };
        await writeFile(command.args.at(-1) as string, fakeMp4Bytes("canvas audio"));
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      now: () => "2026-07-01T23:00:00.000Z"
    });

    const renderReceipt = JSON.parse(await readFile(result.render.receiptPath, "utf8")) as Record<string, any>;
    const audioPath = join(result.packageDir, "assets", "voice.wav");
    const ffmpegCommand = ffmpegCommands[0];
    expect(ffmpegCommand).toBeDefined();
    if (!ffmpegCommand) throw new Error("expected Canvas-to-Cut to invoke FFmpeg");
    expect(ffmpegCommand.args).toEqual(expect.arrayContaining([
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

  it("returns structured failed receipts for static rendered-media Canvas-to-Cut exports before invoking FFmpeg", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-canvas-to-cut-static-"));
    tempDirs.push(outDir);
    const selectionPath = join(outDir, "frame-selection.json");
    await writeFile(selectionPath, JSON.stringify(staticShapeTextFrameSelection(), null, 2), "utf8");
    let ffmpegInvoked = false;

    const result = await runCanvasToCutConnector({
      canvasSelectionPath: selectionPath,
      outDir,
      previewLane: "native",
      renderLane: "ffmpeg",
      dryRunRender: false,
      cutImportMode: "rendered_media",
      ffmpegRunner: async (command) => {
        if (command.args.includes("-encoders")) return { exitCode: 0, stdout: "", stderr: "" }; // Hardware-probe discovery; empty means software.
        ffmpegInvoked = true;
        await writeFile(command.args.at(-1) as string, "static output", "utf8");
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      now: () => "2026-06-30T01:45:00.000Z"
    });
    const renderReceipt = JSON.parse(await readFile(result.render.receiptPath, "utf8")) as Record<string, any>;
    const connectorReceipt = JSON.parse(await readFile(result.receiptPath, "utf8")) as Record<string, any>;

    expect(ffmpegInvoked).toBe(false);
    expect(result).toMatchObject({
      ok: false,
      status: "failed",
      render: {
        ok: false,
        required: true,
        dryRun: false,
        lane: "ffmpeg"
      },
      // the text-delivery invariant: the native preview lane names the case fold it applies to the Canvas copy.
      warnings: [
        "Native renderer case-folded lowercase text to uppercase block glyphs on layer title: ealrnd.",
        expect.stringMatching(/expected at least 2/)
      ]
    });
    expect(result.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "rendered_media", status: "failed", primary: true }),
      expect.objectContaining({ role: "render_receipt", path: result.render.receiptPath, status: "available" }),
      expect.objectContaining({ role: "connector_receipt", path: result.receiptPath, status: "available" })
    ]));
    expect(renderReceipt).toMatchObject({
      operation: "render.final",
      status: "failed",
      output: {
        path: join(outDir, "render", "pkg_canvas_motion_real_frame_intro.mp4"),
        error: {
          code: "frame_quality_failed",
          message: expect.stringMatching(/expected at least 2/)
        }
      }
    });
    expect(connectorReceipt).toMatchObject({
      operation: "connector.canvas_to_cut",
      status: "failed",
      output: {
        render: { ok: false, dryRun: false },
        cut: { ok: true }
      }
    });
  });

  it("returns structured failed receipts when real Canvas-to-Cut FFmpeg encode fails", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-canvas-to-cut-ffmpeg-fail-"));
    tempDirs.push(outDir);
    const selectionPath = join(outDir, "frame-selection.json");
    await writeFile(selectionPath, JSON.stringify(shapeTextFrameSelection(), null, 2), "utf8");

    const result = await runCanvasToCutConnector({
      canvasSelectionPath: selectionPath,
      outDir,
      previewLane: "native",
      renderLane: "ffmpeg",
      dryRunRender: false,
      cutImportMode: "rendered_media",
      ffmpegRunner: async () => ({ exitCode: 1, stdout: "", stderr: "encoder exploded" }),
      now: () => "2026-06-30T01:50:00.000Z"
    });
    const renderReceipt = JSON.parse(await readFile(result.render.receiptPath, "utf8")) as Record<string, any>;
    const connectorReceipt = JSON.parse(await readFile(result.receiptPath, "utf8")) as Record<string, any>;

    expect(result).toMatchObject({
      ok: false,
      status: "failed",
      render: {
        ok: false,
        required: true,
        dryRun: false,
        lane: "ffmpeg",
        frameLane: "browser",
        outputPath: join(outDir, "render", "pkg_canvas_motion_real_frame_intro.mp4")
      },
      // the text-delivery invariant: the native preview lane names the case fold it applies to the Canvas copy.
      warnings: [
        "Native renderer case-folded lowercase text to uppercase block glyphs on layer title: ealrnd.",
        "encoder exploded"
      ]
    });
    expect(result.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "rendered_media", path: join(outDir, "render", "pkg_canvas_motion_real_frame_intro.mp4"), status: "failed", primary: true })
    ]));
    expect(renderReceipt).toMatchObject({
      operation: "render.final",
      status: "failed",
      lane: "ffmpeg",
      output: {
        path: join(outDir, "render", "pkg_canvas_motion_real_frame_intro.mp4"),
        frameLane: "browser",
        error: { code: "ffmpeg_failed", message: "encoder exploded" }
      },
      warnings: ["encoder exploded"]
    });
    expect(connectorReceipt).toMatchObject({
      operation: "connector.canvas_to_cut",
      status: "failed",
      output: {
        render: { ok: false, frameLane: "browser" },
        cut: { ok: true }
      }
    });
  });

  it("can lower shape/text Canvas selections to editable Cut operations without rendering media", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-canvas-to-cut-editable-"));
    tempDirs.push(outDir);
    const selectionPath = join(outDir, "frame-selection.json");
    await writeFile(selectionPath, JSON.stringify(staticShapeTextFrameSelection(), null, 2), "utf8");

    const result = await runCanvasToCutConnector({
      canvasSelectionPath: selectionPath,
      outDir,
      previewLane: "native",
      renderLane: "ffmpeg",
      dryRunRender: false,
      cutImportMode: "editable_lowering",
      ffmpegRunner: async () => {
        throw new Error("editable Cut import should not render media");
      },
      now: () => "2026-06-30T01:45:00.000Z"
    });
    const cutPlan = JSON.parse(await readFile(result.cutPlanPath, "utf8")) as Record<string, any>;
    const renderReceipt = JSON.parse(await readFile(result.render.receiptPath, "utf8")) as Record<string, any>;

    expect(result).toMatchObject({
      ok: true,
      render: {
        ok: true,
        required: false,
        dryRun: true,
        lane: "ffmpeg"
      },
      // the text-delivery invariant: the native preview lane names the case fold it applies to the Canvas copy.
      warnings: [
        "Native renderer case-folded lowercase text to uppercase block glyphs on layer title: ealrnd."
      ]
    });
    expect(result.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "canvas_selection", path: selectionPath, status: "available" }),
      expect.objectContaining({ role: "render_receipt", path: result.render.receiptPath, status: "available" }),
      expect.objectContaining({ role: "cut_plan", path: result.cutPlanPath, status: "available", primary: true })
    ]));
    expect(result.artifacts.find((artifact) => artifact.role === "rendered_media")).toBeUndefined();
    expect(result.render).not.toHaveProperty("outputPath");
    expect(renderReceipt).toMatchObject({
      operation: "render.final",
      status: "not_run",
      output: {
        required: false,
        reason: "Cut import mode editable_lowering does not require rendered media."
      }
    });
    expect(cutPlan).toMatchObject({
      ok: true,
      mode: "editable_lowering",
      operations: [
        { verb: "cut.shape.create", sourceLayerId: "panel" },
        { verb: "cut.title.create", sourceLayerId: "title" }
      ]
    });
  });

  it("defaults to auto editable Cut operations for lowerable Canvas selections", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-canvas-to-cut-auto-editable-"));
    tempDirs.push(outDir);
    const selectionPath = join(outDir, "frame-selection.json");
    await writeFile(selectionPath, JSON.stringify(staticShapeTextFrameSelection(), null, 2), "utf8");

    const result = await runCanvasToCutConnector({
      canvasSelectionPath: selectionPath,
      outDir,
      previewLane: "native",
      renderLane: "ffmpeg",
      dryRunRender: false,
      ffmpegRunner: async () => {
        throw new Error("auto editable Canvas-to-Cut import should not render media");
      },
      now: () => "2026-07-03T00:30:00.000Z"
    });
    const cutPlan = JSON.parse(await readFile(result.cutPlanPath, "utf8")) as Record<string, any>;
    const renderReceipt = JSON.parse(await readFile(result.render.receiptPath, "utf8")) as Record<string, any>;

    expect(result).toMatchObject({
      ok: true,
      render: {
        ok: true,
        required: false,
        dryRun: true,
        lane: "ffmpeg"
      },
      // the text-delivery invariant: the native preview lane names the case fold it applies to the Canvas copy.
      warnings: [
        "Native renderer case-folded lowercase text to uppercase block glyphs on layer title: ealrnd."
      ]
    });
    expect(result.artifacts.find((artifact) => artifact.role === "rendered_media")).toBeUndefined();
    expect(renderReceipt).toMatchObject({
      operation: "render.final",
      status: "not_run",
      output: {
        required: false,
        reason: "Cut import mode editable_lowering does not require rendered media."
      }
    });
    expect(cutPlan).toMatchObject({
      ok: true,
      mode: "editable_lowering",
      operations: [
        { verb: "cut.shape.create", sourceLayerId: "panel" },
        { verb: "cut.title.create", sourceLayerId: "title" }
      ]
    });
  });

  it("rejects explicit editable Canvas lowering when Cut cannot preserve Motion effects", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-canvas-to-cut-editable-unsupported-"));
    tempDirs.push(outDir);
    const selection = staticShapeTextFrameSelection() as Record<string, any>;
    selection.frames[0].layers[0].effects = { blur: 12 };
    const selectionPath = join(outDir, "frame-selection.json");
    await writeFile(selectionPath, JSON.stringify(selection, null, 2), "utf8");

    const result = await runCanvasToCutConnector({
      canvasSelectionPath: selectionPath,
      outDir,
      previewLane: "native",
      renderLane: "ffmpeg",
      dryRunRender: false,
      cutImportMode: "editable_lowering",
      ffmpegRunner: async () => {
        throw new Error("unsupported editable Canvas-to-Cut import should not render media");
      },
      now: () => "2026-07-03T00:40:00.000Z"
    });
    const cutPlan = JSON.parse(await readFile(result.cutPlanPath, "utf8")) as Record<string, any>;

    expect(result).toMatchObject({
      ok: false,
      render: {
        ok: true,
        required: false,
        dryRun: true,
        lane: "ffmpeg"
      },
      // the text-delivery invariant: the native preview lane names the case fold it applies to the Canvas copy.
      // The last warning comes from the receiver check rather than the capability deny-list: Cut
      // rejects the whole `effects` payload field, which is why the specific unsupported effect
      // and the field carrying it are both worth saying.
      warnings: [
        "Native renderer case-folded lowercase text to uppercase block glyphs on layer title: ealrnd.",
        "Target shellx-cut cannot lower effect.blur on layer panel.",
        "Target shellx-cut rejects payload field \"effects\" on layer panel; its editable receiver accepts a fixed field set."
      ]
    });
    expect(result.artifacts.find((artifact) => artifact.role === "rendered_media")).toBeUndefined();
    expect(cutPlan).toMatchObject({
      ok: false,
      mode: null,
      operations: [],
      unsupported: [
        {
          layerId: "panel",
          feature: "effect.blur",
          reason: "Target shellx-cut cannot lower effect.blur on layer panel."
        },
        {
          layerId: "panel",
          feature: "cut.payload.effects",
          reason: "Target shellx-cut rejects payload field \"effects\" on layer panel; its editable receiver accepts a fixed field set."
        }
      ]
    });
  });

  it("preserves Canvas safe areas through Motion package and Cut import plan", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-canvas-to-cut-safe-"));
    tempDirs.push(outDir);
    const selection = shapeTextFrameSelection() as Record<string, any>;
    selection.frames[0].safeAreas = {
      title: { top: 96, right: 128, bottom: 108, left: 128 },
      action: { top: 48, right: 64, bottom: 64, left: 64 }
    };
    const selectionPath = join(outDir, "frame-selection.json");
    await writeFile(selectionPath, JSON.stringify(selection, null, 2), "utf8");

    const result = await runCanvasToCutConnector({
      canvasSelectionPath: selectionPath,
      outDir: join(outDir, "run"),
      previewLane: "native",
      renderLane: "ffmpeg",
      dryRunRender: false,
      cutImportMode: "editable_lowering",
      ffmpegRunner: async () => {
        throw new Error("safe-area metadata handoff should not render media");
      },
      now: () => "2026-07-02T00:20:00.000Z"
    });
    const pkg = await loadMotionPackage(result.packageDir);
    const cutPlan = JSON.parse(await readFile(result.cutPlanPath, "utf8")) as Record<string, any>;

    expect(pkg.motion.safeAreas).toEqual({
      title: { top: 96, right: 128, bottom: 108, left: 128 },
      action: { top: 48, right: 64, bottom: 64, left: 64 }
    });
    expect(cutPlan).toMatchObject({
      document: {
        safeAreas: {
          title: { top: 96, right: 128, bottom: 108, left: 128 },
          action: { top: 48, right: 64, bottom: 64, left: 64 }
        }
      },
      receipt: {
        output: {
          document: {
            safeAreas: {
              title: { top: 96, right: 128, bottom: 108, left: 128 },
              action: { top: 48, right: 64, bottom: 64, left: 64 }
            }
          }
        }
      }
    });
  });

  it("renders image-backed Canvas selections through browser frames before FFmpeg encode", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-canvas-to-cut-browser-"));
    tempDirs.push(outDir);
    const selectionPath = join(outDir, "frame-selection.json");
    await mkdir(join(outDir, "assets"), { recursive: true });
    await writeFile(join(outDir, "assets", "product-retouched.png"), SAMPLE_PNG);
    await writeFile(selectionPath, JSON.stringify(imageFrameSelection(), null, 2), "utf8");

    const result = await runCanvasToCutConnector({
      canvasSelectionPath: selectionPath,
      outDir: join(outDir, "run"),
      previewLane: "native",
      renderLane: "ffmpeg",
      dryRunRender: false,
      cutImportMode: "rendered_media",
      ffmpegRunner: async (command) => {
        if (command.args.includes("-encoders")) return { exitCode: 0, stdout: "", stderr: "" }; // Hardware-probe discovery; empty means software.
        // See the comment on the first runner in this file: the readback is a READ, and a failed
        // expectation inside it would be swallowed rather than reported.
        if (isDeliveredColorReadback(command)) return { exitCode: 0, stdout: ffprobeReadbackStdout(), stderr: "" };
        expect(command.shell).toBe(false);
        expect(command.args).toEqual(expect.arrayContaining(["-frames:v", "2"]));
        await writeFile(command.args.at(-1) as string, fakeMp4Bytes("canvas browser"));
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      now: () => "2026-06-30T02:30:00.000Z"
    });

    const renderReceipt = JSON.parse(await readFile(result.render.receiptPath, "utf8")) as Record<string, unknown>;
    const cutPlan = JSON.parse(await readFile(result.cutPlanPath, "utf8")) as Record<string, unknown>;
    const connectorReceipt = JSON.parse(await readFile(result.receiptPath, "utf8")) as Record<string, unknown>;
    const firstFrame = await readFile(join(outDir, "run", "frames", "pkg_canvas_motion_browser_frame_image", "000001.png"));
    const packagedAsset = await readFile(join(result.packageDir, "assets", "product-retouched.png"));

    expect(packagedAsset).toEqual(SAMPLE_PNG);
    expect(firstFrame.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(result.ok).toBe(true);
    expect(result.status).toBe("warning");
    expect(result.preview).toMatchObject({
      ok: true,
      lane: "native",
      outputPath: join(outDir, "run", "preview", "native-0.png")
    });
    // the text-delivery invariant: the native preview lane names the case fold it applies to the Canvas copy.
    expect(result.warnings).toEqual([
      "Native renderer case-folded lowercase text to uppercase block glyphs on layer caption: rowseimag.",
      "Rendered video is 1000ms; product review clips should be at least 1500ms."
    ]);
    expect(result.render).toMatchObject({
      ok: true,
      dryRun: false,
      lane: "ffmpeg",
      frameLane: "browser",
      outputPath: join(outDir, "run", "render", "pkg_canvas_motion_browser_frame_image.mp4")
    });
    expect(renderReceipt).toMatchObject({
      operation: "render.final",
      // Same rule as the shape/text case above: the review-length advisory escalates the render
      // receipt, which the aggregating connector receipt has always reported as `warning`.
      status: "warning",
      warnings: expect.arrayContaining([
        "Rendered video is 1000ms; product review clips should be at least 1500ms."
      ]),
      lane: "ffmpeg",
      packageId: "pkg_canvas_motion_browser_frame_image",
      output: {
        path: join(outDir, "run", "render", "pkg_canvas_motion_browser_frame_image.mp4"),
        durationMs: 1000,
        width: 320,
        height: 180,
        color: expect.objectContaining({
          observed: { primaries: "bt709", transfer: "bt709", matrix: "bt709", range: "tv" }
        })
      }
    });
    expect(cutPlan).toMatchObject({
      operations: [
        {
          verb: "cut.media.import_rendered",
          source: { render: "artifact" },
          renderedMedia: { dryRun: false }
        }
      ]
    });
    expect(connectorReceipt).toMatchObject({
      operation: "connector.canvas_to_cut",
      status: "warning",
      output: {
        preview: { ok: true },
        render: { ok: true, frameLane: "browser" },
        cut: { ok: true }
      }
    });
  });

  it("rejects explicit editable image lowering until Cut enables native media receiving", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-canvas-to-cut-image-editable-"));
    tempDirs.push(outDir);
    const selectionPath = join(outDir, "frame-selection.json");
    await mkdir(join(outDir, "assets"), { recursive: true });
    await writeFile(join(outDir, "assets", "product-retouched.png"), SAMPLE_PNG);
    await writeFile(selectionPath, JSON.stringify(imageFrameSelection(), null, 2), "utf8");

    const result = await runCanvasToCutConnector({
      canvasSelectionPath: selectionPath,
      outDir: join(outDir, "run"),
      previewLane: "native",
      renderLane: "ffmpeg",
      dryRunRender: false,
      cutImportMode: "editable_lowering",
      ffmpegRunner: async () => {
        throw new Error("editable image Cut import should not render media");
      },
      now: () => "2026-06-30T03:10:00.000Z"
    });

    const cutPlan = JSON.parse(await readFile(result.cutPlanPath, "utf8")) as Record<string, any>;
    const renderReceipt = JSON.parse(await readFile(result.render.receiptPath, "utf8")) as Record<string, any>;
    const packagedAsset = await readFile(join(result.packageDir, "assets", "product-retouched.png"));

    expect(packagedAsset).toEqual(SAMPLE_PNG);
    expect(result).toMatchObject({
      ok: false,
      render: {
        ok: true,
        required: false,
        dryRun: true,
        lane: "ffmpeg"
      },
      warnings: expect.arrayContaining([
        "Target shellx-cut cannot lower image layers to editable Cut operations."
      ])
    });
    expect(result.render).not.toHaveProperty("outputPath");
    expect(renderReceipt).toMatchObject({
      operation: "render.final",
      status: "not_run",
      output: {
        required: false,
        reason: "Cut import planning found no applicable mode; rendered media was not run for the failed explicit handoff."
      }
    });
    expect(cutPlan).toMatchObject({
      ok: false,
      mode: null,
      operations: [],
      unsupported: expect.arrayContaining([
        expect.objectContaining({ layerId: "hero_image", feature: "layer.type:image" })
      ])
    });
  });

  it("rejects portable Canvas video paths from the Cut-origin native video subset", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-canvas-to-cut-video-editable-"));
    tempDirs.push(outDir);
    const selectionPath = join(outDir, "frame-selection.json");
    await mkdir(join(outDir, "assets"), { recursive: true });
    await writeFile(join(outDir, "assets", "clip.mp4"), SAMPLE_VIDEO);
    await writeFile(selectionPath, JSON.stringify(videoFrameSelection(), null, 2), "utf8");

    const result = await runCanvasToCutConnector({
      canvasSelectionPath: selectionPath,
      outDir: join(outDir, "run"),
      previewLane: "native",
      renderLane: "ffmpeg",
      dryRunRender: false,
      cutImportMode: "editable_lowering",
      ffmpegRunner: async () => {
        throw new Error("editable video Cut import should not render media");
      },
      now: () => "2026-06-30T03:25:00.000Z"
    });

    const cutPlan = JSON.parse(await readFile(result.cutPlanPath, "utf8")) as Record<string, any>;
    const renderReceipt = JSON.parse(await readFile(result.render.receiptPath, "utf8")) as Record<string, any>;
    const connectorReceipt = JSON.parse(await readFile(result.receiptPath, "utf8")) as Record<string, any>;
    const packagedAsset = await readFile(join(result.packageDir, "assets", "clip.mp4"));

    expect(packagedAsset).toEqual(SAMPLE_VIDEO);
    expect(result).toMatchObject({
      ok: false,
      status: "failed",
      preview: {
        ok: false,
        failureFatal: false
      },
      render: {
        ok: true,
        required: false,
        dryRun: true,
        lane: "ffmpeg"
      },
      warnings: expect.arrayContaining([
        "Lane native does not support video layers.",
        "Target shellx-cut cannot lower video.source.cutAssetRef on layer hero_clip."
      ])
    });
    expect(result.render).not.toHaveProperty("outputPath");
    expect(renderReceipt).toMatchObject({
      operation: "render.final",
      status: "not_run",
      output: {
        required: false,
        reason: "Cut import planning found no applicable mode; rendered media was not run for the failed explicit handoff."
      }
    });
    expect(cutPlan).toMatchObject({
      ok: false,
      mode: null,
      operations: [],
      unsupported: expect.arrayContaining([
        expect.objectContaining({ layerId: "hero_clip", feature: "video.source.cutAssetRef" })
      ])
    });
    expect(connectorReceipt).toMatchObject({
      status: "failed",
      output: {
        preview: { ok: false, failureFatal: false },
        render: { required: false },
        cut: { ok: false, mode: null }
      }
    });
  });

});

describe("Canvas to Cut output ownership", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("never overwrites a caller's <out>/package, and says why", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-canvas-cut-own-"));
    tempDirs.push(outDir);
    const selectionPath = join(outDir, "frame-selection.json");
    await writeFile(selectionPath, JSON.stringify(shapeTextFrameSelection(), null, 2), "utf8");
    await mkdir(join(outDir, "package"), { recursive: true });
    await writeFile(join(outDir, "package", "manifest.json"), '{"mine":true}', "utf8");

    await expect(runCanvasToCutConnector({ canvasSelectionPath: selectionPath, outDir, dryRunRender: true }))
      .rejects.toMatchObject({ code: "output_dir_not_empty" });

    expect(await readFile(join(outDir, "package", "manifest.json"), "utf8")).toBe('{"mine":true}');
  });

  it("overwrites only when the caller explicitly asks", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-canvas-cut-own-"));
    tempDirs.push(outDir);
    const selectionPath = join(outDir, "frame-selection.json");
    await writeFile(selectionPath, JSON.stringify(shapeTextFrameSelection(), null, 2), "utf8");
    await mkdir(join(outDir, "package"), { recursive: true });
    await writeFile(join(outDir, "package", "manifest.json"), '{"mine":true}', "utf8");

    const result = await runCanvasToCutConnector({ canvasSelectionPath: selectionPath, outDir, dryRunRender: true, force: true });

    expect(result).toMatchObject({ ok: true });
    expect(await readFile(join(outDir, "package", "manifest.json"), "utf8")).not.toBe('{"mine":true}');
  });
});

function shapeTextFrameSelection(): unknown {
  return {
    schema: "shellx-canvas/frame-selection@1",
    selectedFrameId: "frame_intro",
    project: { id: "canvas_motion_real", name: "Motion Real" },
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
            text: "Real render",
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

function staticShapeTextFrameSelection(): unknown {
  const selection = shapeTextFrameSelection() as Record<string, unknown>;
  const frames = selection.frames as Array<Record<string, unknown>>;
  frames[0].layers = (frames[0].layers as Array<Record<string, unknown>>).map((layer) => {
    const copy = { ...layer };
    delete copy.transitions;
    delete copy.keyframes;
    if (copy.kind === "text" && copy.transform && typeof copy.transform === "object") {
      const transform = { ...(copy.transform as Record<string, unknown>) };
      delete transform.width;
      delete transform.height;
      copy.transform = transform;
    }
    return copy;
  });
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

function imageFrameSelection(): unknown {
  return {
    schema: "shellx-canvas/frame-selection@1",
    selectedFrameId: "frame_image",
    project: { id: "canvas_motion_browser", name: "Motion Browser" },
    brand: { tokens: { color: { accent: "#ef4444", ink: "#111827" }, radius: { image: 12 } } },
    frames: [
      {
        id: "frame_image",
        name: "Image",
        durationMs: 1000,
        fps: 2,
        width: 320,
        height: 180,
        background: "#f8fafc",
        layers: [
          {
            id: "hero_image",
            kind: "image",
            assetId: "asset_product_retouched",
            startMs: 0,
            durationMs: 1000,
            fit: "cover",
            transform: { x: 24, y: 24, width: 128, height: 96, rotation: 0, opacity: 1 },
            style: { radius: "{radius.image}" },
            ...revealMotion()
          },
          {
            id: "caption",
            kind: "text",
            text: "Browser image",
            startMs: 0,
            durationMs: 1000,
            transform: { x: 168, y: 64, width: 128, height: 48, opacity: 1 },
            style: { fontSize: 20, color: "{color.ink}", fontWeight: 700 },
            ...revealMotion()
          }
        ]
      }
    ],
    imageEditorOutputs: [
      {
        id: "image_edit_product_browser",
        assetId: "asset_product_retouched",
        kind: "image",
        path: "assets/product-retouched.png",
        mimeType: "image/png",
        width: 1,
        height: 1,
        sha256: "sample",
        editStack: []
      }
    ]
  };
}

function videoFrameSelection(): unknown {
  return {
    schema: "shellx-canvas/frame-selection@1",
    selectedFrameId: "frame_video",
    project: { id: "canvas_motion_video", name: "Motion Video" },
    brand: { tokens: { color: { ink: "#111827" }, radius: { video: 12 } } },
    frames: [
      {
        id: "frame_video",
        name: "Video",
        durationMs: 1000,
        fps: 2,
        width: 320,
        height: 180,
        background: "#f8fafc",
        layers: [
          {
            id: "hero_clip",
            kind: "video",
            assetId: "asset_clip",
            startMs: 0,
            durationMs: 1000,
            fit: "cover",
            trimStartMs: 100,
            trimDurationMs: 800,
            loop: true,
            transform: { x: 24, y: 24, width: 128, height: 96, rotation: 0, opacity: 1 },
            style: { radius: "{radius.video}" }
          },
          {
            id: "caption",
            kind: "text",
            text: "Browser video",
            startMs: 0,
            durationMs: 1000,
            transform: { x: 168, y: 64, width: 128, height: 48, opacity: 1 },
            style: { fontSize: 20, color: "{color.ink}", fontWeight: 700 }
          }
        ]
      }
    ],
    imageEditorOutputs: [
      {
        id: "video_clip_output",
        assetId: "asset_clip",
        kind: "video",
        path: "assets/clip.mp4",
        mimeType: "video/mp4",
        width: 128,
        height: 96,
        sha256: "sample",
        editStack: []
      }
    ]
  };
}

const SAMPLE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP4////fwAJ+wP99djxmgAAAABJRU5ErkJggg==",
  "base64"
);

const SAMPLE_VIDEO = fakeMp4Bytes("canvas sample");

function fakeMp4Bytes(label: string): Buffer {
  return Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom", "ascii"), Buffer.from(label)]);
}
