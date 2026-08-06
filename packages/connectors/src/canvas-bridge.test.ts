import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCanvasBridgeSmokeDoc, runCanvasBridgeFrameSelectionExport } from "./canvas-bridge";

const tempDirs: string[] = [];

describe("Canvas bridge frame-selection export", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("builds a representative Canvas smoke doc for the Motion handoff", () => {
    const doc = buildCanvasBridgeSmokeDoc();

    expect(doc).toMatchObject({
      width: 1280,
      height: 800,
      activeLayerId: "layer-main",
      layers: [
        {
          id: "layer-main",
          visible: true,
          ops: [
            { id: "rect-blue", kind: "shape" },
            { id: "heading", kind: "text", text: "ShellX Canvas" }
          ]
        }
      ]
    });
  });

  it("imports the Canvas checkout bridge and writes a frame-selection JSON", async () => {
    const canvasRoot = await mkdtemp(join(tmpdir(), "shellx-motion-canvas-root-"));
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-canvas-export-"));
    tempDirs.push(canvasRoot, outDir);
    await mkdir(join(canvasRoot, "app", "server"), { recursive: true });
    await writeFile(join(canvasRoot, "app", "package.json"), JSON.stringify({ name: "shellx-canvas" }), "utf8");
    await writeFile(
      join(canvasRoot, "app", "server", "motion-package.mjs"),
      `
        import { mkdir, writeFile } from "node:fs/promises";
        import { dirname } from "node:path";
        export function buildMotionFrameSelection(input) {
          return {
            schema: "shellx-canvas/frame-selection@1",
            selectedFrameId: "frame_" + input.target,
            project: { id: input.target, name: input.projectName },
            brand: { tokens: input.brandTokens },
            frames: [{
              id: "frame_" + input.target,
              name: input.frameName,
              durationMs: input.durationMs,
              fps: input.fps,
              width: input.doc.width,
              height: input.doc.height,
              layers: input.doc.layers[0].ops.map((op) => ({ id: op.id, kind: op.kind, startMs: 0, durationMs: input.durationMs }))
            }],
            imageEditorOutputs: []
          };
        }
        export async function writeMotionFrameSelection(selection, options) {
          await mkdir(dirname(options.outPath), { recursive: true });
          await writeFile(options.outPath, JSON.stringify(selection, null, 2) + "\\n", "utf8");
          return { ok: true, path: options.outPath, schema: selection.schema };
        }
      `,
      "utf8"
    );

    const outPath = join(outDir, "frame-selection.json");
    const result = await runCanvasBridgeFrameSelectionExport({
      canvasRoot,
      outPath,
      target: "sample",
      projectName: "Canvas Sample Project",
      frameName: "Story Hero",
      selectedIds: ["rect-blue", "heading"],
      generatedAt: "2026-06-30T01:30:00.000Z",
      trustedCanvasRoots: [canvasRoot]
    });
    const written = JSON.parse(await readFile(outPath, "utf8")) as Record<string, unknown>;
    const receipt = JSON.parse(await readFile(join(outDir, "canvas-bridge-export.receipt.json"), "utf8")) as Record<string, any>;

    expect(result).toMatchObject({
      ok: true,
      schema: "shellx-canvas/frame-selection@1",
      path: outPath,
      receiptPath: join(outDir, "canvas-bridge-export.receipt.json"),
      selectedFrameId: "frame_sample",
      layerIds: ["rect-blue", "heading"],
      artifacts: expect.arrayContaining([
        expect.objectContaining({ role: "canvas_bridge", path: join(canvasRoot, "app", "server", "motion-package.mjs"), status: "available" }),
        expect.objectContaining({ role: "canvas_frame_selection", path: outPath, status: "available", mediaType: "application/json", primary: true }),
        expect.objectContaining({ role: "connector_receipt", path: join(outDir, "canvas-bridge-export.receipt.json"), status: "available" })
      ])
    });
    expect(written).toMatchObject({
      schema: "shellx-canvas/frame-selection@1",
      selectedFrameId: "frame_sample",
      project: { id: "sample", name: "Canvas Sample Project" }
    });
    expect(receipt).toMatchObject({
      operation: "canvas.bridge_export",
      status: "passed",
      packageId: "canvas_bridge_export",
      output: {
        path: outPath,
        schema: "shellx-canvas/frame-selection@1",
        selectedFrameId: "frame_sample",
        layerIds: ["rect-blue", "heading"]
      },
      artifacts: expect.arrayContaining([
        expect.objectContaining({ role: "canvas_bridge", path: join(canvasRoot, "app", "server", "motion-package.mjs"), status: "available" }),
        expect.objectContaining({ role: "canvas_frame_selection", path: outPath, status: "available", primary: true })
      ])
    });
  });

  it("accepts the canonical Motion-owned Canvas frame-selection schema", async () => {
    const canvasRoot = await mkdtemp(join(tmpdir(), "shellx-motion-canonical-canvas-root-"));
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-canonical-canvas-export-"));
    tempDirs.push(canvasRoot, outDir);
    await mkdir(join(canvasRoot, "app", "server"), { recursive: true });
    await writeFile(join(canvasRoot, "app", "package.json"), JSON.stringify({ name: "shellx-canvas" }), "utf8");
    await writeFile(
      join(canvasRoot, "app", "server", "motion-package.mjs"),
      `
        import { mkdir, writeFile } from "node:fs/promises";
        import { dirname } from "node:path";
        export function buildMotionFrameSelection(input) {
          return {
            schema: "shellx-motion/canvas-frame-selection@1",
            selectedFrameId: "frame_" + input.target,
            project: { id: input.target, name: input.projectName },
            brand: { tokens: input.brandTokens },
            frames: [{
              id: "frame_" + input.target,
              name: input.frameName,
              durationMs: input.durationMs,
              fps: input.fps,
              width: input.doc.width,
              height: input.doc.height,
              layers: input.doc.layers[0].ops.map((op) => ({ id: op.id, kind: op.kind, startMs: 0, durationMs: input.durationMs }))
            }],
            imageEditorOutputs: []
          };
        }
        export async function writeMotionFrameSelection(selection, options) {
          await mkdir(dirname(options.outPath), { recursive: true });
          await writeFile(options.outPath, JSON.stringify(selection, null, 2) + "\\n", "utf8");
          return { ok: true, path: options.outPath, schema: selection.schema };
        }
      `,
      "utf8"
    );

    const outPath = join(outDir, "frame-selection.json");
    const result = await runCanvasBridgeFrameSelectionExport({
      canvasRoot,
      outPath,
      target: "canonical",
      generatedAt: "2026-07-13T00:00:00.000Z",
      trustedCanvasRoots: [canvasRoot]
    });

    expect(result).toMatchObject({
      ok: true,
      schema: "shellx-motion/canvas-frame-selection@1",
      path: outPath,
      selectedFrameId: "frame_canonical",
      layerIds: ["rect-blue", "heading"]
    });
    expect(JSON.parse(await readFile(outPath, "utf8"))).toMatchObject({
      schema: "shellx-motion/canvas-frame-selection@1",
      selectedFrameId: "frame_canonical"
    });
  });

  it("refuses to import a bridge from an untrusted Canvas root", async () => {
    const canvasRoot = await mkdtemp(join(tmpdir(), "shellx-motion-fake-canvas-root-"));
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-fake-canvas-export-"));
    tempDirs.push(canvasRoot, outDir);
    const pwnedPath = join(outDir, "import-side-effect.txt");
    await mkdir(join(canvasRoot, "app", "server"), { recursive: true });
    await writeFile(join(canvasRoot, "app", "package.json"), JSON.stringify({ name: "shellx-canvas" }), "utf8");
    await writeFile(
      join(canvasRoot, "app", "server", "motion-package.mjs"),
      `
        import { writeFile } from "node:fs/promises";
        await writeFile(${JSON.stringify(pwnedPath)}, "imported", "utf8");
        export function buildMotionFrameSelection() {
          return { schema: "shellx-canvas/frame-selection@1", selectedFrameId: "frame_fake", frames: [] };
        }
        export async function writeMotionFrameSelection(selection, options) {
          return { ok: true, path: options.outPath, schema: selection.schema };
        }
      `,
      "utf8"
    );

    const result = await runCanvasBridgeFrameSelectionExport({
      canvasRoot,
      outPath: join(outDir, "frame-selection.json")
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "canvas_bridge_untrusted",
        message: "Canvas bridge import was refused because the root is not a trusted Design Studio checkout."
      }
    });
    await expect(readFile(pwnedPath, "utf8")).rejects.toThrow();
  });
});

describe("Canvas bridge export output ownership", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  /** A trusted Canvas checkout whose bridge writes whatever `outPath` it is handed. */
  async function writeTrustedCanvasCheckout(): Promise<string> {
    const canvasRoot = await mkdtemp(join(tmpdir(), "shellx-motion-canvas-root-"));
    tempDirs.push(canvasRoot);
    await mkdir(join(canvasRoot, "app", "server"), { recursive: true });
    await writeFile(join(canvasRoot, "app", "package.json"), JSON.stringify({ name: "shellx-canvas" }), "utf8");
    await writeFile(
      join(canvasRoot, "app", "server", "motion-package.mjs"),
      `
        import { mkdir, writeFile } from "node:fs/promises";
        import { dirname } from "node:path";
        export function buildMotionFrameSelection(input) {
          return {
            schema: "shellx-canvas/frame-selection@1",
            selectedFrameId: "frame_" + input.target,
            project: { id: input.target, name: input.projectName },
            frames: [{ id: "frame_" + input.target, name: input.frameName, durationMs: input.durationMs, fps: input.fps, width: input.doc.width, height: input.doc.height, layers: [] }]
          };
        }
        export async function writeMotionFrameSelection(selection, options) {
          await mkdir(dirname(options.outPath), { recursive: true });
          await writeFile(options.outPath, JSON.stringify(selection, null, 2), "utf8");
          return { path: options.outPath, schema: selection.schema };
        }
      `,
      "utf8"
    );
    return canvasRoot;
  }

  it("never overwrites a caller's file at --out", async () => {
    // Reproduced before the fix: the bridge writes `outPath` unconditionally and nothing guarded it,
    // so a caller's own sel.json was replaced by a run that reported ok:true.
    const canvasRoot = await writeTrustedCanvasCheckout();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-canvas-export-"));
    tempDirs.push(outDir);
    const outPath = join(outDir, "sel.json");
    await writeFile(outPath, "MY SELECTION", "utf8");

    const result = await runCanvasBridgeFrameSelectionExport({ canvasRoot, outPath, trustedCanvasRoots: [canvasRoot] });

    expect(result).toMatchObject({ ok: false, error: { code: "output_path_exists" } });
    expect(await readFile(outPath, "utf8")).toBe("MY SELECTION");
  });

  it("overwrites only when the caller explicitly asks", async () => {
    const canvasRoot = await writeTrustedCanvasCheckout();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-canvas-export-"));
    tempDirs.push(outDir);
    const outPath = join(outDir, "sel.json");
    await writeFile(outPath, "MY SELECTION", "utf8");

    const result = await runCanvasBridgeFrameSelectionExport({ canvasRoot, outPath, force: true, trustedCanvasRoots: [canvasRoot] });

    expect(result).toMatchObject({ ok: true, schema: "shellx-canvas/frame-selection@1" });
    expect(await readFile(outPath, "utf8")).toContain("shellx-canvas/frame-selection@1");
  });
});
