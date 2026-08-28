import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createIntegrationEnvelope, loadMotionPackage } from "@shellx-motion/core";
import { runCanvasMp4Export } from "./canvas-to-mp4";
import { failedStreamingRenderer, streamingTestMediaBytes, successfulStreamingRenderer } from "./streaming-final.test-support";

const tempDirs: string[] = [];

/**
 * A stale frame from a longer previous render. Real PNG bytes on purpose: the frames guard proves
 * ownership from CONTENT, so a text file named `000003.png` is (correctly) refused rather than
 * wiped. This preserves the directory-entry ownership contract without changing the test's focus.
 */
const STALE_FRAME_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("stale", "utf8")]);


describe.runIf(process.platform === "linux")("Canvas independent MP4 export connector", () => {
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

  it("stages an attested final-render seam artifact and reuses its handle in the Cut import plan", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-canvas-mp4-real-"));
    tempDirs.push(outDir);
    const selectionPath = join(outDir, "frame-selection.json");
    await writeFile(selectionPath, JSON.stringify(shapeTextFrameSelection(), null, 2), "utf8");
    const staleFrame = join(outDir, "frames", "pkg_canvas_motion_export_frame_intro", "000003.png");
    await mkdir(join(outDir, "frames", "pkg_canvas_motion_export_frame_intro"), { recursive: true });
    await writeFile(staleFrame, STALE_FRAME_BYTES);
    const result = await runCanvasMp4Export({
      canvasSelectionPath: selectionPath,
      outDir,
      dryRunRender: false,
      streamingRenderer: successfulStreamingRenderer({
        label: "canvas export",
        status: "warning",
        warnings: ["Rendered video is 1000ms; product review clips should be at least 1500ms."],
        output: {
          durationMs: 1000,
          width: 640,
          height: 360,
          color: {
            profile: "sdr-bt709",
            primaries: "bt709",
            transfer: "bt709",
            matrix: "bt709",
            range: "tv",
            observed: { primaries: "bt709", transfer: "bt709", matrix: "bt709", range: "tv" }
          }
        }
      }),
      now: () => "2026-06-30T04:30:00.000Z"
    });
    const renderReceipt = JSON.parse(await readFile(result.render.receiptPath, "utf8")) as Record<string, unknown>;
    const exported = await readFile(result.render.outputPath);
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
    expect(exported).toEqual(streamingTestMediaBytes("canvas export", result.render.outputPath));
    // Streamed final delivery does not own, inspect, or retain the caller's frame cache.
    expect(await readFile(staleFrame)).toEqual(STALE_FRAME_BYTES);
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
        // This seam supplies the same declared/observed receipt shape that the renderer integration
        // suite verifies against its actual process/readback boundary.
        color: {
          profile: "sdr-bt709",
          primaries: "bt709",
          transfer: "bt709",
          matrix: "bt709",
          range: "tv",
          observed: { primaries: "bt709", transfer: "bt709", matrix: "bt709", range: "tv" }
        },
        frameTransport: { delivery: "streamed", retainedFrameCount: 0 }
      }
    });
    expect(renderReceipt.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "rendered_media", path: result.render.outputPath })
    ]));
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

  it("forwards Canvas-to-MP4 through the strict GPU final lane and binds its renderer evidence", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-canvas-mp4-gpu-"));
    tempDirs.push(outDir);
    const selectionPath = join(outDir, "frame-selection.json");
    await writeFile(selectionPath, JSON.stringify(shapeTextFrameSelection(), null, 2), "utf8");
    const result = await runCanvasMp4Export({ canvasSelectionPath: selectionPath, outDir, frameLane: "gpu", dryRunRender: false,
      streamingRenderer: successfulStreamingRenderer("canvas gpu connector seam"), now: () => "2026-08-13T10:00:00.000Z" });
    const connectorReceipt = JSON.parse(await readFile(result.receiptPath, "utf8")) as Record<string, any>;
    const renderReceipt = JSON.parse(await readFile(result.render.receiptPath, "utf8")) as Record<string, any>;

    expect(result.render).toMatchObject({ ok: true, dryRun: false, lane: "ffmpeg", frameLane: "gpu" });
    expect(renderReceipt).toMatchObject({
      status: "passed",
      output: { frameLane: "gpu", frameTransport: { frameLane: "gpu", producer: { frameLane: "gpu" } } },
      inputHashes: { "gpu-static-plan": expect.stringMatching(/^[a-f0-9]{64}$/) }
    });
    expect(connectorReceipt).toMatchObject({ output: { render: { frameLane: "gpu", gpu: { execution: "completed", evidence: {
      schema: "shellx-motion/connector-gpu-final-evidence@1", receiptId: renderReceipt.id,
      frameTransport: { frameLane: "gpu", producer: { frameLane: "gpu" } },
      provenance: { "gpu-frame-sequence": expect.stringMatching(/^[a-f0-9]{64}$/) }
    } } } } });
  });

  it("labels a Canvas GPU dry run as planned and refuses non-video GIF delivery", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-canvas-mp4-gpu-plan-"));
    tempDirs.push(outDir);
    const selectionPath = join(outDir, "frame-selection.json");
    await writeFile(selectionPath, JSON.stringify(shapeTextFrameSelection(), null, 2), "utf8");
    const planned = await runCanvasMp4Export({
      canvasSelectionPath: selectionPath,
      outDir,
      frameLane: "gpu",
      dryRunRender: true,
      now: () => "2026-08-13T10:00:00.000Z"
    });
    const renderReceipt = JSON.parse(await readFile(planned.render.receiptPath, "utf8")) as Record<string, any>;
    expect(planned.render).toMatchObject({ dryRun: true, frameLane: "gpu" });
    expect(renderReceipt.output).toMatchObject({
      frameLane: "gpu",
      gpu: { status: "planned_not_executed", hardwareEvidence: "not_collected" }
    });
    await expect(runCanvasMp4Export({
      canvasSelectionPath: selectionPath,
      outDir: join(outDir, "gif"),
      frameLane: "gpu",
      preset: "gif"
    })).rejects.toThrow("streamed final-video presets only");
  });

  /** Run a successful Canvas MP4 export with the renderer's bounded diagnostics. */
  async function exportWithEncodeStderr(stderr: string) {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-canvas-mp4-diagnostic-"));
    tempDirs.push(outDir);
    const selectionPath = join(outDir, "frame-selection.json");
    await writeFile(selectionPath, JSON.stringify(reviewLengthShapeTextFrameSelection(), null, 2), "utf8");

    const result = await runCanvasMp4Export({
      canvasSelectionPath: selectionPath,
      outDir,
      dryRunRender: false,
      streamingRenderer: successfulStreamingRenderer({
        label: "canvas diagnostic",
        warnings: stderr.includes("Non-monotonous DTS")
          ? [stderr.replace(/\b0x[0-9a-f]+\b/gi, "[address]")]
          : []
      }),
      now: () => "2026-07-03T04:30:00.000Z"
    });
    return {
      result,
      renderReceipt: JSON.parse(await readFile(result.render.receiptPath, "utf8")) as Record<string, any>,
      exportReceipt: JSON.parse(await readFile(result.receiptPath, "utf8")) as Record<string, any>
    };
  }

  it("keeps successful connector receipts passed and silent when the stream has no diagnostic", async () => {
    // A silent staged seam preserves the success-status invariant: `warnings.length` remains useful.
    const { result, renderReceipt, exportReceipt } = await exportWithEncodeStderr(
      "[libx264 @ 0000020c04c68080] ref B L0: 98.0%  2.0%\n[libx264 @ 0000020c04c68080] kb/s:17.48"
    );

    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(renderReceipt).toMatchObject({ operation: "render.final", status: "passed", warnings: [] });
    expect(exportReceipt).toMatchObject({ operation: "connector.canvas_to_mp4", status: "passed", warnings: [] });
  }, 45_000);

  it("marks successful connector receipts warning when they retain a real stream diagnostic", async () => {
    // The encode succeeds, but the retained renderer evidence is actionable and must move both
    // receipts from `passed` to `warning`.
    const diagnostic = "[mp4 @ 0x55f] Non-monotonous DTS in output stream 0:0; previous: 1024, current: 512;";
    // The staged seam supplies a normalised bounded diagnostic; the renderer integration suite
    // verifies normalisation from real process output.
    const asRecorded = diagnostic.replace(/\b0x[0-9a-f]+\b/gi, "[address]");
    const { result, renderReceipt, exportReceipt } = await exportWithEncodeStderr(diagnostic);

    expect(result.ok).toBe(true);
    expect(renderReceipt.status).toBe("warning");
    expect(exportReceipt.status).toBe("warning");
    expect(result.warnings).toContain(asRecorded);
    expect(renderReceipt.warnings).toContain(asRecorded);
    expect(exportReceipt.warnings).toContain(asRecorded);
    // The diagnostic survives with only its pointer normalized, and its warning status makes that
    // fact visible to a consumer that reads the receipt verdict rather than `warnings` directly.
    expect(asRecorded).toContain("Non-monotonous DTS in output stream 0:0");
  }, 45_000);

  it("escalates both receipts when the delivered file lacks the colour its preset promised", async () => {
    // The seam models a mismatched delivered-colour receipt; real readback coverage belongs to the
    // renderer integration suite. The connector must still escalate both receipt surfaces.
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-canvas-mp4-colour-mismatch-"));
    tempDirs.push(outDir);
    const selectionPath = join(outDir, "frame-selection.json");
    await writeFile(selectionPath, JSON.stringify(reviewLengthShapeTextFrameSelection(), null, 2), "utf8");

    const result = await runCanvasMp4Export({
      canvasSelectionPath: selectionPath,
      outDir,
      dryRunRender: false,
      streamingRenderer: successfulStreamingRenderer({
        label: "canvas colour mismatch",
        status: "warning",
        warnings: ["Delivered colour does not match the sdr-bt709 profile the preset declares."],
        output: {
          color: {
            profile: "sdr-bt709",
            transfer: "bt709",
            primaries: "bt709",
            observed: { matrix: "bt709", range: "tv", transfer: null, primaries: null }
          }
        }
      }),
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

  it("returns structured failed receipts when the Canvas MP4 final-render seam fails", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-canvas-mp4-ffmpeg-fail-"));
    tempDirs.push(outDir);
    const selectionPath = join(outDir, "frame-selection.json");
    await writeFile(selectionPath, JSON.stringify(shapeTextFrameSelection(), null, 2), "utf8");

    const result = await runCanvasMp4Export({
      canvasSelectionPath: selectionPath,
      outDir,
      dryRunRender: false,
      streamingRenderer: failedStreamingRenderer("ffmpeg_failed", "encoder exploded"),
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

  it("passes Canvas audio layers into the staged independent-MP4 seam", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-canvas-mp4-audio-"));
    tempDirs.push(outDir);
    const selectionPath = join(outDir, "frame-selection.json");
    await mkdir(join(outDir, "assets"), { recursive: true, mode: 0o700 });
    await writeFile(join(outDir, "assets", "voice.wav"), "fake wav bytes", "utf8");
    await writeFile(selectionPath, JSON.stringify(audioShapeTextFrameSelection(), null, 2), "utf8");
    let audioInput: unknown;

    const result = await runCanvasMp4Export({
      canvasSelectionPath: selectionPath,
      outDir,
      dryRunRender: false,
      streamingRenderer: async (input) => {
        audioInput = input.audio;
        return await successfulStreamingRenderer("canvas export audio")(input);
      },
      now: () => "2026-07-01T23:30:00.000Z"
    });

    const renderReceipt = JSON.parse(await readFile(result.render.receiptPath, "utf8")) as Record<string, any>;
    const audioPath = join(result.packageDir, "assets", "voice.wav");
    expect(audioInput).toMatchObject({ path: audioPath });
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

  it("records a static Canvas MP4 quality refusal from the final-render seam", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-canvas-mp4-static-"));
    tempDirs.push(outDir);
    const selectionPath = join(outDir, "frame-selection.json");
    await writeFile(selectionPath, JSON.stringify(staticShapeTextFrameSelection(), null, 2), "utf8");
    const result = await runCanvasMp4Export({
      canvasSelectionPath: selectionPath,
      outDir,
      dryRunRender: false,
      streamingRenderer: failedStreamingRenderer(
        "frame_quality_failed",
        "Rendered frame sequence has 1 unique frame; expected at least 2."
      ),
      now: () => "2026-06-30T04:45:00.000Z"
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

describe.runIf(process.platform === "linux")("Canvas MP4 output ownership", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("never deletes or treats a caller's files under <out>/frames as streaming retention", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-canvas-mp4-own-"));
    tempDirs.push(outDir);
    const selectionPath = join(outDir, "frame-selection.json");
    await writeFile(selectionPath, JSON.stringify(shapeTextFrameSelection(), null, 2), "utf8");
    const framesDir = join(outDir, "frames", "pkg_canvas_motion_export_frame_intro");
    await mkdir(framesDir, { recursive: true });
    await writeFile(join(framesDir, "keepme.txt"), "user data", "utf8");

    const result = await runCanvasMp4Export({
      canvasSelectionPath: selectionPath,
      outDir,
      dryRunRender: false,
      streamingRenderer: successfulStreamingRenderer("frames are caller-owned"),
      now: () => "2026-08-02T00:00:00.000Z"
    });

    expect(result.ok).toBe(true);
    expect(await readFile(join(framesDir, "keepme.txt"), "utf8")).toBe("user data");
  });

  it("never overwrites a caller's <out>/package", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-canvas-mp4-own-"));
    tempDirs.push(outDir);
    const selectionPath = join(outDir, "frame-selection.json");
    await writeFile(selectionPath, JSON.stringify(shapeTextFrameSelection(), null, 2), "utf8");
    await mkdir(join(outDir, "package"), { recursive: true, mode: 0o700 });
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
    await mkdir(join(outDir, "package"), { recursive: true, mode: 0o700 });
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
