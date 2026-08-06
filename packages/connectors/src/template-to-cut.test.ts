import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadMotionPackage } from "@shellx-motion/core";
import { clearDefaultEncodePolicyCache, resolveFfmpegExecutable, type FfmpegCommand } from "@shellx-motion/renderer-ffmpeg";
import { runTemplateToCutConnector } from "./template-to-cut";
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

describe("Template to Cut connector harness", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("applies TemplateIR values and emits the exact Cut-native static subset without rendered media", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-template-to-cut-editable-"));
    tempDirs.push(outDir);

    const result = await runTemplateToCutConnector({
      packageRoot: resolve("../../fixtures/cut-native-static-package"),
      outDir,
      values: {
        title: "Dr. Mira Chen",
        accentColor: "#ff006e"
      },
      cutImportMode: "editable_lowering",
      dryRunRender: false,
      ffmpegRunner: async () => {
        throw new Error("editable template-to-Cut import should not render media");
      },
      now: () => "2026-06-30T03:30:00.000Z"
    });
    const pkg = await loadMotionPackage(result.packageDir);
    const templateReceipt = JSON.parse(await readFile(result.template.receiptPath, "utf8")) as Record<string, any>;
    const renderReceipt = JSON.parse(await readFile(result.render.receiptPath, "utf8")) as Record<string, any>;
    const cutPlan = JSON.parse(await readFile(result.cutPlanPath, "utf8")) as Record<string, any>;
    const connectorReceipt = JSON.parse(await readFile(result.receiptPath, "utf8")) as Record<string, any>;

    expect(result).toMatchObject({
      ok: true,
      template: {
        changedParams: ["title", "accentColor"],
        changedBindings: [
          { paramId: "title", path: "/layers/1/text", oldValue: "Native in Cut", newValue: "Dr. Mira Chen" },
          { paramId: "accentColor", path: "/layers/0/fill", oldValue: "#13d3ff", newValue: "#ff006e" }
        ]
      },
      render: {
        ok: true,
        required: false,
        dryRun: true,
        lane: "ffmpeg"
      },
      preview: {
        ok: true,
        outputPath: join(outDir, "preview", "native-0.png")
      },
      // the text-delivery invariant: the native preview lane reports the case fold and the ignored font family
      // instead of silently substituting them.
      warnings: ["Native renderer case-folded lowercase text to uppercase block glyphs on layer title: riahen."]
    });
    expect(result.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "template_source", path: resolve("../../fixtures/cut-native-static-package"), status: "available" }),
      expect.objectContaining({ role: "motion_package", path: result.packageDir, status: "available" }),
      expect.objectContaining({ role: "template_apply_receipt", path: result.template.receiptPath, status: "available" }),
      expect.objectContaining({ role: "cut_plan", path: result.cutPlanPath, status: "available", primary: true })
    ]));
    expect(result.artifacts.find((artifact) => artifact.role === "rendered_media")).toBeUndefined();
    expect(result.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "preview_frame", path: join(outDir, "preview", "native-0.png"), status: "available", mediaType: "image/png" })
    ]));
    expect(pkg.motion.layers[1]).toMatchObject({ id: "title", text: "Dr. Mira Chen", transform: { scale: 1 } });
    expect(pkg.motion.layers[0]).toMatchObject({ id: "accent", fill: "#ff006e" });
    expect(templateReceipt).toMatchObject({
      operation: "template.apply",
      status: "passed",
      packageId: "pkg_cut_native_static",
      output: {
        changedParams: ["title", "accentColor"]
      }
    });
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
        { verb: "cut.shape.create", sourceLayerId: "accent", payload: { fill: "#ff006e" } },
        { verb: "cut.title.create", sourceLayerId: "title", payload: { text: "Dr. Mira Chen" } }
      ]
    });
    expect(connectorReceipt).toMatchObject({
      operation: "connector.template_to_cut",
      // the text-delivery invariant: degraded, because the native preview could not draw the applied title faithfully.
      status: "warning",
      output: {
        template: {
          changedParams: ["title", "accentColor"],
          receiptPath: result.template.receiptPath
        },
        cut: { ok: true, mode: "editable_lowering", planPath: result.cutPlanPath },
        artifacts: expect.arrayContaining([
          expect.objectContaining({ role: "cut_plan", path: result.cutPlanPath, primary: true })
        ])
      }
    });
    expect(connectorReceipt.warnings).toEqual([
      "Native renderer case-folded lowercase text to uppercase block glyphs on layer title: riahen."
    ]);
  });

  it("defaults to rendered media when the template exceeds Cut's native receiver", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-template-to-cut-auto-editable-"));
    tempDirs.push(outDir);

    const result = await runTemplateToCutConnector({
      packageRoot: resolve("../../fixtures/packages/editable-lower-third"),
      outDir,
      values: {
        title: "Auto Editable"
      },
      dryRunRender: true,
      now: () => "2026-07-03T01:10:00.000Z"
    });
    const cutPlan = JSON.parse(await readFile(result.cutPlanPath, "utf8")) as Record<string, any>;
    const renderReceipt = JSON.parse(await readFile(result.render.receiptPath, "utf8")) as Record<string, any>;

    expect(result).toMatchObject({
      ok: true,
      render: {
        ok: true,
        required: true,
        dryRun: true,
        lane: "ffmpeg"
      },
      warnings: [
        "Native renderer case-folded lowercase text to uppercase block glyphs on layer title: utodiable.",
        "Native renderer ignored the requested font family 'Inter' on layer title and drew block glyphs instead.",
        "Native renderer case-folded lowercase text to uppercase block glyphs on layer subtitle: roductea.",
        "Native renderer ignored the requested font family 'Inter' on layer subtitle and drew block glyphs instead.",
        "Target shellx-cut cannot lower transition.slide on layer title.",
        "Target shellx-cut cannot lower text.style.fontFamily on layer title.",
        "Target shellx-cut cannot lower text.style.fontWeight on layer title.",
        "Target shellx-cut cannot lower text.style.fontFamily on layer subtitle.",
        "Target shellx-cut cannot lower transition.wipe on layer accent."
      ]
    });
    expect(renderReceipt).toMatchObject({ operation: "render.final" });
    expect(cutPlan).toMatchObject({
      ok: true,
      mode: "rendered_media",
      operations: [
        { verb: "cut.media.import_rendered" }
      ],
      unsupported: expect.arrayContaining([
        expect.objectContaining({ layerId: "title", feature: "transition.slide" }),
        expect.objectContaining({ layerId: "accent", feature: "transition.wipe" })
      ])
    });
  });

  it("uses a semantic browser review frame when auto previewing a rich rendered-media template", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-template-to-cut-rich-browser-preview-"));
    tempDirs.push(outDir);

    const result = await runTemplateToCutConnector({
      packageRoot: resolve("../../templates/shellx-product-pack/cinematic-rain-launch"),
      outDir,
      values: { title: "Rain becomes part of the product story", rainIntensity: 0.68 },
      previewLane: "auto",
      cutImportMode: "rendered_media",
      dryRunRender: true,
      now: () => "2026-07-13T12:30:00.000Z"
    });
    const connectorReceipt = JSON.parse(await readFile(result.receiptPath, "utf8")) as Record<string, any>;

    expect(result).toMatchObject({
      ok: true,
      preview: {
        ok: true,
        lane: "browser",
        atMs: 300,
        failureFatal: false,
        outputPath: join(outDir, "preview", "browser-300.png")
      },
      render: { ok: true, required: true, dryRun: true, lane: "ffmpeg" }
    });
    expect(result.warnings).not.toEqual(expect.arrayContaining([
      expect.stringContaining("does not support environment"),
      expect.stringContaining("does not support particles")
    ]));
    expect(connectorReceipt).toMatchObject({
      operation: "connector.template_to_cut",
      status: "passed",
      output: {
        preview: { ok: true, lane: "browser", atMs: 300, failureFatal: false }
      }
    });
    // Rich cinematic (rain-launch) browser preview render is ~4s in isolation; give headroom so it does
    // not flake past the 5s default under full parallel-suite CPU contention.
  }, 45_000);

  it("marks dry-run rendered-media plans failed when native preview fails", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-template-to-cut-preview-fail-"));
    tempDirs.push(outDir);
    const sourcePackage = await createPreviewFailingTemplatePackage(outDir);

    const result = await runTemplateToCutConnector({
      packageRoot: sourcePackage,
      outDir: join(outDir, "run"),
      values: { title: "Preview Failure" },
      cutImportMode: "rendered_media",
      dryRunRender: true,
      now: () => "2026-07-03T12:50:00.000Z"
    });
    const connectorReceipt = JSON.parse(await readFile(result.receiptPath, "utf8")) as Record<string, any>;

    expect(result).toMatchObject({
      ok: false,
      preview: { ok: false, lane: "native", failureFatal: true },
      render: { ok: true, required: true, dryRun: true },
      warnings: expect.arrayContaining([expect.stringContaining("Unsupported color format")])
    });
    expect(connectorReceipt).toMatchObject({
      operation: "connector.template_to_cut",
      status: "failed",
      output: {
        preview: { ok: false, lane: "native", failureFatal: true },
        render: { ok: true, dryRun: true },
        cut: { ok: true, mode: "rendered_media" }
      }
    });
  });

  it("renders applied templates to a real MP4 artifact before Cut rendered-media import", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-template-to-cut-rendered-"));
    tempDirs.push(outDir);
    const sourcePackage = await createShortTemplatePackage(outDir);
    const staleFrame = join(outDir, "frames", "pkg_editable_lower_third", "000999.png");
    await mkdir(join(outDir, "frames", "pkg_editable_lower_third"), { recursive: true });
    await writeFile(staleFrame, STALE_FRAME_BYTES);

    const result = await runTemplateToCutConnector({
      packageRoot: sourcePackage,
      outDir,
      values: { title: "Rendered Template" },
      cutImportMode: "rendered_media",
      dryRunRender: false,
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
        await writeFile(command.args.at(-1) as string, fakeMp4Bytes("template"));
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      now: () => "2026-06-30T03:45:00.000Z"
    });
    const renderReceipt = JSON.parse(await readFile(result.render.receiptPath, "utf8")) as Record<string, any>;
    const cutPlan = JSON.parse(await readFile(result.cutPlanPath, "utf8")) as Record<string, any>;
    const firstFrame = await readFile(join(outDir, "frames", "pkg_editable_lower_third", "000001.png"));

    expect(firstFrame.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    await expect(stat(staleFrame)).rejects.toMatchObject({ code: "ENOENT" });
    expect(result.render).toMatchObject({
      ok: true,
      required: true,
      dryRun: false,
      lane: "ffmpeg",
      frameLane: "browser",
      outputPath: join(outDir, "render", "pkg_editable_lower_third.mp4")
    });
    expect(result.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "rendered_media", path: join(outDir, "render", "pkg_editable_lower_third.mp4"), status: "available", mediaType: "video/mp4", primary: true }),
      expect.objectContaining({ role: "render_receipt", path: result.render.receiptPath, status: "available" })
    ]));
    expect(renderReceipt).toMatchObject({
      operation: "render.final",
      // `warning`, not `passed`: this 1000ms render carries the review-length advisory, and since
      // a render receipt escalates on an actionable warning exactly as the connector receipt
      // aggregating the same warning does.
      status: "warning",
      warnings: expect.arrayContaining([
        "Rendered video is 1000ms; product review clips should be at least 1500ms."
      ]),
      lane: "ffmpeg",
      output: {
        path: join(outDir, "render", "pkg_editable_lower_third.mp4"),
        width: 1280,
        height: 720,
        durationMs: 1000,
        frameLane: "browser",
        // The delivered colour is now OBSERVED off the file, not merely declared from the preset.
        color: expect.objectContaining({
          profile: "sdr-bt709",
          observed: { primaries: "bt709", transfer: "bt709", matrix: "bt709", range: "tv" }
        })
      }
    });
    expect(cutPlan).toMatchObject({
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
  }, 90_000);

  it("returns structured failed receipts when rendered Template-to-Cut FFmpeg encode fails", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-template-to-cut-ffmpeg-fail-"));
    tempDirs.push(outDir);
    const sourcePackage = await createShortTemplatePackage(outDir);

    const result = await runTemplateToCutConnector({
      packageRoot: sourcePackage,
      outDir: join(outDir, "run"),
      values: { title: "Failed Template" },
      cutImportMode: "rendered_media",
      dryRunRender: false,
      ffmpegRunner: async () => ({ exitCode: 1, stdout: "", stderr: "encoder exploded" }),
      now: () => "2026-07-03T02:15:00.000Z"
    });
    const renderReceipt = JSON.parse(await readFile(result.render.receiptPath, "utf8")) as Record<string, any>;
    const connectorReceipt = JSON.parse(await readFile(result.receiptPath, "utf8")) as Record<string, any>;

    expect(result).toMatchObject({
      ok: false,
      render: {
        ok: false,
        required: true,
        dryRun: false,
        lane: "ffmpeg",
        frameLane: "browser",
        outputPath: join(outDir, "run", "render", "pkg_editable_lower_third.mp4")
      },
      artifacts: expect.arrayContaining([
        expect.objectContaining({ role: "rendered_media", path: join(outDir, "run", "render", "pkg_editable_lower_third.mp4"), status: "failed", primary: true })
      ]),
      warnings: [
        "Native renderer case-folded lowercase text to uppercase block glyphs on layer title: ailedmpt.",
        "Native renderer ignored the requested font family 'Inter' on layer title and drew block glyphs instead.",
        "Native renderer case-folded lowercase text to uppercase block glyphs on layer subtitle: roductea.",
        "Native renderer ignored the requested font family 'Inter' on layer subtitle and drew block glyphs instead.",
        "encoder exploded"
      ]
    });
    expect(renderReceipt).toMatchObject({
      operation: "render.final",
      status: "failed",
      lane: "ffmpeg",
      output: {
        path: join(outDir, "run", "render", "pkg_editable_lower_third.mp4"),
        frameLane: "browser",
        error: { code: "ffmpeg_failed", message: "encoder exploded" }
      },
      warnings: ["encoder exploded"]
    });
    expect(connectorReceipt).toMatchObject({
      operation: "connector.template_to_cut",
      status: "failed",
      output: {
        render: { ok: false, dryRun: false, frameLane: "browser" },
        cut: { ok: true, mode: "rendered_media" }
      },
      warnings: [
        "Native renderer case-folded lowercase text to uppercase block glyphs on layer title: ailedmpt.",
        "Native renderer ignored the requested font family 'Inter' on layer title and drew block glyphs instead.",
        "Native renderer case-folded lowercase text to uppercase block glyphs on layer subtitle: roductea.",
        "Native renderer ignored the requested font family 'Inter' on layer subtitle and drew block glyphs instead.",
        "encoder exploded"
      ]
    });
  });

  it("muxes package audio layers into rendered Template-to-Cut imports", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-template-to-cut-audio-"));
    tempDirs.push(outDir);
    const sourcePackage = await createAudioTemplatePackage(outDir);
    const commands: FfmpegCommand[] = [];

    const result = await runTemplateToCutConnector({
      packageRoot: sourcePackage,
      outDir: join(outDir, "run"),
      values: { title: "Audio Template" },
      cutImportMode: "rendered_media",
      dryRunRender: false,
      ffmpegRunner: async (command) => {
        if (command.args.includes("-encoders")) return { exitCode: 0, stdout: "", stderr: "" }; // Hardware-probe discovery; empty means software.
        commands.push(command);
        // The readback READS the staged artifact; answering it as an encode would rewrite it.
        if (isDeliveredColorReadback(command)) return { exitCode: 0, stdout: ffprobeReadbackStdout(), stderr: "" };
        await writeFile(command.args.at(-1) as string, fakeMp4Bytes("template audio"));
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      now: () => "2026-07-01T23:45:00.000Z"
    });
    const renderReceipt = JSON.parse(await readFile(result.render.receiptPath, "utf8")) as Record<string, any>;
    const audioPath = join(result.packageDir, "assets", "voice.wav");
    const command = commands[0];
    expect(command).toBeDefined();
    if (!command) throw new Error("expected Template-to-Cut to invoke FFmpeg");
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
        startMs: 250,
        durationMs: 1800,
        volume: 0.35,
        fadeInMs: 180,
        fadeOutMs: 240
      }
    });
  }, 90_000);
});

async function createShortTemplatePackage(outDir: string): Promise<string> {
  const packageRoot = join(outDir, "short-source-package");
  await cp(resolve("../../fixtures/packages/editable-lower-third"), packageRoot, { recursive: true });
  const motionPath = join(packageRoot, "motion.json");
  const motion = JSON.parse(await readFile(motionPath, "utf8")) as Record<string, any>;
  motion.durationMs = 1000;
  motion.fps = 2;
  motion.layers = motion.layers.map((layer: Record<string, any>) => ({
    ...layer,
    durationMs: 1000
  }));
  await writeFile(motionPath, `${JSON.stringify(motion, null, 2)}\n`, "utf8");
  return packageRoot;
}

function fakeMp4Bytes(label: string): Buffer {
  return Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom", "ascii"), Buffer.from(label)]);
}

async function createPreviewFailingTemplatePackage(outDir: string): Promise<string> {
  const packageRoot = join(outDir, "preview-failing-source-package");
  await cp(resolve("../../fixtures/packages/editable-lower-third"), packageRoot, { recursive: true });
  const motionPath = join(packageRoot, "motion.json");
  const motion = JSON.parse(await readFile(motionPath, "utf8")) as Record<string, any>;
  motion.layers = motion.layers.map((layer: Record<string, any>) =>
    layer.id === "title"
      ? { ...layer, style: { ...layer.style, color: "color(display-p3 1 0 0)" } }
      : layer
  );
  await writeFile(motionPath, `${JSON.stringify(motion, null, 2)}\n`, "utf8");
  return packageRoot;
}

async function createAudioTemplatePackage(outDir: string): Promise<string> {
  const packageRoot = join(outDir, "source-package");
  await cp(resolve("../../fixtures/packages/editable-lower-third"), packageRoot, { recursive: true });
  await mkdir(join(packageRoot, "assets"), { recursive: true });
  await writeFile(join(packageRoot, "assets", "voice.wav"), "fake wav bytes", "utf8");

  const manifestPath = join(packageRoot, "manifest.json");
  const motionPath = join(packageRoot, "motion.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, any>;
  const motion = JSON.parse(await readFile(motionPath, "utf8")) as Record<string, any>;
  manifest.assets = ["assets/voice.wav"];
  motion.durationMs = 2000;
  motion.fps = 2;
  motion.assets = [{ id: "asset_voice", path: "assets/voice.wav", mimeType: "audio/wav" }];
  motion.layers = [
    ...motion.layers.map((layer: Record<string, any>) => ({
      ...layer,
      durationMs: 2000
    })),
    {
      id: "voiceover",
      type: "audio",
      assetId: "assets/voice.wav",
      source: "assets/voice.wav",
      startMs: 250,
      durationMs: 1800,
      volume: 0.35,
      fadeInMs: 180,
      fadeOutMs: 240
    }
  ];
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(motionPath, `${JSON.stringify(motion, null, 2)}\n`, "utf8");
  return packageRoot;
}

describe("output ownership", () => {
  it("never destroys a caller's files under --out, and says why", async () => {
    // A dry-run connector must not delete a sentinel file under <out>/package and still report
    // ok:true. `outDir` is caller-supplied, so
    // a subdirectory named "package" is NOT evidence that Motion created it.
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-connector-own-"));
    tempDirs.push(outDir);
    await mkdir(join(outDir, "package"), { recursive: true });
    await writeFile(join(outDir, "package", "user-sentinel.txt"), "user data", "utf8");

    await expect(runTemplateToCutConnector({
      packageRoot: resolve("../../templates/shellx-product-pack/feature-announcement"),
      values: {},
      outDir,
      previewLane: "auto",
      renderLane: "ffmpeg",
      dryRunRender: true,
      cutImportMode: "auto"
    })).rejects.toMatchObject({ code: "output_dir_not_empty" });

    // Nothing removed on the refusal path.
    expect(await readFile(join(outDir, "package", "user-sentinel.txt"), "utf8")).toBe("user data");
  }, 60_000);

  it("overwrites only when the caller explicitly asks", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-connector-own-"));
    tempDirs.push(outDir);
    await mkdir(join(outDir, "package"), { recursive: true });
    await writeFile(join(outDir, "package", "user-sentinel.txt"), "user data", "utf8");

    // The subject here is the guard, not the render: assert it does not REFUSE, and that the
    // overwrite the caller explicitly asked for actually happened.
    await runTemplateToCutConnector({
      packageRoot: resolve("../../templates/shellx-product-pack/feature-announcement"),
      values: {},
      outDir,
      previewLane: "auto",
      renderLane: "ffmpeg",
      dryRunRender: true,
      force: true,
      cutImportMode: "auto"
    }).catch((error: { code?: string }) => {
      expect(error.code).not.toBe("output_dir_not_empty");
    });

    await expect(readFile(join(outDir, "package", "user-sentinel.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  }, 60_000);
});
