import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { cliAuthoringRoots } from "./debug-authoring-roots";

describe("CLI authoring root derivation", () => {
  it("bounds each direct authoring alias to its declared input and output parents", () => {
    const roots = (command: Parameters<typeof cliAuthoringRoots>[0], args: Record<string, unknown>) => cliAuthoringRoots(command, args);

    expect(roots("motion.script.compile", { scriptPath: "/tmp/input/storyboard.json", packageDir: "/tmp/output/package" })).toEqual({
      inputRoots: [resolve("/tmp/input")], outputRoots: [resolve("/tmp/output")]
    });
    expect(roots("motion.storyboard.panel", { storyboardPath: "/tmp/input/storyboard.json" })).toEqual({
      inputRoots: [resolve("/tmp/input")], outputRoots: [resolve("/tmp/input")]
    });
    expect(roots("motion.storyboard.graph", { path: "/tmp/input/storyboard.json" })).toEqual({
      inputRoots: [resolve("/tmp/input")], outputRoots: [resolve("/tmp/input")]
    });
    expect(roots("motion.html.snippet.export", { packageRoot: "/tmp/input/package", outDir: "/tmp/output/export" })).toEqual({
      inputRoots: [resolve("/tmp/input")], outputRoots: [resolve("/tmp/output")]
    });
    expect(roots("motion.html.snippet.import", { htmlPath: "/tmp/input/index.html", packageDir: "/tmp/output/package" })).toEqual({
      inputRoots: [resolve("/tmp/input")], outputRoots: [resolve("/tmp/output")]
    });
    expect(roots("motion.otio.export", { packageRoot: "/tmp/input/package", outPath: "/tmp/output/timeline.otio" })).toEqual({
      inputRoots: [resolve("/tmp/input")], outputRoots: [resolve("/tmp/output")]
    });
    expect(roots("motion.otio.import", { otioPath: "/tmp/input/timeline.otio", packageDir: "/tmp/output/package" })).toEqual({
      inputRoots: [resolve("/tmp/input")], outputRoots: [resolve("/tmp/output")]
    });
    expect(roots("motion.source.to_scripted_video", { sourcePath: "/tmp/input/source.md", outDir: "/tmp/output/storyboard" })).toEqual({
      inputRoots: [resolve("/tmp/input")], outputRoots: [resolve("/tmp/output")]
    });
    expect(roots("motion.connector.source_to_cut", { sourcePath: "/tmp/input/source.md", outDir: "/tmp/output/cut" })).toEqual({
      inputRoots: [resolve("/tmp/input")], outputRoots: [resolve("/tmp/output")]
    });
    expect(roots("motion.connector.canvas_to_mp4", { canvasSelectionPath: "/tmp/input/selection.json", outDir: "/tmp/output/mp4" })).toEqual({
      inputRoots: [resolve("/tmp/input")], outputRoots: [resolve("/tmp/output")]
    });
    expect(roots("motion.connector.canvas_to_cut", { canvasSelectionPath: "/tmp/input/selection.json", outDir: "/tmp/output/cut" })).toEqual({
      inputRoots: [resolve("/tmp/input")], outputRoots: [resolve("/tmp/output")]
    });
    expect(roots("motion.connector.script_to_cut", { scriptPath: "/tmp/input/storyboard.json", outDir: "/tmp/output/cut" })).toEqual({
      inputRoots: [resolve("/tmp/input")], outputRoots: [resolve("/tmp/output")]
    });
    expect(roots("motion.connector.cut_generate_to_cut", { script: { schema: "shellx-motion/scripted-video@1" }, outDir: "/tmp/output/cut" })).toEqual({
      inputRoots: [], outputRoots: [resolve("/tmp/output")]
    });
    expect(roots("motion.connector.template_to_cut", { packageRoot: "/tmp/input/package", outDir: "/tmp/output/cut" })).toEqual({
      inputRoots: [resolve("/tmp/input/package")], outputRoots: [resolve("/tmp/output")]
    });
    expect(roots("motion.canvas.bridge_export", { outPath: "/tmp/output/selection.json" })).toEqual({
      inputRoots: [], outputRoots: [resolve("/tmp/output")]
    });
    expect(roots("motion.timeline.caption.import", {
      packageRoot: "/tmp/package/source", captionsPath: "/tmp/captions/captions.srt", outDir: "/tmp/output/package"
    })).toEqual({
      inputRoots: [resolve("/tmp/package"), resolve("/tmp/captions")], outputRoots: [resolve("/tmp/output")]
    });
    expect(roots("motion.timeline.shape.geometry-keyframes.inspect", { packageRoot: "/tmp/package/source" })).toEqual({
      inputRoots: [resolve("/tmp/package")], outputRoots: [resolve("/tmp/package")]
    });
    expect(roots("motion.timeline.shape.geometry-keyframes.upsert", { packageRoot: "/tmp/package/source", outDir: "/tmp/output/package" })).toEqual({
      inputRoots: [resolve("/tmp/package")], outputRoots: [resolve("/tmp/output")]
    });
    expect(roots("motion.browser.workflow.capture", {
      outDir: "/tmp/output/capture",
      catalogPath: "/tmp/evidence/browser-workflows.catalog.json",
      recordingManifestPath: "/tmp/evidence/recording.manifest.json"
    })).toEqual({
      inputRoots: [resolve("/tmp/output")],
      outputRoots: [resolve("/tmp/output")]
    });
    expect(roots("motion.prompt.run", { cwd: "/tmp/prompt-workspace" })).toEqual({
      inputRoots: [resolve("/tmp/prompt-workspace")], outputRoots: [resolve("/tmp/prompt-workspace")]
    });
    expect(roots("motion.procedural.inspect", { packageRoot: "/tmp/procedural/source" })).toEqual({
      inputRoots: [resolve("/tmp/procedural")], outputRoots: [resolve("/tmp/procedural")]
    });
    expect(roots("motion.procedural.relationship.enabled.set", {
      packageRoot: "/tmp/procedural/source", outDir: "/tmp/revisions/disabled"
    })).toEqual({
      inputRoots: [resolve("/tmp/procedural")], outputRoots: [resolve("/tmp/revisions")]
    });
    expect(roots("motion.package.patch", {
      packageRoot: "/tmp/package/source", outDir: "/tmp/revisions/patched"
    })).toEqual({
      inputRoots: [resolve("/tmp/package")], outputRoots: [resolve("/tmp/revisions")]
    });
  });

  it("does not invent roots when a required local path is absent", () => {
    expect(cliAuthoringRoots("motion.html.snippet.import", { htmlPath: "/tmp/input/index.html" })).toBeNull();
    expect(cliAuthoringRoots("motion.otio.export", { packageRoot: "/tmp/input/package" })).toBeNull();
    expect(cliAuthoringRoots("motion.script.compile", { packageDir: "/tmp/output/package" })).toBeNull();
    expect(cliAuthoringRoots("motion.storyboard.panel", { script: { schema: "shellx-motion/scripted-video@1" } })).toBeNull();
    expect(cliAuthoringRoots("motion.browser.workflow.capture", { packageRoot: "/tmp/input/package" })).toBeNull();
    expect(cliAuthoringRoots("motion.timeline.shape.geometry-keyframes.inspect", {})).toBeNull();
    expect(cliAuthoringRoots("motion.timeline.shape.geometry-keyframes.move", { packageRoot: "/tmp/input/package" })).toBeNull();
    expect(cliAuthoringRoots("motion.prompt.run", { executeAgentCommands: true })).toBeNull();
    expect(cliAuthoringRoots("motion.procedural.inspect", {})).toBeNull();
    expect(cliAuthoringRoots("motion.procedural.relationship.set", { packageRoot: "/tmp/input/package" })).toBeNull();
    expect(cliAuthoringRoots("motion.package.patch", { packageRoot: "/tmp/input/package" })).toBeNull();
    expect(cliAuthoringRoots("motion.connector.canvas_to_mp4", { canvasSelectionPath: "/tmp/input/selection.json" })).toBeNull();
    expect(cliAuthoringRoots("motion.connector.script_to_cut", { outDir: "/tmp/output/cut" })).toBeNull();
    expect(cliAuthoringRoots("motion.connector.template_to_cut", { packageRoot: "/tmp/input/package" })).toBeNull();
    expect(cliAuthoringRoots("motion.canvas.bridge_export", {})).toBeNull();
  });

  it("uses the output parent as the inert input root for an inline script", () => {
    expect(cliAuthoringRoots("motion.script.compile", { script: { schema: "shellx-motion/scripted-video@1" }, packageDir: "/tmp/output/package" })).toEqual({
      inputRoots: [resolve("/tmp/output")], outputRoots: [resolve("/tmp/output")]
    });
  });
});
