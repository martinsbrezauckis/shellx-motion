import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const connectorCalls = vi.hoisted(() => ({
  runCanvasBridgeFrameSelectionExport: vi.fn(),
  runCanvasMp4Export: vi.fn(),
  runTemplateToCutConnector: vi.fn(),
  runCutGenerateToCutConnector: vi.fn()
}));

vi.mock("@shellx-motion/connectors", async (importOriginal) => ({
  ...await importOriginal(),
  ...connectorCalls
}));

const { dispatchDebugCommand } = await import("./index.js");
const tempDirs: string[] = [];
const itLinux = process.platform === "linux" ? it : it.skip;

afterEach(async () => {
  Object.values(connectorCalls).forEach((call) => call.mockReset());
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("legacy connector authoring roots", () => {
  it.each([
    ["Canvas-to-MP4", "motion.connector.canvas_to_mp4", { canvasSelectionPath: "/untrusted/selection.json", outDir: "/untrusted/output" }],
    ["Canvas bridge export", "motion.canvas.bridge_export", { canvasRoot: "/untrusted/canvas", outPath: "/untrusted/selection.json" }],
    ["Template-to-Cut", "motion.connector.template_to_cut", { packageRoot: "/untrusted/package", outDir: "/untrusted/output", values: { title: "Root fence" }, cutImportMode: "rendered_media" }],
    ["Cut Generate-to-Cut", "motion.connector.cut_generate_to_cut", { script: scriptedVideo(), outDir: "/untrusted/output" }]
  ] as const)("fails closed for %s when host authoring roots are absent", async (_label, command, args) => {
    const result = await dispatchDebugCommand(command, args, { tier: "write_local" });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "capability_unavailable", message: expect.stringMatching(/host-approved authoring .* root/) }
    });
    expectAllAdaptersUntouched();
  });

  it("requires an input root for the Cut Generate-to-Cut scriptPath form", async () => {
    const fixture = await createFixture();
    const outDir = join(fixture.outputRoot, "cut-output");
    const result = await dispatchDebugCommand(
      "motion.connector.cut_generate_to_cut",
      { scriptPath: fixture.scriptPath, outDir },
      { tier: "write_local", authoringOutputRoots: [fixture.outputRoot] }
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "capability_unavailable", message: expect.stringMatching(/scriptPath.*authoring input root/) }
    });
    await expect(lstat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
    expectAllAdaptersUntouched();
  });

  it("refuses each legacy connector input or output outside host roots before creating an output parent", async () => {
    const fixture = await createFixture();
    const outsideOutputRoot = join(fixture.root, "outside-output");
    const services = {
      tier: "write_local" as const,
      authoringInputRoots: [fixture.inputRoot],
      authoringOutputRoots: [fixture.outputRoot],
      readReceipt: async () => null
    };
    const attempts = [
      ["motion.connector.canvas_to_mp4", { canvasSelectionPath: fixture.outsideCanvasSelectionPath, outDir: join(fixture.outputRoot, "canvas-input-refusal") }],
      ["motion.connector.canvas_to_mp4", { canvasSelectionPath: fixture.canvasSelectionPath, outDir: join(outsideOutputRoot, "canvas-output") }],
      ["motion.canvas.bridge_export", { canvasRoot: fixture.canvasRoot, outPath: join(outsideOutputRoot, "bridge", "selection.json") }],
      ["motion.connector.template_to_cut", { packageRoot: fixture.outsideTemplateRoot, outDir: join(fixture.outputRoot, "template-input-refusal"), values: { title: "Root fence" }, cutImportMode: "rendered_media" }],
      ["motion.connector.template_to_cut", { packageRoot: fixture.templateRoot, outDir: join(outsideOutputRoot, "template-output"), values: { title: "Root fence" }, cutImportMode: "rendered_media" }],
      ["motion.connector.cut_generate_to_cut", { scriptPath: fixture.outsideScriptPath, outDir: join(fixture.outputRoot, "cut-input-refusal") }],
      ["motion.connector.cut_generate_to_cut", { script: scriptedVideo(), outDir: join(outsideOutputRoot, "cut-output") }]
    ] as const;

    for (const [command, args] of attempts) {
      const result = await dispatchDebugCommand(command, args, services);
      expect(result).toMatchObject({
        ok: false,
        error: { code: "invalid_args", message: expect.stringMatching(/approved authoring .* root|symbolic links/) }
      });
    }

    await expect(lstat(outsideOutputRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expectAllAdaptersUntouched();
  });

  it("admits platform-independent legacy connector routes only after their configured roots contain the supplied paths", async () => {
    const fixture = await createFixture();
    const bridgeOutPath = join(fixture.outputRoot, "bridge-output", "selection.json");
    const templateOutDir = join(fixture.outputRoot, "template-output");
    const cutOutDir = join(fixture.outputRoot, "cut-output");
    const services = {
      tier: "write_local" as const,
      authoringInputRoots: [fixture.inputRoot],
      authoringOutputRoots: [fixture.outputRoot],
      readReceipt: async () => null
    };
    connectorCalls.runCanvasBridgeFrameSelectionExport.mockResolvedValue({
      ok: true, path: bridgeOutPath, receiptPath: join(fixture.outputRoot, "bridge-output", "bridge.receipt.json")
    });
    connectorCalls.runTemplateToCutConnector.mockResolvedValue({
      ok: true, receiptPath: join(templateOutDir, "connector.receipt.json"), warnings: [], cutPlanPath: join(templateOutDir, "cut-import-plan.json")
    });
    connectorCalls.runCutGenerateToCutConnector.mockResolvedValue({
      ok: true,
      receiptPath: join(cutOutDir, "connector.receipt.json"),
      warnings: [],
      packageDir: join(cutOutDir, "package"),
      preview: { outputPath: join(cutOutDir, "preview.png") },
      render: { outputPath: join(cutOutDir, "render.mp4") },
      cutPlanPath: join(cutOutDir, "cut-import-plan.json")
    });

    await expect(dispatchDebugCommand(
      "motion.canvas.bridge_export",
      { canvasRoot: fixture.canvasRoot, outPath: bridgeOutPath },
      services
    )).resolves.toMatchObject({ ok: true, visibleState: { operation: "canvas.bridge_export" } });
    await expect(dispatchDebugCommand(
      "motion.connector.template_to_cut",
      { packageRoot: fixture.templateRoot, outDir: templateOutDir, values: { title: "Root fence" }, cutImportMode: "rendered_media" },
      services
    )).resolves.toMatchObject({ ok: true, visibleState: { operation: "connector.template_to_cut" } });
    await expect(dispatchDebugCommand(
      "motion.connector.cut_generate_to_cut",
      { scriptPath: fixture.scriptPath, outDir: cutOutDir },
      services
    )).resolves.toMatchObject({ ok: true, visibleState: { operation: "connector.cut_generate_to_cut" } });

    expect(connectorCalls.runCanvasBridgeFrameSelectionExport).toHaveBeenCalledWith(expect.objectContaining({
      canvasRoot: fixture.canvasRoot, outPath: bridgeOutPath
    }));
    expect(connectorCalls.runTemplateToCutConnector).toHaveBeenCalledWith({
      packageRoot: fixture.templateRoot, outDir: templateOutDir, values: { title: "Root fence" }
    });
    expect(connectorCalls.runCutGenerateToCutConnector).toHaveBeenCalledWith(expect.objectContaining({
      scriptPath: fixture.scriptPath, outDir: cutOutDir
    }));
  });

  itLinux("admits Canvas-to-MP4 only after configured roots contain the supplied paths", async () => {
    const fixture = await createFixture();
    const canvasOutDir = join(fixture.outputRoot, "canvas-output");
    const services = {
      tier: "write_local" as const,
      authoringInputRoots: [fixture.inputRoot],
      authoringOutputRoots: [fixture.outputRoot],
      readReceipt: async () => null
    };
    connectorCalls.runCanvasMp4Export.mockResolvedValue({
      ok: true, receiptPath: join(canvasOutDir, "connector.receipt.json"), warnings: [], render: { outputPath: join(canvasOutDir, "render.mp4") }
    });

    await expect(dispatchDebugCommand(
      "motion.connector.canvas_to_mp4",
      { canvasSelectionPath: fixture.canvasSelectionPath, outDir: canvasOutDir },
      services
    )).resolves.toMatchObject({ ok: true, visibleState: { operation: "connector.canvas_to_mp4" } });

    expect(connectorCalls.runCanvasMp4Export).toHaveBeenCalledWith(expect.objectContaining({
      canvasSelectionPath: fixture.canvasSelectionPath, outDir: canvasOutDir
    }));
  });
});

function expectAllAdaptersUntouched(): void {
  Object.values(connectorCalls).forEach((call) => expect(call).not.toHaveBeenCalled());
}

async function createFixture(): Promise<{
  root: string;
  inputRoot: string;
  outputRoot: string;
  canvasRoot: string;
  canvasSelectionPath: string;
  outsideCanvasSelectionPath: string;
  templateRoot: string;
  outsideTemplateRoot: string;
  scriptPath: string;
  outsideScriptPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-legacy-connector-roots-"));
  tempDirs.push(root);
  const inputRoot = join(root, "inputs");
  const outputRoot = join(root, "outputs");
  const canvasRoot = join(inputRoot, "canvas");
  const templateRoot = join(inputRoot, "template");
  const outsideInputRoot = join(root, "outside-input");
  const outsideTemplateRoot = join(outsideInputRoot, "template");
  const canvasSelectionPath = join(inputRoot, "canvas-selection.json");
  const outsideCanvasSelectionPath = join(outsideInputRoot, "canvas-selection.json");
  const scriptPath = join(inputRoot, "script.json");
  const outsideScriptPath = join(outsideInputRoot, "script.json");
  await Promise.all([
    mkdir(canvasRoot, { recursive: true, mode: 0o700 }),
    mkdir(templateRoot, { recursive: true, mode: 0o700 }),
    mkdir(outsideTemplateRoot, { recursive: true, mode: 0o700 }),
    mkdir(outputRoot, { recursive: true, mode: 0o700 })
  ]);
  await Promise.all([
    writeFile(canvasSelectionPath, "{}\n", "utf8"),
    writeFile(outsideCanvasSelectionPath, "{}\n", "utf8"),
    writeFile(scriptPath, `${JSON.stringify(scriptedVideo())}\n`, "utf8"),
    writeFile(outsideScriptPath, `${JSON.stringify(scriptedVideo())}\n`, "utf8")
  ]);
  return {
    root,
    inputRoot,
    outputRoot,
    canvasRoot,
    canvasSelectionPath,
    outsideCanvasSelectionPath,
    templateRoot,
    outsideTemplateRoot,
    scriptPath,
    outsideScriptPath
  };
}

function scriptedVideo(): Record<string, unknown> {
  return {
    schema: "shellx-motion/scripted-video@1",
    id: "connector-roots",
    name: "Connector roots",
    sourceApp: "shellx-cut",
    workflow: "generate",
    width: 1280,
    height: 720,
    fps: 24,
    frames: [{ id: "intro", title: "Roots", durationMs: 1000 }]
  };
}
