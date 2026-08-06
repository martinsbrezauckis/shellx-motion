import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadMotionPackage, readAttestedArtifactHandle, verifyAttestedArtifactHandle } from "@shellx-motion/core";
import { clearDefaultEncodePolicyCache, resolveFfmpegExecutable, type FfmpegCommand, type FfmpegRunner } from "@shellx-motion/renderer-ffmpeg";
import { runScriptToCutConnector } from "./script-to-cut";
import { ffprobeReadbackStdout, isDeliveredColorReadback } from "./ffprobe-readback.test-support";

const tempDirs: string[] = [];

// Clear the shared encode-policy probe cache before each test so the per-host hardware probe
// runs deterministically (and once) per render regardless of test order.
beforeEach(clearDefaultEncodePolicyCache);

describe("script-to-Cut connector", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("writes a scripted Motion package, native preview, render dry-run receipt, and Cut import plan without Canvas", async () => {
    const outDir = await makeTempDir();
    const scriptPath = join(outDir, "storyboard.json");
    await writeFile(scriptPath, `${JSON.stringify(scriptedVideo(), null, 2)}\n`, "utf8");

    const result = await runScriptToCutConnector({
      scriptPath,
      outDir,
      dryRunRender: true,
      now: () => "2026-06-30T08:20:00.000Z"
    });
    const pkg = await loadMotionPackage(result.packageDir);
    const cutPlan = JSON.parse(await readFile(result.cutPlanPath, "utf8")) as Record<string, any>;
    const receipt = JSON.parse(await readFile(result.receiptPath, "utf8")) as Record<string, any>;

    expect(result).toMatchObject({
      ok: true,
      packageDir: join(outDir, "package"),
      preview: { ok: true, lane: "native", receiptPath: join(outDir, "receipts", "native-preview.receipt.json") },
      render: { ok: true, dryRun: true, lane: "ffmpeg", receiptPath: join(outDir, "receipts", "ffmpeg-render.receipt.json") },
      cutPlanPath: join(outDir, "cut-import-plan.json"),
      receiptPath: join(outDir, "connector-run.receipt.json"),
      artifacts: expect.arrayContaining([
        expect.objectContaining({ role: "scripted_video", path: scriptPath, status: "available" }),
        expect.objectContaining({ role: "rendered_media", path: join(outDir, "render", "pkg_script_launch_demo.mp4"), status: "planned", mediaType: "video/mp4", primary: true }),
        expect.objectContaining({ role: "cut_plan", path: join(outDir, "cut-import-plan.json"), status: "available" }),
        expect.objectContaining({ role: "connector_receipt", path: join(outDir, "connector-run.receipt.json"), status: "available" })
      ]),
      // the text-delivery invariant: the native preview lane now names the case fold it applies instead of
      // silently uppercasing the scripted copy.
      warnings: [
        "Native renderer case-folded lowercase text to uppercase block glyphs on layer frame_hook_title: ok.",
        "Native renderer case-folded lowercase text to uppercase block glyphs on layer frame_hook_body: howtenrkfl."
      ]
    });
    expect(pkg.manifest.compatibility.hosts).toEqual(["shellx-motion", "shellx-cut"]);
    expect(pkg.manifest.compatibility.lanes).toEqual(["native", "browser", "ffmpeg", "cut"]);
    expect(pkg.manifest.compatibility.hosts).not.toContain("shellx-canvas");
    expect(cutPlan).toMatchObject({
      schema: "shellx-motion/cut-import-plan@1",
      ok: true,
      mode: "rendered_media",
      operations: [
        {
          verb: "cut.media.import_rendered",
          source: { packageId: "pkg_script_launch_demo", motionId: "motion_script_launch_demo", render: "dry_run" },
          renderedMedia: {
            plannedPath: join(outDir, "render", "pkg_script_launch_demo.mp4"),
            receiptPath: join(outDir, "receipts", "ffmpeg-render.receipt.json"),
            dryRun: true
          }
        }
      ]
    });
    expect(receipt).toMatchObject({
      operation: "connector.script_to_cut",
      // the text-delivery invariant: the run is degraded, not clean — the native preview could not draw the copy
      // faithfully and the connector receipt now carries that instead of hiding it.
      status: "warning",
      packageId: "pkg_script_launch_demo",
      lane: "connector",
      output: {
        artifacts: expect.arrayContaining([
          expect.objectContaining({ role: "rendered_media", path: join(outDir, "render", "pkg_script_launch_demo.mp4"), status: "planned", primary: true }),
          expect.objectContaining({ role: "cut_plan", path: result.cutPlanPath, status: "available" })
        ]),
        script: { path: scriptPath },
        cut: { ok: true, mode: "rendered_media", planPath: result.cutPlanPath }
      },
      warnings: [
        "Native renderer case-folded lowercase text to uppercase block glyphs on layer frame_hook_title: ok.",
        "Native renderer case-folded lowercase text to uppercase block glyphs on layer frame_hook_body: howtenrkfl."
      ]
    });
  });

  it("can label scripted-video receipts as Cut Generate handoffs", async () => {
    const outDir = await makeTempDir();
    const scriptPath = join(outDir, "storyboard.json");
    await writeFile(scriptPath, `${JSON.stringify(scriptedVideo(), null, 2)}\n`, "utf8");

    const result = await runScriptToCutConnector({
      scriptPath,
      outDir,
      dryRunRender: true,
      receiptOperation: "connector.cut_generate_to_cut",
      now: () => "2026-06-30T08:20:00.000Z"
    });
    const receipt = JSON.parse(await readFile(result.receiptPath, "utf8")) as Record<string, any>;

    expect(result).toMatchObject({
      ok: true,
      cutPlanPath: join(outDir, "cut-import-plan.json")
    });
    expect(receipt).toMatchObject({
      operation: "connector.cut_generate_to_cut",
      output: {
        script: { path: scriptPath },
        cut: { ok: true, mode: "rendered_media" },
        render: { ok: true, dryRun: true }
      }
    });
  });

  it("marks dry-run rendered-media plans failed when native preview fails", async () => {
    const outDir = await makeTempDir();
    const scriptPath = join(outDir, "storyboard.json");
    await writeFile(scriptPath, `${JSON.stringify(previewFailingScriptedVideo(), null, 2)}\n`, "utf8");

    const result = await runScriptToCutConnector({
      scriptPath,
      outDir,
      dryRunRender: true,
      now: () => "2026-07-03T12:45:00.000Z"
    });
    const receipt = JSON.parse(await readFile(result.receiptPath, "utf8")) as Record<string, any>;

    expect(result).toMatchObject({
      ok: false,
      preview: { ok: false, lane: "native", failureFatal: true },
      render: { ok: true, required: true, dryRun: true },
      warnings: expect.arrayContaining([expect.stringContaining("Unsupported color format")])
    });
    expect(receipt).toMatchObject({
      operation: "connector.script_to_cut",
      status: "failed",
      output: {
        preview: { ok: false, lane: "native", failureFatal: true },
        render: { ok: true, dryRun: true },
        cut: { ok: true, mode: "rendered_media" }
      }
    });
  });

  it("renders scripted frames to a real MP4 artifact through browser frames before Cut apply", async () => {
    const outDir = await makeTempDir();
    const scriptPath = join(outDir, "storyboard.json");
    const commands: FfmpegCommand[] = [];
    await writeFile(scriptPath, `${JSON.stringify(scriptedVideo(), null, 2)}\n`, "utf8");
    const runner: FfmpegRunner = async (command) => {
      if (command.args.includes("-encoders")) return { exitCode: 0, stdout: "", stderr: "" }; // Hardware-probe discovery; empty means software.
      commands.push(command);
      if (command.args[0] === "-version") {
        return { exitCode: 0, stdout: "ffmpeg version fake", stderr: "" };
      }
      // The delivered-colour readback READS the staged artifact; answering it as an encode would
      // rewrite the file it was asked to inspect. See ./ffprobe-readback.test-support.
      if (isDeliveredColorReadback(command)) return { exitCode: 0, stdout: ffprobeReadbackStdout(), stderr: "" };
      await mkdir(dirname(command.args.at(-1) as string), { recursive: true });
      await writeFile(command.args.at(-1) as string, fakeMp4Bytes("script connector"));
      return { exitCode: 0, stdout: "", stderr: "frame=1 speed=1x" };
    };

    const result = await runScriptToCutConnector({
      scriptPath,
      outDir,
      dryRunRender: false,
      ffmpegRunner: runner,
      now: () => "2026-06-30T08:21:00.000Z"
    });
    const renderReceipt = JSON.parse(await readFile(result.render.receiptPath, "utf8")) as Record<string, any>;
    const firstFrame = await readFile(join(outDir, "frames", "pkg_script_launch_demo", "000001.png"));
    const cutPlan = JSON.parse(await readFile(result.cutPlanPath, "utf8")) as Record<string, any>;
    const handlePath = join(outDir, "artifacts", "rendered-media.artifact.json");
    const handle = await readAttestedArtifactHandle(handlePath);
    const verified = await verifyAttestedArtifactHandle(outDir, handle, {
      requiredReceiptRoles: ["render", "connector"],
      probe: false
    });

    expect(result).toMatchObject({
      ok: true,
      render: {
        ok: true,
        dryRun: false,
        lane: "ffmpeg",
        frameLane: "browser",
        outputPath: join(outDir, "render", "pkg_script_launch_demo.mp4")
      },
      artifacts: expect.arrayContaining([
        expect.objectContaining({ role: "rendered_media", path: join(outDir, "render", "pkg_script_launch_demo.mp4"), status: "available", mediaType: "video/mp4", primary: true }),
        expect.objectContaining({ role: "artifact_handle", path: handlePath, status: "available" })
      ])
    });
    expect(cutPlan.operations[0].renderedMedia).toMatchObject({
      dryRun: false,
      handle: {
        schema: "shellx-motion/artifact-handle-ref@1",
        id: handle.id,
        rootRelativePath: "artifacts/rendered-media.artifact.json",
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/)
      }
    });
    expect(verified.path).toBe(await realpath(join(outDir, "render", "pkg_script_launch_demo.mp4")));
    expect(result.warnings).toContain("Rendered video is 1000ms; product review clips should be at least 1500ms.");
    await stat(join(outDir, "render", "pkg_script_launch_demo.mp4"));
    expect(firstFrame.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    // Two commands, not one: the encode, then the delivered-colour readback of the file it wrote
    // (`verifyDeliveredColor`, default-on under the current contract).
    expect(commands).toHaveLength(2);
    expect(commands[0]).toEqual({
      executable: resolveFfmpegExecutable(),
      args: [
        "-y",
        "-framerate",
        "2",
        "-start_number",
        "1",
        "-protocol_whitelist",
        "file",
        "-i",
        join(outDir, "frames", "pkg_script_launch_demo", "%06d.png"),
        "-frames:v",
        "2",
        "-c:v",
        "libx264",
        "-crf",
        "18",
        "-preset",
        "medium",
        "-pix_fmt",
        "yuv420p",
        "-vf",
        // `setparams` was appended . `scale` carries only matrix and range on the output
        // frame, and newer FFmpeg takes the encoder's colour properties from the FILTERGRAPH FRAME,
        // so unset frame primaries/transfer silently beat `-color_primaries`/`-color_trc` and the
        // delivered HEVC/AV1 files lost both tags while the receipt still declared sdr-bt709.
        // Setting all four on the frame is codec- and FFmpeg-version-independent.
        "scale=in_range=full:out_range=tv:out_color_matrix=bt709,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv",
        "-colorspace",
        "bt709",
        "-color_primaries",
        "bt709",
        "-color_trc",
        "bt709",
        "-color_range",
        "tv",
        "-movflags",
        "+faststart",
        expect.stringContaining(join(outDir, "render", ".pkg_script_launch_demo.mp4."))
      ],
      shell: false
    });
    // The readback reads exactly the file the encode wrote — the staged artifact, before the move.
    expect(commands[1]).toMatchObject({
      executable: expect.stringContaining("ffprobe"),
      args: expect.arrayContaining(["-show_streams"]),
      shell: false
    });
    expect(commands[1]?.args.at(-1)).toBe(commands[0]?.args.at(-1));
    expect(renderReceipt).toMatchObject({
      operation: "render.final",
      // `warning`: this 1000ms export carries the review-length advisory, and a render receipt now
      // escalates on an actionable warning exactly as the connector receipt aggregating it does.
      status: "warning",
      warnings: expect.arrayContaining([
        "Rendered video is 1000ms; product review clips should be at least 1500ms."
      ]),
      lane: "ffmpeg",
      output: {
        frameLane: "browser",
        // The delivered colour is now OBSERVED, not merely declared.
        color: expect.objectContaining({
          profile: "sdr-bt709",
          observed: { primaries: "bt709", transfer: "bt709", matrix: "bt709", range: "tv" }
        })
      }
    });
  });

  it("rejects static multi-frame scripted-video renders before Cut media import", async () => {
    const outDir = await makeTempDir();
    const scriptPath = join(outDir, "storyboard.json");
    const commands: FfmpegCommand[] = [];
    await writeFile(scriptPath, `${JSON.stringify(staticScriptedVideo(), null, 2)}\n`, "utf8");

    const result = await runScriptToCutConnector({
      scriptPath,
      outDir,
      dryRunRender: false,
      ffmpegRunner: async (command) => {
        if (command.args.includes("-encoders")) return { exitCode: 0, stdout: "", stderr: "" }; // Hardware-probe discovery; empty means software.
        commands.push(command);
        await writeFile(command.args.at(-1) as string, "fake mp4 bytes", "utf8");
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      now: () => "2026-06-30T08:23:00.000Z"
    });
    const renderReceipt = JSON.parse(await readFile(result.render.receiptPath, "utf8")) as Record<string, any>;
    const connectorReceipt = JSON.parse(await readFile(result.receiptPath, "utf8")) as Record<string, any>;

    expect(commands).toEqual([]);
    expect(result).toMatchObject({
      ok: false,
      render: {
        ok: false,
        required: true,
        dryRun: false,
        lane: "ffmpeg",
        frameLane: "browser",
        outputPath: join(outDir, "render", "pkg_script_static_demo.mp4")
      },
      artifacts: expect.arrayContaining([
        expect.objectContaining({ role: "rendered_media", path: join(outDir, "render", "pkg_script_static_demo.mp4"), status: "failed", primary: true })
      ]),
      warnings: [
        "Native renderer case-folded lowercase text to uppercase block glyphs on layer frame_first_title: amefr.",
        "Native renderer case-folded lowercase text to uppercase block glyphs on layer frame_first_body: ovisblechang.",
        "Rendered frame sequence has 1 unique frame; expected at least 2."
      ]
    });
    expect(renderReceipt).toMatchObject({
      operation: "render.final",
      status: "failed",
      output: {
        path: join(outDir, "render", "pkg_script_static_demo.mp4"),
        frameLane: "browser",
        error: {
          code: "frame_quality_failed",
          message: "Rendered frame sequence has 1 unique frame; expected at least 2."
        }
      }
    });
    expect(connectorReceipt).toMatchObject({
      operation: "connector.script_to_cut",
      status: "failed",
      output: {
        render: { ok: false, dryRun: false, frameLane: "browser" },
        cut: { ok: true, mode: "rendered_media" }
      },
      warnings: [
        "Native renderer case-folded lowercase text to uppercase block glyphs on layer frame_first_title: amefr.",
        "Native renderer case-folded lowercase text to uppercase block glyphs on layer frame_first_body: ovisblechang.",
        "Rendered frame sequence has 1 unique frame; expected at least 2."
      ]
    });
  }, 45_000);

  it("rejects explicit editable scripted-video lowering when Cut cannot preserve its scenes and typography", async () => {
    const outDir = await makeTempDir();
    const scriptPath = join(outDir, "storyboard.json");
    await writeFile(scriptPath, `${JSON.stringify(scriptedVideo(), null, 2)}\n`, "utf8");

    const result = await runScriptToCutConnector({
      scriptPath,
      outDir,
      dryRunRender: false,
      cutImportMode: "editable_lowering",
      ffmpegRunner: async () => {
        throw new Error("editable Cut import should not render media");
      },
      now: () => "2026-06-30T08:22:00.000Z"
    });
    const cutPlan = JSON.parse(await readFile(result.cutPlanPath, "utf8")) as Record<string, any>;
    const renderReceipt = JSON.parse(await readFile(result.render.receiptPath, "utf8")) as Record<string, any>;

    expect(result).toMatchObject({
      ok: false,
      render: {
        ok: true,
        required: false,
        dryRun: true,
        lane: "ffmpeg"
      },
      artifacts: expect.arrayContaining([
        expect.objectContaining({ role: "cut_plan", path: join(outDir, "cut-import-plan.json"), status: "available", primary: true })
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
    expect(result.warnings).toEqual(expect.arrayContaining([
      "Target shellx-cut cannot lower timeline.scenes to editable Cut operations."
    ]));
    expect(cutPlan).toMatchObject({
      ok: false,
      mode: null,
      operations: [],
      unsupported: expect.arrayContaining([
        expect.objectContaining({ feature: "timeline.scenes" }),
        expect.objectContaining({ feature: "text.box" })
      ])
    });
  });
});

describe("script-to-Cut output ownership", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("never overwrites a caller's files under --out, and says why", async () => {
    // Reproduced before the fix: this connector called NO guard, so a caller's own
    // `<out>/package/manifest.json` was replaced by a dry run that still reported ok:true.
    const outDir = await makeTempDir();
    const scriptPath = join(outDir, "storyboard.json");
    await writeFile(scriptPath, `${JSON.stringify(scriptedVideo(), null, 2)}\n`, "utf8");
    await mkdir(join(outDir, "package"), { recursive: true });
    await writeFile(join(outDir, "package", "manifest.json"), '{"mine":true}', "utf8");

    await expect(runScriptToCutConnector({ scriptPath, outDir, dryRunRender: true }))
      .rejects.toMatchObject({ code: "output_dir_not_empty" });

    expect(await readFile(join(outDir, "package", "manifest.json"), "utf8")).toBe('{"mine":true}');
  });

  it("refuses a non-empty owned directory even when <out>/package is absent", async () => {
    // Guarding `<out>/package` alone leaves every other directory this connector recreates unguarded.
    const outDir = await makeTempDir();
    const scriptPath = join(outDir, "storyboard.json");
    await writeFile(scriptPath, `${JSON.stringify(scriptedVideo(), null, 2)}\n`, "utf8");
    await mkdir(join(outDir, "render"), { recursive: true });
    await writeFile(join(outDir, "render", "my-cut.mp4"), "user video", "utf8");

    await expect(runScriptToCutConnector({ scriptPath, outDir, dryRunRender: true }))
      .rejects.toMatchObject({ code: "output_dir_not_empty", path: join(outDir, "render") });

    expect(await readFile(join(outDir, "render", "my-cut.mp4"), "utf8")).toBe("user video");
    // Nothing was created on the refusal path either.
    await expect(stat(join(outDir, "package"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("overwrites only when the caller explicitly asks", async () => {
    const outDir = await makeTempDir();
    const scriptPath = join(outDir, "storyboard.json");
    await writeFile(scriptPath, `${JSON.stringify(scriptedVideo(), null, 2)}\n`, "utf8");
    await mkdir(join(outDir, "package"), { recursive: true });
    await writeFile(join(outDir, "package", "manifest.json"), '{"mine":true}', "utf8");

    const result = await runScriptToCutConnector({ scriptPath, outDir, dryRunRender: true, force: true });

    expect(result).toMatchObject({ ok: true, packageDir: join(outDir, "package") });
    expect(await readFile(join(outDir, "package", "manifest.json"), "utf8")).not.toBe('{"mine":true}');
  });
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "shellx-motion-script-cut-"));
  tempDirs.push(dir);
  return dir;
}

function scriptedVideo(): unknown {
  return {
    schema: "shellx-motion/scripted-video@1",
    id: "launch-demo",
    name: "Launch Demo",
    sourceApp: "shellx-cut",
    workflow: "generate",
    width: 640,
    height: 360,
    fps: 2,
    frames: [
      {
        id: "hook",
        title: "Hook",
        body: "Show the new workflow",
        durationMs: 500,
        background: "#0f172a",
        accent: "#38bdf8"
      },
      {
        id: "cta",
        title: "Cut edits it",
        caption: "Rendered by Motion",
        durationMs: 500,
        background: "#111827",
        accent: "#22c55e"
      }
    ]
  };
}

function staticScriptedVideo(): unknown {
  return {
    schema: "shellx-motion/scripted-video@1",
    id: "static-demo",
    name: "Static Demo",
    sourceApp: "shellx-cut",
    workflow: "generate",
    width: 640,
    height: 360,
    fps: 2,
    frames: [
      {
        id: "first",
        title: "Same frame",
        body: "No visible change",
        durationMs: 500,
        background: "#0f172a",
        accent: "#38bdf8"
      },
      {
        id: "second",
        title: "Same frame",
        body: "No visible change",
        durationMs: 500,
        background: "#0f172a",
        accent: "#38bdf8"
      }
    ]
  };
}

function previewFailingScriptedVideo(): unknown {
  return {
    schema: "shellx-motion/scripted-video@1",
    id: "preview-fail-demo",
    name: "Preview Fail Demo",
    sourceApp: "shellx-cut",
    workflow: "generate",
    width: 640,
    height: 360,
    fps: 2,
    frames: [
      {
        id: "bad-preview",
        title: "Bad native preview",
        body: "Dry-run export must surface this failure",
        durationMs: 1000,
        background: "color(display-p3 1 0 0)",
        accent: "#38bdf8"
      }
    ]
  };
}

function fakeMp4Bytes(label: string): Buffer {
  return Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from("ftypisom", "ascii"),
    Buffer.from(label, "utf8")
  ]);
}
