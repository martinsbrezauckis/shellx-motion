import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const connectors = vi.hoisted(() => ({
  runCanvasToCutConnector: vi.fn(),
  runScriptToCutConnector: vi.fn(),
  runSourceToCutConnector: vi.fn(),
  runCutGenerateToCutConnector: vi.fn()
}));

vi.mock("@shellx-motion/connectors", async (importOriginal) => ({
  ...await importOriginal(),
  ...connectors
}));

const { dispatchDebugCommand } = await import("./index.js");
const roots: string[] = [];

afterEach(async () => {
  connectors.runCanvasToCutConnector.mockReset();
  connectors.runScriptToCutConnector.mockReset();
  connectors.runSourceToCutConnector.mockReset();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.skipIf(process.platform !== "linux")("P2B Debug connector dispatch", () => {
  it("admits Canvas only after Linux/root checks and forwards no legacy producer controls", async () => {
    const root = await fixtureRoot();
    const canvasSelectionPath = join(root, "canvas.json");
    const outDir = join(root, "canvas-out");
    await writeFile(canvasSelectionPath, "{}", "utf8");
    connectors.runCanvasToCutConnector.mockResolvedValue(connectorResult(outDir));

    const result = await dispatchDebugCommand("motion.connector.canvas_to_cut", {
      canvasSelectionPath, outDir, cutImportMode: "rendered_media"
    }, { tier: "write_local", authoringInputRoots: [root], authoringOutputRoots: [root] });

    expect(result).toMatchObject({ ok: true, visibleState: { operation: "connector.canvas_to_cut" } });
    expect(JSON.stringify(result)).not.toContain(canvasSelectionPath);
    expect(connectors.runCanvasToCutConnector).toHaveBeenCalledWith({ canvasSelectionPath, outDir });
  });

  it("requires exactly one Script input and reports only file or inline input identity", async () => {
    const root = await fixtureRoot();
    const scriptPath = join(root, "script.json");
    const outDir = join(root, "script-out");
    await writeFile(scriptPath, "{}", "utf8");
    connectors.runScriptToCutConnector.mockResolvedValue(connectorResult(outDir));

    const result = await dispatchDebugCommand("motion.connector.script_to_cut", {
      scriptPath, outDir, startMs: 10, durationMs: 50, track: "upper"
    }, { tier: "write_local", authoringInputRoots: [root], authoringOutputRoots: [root] });

    expect(result).toMatchObject({ ok: true, visibleState: { scriptInput: "file" }, result: { scriptInput: "file" } });
    expect(JSON.stringify(result)).not.toContain(scriptPath);
    expect(connectors.runScriptToCutConnector).toHaveBeenCalledWith({ scriptPath, outDir, cutPlacement: { startMs: 10, durationMs: 50, track: "upper" } });
  });

  it("preserves Source sizing inputs but never returns its external source path", async () => {
    const root = await fixtureRoot();
    const sourcePath = join(root, "source.md");
    const outDir = join(root, "source-out");
    await writeFile(sourcePath, "# Source", "utf8");
    connectors.runSourceToCutConnector.mockResolvedValue({ ...connectorResult(outDir), storyboard: { scriptPath: join(outDir, "scripted-video.json") } });

    const result = await dispatchDebugCommand("motion.connector.source_to_cut", {
      sourcePath, outDir, maxFrames: 2, frameDurationMs: 900, width: 640, height: 360, fps: 24
    }, { tier: "write_local", authoringInputRoots: [root], authoringOutputRoots: [root] });

    expect(result).toMatchObject({ ok: true, visibleState: { sourceInput: "markdown" } });
    expect(JSON.stringify(result)).not.toContain(sourcePath);
    expect(connectors.runSourceToCutConnector).toHaveBeenCalledWith(expect.objectContaining({
      sourcePath, sourceInputRoot: root, outDir, maxFrames: 2, frameDurationMs: 900, width: 640, height: 360, fps: 24
    }));
  });

  it("redacts a P2B file input from a lower-layer exception without changing its failure class", async () => {
    const root = await fixtureRoot();
    const sourcePath = join(root, "source.md");
    await writeFile(sourcePath, "# Source", "utf8");
    connectors.runSourceToCutConnector.mockRejectedValue(new Error(`source read failed: ${sourcePath}`));
    const sourcePathArg = relative(process.cwd(), sourcePath);

    const result = await dispatchDebugCommand("motion.connector.source_to_cut", {
      sourcePath: sourcePathArg, outDir: join(root, "source-out")
    }, { tier: "write_local", authoringInputRoots: [root], authoringOutputRoots: [root] });

    expect(result).toMatchObject({ ok: false, error: { code: "connector_failed", message: "source read failed: [P2B input]" } });
    expect(JSON.stringify(result)).not.toContain(sourcePath);
    expect(JSON.stringify(result)).not.toContain(sourcePathArg);
  });
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-debug-p2b-"));
  roots.push(root);
  return root;
}

function connectorResult(outDir: string) {
  return {
    ok: true,
    receiptPath: join(outDir, "connector.receipt.json"),
    warnings: [],
    packageDir: join(outDir, "package"),
    cutPlanPath: join(outDir, "cut-import-plan.json"),
    preview: { outputPath: join(outDir, "preview.png") },
    render: { outputPath: join(outDir, "render.mp4") }
  };
}
