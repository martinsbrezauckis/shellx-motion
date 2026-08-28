import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dispatchDebugCommand } from "./index.js";

const roots: string[] = [];
const fixturePackage = "../../fixtures/packages/keyframed-lower-third";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workspace(): Promise<{ root: string; outputRoot: string; outsideRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-debug-browser-workflow-output-"));
  const outputRoot = join(root, "approved-output");
  const outsideRoot = join(root, "outside");
  await Promise.all([mkdir(outputRoot, { mode: 0o700 }), mkdir(outsideRoot, { mode: 0o700 })]);
  roots.push(root);
  return { root, outputRoot, outsideRoot };
}

function browserFrameRenderer(calls: number[]) {
  return async (pkg: { motion: { width: number; height: number }; manifest: { id: string } }, options: { atMs: number; outDir: string; outputPath?: string }) => {
    calls.push(options.atMs);
    const outputPath = options.outputPath ?? join(options.outDir, `${pkg.manifest.id}-browser-${options.atMs}.png`);
    await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
    await writeFile(outputPath, `frame ${options.atMs}`, "utf8");
    return {
      ok: true as const,
      output: {
        path: outputPath,
        sha256: `${String(options.atMs).padStart(4, "0")}${"a".repeat(60)}`.slice(0, 64),
        width: pkg.motion.width,
        height: pkg.motion.height,
        atMs: options.atMs,
        browser: { name: "chromium", version: "test" },
        viewport: { width: pkg.motion.width, height: pkg.motion.height, deviceScaleFactor: 1 },
        workflowTrace: {
          schema: "shellx-motion/browser-workflow-trace@1" as const,
          workflowHash: "b".repeat(64),
          stepCount: 0,
          steps: []
        }
      },
      receipt: {
        schema: "shellx-motion/receipt@1" as const,
        id: `browser-workflow-output-${options.atMs}`,
        operation: "preview.frame",
        status: "passed" as const,
        packageId: pkg.manifest.id,
        inputHashes: { motion: "c".repeat(64), workflow: "b".repeat(64) },
        createdAt: "2026-08-11T00:00:00.000Z",
        lane: "browser" as const,
        output: { path: outputPath },
        warnings: []
      }
    };
  };
}

describe("debug browser workflow output authority", () => {
  it("rejects every caller-selected evidence path outside configured output roots before rendering", async () => {
    const { outputRoot, outsideRoot } = await workspace();
    const inside = join(outputRoot, "capture");
    const manifest = join(inside, "recording.manifest.json");
    const cases: Array<{ label: string; args: Record<string, unknown> }> = [
      { label: "outDir", args: { outDir: join(outsideRoot, "capture") } },
      { label: "outputPath", args: { outDir: inside, outputPath: join(outsideRoot, "frame.png") } },
      { label: "catalogPath", args: { outDir: inside, catalogPath: join(outsideRoot, "catalog.json") } },
      { label: "recordingManifestPath", args: { outDir: inside, recordingManifestPath: join(outsideRoot, "recording.manifest.json") } },
      {
        label: "recordingFramesDir",
        args: {
          outDir: inside,
          recordingManifestPath: manifest,
          recordingFramesDir: join(outsideRoot, "recording-frames")
        }
      }
    ];

    for (const testCase of cases) {
      const calls: number[] = [];
      const result = await dispatchDebugCommand(
        "motion.browser.workflow.capture",
        { packageRoot: fixturePackage, ...testCase.args },
        {
          tier: "render_motion",
          authoringOutputRoots: [outputRoot],
          browserFrameRenderer: browserFrameRenderer(calls)
        }
      );
      expect(result, testCase.label).toMatchObject({
        ok: false,
        error: {
          code: "invalid_args",
          message: testCase.label === "outDir"
            ? expect.stringContaining("approved authoring output root")
            : "Browser workflow auxiliary output must be inside the admitted capture output directory or trusted debug scratch root."
        }
      });
      expect(calls, testCase.label).toEqual([]);
    }
  });

  it("publishes safe traces, receipts, sampled manifests, and a mutable catalog inside an approved root", async () => {
    const { outputRoot } = await workspace();
    const scratchRoot = join(outputRoot, "scratch");
    const outDir = join(scratchRoot, "capture");
    const catalogPath = join(scratchRoot, "catalogs", "browser-workflows.catalog.json");
    const recordingManifestPath = join(outDir, "recordings", "recording.manifest.json");
    await mkdir(dirname(catalogPath), { recursive: true, mode: 0o700 });
    await writeFile(catalogPath, `${JSON.stringify({ schema: "shellx-motion/browser-workflow-catalog@1", entries: [] })}\n`, "utf8");
    const calls: number[] = [];

    const result = await dispatchDebugCommand(
      "motion.browser.workflow.capture",
      {
        packageRoot: fixturePackage,
        outDir,
        catalogPath,
        recordingManifestPath,
        recordingSampleCount: 2
      },
      {
        tier: "render_motion",
        scratchRoot,
        authoringOutputRoots: [outputRoot],
        browserFrameRenderer: browserFrameRenderer(calls)
      }
    );

    expect(result).toMatchObject({
      ok: true,
      result: {
        workflowCatalogPath: catalogPath,
        recordingManifestPath,
        artifacts: expect.arrayContaining([
          expect.objectContaining({ role: "browser_workflow_trace" }),
          expect.objectContaining({ role: "browser_workflow_catalog", path: catalogPath }),
          expect.objectContaining({ role: "browser_recording_manifest", path: recordingManifestPath }),
          expect.objectContaining({ role: "preview_receipt" })
        ])
      }
    });
    expect(calls).toEqual([0, 0, 3000]);
    const catalog = JSON.parse(await readFile(catalogPath, "utf8")) as { entries: unknown[] };
    const manifest = JSON.parse(await readFile(recordingManifestPath, "utf8")) as { sampleCount: number };
    expect(catalog.entries).toHaveLength(1);
    expect(manifest.sampleCount).toBe(2);
  });

  it("does not turn broad authoring output roots into external catalog authority", async () => {
    const { outputRoot } = await workspace();
    const scratchRoot = join(outputRoot, "scratch");
    const outDir = outputRoot;
    const catalogPath = join(outDir, "victim-browser-workflows.catalog.json");
    const preserved = "do not replace broad-root victim\n";
    await mkdir(scratchRoot, { mode: 0o700 });
    await writeFile(catalogPath, preserved, "utf8");
    const calls: number[] = [];

    const result = await dispatchDebugCommand(
      "motion.browser.workflow.capture",
      { packageRoot: fixturePackage, outDir, catalogPath },
      {
        tier: "render_motion",
        scratchRoot,
        authoringOutputRoots: [outputRoot],
        browserFrameRenderer: browserFrameRenderer(calls)
      }
    );

    expect(result).toEqual({
      ok: false,
      error: {
        code: "invalid_args",
        message: "Browser workflow auxiliary output must be inside the admitted capture output directory or trusted debug scratch root."
      },
      warnings: []
    });
    expect(calls).toEqual([]);
    await expect(readFile(catalogPath, "utf8")).resolves.toBe(preserved);
  });

  it("keeps ordinary render_motion capture available through a host scratch root without authoring roots", async () => {
    const { outputRoot } = await workspace();
    const catalogPath = join(outputRoot, "browser-workflows.catalog.json");
    const calls: number[] = [];

    const result = await dispatchDebugCommand(
      "motion.browser.workflow.capture",
      { packageRoot: fixturePackage, catalogPath },
      {
        tier: "render_motion",
        scratchRoot: outputRoot,
        browserFrameRenderer: browserFrameRenderer(calls)
      }
    );

    expect(result).toMatchObject({
      ok: true,
      result: {
        outputPath: expect.stringContaining("pkg_keyframed_lower_third-browser-0.png"),
        workflowCatalogPath: catalogPath
      }
    });
    expect(calls).toEqual([0]);
    await expect(readFile(catalogPath, "utf8")).resolves.toContain('"entries"');
  });

  it("preserves an existing recording manifest instead of replacing it", async () => {
    const { outputRoot } = await workspace();
    const outDir = join(outputRoot, "capture");
    const recordingManifestPath = join(outDir, "recordings", "recording.manifest.json");
    const preserved = "preserve this evidence\n";
    await mkdir(dirname(recordingManifestPath), { recursive: true, mode: 0o700 });
    await writeFile(recordingManifestPath, preserved, "utf8");
    const calls: number[] = [];

    const result = await dispatchDebugCommand(
      "motion.browser.workflow.capture",
      { packageRoot: fixturePackage, outDir, recordingManifestPath, recordingSampleCount: 1 },
      {
        tier: "render_motion",
        authoringOutputRoots: [outputRoot],
        browserFrameRenderer: browserFrameRenderer(calls)
      }
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "browser_workflow_capture_failed", message: expect.stringContaining("Final output already exists") }
    });
    expect(calls).toEqual([0, 0]);
    await expect(readFile(recordingManifestPath, "utf8")).resolves.toBe(preserved);
  });

  it("refuses a repeated capture in one output directory instead of replacing immutable sidecars", async () => {
    const { outputRoot } = await workspace();
    const outDir = join(outputRoot, "capture");
    const tracePath = join(outDir, "pkg_keyframed_lower_third-browser-workflow.trace.json");
    const calls: number[] = [];
    const services = {
      tier: "render_motion" as const,
      authoringOutputRoots: [outputRoot],
      browserFrameRenderer: browserFrameRenderer(calls)
    };

    const first = await dispatchDebugCommand(
      "motion.browser.workflow.capture",
      { packageRoot: fixturePackage, outDir },
      services
    );
    const firstTrace = await readFile(tracePath, "utf8");
    const repeated = await dispatchDebugCommand(
      "motion.browser.workflow.capture",
      { packageRoot: fixturePackage, outDir },
      services
    );

    expect(first.ok).toBe(true);
    expect(repeated).toMatchObject({
      ok: false,
      error: { code: "browser_workflow_capture_failed", message: expect.stringContaining("Final output already exists") }
    });
    expect(calls).toEqual([0, 0]);
    await expect(readFile(tracePath, "utf8")).resolves.toBe(firstTrace);
  });

  it.skipIf(process.platform === "win32")("rejects a recording manifest symlink before rendering", async () => {
    const { outputRoot, outsideRoot } = await workspace();
    const outDir = join(outputRoot, "capture");
    const recordingManifestPath = join(outDir, "recordings", "recording.manifest.json");
    const outsideManifest = join(outsideRoot, "recording.manifest.json");
    await mkdir(dirname(recordingManifestPath), { recursive: true, mode: 0o700 });
    await symlink(outsideManifest, recordingManifestPath, "file");
    const calls: number[] = [];

    const result = await dispatchDebugCommand(
      "motion.browser.workflow.capture",
      { packageRoot: fixturePackage, outDir, recordingManifestPath },
      {
        tier: "render_motion",
        authoringOutputRoots: [outputRoot],
        browserFrameRenderer: browserFrameRenderer(calls)
      }
    );

    expect(result).toEqual({
      ok: false,
      error: {
        code: "invalid_args",
        message: "Browser workflow auxiliary output must be inside the admitted capture output directory or trusted debug scratch root."
      },
      warnings: []
    });
    expect(calls).toEqual([]);
    await expect(readFile(outsideManifest, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
