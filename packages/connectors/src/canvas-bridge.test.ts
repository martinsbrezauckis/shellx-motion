import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJsonSha256 } from "@shellx-motion/core";
import { buildCanvasBridgeSmokeDoc, runCanvasBridgeFrameSelectionExport } from "./canvas-bridge";

const tempDirs: string[] = [];

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve: () => resolve?.() };
}

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
    await mkdir(join(canvasRoot, "app", "server"), { recursive: true, mode: 0o700 });
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
      receiptPath: join(outDir, "canvas-bridge-export.receipt.json"),
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
    expect(receipt.inputHashes.selection).toBe(createHash("sha256").update(await readFile(outPath)).digest("hex"));
    expect(receipt.inputHashes.bridge).toBe(canonicalJsonSha256([{
      path: "motion-package.mjs",
      sha256: createHash("sha256")
        .update(await readFile(join(canvasRoot, "app", "server", "motion-package.mjs")))
        .digest("hex")
    }]));
  });

  it("accepts the canonical Motion-owned Canvas frame-selection schema", async () => {
    const canvasRoot = await mkdtemp(join(tmpdir(), "shellx-motion-canonical-canvas-root-"));
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-canonical-canvas-export-"));
    tempDirs.push(canvasRoot, outDir);
    await mkdir(join(canvasRoot, "app", "server"), { recursive: true, mode: 0o700 });
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
    await mkdir(join(canvasRoot, "app", "server"), { recursive: true, mode: 0o700 });
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

  it.runIf(typeof process.getuid === "function")("refuses an output parent that another local principal could retarget", async () => {
    const canvasRoot = await mkdtemp(join(tmpdir(), "shellx-motion-canvas-root-"));
    const outRoot = await mkdtemp(join(tmpdir(), "shellx-motion-canvas-export-"));
    tempDirs.push(canvasRoot, outRoot);
    const sharedParent = join(outRoot, "shared");
    await mkdir(sharedParent);
    await chmod(sharedParent, 0o777);
    await mkdir(join(canvasRoot, "app", "server"), { recursive: true, mode: 0o700 });
    await writeFile(join(canvasRoot, "app", "package.json"), JSON.stringify({ name: "shellx-canvas" }), "utf8");
    await writeFile(
      join(canvasRoot, "app", "server", "motion-package.mjs"),
      "export function buildMotionFrameSelection() { return {}; } export async function writeMotionFrameSelection() { return {}; }",
      "utf8"
    );

    const result = await runCanvasBridgeFrameSelectionExport({
      canvasRoot,
      outPath: join(sharedParent, "selection.json"),
      trustedCanvasRoots: [canvasRoot]
    });

    expect(result).toMatchObject({ ok: false, error: { code: "canvas_bridge_output_parent_unsafe" } });
    expect(await readdir(sharedParent)).toEqual([]);
  });
});

describe("Canvas bridge export output ownership", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  /** A trusted Canvas checkout whose bridge writes whatever `outPath` it is handed. */
  async function writeTrustedCanvasCheckout(options: {
    writeSentinelPath?: string;
    returnWrongPath?: boolean;
    raceReceiptPath?: string;
  } = {}): Promise<string> {
    const canvasRoot = await mkdtemp(join(tmpdir(), "shellx-motion-canvas-root-"));
    tempDirs.push(canvasRoot);
    await mkdir(join(canvasRoot, "app", "server"), { recursive: true, mode: 0o700 });
    await writeFile(join(canvasRoot, "app", "package.json"), JSON.stringify({ name: "shellx-canvas" }), "utf8");
    await writeFile(
      join(canvasRoot, "app", "server", "motion-package.mjs"),
      `
        import { mkdir, writeFile } from "node:fs/promises";
        import { dirname, join } from "node:path";
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
          ${options.writeSentinelPath ? `await writeFile(${JSON.stringify(options.writeSentinelPath)}, "bridge invoked", "utf8");` : ""}
          ${options.raceReceiptPath ? `await writeFile(${JSON.stringify(options.raceReceiptPath)}, "COMPETITOR RECEIPT", "utf8");` : ""}
          return { path: ${options.returnWrongPath ? 'join(dirname(options.outPath), "unexpected-selection.json")' : "options.outPath"}, schema: selection.schema };
        }
      `,
      "utf8"
    );
    return canvasRoot;
  }

  it.runIf(typeof process.getuid === "function")("refuses an allowlisted Canvas checkout writable by another principal", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-canvas-export-"));
    tempDirs.push(outDir);
    const sentinelPath = join(outDir, "bridge-invoked.txt");
    const canvasRoot = await writeTrustedCanvasCheckout({ writeSentinelPath: sentinelPath });
    await chmod(canvasRoot, 0o777);

    const result = await runCanvasBridgeFrameSelectionExport({
      canvasRoot,
      outPath: join(outDir, "selection.json"),
      trustedCanvasRoots: [canvasRoot]
    });

    expect(result).toMatchObject({ ok: false, error: { code: "canvas_bridge_untrusted" } });
    await expect(readFile(sentinelPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a Canvas checkout replaced after authority admission without importing replacement code", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-canvas-export-"));
    tempDirs.push(outDir);
    const canvasRoot = await writeTrustedCanvasCheckout();
    const displacedRoot = `${canvasRoot}-displaced`;
    const sentinelPath = join(outDir, "replacement-imported.txt");
    tempDirs.push(displacedRoot);

    const result = await runCanvasBridgeFrameSelectionExport(
      { canvasRoot, outPath: join(outDir, "selection.json"), trustedCanvasRoots: [canvasRoot] },
      {
        afterBridgeAuthorized: async () => {
          await rename(canvasRoot, displacedRoot);
          await mkdir(join(canvasRoot, "app", "server"), { recursive: true, mode: 0o700 });
          await writeFile(join(canvasRoot, "app", "package.json"), JSON.stringify({ name: "shellx-canvas" }), "utf8");
          await writeFile(join(canvasRoot, "app", "server", "motion-package.mjs"), `
            import { writeFile } from "node:fs/promises";
            await writeFile(${JSON.stringify(sentinelPath)}, "replacement imported", "utf8");
            export function buildMotionFrameSelection() { return {}; }
            export async function writeMotionFrameSelection() { return {}; }
          `, "utf8");
        }
      }
    );

    expect(result).toMatchObject({ ok: false, error: { code: "canvas_bridge_untrusted" } });
    await expect(readFile(sentinelPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(outDir, "selection.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

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

  it("preflights the fixed sibling receipt before it imports or invokes the bridge", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-canvas-export-"));
    tempDirs.push(outDir);
    const outPath = join(outDir, "sel.json");
    const receiptPath = join(outDir, "canvas-bridge-export.receipt.json");
    const bridgeSentinelPath = join(outDir, "bridge-invoked.txt");
    const canvasRoot = await writeTrustedCanvasCheckout({ writeSentinelPath: bridgeSentinelPath });
    await writeFile(receiptPath, "MY RECEIPT", "utf8");

    const result = await runCanvasBridgeFrameSelectionExport({ canvasRoot, outPath, trustedCanvasRoots: [canvasRoot] });

    expect(result).toMatchObject({ ok: false, error: { code: "output_path_exists" } });
    expect(await readFile(receiptPath, "utf8")).toBe("MY RECEIPT");
    await expect(readFile(outPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(bridgeSentinelPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(outDir)).toEqual(["canvas-bridge-export.receipt.json"]);
  });

  it("retains receiptPath compatibility only for the fixed sibling destination", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-canvas-export-"));
    tempDirs.push(outDir);
    const outPath = join(outDir, "sel.json");
    const bridgeSentinelPath = join(outDir, "bridge-invoked.txt");
    const canvasRoot = await writeTrustedCanvasCheckout({ writeSentinelPath: bridgeSentinelPath });

    const result = await runCanvasBridgeFrameSelectionExport({
      canvasRoot,
      outPath,
      receiptPath: join(outDir, "caller-selected-receipt.json"),
      trustedCanvasRoots: [canvasRoot]
    });

    expect(result).toMatchObject({ ok: false, error: { code: "canvas_bridge_receipt_path_fixed" } });
    await expect(readFile(bridgeSentinelPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(outDir)).toEqual([]);
  });

  it("cleans staged output and refuses a bridge result outside the approved destination", async () => {
    const canvasRoot = await writeTrustedCanvasCheckout({ returnWrongPath: true });
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-canvas-export-"));
    tempDirs.push(outDir);
    const outPath = join(outDir, "sel.json");
    const receiptPath = join(outDir, "canvas-bridge-export.receipt.json");

    const result = await runCanvasBridgeFrameSelectionExport({ canvasRoot, outPath, trustedCanvasRoots: [canvasRoot] });

    expect(result).toMatchObject({ ok: false, error: { code: "canvas_bridge_output_path_mismatch" } });
    await expect(readFile(outPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(receiptPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(outDir)).toEqual([]);
  });

  it("leaves its published selection when a competing receipt prevents receipt publication", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-canvas-export-"));
    tempDirs.push(outDir);
    const outPath = join(outDir, "sel.json");
    const receiptPath = join(outDir, "canvas-bridge-export.receipt.json");
    const canvasRoot = await writeTrustedCanvasCheckout({ raceReceiptPath: receiptPath });

    const result = await runCanvasBridgeFrameSelectionExport({ canvasRoot, outPath, trustedCanvasRoots: [canvasRoot] });

    expect(result).toMatchObject({ ok: false, error: { code: "canvas_bridge_export_failed" } });
    // A conditional lstat/unlink cannot safely roll this back: another process can replace this
    // pathname after the identity check. Preserve the partial owned artifact instead of exposing
    // a deletion primitive for that replacement.
    expect(await readFile(outPath, "utf8")).toContain("shellx-canvas/frame-selection@1");
    expect(await readFile(receiptPath, "utf8")).toBe("COMPETITOR RECEIPT");
  });

  it("refuses bridge bytes substituted after the bridge writes its private intake stage", async () => {
    const canvasRoot = await writeTrustedCanvasCheckout();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-canvas-export-"));
    tempDirs.push(outDir);
    const outPath = join(outDir, "sel.json");
    const receiptPath = join(outDir, "canvas-bridge-export.receipt.json");

    const result = await runCanvasBridgeFrameSelectionExport(
      { canvasRoot, outPath, target: "trusted", trustedCanvasRoots: [canvasRoot] },
      {
        afterBridgeStaged: async (stagedSelectionPath) => {
          const substituted = JSON.parse(await readFile(stagedSelectionPath, "utf8")) as Record<string, any>;
          substituted.selectedFrameId = "frame_substituted";
          substituted.project.id = "substituted";
          substituted.frames[0].id = "frame_substituted";
          await writeFile(stagedSelectionPath, JSON.stringify(substituted, null, 2), "utf8");
        }
      }
    );

    expect(result).toMatchObject({ ok: false, error: { code: "canvas_bridge_export_failed" } });
    await expect(readFile(outPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(receiptPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never lets force replace a directory-shaped receipt destination", async () => {
    const canvasRoot = await writeTrustedCanvasCheckout();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-canvas-export-"));
    tempDirs.push(outDir);
    const outPath = join(outDir, "sel.json");
    const receiptPath = join(outDir, "canvas-bridge-export.receipt.json");
    await writeFile(outPath, "MY SELECTION", "utf8");
    await mkdir(receiptPath);
    await writeFile(join(receiptPath, "caller-data.txt"), "MY RECEIPT DIRECTORY", "utf8");

    const result = await runCanvasBridgeFrameSelectionExport({ canvasRoot, outPath, force: true, trustedCanvasRoots: [canvasRoot] });

    expect(result).toMatchObject({ ok: false, error: { code: "output_path_exists" } });
    expect(await readFile(outPath, "utf8")).toBe("MY SELECTION");
    expect(await readFile(join(receiptPath, "caller-data.txt"), "utf8")).toBe("MY RECEIPT DIRECTORY");
  });

  it("replaces the selection and fixed sibling receipt only when the caller explicitly asks", async () => {
    const canvasRoot = await writeTrustedCanvasCheckout();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-canvas-export-"));
    tempDirs.push(outDir);
    const outPath = join(outDir, "sel.json");
    const receiptPath = join(outDir, "canvas-bridge-export.receipt.json");
    await writeFile(outPath, "MY SELECTION", "utf8");
    await writeFile(receiptPath, "MY RECEIPT", "utf8");

    const refused = await runCanvasBridgeFrameSelectionExport({ canvasRoot, outPath, trustedCanvasRoots: [canvasRoot] });
    expect(refused).toMatchObject({ ok: false, error: { code: "output_path_exists" } });
    expect(await readFile(outPath, "utf8")).toBe("MY SELECTION");
    expect(await readFile(receiptPath, "utf8")).toBe("MY RECEIPT");

    const result = await runCanvasBridgeFrameSelectionExport({ canvasRoot, outPath, force: true, trustedCanvasRoots: [canvasRoot] });

    expect(result).toMatchObject({ ok: true, schema: "shellx-canvas/frame-selection@1" });
    expect(await readFile(outPath, "utf8")).toContain("shellx-canvas/frame-selection@1");
    expect(JSON.parse(await readFile(receiptPath, "utf8"))).toMatchObject({
      operation: "canvas.bridge_export",
      status: "passed",
      output: { path: outPath, receiptPath }
    });
  });

  it("serializes concurrent forced publishers so a successful selection and receipt stay bound", async () => {
    const canvasRoot = await writeTrustedCanvasCheckout();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-canvas-export-"));
    tempDirs.push(outDir);
    const outPath = join(outDir, "sel.json");
    const receiptPath = join(outDir, "canvas-bridge-export.receipt.json");
    await writeFile(outPath, "OLD SELECTION", "utf8");
    await writeFile(receiptPath, "OLD RECEIPT", "utf8");

    const firstSelectionPublished = deferred();
    const continueFirst = deferred();
    const secondSelectionPublished = deferred();
    const continueSecond = deferred();
    const first = runCanvasBridgeFrameSelectionExport(
      { canvasRoot, outPath, target: "first", force: true, trustedCanvasRoots: [canvasRoot] },
      {
        afterSelectionPublished: async () => {
          firstSelectionPublished.resolve();
          await continueFirst.promise;
        }
      }
    );
    await firstSelectionPublished.promise;
    const second = runCanvasBridgeFrameSelectionExport(
      { canvasRoot, outPath, target: "second", force: true, trustedCanvasRoots: [canvasRoot] },
      {
        afterSelectionPublished: async () => {
          secondSelectionPublished.resolve();
          await continueSecond.promise;
        }
      }
    );
    const secondRace = await Promise.race([
      second.then((result) => ({ kind: "result" as const, result })),
      secondSelectionPublished.promise.then(() => ({ kind: "selection" as const }))
    ]);

    // Before the reservation fix, the second publisher reaches its own selection publication.
    // Let the first wrongly report success, then let the second fail its receipt and roll back its
    // selection. The expected assertions below make that unsafe interleave a deterministic red test.
    continueFirst.resolve();
    const firstResult = await first;
    if (secondRace.kind === "selection") continueSecond.resolve();
    const secondResult = secondRace.kind === "result" ? secondRace.result : await second;

    expect(firstResult).toMatchObject({ ok: true, selectedFrameId: "frame_first" });
    expect(secondResult).toMatchObject({
      ok: false,
      error: { code: "canvas_bridge_output_busy", suggestedAction: expect.stringContaining("rmdir") }
    });
    expect(JSON.parse(await readFile(outPath, "utf8"))).toMatchObject({ selectedFrameId: "frame_first" });
    expect(JSON.parse(await readFile(receiptPath, "utf8"))).toMatchObject({
      operation: "canvas.bridge_export",
      output: { path: outPath, receiptPath, selectedFrameId: "frame_first" }
    });
  });

  it("refuses a retargeted private reservation stage without deleting the replacement", async () => {
    const canvasRoot = await writeTrustedCanvasCheckout();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-canvas-export-"));
    tempDirs.push(outDir);
    const outPath = join(outDir, "sel.json");
    let replacementSelectionPath: string | undefined;

    const result = await runCanvasBridgeFrameSelectionExport(
      { canvasRoot, outPath, trustedCanvasRoots: [canvasRoot] },
      {
        beforeSelectionPublished: async (stageDir) => {
          await rename(stageDir, join(outDir, "displaced-private-stage"));
          await mkdir(stageDir);
          replacementSelectionPath = join(stageDir, "selection.json");
          await writeFile(replacementSelectionPath, "host private-stage replacement", "utf8");
        }
      }
    );

    // The expected reservation-stage identity makes publication refuse. Cleanup retains the
    // replacement and reports the deliberately retained lock's manual recovery contract.
    expect(result).toMatchObject({
      ok: false,
      error: { code: "canvas_bridge_output_busy", suggestedAction: expect.stringContaining("rmdir") }
    });
    await expect(readFile(replacementSelectionPath as string, "utf8")).resolves.toBe("host private-stage replacement");
    await expect(readFile(outPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(outDir, "canvas-bridge-export.receipt.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
