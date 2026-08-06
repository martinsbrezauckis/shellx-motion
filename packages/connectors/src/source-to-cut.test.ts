import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSourceImportDocument } from "@shellx-motion/core";
import { clearDefaultEncodePolicyCache, type FfmpegCommand, type FfmpegRunner } from "@shellx-motion/renderer-ffmpeg";
import { runSourceToCutConnector } from "./source-to-cut";
import { ffprobeReadbackStdout, isDeliveredColorReadback } from "./ffprobe-readback.test-support";

const tempDirs: string[] = [];

// Clear the shared encode-policy probe cache before each test so the per-host hardware probe
// runs deterministically (and once) per render regardless of test order.
beforeEach(clearDefaultEncodePolicyCache);

describe("source-to-Cut connector", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("plans source Markdown into a review-required storyboard and Cut import handoff", async () => {
    const outDir = await makeTempDir();
    const sourceDir = join(outDir, "source-import");
    const sourcePath = join(sourceDir, "source.md");
    await mkdir(dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, importedSourceMarkdown(), "utf8");

    const result = await runSourceToCutConnector({
      sourcePath,
      outDir,
      dryRunRender: true,
      maxFrames: 2,
      frameDurationMs: 900,
      width: 640,
      height: 360,
      fps: 24,
      now: () => "2026-07-04T12:00:00.000Z"
    });
    const receipt = JSON.parse(await readFile(result.receiptPath, "utf8")) as Record<string, any>;
    const scripted = JSON.parse(await readFile(result.storyboard.scriptPath, "utf8")) as Record<string, any>;

    expect(result).toMatchObject({
      ok: true,
      source: {
        path: sourcePath,
        url: "https://github.com/nexu-io/html-video",
        kind: "repo"
      },
      storyboard: {
        scriptPath: join(outDir, "storyboard", "scripted-video.json"),
        receiptPath: join(outDir, "storyboard", "receipts", "source-storyboard.receipt.json"),
        frameCount: 2,
        reviewRequired: true
      },
      packageDir: join(outDir, "cut", "package"),
      cutPlanPath: join(outDir, "cut", "cut-import-plan.json"),
      render: { required: true, dryRun: true, lane: "ffmpeg" },
      artifacts: expect.arrayContaining([
        expect.objectContaining({ role: "source_markdown", path: sourcePath, status: "available", primary: true }),
        expect.objectContaining({ role: "scripted_video", path: join(outDir, "storyboard", "scripted-video.json"), status: "available" }),
        expect.objectContaining({ role: "source_storyboard_receipt", path: join(outDir, "storyboard", "receipts", "source-storyboard.receipt.json"), status: "available" }),
        expect.objectContaining({ role: "motion_package", path: join(outDir, "cut", "package"), status: "available" }),
        expect.objectContaining({ role: "cut_plan", path: join(outDir, "cut", "cut-import-plan.json"), status: "available" }),
        expect.objectContaining({ role: "source_to_cut_receipt", path: join(outDir, "receipts", "source-to-cut.receipt.json"), status: "available" })
      ])
    });
    expect(scripted).toMatchObject({
      schema: "shellx-motion/scripted-video@1",
      workflow: "source-to-scripted-video",
      review: { status: "needs-review", required: true },
      frames: [
        expect.objectContaining({
          reviewStatus: "needs-review",
          sourceRefs: [expect.objectContaining({ url: "https://github.com/nexu-io/html-video", path: sourcePath })]
        }),
        expect.objectContaining({
          reviewStatus: "needs-review",
          sourceRefs: [expect.objectContaining({ url: "https://github.com/nexu-io/html-video", path: sourcePath })]
        })
      ]
    });
    expect(receipt).toMatchObject({
      operation: "connector.source_to_cut",
      // the text-delivery invariant: the native preview case-folds the storyboard copy and now says so, which
      // degrades the connector receipt instead of reporting a clean pass.
      status: "warning",
      lane: "connector",
      output: {
        source: { path: sourcePath, kind: "repo" },
        storyboard: { frameCount: 2, reviewRequired: true },
        connector: { receiptPath: join(outDir, "cut", "connector-run.receipt.json") },
        cut: { ok: true, mode: "rendered_media", planPath: result.cutPlanPath }
      }
    });
  });

  it("can render source-derived storyboards through browser frames before Cut import", async () => {
    const outDir = await makeTempDir();
    const sourcePath = join(outDir, "source.md");
    const commands: FfmpegCommand[] = [];
    await writeFile(sourcePath, importedSourceMarkdown(), "utf8");
    const runner: FfmpegRunner = async (command) => {
      if (command.args.includes("-encoders")) return { exitCode: 0, stdout: "", stderr: "" }; // Hardware-probe discovery; empty means software.
      commands.push(command);
      // The delivered-colour readback READS the staged artifact; answering it as an encode would
      // rewrite the file it was asked to inspect. See ./ffprobe-readback.test-support.
      if (isDeliveredColorReadback(command)) return { exitCode: 0, stdout: ffprobeReadbackStdout(), stderr: "" };
      await mkdir(dirname(command.args.at(-1) as string), { recursive: true });
      await writeFile(command.args.at(-1) as string, Buffer.concat([
        Buffer.from([0x00, 0x00, 0x00, 0x18]),
        Buffer.from("ftypisomsource connector", "ascii")
      ]));
      return { exitCode: 0, stdout: "", stderr: "frame=1 speed=1x" };
    };

    const result = await runSourceToCutConnector({
      sourcePath,
      outDir,
      dryRunRender: false,
      maxFrames: 2,
      frameDurationMs: 900,
      width: 640,
      height: 360,
      fps: 2,
      ffmpegRunner: runner,
      now: () => "2026-07-04T12:01:00.000Z"
    });

    expect(result).toMatchObject({
      ok: true,
      render: {
        ok: true,
        required: true,
        dryRun: false,
        lane: "ffmpeg",
        frameLane: "browser"
      },
      artifacts: expect.arrayContaining([
        expect.objectContaining({ role: "rendered_media", status: "available", mediaType: "video/mp4", primary: true })
      ])
    });
    await stat(result.render.outputPath as string);
    // Two commands, not one: the encode, then the delivered-colour readback of the file it wrote
    // (`verifyDeliveredColor`, default-on under the current contract).
    expect(commands).toHaveLength(2);
    expect(commands[0]?.args.at(-1)).toEqual(expect.stringContaining(join(outDir, "cut", "render", ".pkg_script_source_html_video_reference_workflow.mp4.")));
    expect(commands[0]?.args.at(-1)).toEqual(expect.stringMatching(/\.stage\.mp4$/));
    // The readback reads exactly the staged file the encode produced.
    expect(commands[1]?.args).toEqual(expect.arrayContaining(["-show_streams"]));
    expect(commands[1]?.args.at(-1)).toBe(commands[0]?.args.at(-1));
  }, 45_000);
});

describe("source-to-Cut output ownership", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("never overwrites a caller's storyboard under --out", async () => {
    const outDir = await makeTempDir();
    const sourcePath = join(outDir, "source-import", "source.md");
    await mkdir(dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, importedSourceMarkdown(), "utf8");
    await mkdir(join(outDir, "storyboard"), { recursive: true });
    await writeFile(join(outDir, "storyboard", "scripted-video.json"), '{"mine":true}', "utf8");

    await expect(runSourceToCutConnector({ sourcePath, outDir, dryRunRender: true, maxFrames: 1 }))
      .rejects.toMatchObject({ code: "output_dir_not_empty", path: join(outDir, "storyboard") });

    expect(await readFile(join(outDir, "storyboard", "scripted-video.json"), "utf8")).toBe('{"mine":true}');
  });

  it("overwrites only when the caller explicitly asks", async () => {
    const outDir = await makeTempDir();
    const sourcePath = join(outDir, "source-import", "source.md");
    await mkdir(dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, importedSourceMarkdown(), "utf8");
    await mkdir(join(outDir, "storyboard"), { recursive: true });
    await writeFile(join(outDir, "storyboard", "scripted-video.json"), '{"mine":true}', "utf8");

    const result = await runSourceToCutConnector({ sourcePath, outDir, dryRunRender: true, maxFrames: 1, force: true });

    expect(result).toMatchObject({ ok: true });
    expect(await readFile(join(outDir, "storyboard", "scripted-video.json"), "utf8")).not.toBe('{"mine":true}');
  });
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "shellx-motion-source-cut-"));
  tempDirs.push(dir);
  return dir;
}

function importedSourceMarkdown(): string {
  return buildSourceImportDocument({
    url: "https://github.com/nexu-io/html-video",
    title: "html-video reference workflow",
    kind: "repo",
    markdown: [
      "## HTML video workflows",
      "The reference project demonstrates source-driven HTML composition into video output.",
      "",
      "## Agent inputs",
      "Prompt, link, and repository inputs should become reviewable storyboard frames before timeline mutation.",
      "",
      "## ShellX placement",
      "Motion keeps package, receipt, source refs, and Cut handoff state separate from Canvas."
    ].join("\n")
  }).markdown;
}
