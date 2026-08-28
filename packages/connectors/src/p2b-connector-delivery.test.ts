import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSourceImportDocument, loadedPackageInputHashes, PublicationCommitUncertainError, type MotionPackage, type OperationReceipt } from "@shellx-motion/core";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { assertP2BClosedTreeCapacity, assertP2BPathlessExecutionInput, P2B_MAX_SCRIPT_INPUT_BYTES } from "./p2b-connector-delivery";

const faults = vi.hoisted(() => ({
  preview: undefined as undefined | ((pkg: any, options: any) => Promise<any>),
  final: undefined as undefined | ((input: any) => Promise<any>),
  afterInputRead: undefined as undefined | (() => Promise<void>),
  commitUncertain: false,
  commitUncertainError: undefined as PublicationCommitUncertainError | undefined,
  commitCalls: 0,
  stagingRoots: [] as string[]
}));

vi.mock("@shellx-motion/renderer-browser", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@shellx-motion/renderer-browser")>();
  return { ...actual, renderMotionBrowserFrame: async (pkg: any, options: any) => {
    await faults.afterInputRead?.();
    if (!faults.preview) throw new Error("P2B test did not install the private Browser preview producer.");
    return await faults.preview(pkg, options);
  } };
});

vi.mock("./streaming-final", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./streaming-final")>();
  return { ...actual, renderConnectorStreamingArtifact: async (input: any) => {
    if (!faults.final) throw new Error("P2B test did not install the private Browser-to-FFmpeg producer.");
    return await faults.final(input);
  } };
});

vi.mock("./connector-delivery", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./connector-delivery")>();
  return {
    ...actual,
    createPrivateConnectorDelivery: async (outDir: string) => {
      const delivery = await actual.createPrivateConnectorDelivery(outDir);
      faults.stagingRoots.push(delivery.stagingRoot);
      return {
        ...delivery,
        commit: async (inventory: any) => {
          faults.commitCalls += 1;
          await delivery.commit(inventory);
          if (faults.commitUncertain) {
            const error = new PublicationCommitUncertainError({
              publicPath: outDir, kind: "directory", expectedIdentity: { dev: 1, ino: 2 },
              expected: { sha256: "a".repeat(64), entryCount: 0, entries: [] }
            }, new Error("injected post-rename uncertainty"));
            faults.commitUncertainError = error;
            throw error;
          }
        }
      };
    }
  };
});

import { runCanvasToCutConnector } from "./canvas-to-cut";
import { runScriptToCutConnector } from "./script-to-cut";
import { runSourceToCutConnector } from "./source-to-cut";

const roots: string[] = [];
afterEach(async () => {
  faults.preview = undefined;
  faults.final = undefined;
  faults.afterInputRead = undefined;
  faults.commitUncertain = false;
  faults.commitUncertainError = undefined;
  faults.commitCalls = 0;
  faults.stagingRoots = [];
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// These mock only fixed internal producers. They prove private P2B assembly and publication
// semantics; the Linux Browser-to-FFmpeg smoke remains a separate missing host proof.
describe.runIf(process.platform === "linux")("Canvas/Script/Source P2B atomic connector delivery", () => {
  it("publishes Canvas as one exact Browser preview/Browser-to-FFmpeg MP4 F/H/C tree without input artifacts", async () => {
    const { root, sourceDir, outDir } = await fixture();
    installSuccessfulProducers();
    const selectionPath = join(sourceDir, "selection.json");
    await writeFile(selectionPath, `${JSON.stringify(canvasSelection(), null, 2)}\n`, "utf8");
    const result = await trusted(root, () => runCanvasToCutConnector({ canvasSelectionPath: selectionPath, outDir }));
    const connector = await json(result.receiptPath), render = await json(result.render.receiptPath), plan = await json(result.cutPlanPath);
    const handleReference = plan.operations[0].renderedMedia.handle;
    const handle = await json(join(outDir, handleReference.rootRelativePath));
    const publicText = JSON.stringify({ result, connector, render, plan, handle });
    const leaves = (await readdir(outDir, { recursive: true })).filter((path): path is string => typeof path === "string").sort();

    expect(result).toMatchObject({
      ok: true,
      preview: { ok: true, lane: "browser", failureFatal: false },
      render: { ok: true, required: true, dryRun: false, lane: "ffmpeg", frameLane: "browser", preset: "mp4-h264" }
    });
    expect(connector.inputHashes["admitted-package-tree"]).toBe(render.inputHashes["admitted-package-tree"]);
    expect(plan.receipt.inputHashes["admitted-package-tree"]).toBe(connector.inputHashes["admitted-package-tree"]);
    expect(handle.receipts).toEqual(expect.arrayContaining([expect.objectContaining({ role: "render" }), expect.objectContaining({ role: "connector" })]));
    expect(result.artifacts).not.toContainEqual(expect.objectContaining({ role: "canvas_selection" }));
    expect(publicText).not.toContain(selectionPath);
    expect(leaves.some((path) => path.includes(".stage") || path.includes(".p2b-generated-package"))).toBe(false);

    const packageLeaves = (await readdir(result.packageDir, { recursive: true }))
      .filter((path): path is string => typeof path === "string")
      .map((path) => join(result.packageDir, path));
    const packageFiles = (await Promise.all(packageLeaves.map(async (path) => (await stat(path)).isFile() ? path : undefined)))
      .filter((path): path is string => path !== undefined);
    const privateStage = faults.stagingRoots[0];
    expect(privateStage).toBeTruthy();
    expect(packageFiles).toContain(join(result.packageDir, "receipts", "canvas-export.receipt.json"));
    for (const path of packageFiles) {
      const bytes = await readFile(path);
      expect(bytes.includes(Buffer.from(".p2b-generated-package", "utf8"))).toBe(false);
      expect(bytes.includes(Buffer.from(privateStage!, "utf8"))).toBe(false);
    }
    const packageReceipt = await json(join(result.packageDir, "receipts", "canvas-export.receipt.json"));
    expect(packageReceipt.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "motion_package", path: ".", primary: true })
    ]));
    expect(packageReceipt.output).toMatchObject({
      packageRoot: ".",
      manifestPath: "manifest.json",
      motionPath: "motion.json",
      resourceCatalogPath: "resource-catalog.json",
      receiptPath: "receipts/canvas-export.receipt.json",
      packageContentHashes: {
        "manifest.json": { sha256: expect.stringMatching(/^[a-f0-9]{64}$/), byteLength: expect.any(Number) },
        "motion.json": { sha256: expect.stringMatching(/^[a-f0-9]{64}$/), byteLength: expect.any(Number) },
        "resource-catalog.json": { sha256: expect.stringMatching(/^[a-f0-9]{64}$/), byteLength: expect.any(Number) }
      }
    });
    expect(packageReceipt.output.packageDir).toBeUndefined();
    for (const ref of ["manifest.json", "motion.json", "resource-catalog.json"]) {
      const bytes = await readFile(join(result.packageDir, ref));
      expect(packageReceipt.output.packageContentHashes[ref]).toEqual({ sha256: digest(bytes), byteLength: bytes.byteLength });
    }
  });

  it("admits a file-backed Script before a hostile source mutation and never leaks the source path", async () => {
    const { root, sourceDir, outDir } = await fixture();
    installSuccessfulProducers();
    const scriptPath = join(sourceDir, "script.json");
    await writeFile(scriptPath, `${JSON.stringify(scriptedVideo("Original script"), null, 2)}\n`, "utf8");
    faults.afterInputRead = async () => { await writeFile(scriptPath, `${JSON.stringify(scriptedVideo("Mutated source"), null, 2)}\n`, "utf8"); };
    const result = await trusted(root, () => runScriptToCutConnector({ scriptPath, outDir }));
    const motion = await json(join(result.packageDir, "motion.json"));
    const packageReceipt = await json(join(result.packageDir, "receipts", "script-compile.receipt.json"));
    const text = JSON.stringify({ result, motion, connector: await json(result.receiptPath) });
    expect(text).toContain("Original script");
    expect(text).not.toContain("Mutated source");
    expect(text).not.toContain(scriptPath);
    expect(packageReceipt).toMatchObject({
      operation: "script.compile",
      artifacts: [expect.objectContaining({ role: "motion_package", path: ".", primary: true })],
      output: {
        packageRoot: ".",
        manifestPath: "manifest.json",
        motionPath: "motion.json",
        receiptPath: "receipts/script-compile.receipt.json",
        packageContentHashes: {
          "manifest.json": expect.objectContaining({ sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
          "motion.json": expect.objectContaining({ sha256: expect.stringMatching(/^[a-f0-9]{64}$/) })
        }
      }
    });
    await expectP2BPackageFreeOfPrivateGeneration(result.packageDir, faults.stagingRoots[0]!);
    expect(await readFile(scriptPath, "utf8")).toContain("Mutated source");
  });

  it("refuses a file-backed Script when a private renderer receipt leaks its admitted absolute path", async () => {
    const { root, sourceDir, outDir } = await fixture();
    const scriptPath = join(sourceDir, "script.json");
    await writeFile(scriptPath, `${JSON.stringify(scriptedVideo("Leak refusal"), null, 2)}\n`, "utf8");
    faults.preview = successfulPreview;
    faults.final = async (input) => {
      const result = await successfulFinal(input);
      (result.receipt.output as Record<string, unknown>).externalScriptPath = scriptPath;
      return result;
    };
    await expect(trusted(root, () => runScriptToCutConnector({ scriptPath, outDir }))).rejects.toThrow(/leaked an external local path/i);
    await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("admits Canvas asset bytes before hostile mutation and publishes only the copied immutable asset", async () => {
    const { root, sourceDir, outDir } = await fixture();
    installSuccessfulProducers();
    const original = Buffer.from("canvas-asset-original"), mutated = Buffer.from("canvas-asset-mutated");
    const assetPath = join(sourceDir, "assets", "product.png"), selectionPath = join(sourceDir, "selection.json");
    await mkdir(dirname(assetPath), { recursive: true, mode: 0o700 });
    await writeFile(assetPath, original);
    await writeFile(selectionPath, `${JSON.stringify(canvasSelectionWithAsset(original), null, 2)}\n`, "utf8");
    faults.afterInputRead = async () => { await writeFile(assetPath, mutated); };
    const result = await trusted(root, () => runCanvasToCutConnector({ canvasSelectionPath: selectionPath, outDir }));
    expect(await readFile(join(result.packageDir, "assets", "product.png"))).toEqual(original);
    expect(await readFile(assetPath)).toEqual(mutated);
  });

  it("accepts path-like visible Canvas text but refuses an absolute typed asset reference", async () => {
    const { root, sourceDir, outDir } = await fixture();
    installSuccessfulProducers();
    const visible = canvasSelection() as any;
    visible.frames[0].layers[0].text = "/launch C:\\TEMP";
    const visiblePath = join(sourceDir, "visible-text.json");
    await writeFile(visiblePath, `${JSON.stringify(visible, null, 2)}\n`, "utf8");
    const accepted = await trusted(root, () => runCanvasToCutConnector({ canvasSelectionPath: visiblePath, outDir }));
    expect(await readFile(join(accepted.packageDir, "motion.json"), "utf8")).toContain("/launch C:\\\\TEMP");

    const absoluteAsset = canvasSelectionWithAsset(Buffer.from("absolute-asset"));
    absoluteAsset.imageEditorOutputs[0].path = "/outside/product.png";
    const absolutePath = join(sourceDir, "absolute-asset.json"), refusedOut = join(root, "absolute-refused");
    await writeFile(absolutePath, `${JSON.stringify(absoluteAsset, null, 2)}\n`, "utf8");
    await expect(trusted(root, () => runCanvasToCutConnector({ canvasSelectionPath: absolutePath, outDir: refusedOut }))).rejects.toThrow(/Asset path escapes package root/i);
    await expect(stat(refusedOut)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("accepts bounded inline Script input and refuses legacy callbacks/options before publication", async () => {
    const { root, outDir } = await fixture();
    installSuccessfulProducers();
    const result = await trusted(root, () => runScriptToCutConnector({ script: scriptedVideo("Inline owned") , outDir, cutImportMode: "rendered_media" }));
    expect(result).toMatchObject({
      ok: true,
      preview: { lane: "browser", failureFatal: false },
      render: { required: true, dryRun: false, lane: "ffmpeg", frameLane: "browser" }
    });
    const refused = join(root, "refused");
    let invoked = false;
    await expect(runScriptToCutConnector({ script: scriptedVideo("No callback"), outDir: refused, streamingRenderer: async () => { invoked = true; } } as any)).rejects.toThrow(/legacy streamingRenderer/i);
    expect(invoked).toBe(false);
    await expect(stat(refused)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("converts inline Script from its once-admitted JSON bytes, never a second caller-object read", async () => {
    const { root, outDir } = await fixture();
    installSuccessfulProducers();
    const admitted = scriptedVideo("Accessor admitted") as any;
    const changed = scriptedVideo("Accessor changed") as any;
    let frameReads = 0;
    Object.defineProperty(admitted, "frames", {
      enumerable: true,
      get: () => (++frameReads === 1 ? (scriptedVideo("Accessor admitted") as any).frames : changed.frames)
    });
    const result = await trusted(root, () => runScriptToCutConnector({ script: admitted, outDir }));
    const motionText = await readFile(join(result.packageDir, "motion.json"), "utf8");
    expect(frameReads).toBe(1);
    expect(motionText).toContain("Accessor admitted");
    expect(motionText).not.toContain("Accessor changed");
  });

  it("refuses oversized Script JSON before parsing or creating a P2B delivery", async () => {
    const { root, sourceDir, outDir } = await fixture();
    const scriptPath = join(sourceDir, "oversized-script.json");
    await writeFile(scriptPath, Buffer.alloc(P2B_MAX_SCRIPT_INPUT_BYTES + 1, 0x20));

    await expect(trusted(root, () => runScriptToCutConnector({ scriptPath, outDir })))
      .rejects.toThrow("Scripted-video input exceeds its byte limit");
    await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
    expect(faults.stagingRoots).toEqual([]);
  });

  it("refuses oversized inline Script text before its JSON serialization", async () => {
    const { root, outDir } = await fixture();
    const input = scriptedVideo("x".repeat(16 * 1024 + 1));

    await expect(trusted(root, () => runScriptToCutConnector({ script: input, outDir })))
      .rejects.toThrow("frames[0].title exceeds the 16384-byte scripted-video string limit.");
    await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
    expect(faults.stagingRoots).toEqual([]);
  });

  it("refuses every public legacy selector/callback surface before a Canvas, Script, or Source stage", async () => {
    const { root, sourceDir, outDir } = await fixture();
    const selectionPath = join(sourceDir, "selection.json"), sourcePath = join(sourceDir, "source.md");
    await writeFile(selectionPath, `${JSON.stringify(canvasSelection())}\n`, "utf8");
    await writeFile(sourcePath, sourceMarkdown(), "utf8");
    await expect(runCanvasToCutConnector({ canvasSelectionPath: selectionPath, outDir: join(root, "canvas-refused"), dryRunRender: true } as any)).rejects.toThrow(/legacy dryRunRender/i);
    await expect(runScriptToCutConnector({ script: scriptedVideo("refused"), outDir: join(root, "script-refused"), ffmpegRunner: async () => undefined } as any)).rejects.toThrow(/legacy ffmpegRunner/i);
    await expect(runSourceToCutConnector({ sourcePath, sourceInputRoot: sourceDir, outDir: join(root, "source-refused"), cutImportMode: "editable_lowering" } as any)).rejects.toThrow(/legacy cutImportMode/i);
    await expect(Promise.all(["canvas-refused", "script-refused", "source-refused"].map(async (name) => await stat(join(root, name))))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses missing Canvas assets and Source input nested below its output before publication", async () => {
    const { root, sourceDir } = await fixture();
    const missingSelection = join(sourceDir, "missing-assets.json"), outDir = join(root, "canvas-out");
    await writeFile(missingSelection, await readFile(join(resolve("../../fixtures/canvas"), "frame-selection.json")));
    await expect(trusted(root, () => runCanvasToCutConnector({ canvasSelectionPath: missingSelection, outDir }))).rejects.toThrow(/missing Canvas assets/i);
    await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
    const overlappingOut = join(root, "overlap"), overlappingSource = join(overlappingOut, "source.md");
    await mkdir(overlappingOut);
    await writeFile(overlappingSource, sourceMarkdown(), "utf8");
    await expect(runSourceToCutConnector({ sourcePath: overlappingSource, sourceInputRoot: overlappingOut, outDir: overlappingOut, maxFrames: 1 })).rejects.toThrow(/external to the caller-selected output/i);
  });

  it("Source derives a logical storyboard in memory, binds exact child F/H/C, and commits once at the outer root", async () => {
    const { root, sourceDir, outDir } = await fixture();
    installSuccessfulProducers();
    const sourcePath = join(sourceDir, "source.md");
    await writeFile(sourcePath, sourceMarkdown(), "utf8");
    const result = await trusted(root, () => runSourceToCutConnector({ sourcePath, sourceInputRoot: sourceDir, outDir, maxFrames: 1, fps: 2 }));
    const receipt = await json(result.receiptPath);
    const storyboard = await json(result.storyboard.scriptPath);
    const childF = await json(result.connector.receiptPath), childC = await json(result.cutPlanPath);
    const childHandleRef = childC.operations[0].renderedMedia.handle;
    const childH = await json(join(outDir, childHandleRef.rootRelativePath));
    const publicText = JSON.stringify({ result, receipt, storyboard, childF, childH, childC });

    expect(result).toMatchObject({
      preview: { lane: "browser", failureFatal: false },
      render: { required: true, dryRun: false, lane: "ffmpeg", frameLane: "browser" }
    });
    expect(receipt.inputHashes).toMatchObject({ childConnectorReceipt: digest(Buffer.from(JSON.stringify(childF, null, 2) + "\n")), childArtifactHandle: digest(Buffer.from(JSON.stringify(childH, null, 2) + "\n")), childCutPlan: digest(Buffer.from(JSON.stringify(childC, null, 2) + "\n")) });
    expect(storyboard.frames[0].sourceRefs[0].path).toBe("input/source.md");
    expect((await json(join(outDir, "cut", "package", "motion.json"))).scenes[0]["x-storyboard"].sourceRefs[0].path).toBe("input/source.md");
    expect(result.artifacts).not.toContainEqual(expect.objectContaining({ role: "source_markdown" }));
    expect(result.artifacts).not.toContainEqual(expect.objectContaining({ role: "source_import_receipt" }));
    expect(publicText).not.toContain(sourcePath);
    expect(publicText).not.toContain(".stage");
    expect(await stat(outDir)).toMatchObject({ isDirectory: expect.any(Function) });
    expect((await readdir(outDir, { recursive: true })).map(String)).toContain("cut/package/manifest.json");
    await expectP2BPackageFreeOfPrivateGeneration(join(outDir, "cut", "package"), faults.stagingRoots[0]!);
  });

  it.each([
    ["nonempty output", async (root: string, outDir: string) => { await mkdir(outDir, { mode: 0o700 }); await writeFile(join(outDir, "sentinel.txt"), "keep", "utf8"); return { script: scriptedVideo("collision"), outDir }; }, /not empty/i],
    ["legacy force", async (_root: string, outDir: string) => ({ script: scriptedVideo("force"), outDir, force: true } as any), /does not support legacy force/i]
  ])("refuses %s without exposing a public partial root", async (_label, makeInput, expected) => {
    const { root, outDir } = await fixture();
    const input = await makeInput(root, outDir);
    await expect(trusted(root, () => runScriptToCutConnector(input))).rejects.toThrow(expected);
    if (_label === "nonempty output") expect(await readFile(join(outDir, "sentinel.txt"), "utf8")).toBe("keep");
    else await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("aborts before commit on a private final-producer failure and preserves typed commit uncertainty", async () => {
    const { root, outDir } = await fixture();
    faults.preview = successfulPreview;
    faults.final = async () => { throw new Error("private final failure"); };
    await expect(trusted(root, () => runScriptToCutConnector({ script: scriptedVideo("failure"), outDir }))).rejects.toThrow(/private final failure/);
    await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
    installSuccessfulProducers();
    const uncertainOut = join(root, "uncertain");
    faults.commitUncertain = true;
    let received: unknown;
    try { await trusted(root, () => runScriptToCutConnector({ script: scriptedVideo("uncertain"), outDir: uncertainOut })); }
    catch (error) { received = error; }
    expect(received).toBe(faults.commitUncertainError);
    expect(received).toBeInstanceOf(PublicationCommitUncertainError);
    expect(received).toMatchObject({ code: "publication_commit_uncertain", evidence: { publicPath: uncertainOut, kind: "directory" } });
  });

  it("propagates cancellation into the P2B final producer and aborts before its only public commit", async () => {
    const { root, outDir } = await fixture();
    faults.preview = successfulPreview;
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    faults.final = async (input) => {
      receivedSignal = input.signal;
      const result = await successfulFinal(input);
      controller.abort(new Error("coordinator cancelled P2B connector"));
      return result;
    };

    await expect(trusted(root, () => runScriptToCutConnector({
      script: scriptedVideo("cancelled"),
      outDir,
      signal: controller.signal
    }))).rejects.toThrow("coordinator cancelled P2B connector");

    expect(receivedSignal).toBe(controller.signal);
    expect(faults.commitCalls).toBe(0);
    await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves neither Canvas nor Source public output when the private final producer fails", async () => {
    const { root, sourceDir } = await fixture();
    const selectionPath = join(sourceDir, "selection.json"), sourcePath = join(sourceDir, "source.md");
    await writeFile(selectionPath, `${JSON.stringify(canvasSelection())}\n`, "utf8");
    await writeFile(sourcePath, sourceMarkdown(), "utf8");
    faults.preview = successfulPreview;
    faults.final = async () => { throw new Error("late private final failure"); };
    const canvasOut = join(root, "canvas-failed"), sourceOut = join(root, "source-failed");
    await expect(trusted(root, () => runCanvasToCutConnector({ canvasSelectionPath: selectionPath, outDir: canvasOut }))).rejects.toThrow(/late private final failure/);
    await expect(trusted(root, () => runSourceToCutConnector({ sourcePath, sourceInputRoot: sourceDir, outDir: sourceOut, maxFrames: 1 }))).rejects.toThrow(/late private final failure/);
    await expect(stat(canvasOut)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(sourceOut)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reserves Source's three parent leaves before producers against the P1 file limit", () => {
    const nearLimit = { evidence: { entries: [], fileCount: 1015, aggregateBytes: 0 } };
    expect(() => assertP2BClosedTreeCapacity(nearLimit as any, 10)).toThrow(/1024-file limit/i);
  });

  it("counts Source's cut/package prefix before producers against P1 final path depth", () => {
    const deepLeaf = Array.from({ length: 15 }, (_value, index) => `part-${index}`).join("/");
    const admitted = { evidence: { entries: [{ kind: "file", path: deepLeaf }], fileCount: 1, aggregateBytes: 0 } };
    expect(() => assertP2BClosedTreeCapacity(admitted as any, 7, "package")).not.toThrow();
    expect(() => assertP2BClosedTreeCapacity(admitted as any, 10, "cut/package")).toThrow(/cut\/package.*at most 16 final root-relative path components/i);
  });

  it.each([
    ["POSIX source path", (script: any) => { script.frames[0].sourceRefs = [{ type: "article", path: "/private/source.md" }]; }, /logical input\/ locator/i],
    ["Windows source path", (script: any) => { script.frames[0].sourceRefs = [{ type: "article", path: "C:\\private\\source.md" }]; }, /logical input\/ locator/i],
    ["traversing source path", (script: any) => { script.frames[0].sourceRefs = [{ type: "article", path: "input/../source.md" }]; }, /logical input\/ locator/i],
    ["private source URL", (script: any) => { script.frames[0].sourceRefs = [{ type: "article", url: "file:///private/source.md" }]; }, /public http\(s\) URL/i],
    ["absolute asset locator", (script: any) => { script.frames[0].assetRefs = ["/private/asset.png"]; }, /package-local assets\/ locator/i],
    ["unadmitted Script asset", (script: any) => { script.frames[0].assetRefs = ["assets/unadmitted.png"]; }, /admitted package file leaf/i]
  ])("refuses typed P2B %s before producers or publication", async (_label, mutate, expected) => {
    const { root, outDir } = await fixture();
    const script = scriptedVideo("Locator refusal") as any;
    mutate(script);
    await expect(trusted(root, () => runScriptToCutConnector({ script, outDir }))).rejects.toThrow(expected);
    await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["active script", { type: "web", id: "web" }, /active agent scripts/i],
    ["audio", { type: "audio", id: "audio" }, /refuses audio/i],
    ["GPU", { type: "shader", id: "shader" }, /closed GPU provenance/i]
  ])("refuses path-bound %s content before producer execution", (_label, layer, expected) => {
    expect(() => assertP2BPathlessExecutionInput({ motion: { layers: [layer], audio: undefined } } as any, "P2B test")).toThrow(expected);
  });
});

describe("P2B portable refusal", () => {
  it.runIf(process.platform !== "linux")("refuses before input reads or stage creation on unsupported hosts", async () => {
    const { outDir } = await fixture();
    await expect(runScriptToCutConnector({ scriptPath: join(outDir, "missing.json"), outDir })).rejects.toThrow(/Linux-only/i);
    await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function fixture(): Promise<{ root: string; sourceDir: string; outDir: string }> {
  const root = await mkdtemp(join(process.cwd(), ".tmp-shellx-motion-p2b-"));
  roots.push(root);
  const sourceDir = join(root, "input"), outDir = join(root, "out");
  await mkdir(sourceDir, { recursive: true, mode: 0o700 });
  return { root, sourceDir, outDir };
}

async function expectP2BPackageFreeOfPrivateGeneration(packageDir: string, stagingRoot: string): Promise<void> {
  const entries = await readdir(packageDir, { recursive: true });
  for (const entry of entries) {
    const path = join(packageDir, String(entry));
    if (!(await stat(path)).isFile()) continue;
    const bytes = await readFile(path);
    expect(bytes.includes(Buffer.from(".p2b-generated-package", "utf8"))).toBe(false);
    expect(bytes.includes(Buffer.from(stagingRoot, "utf8"))).toBe(false);
  }
}

async function trusted<T>(root: string, action: () => Promise<T>): Promise<T> {
  return await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(root), action);
}

function installSuccessfulProducers(): void { faults.preview = successfulPreview; faults.final = successfulFinal; }
async function successfulPreview(pkg: MotionPackage, options: { outputPath: string; atMs: number }) {
  const bytes = Buffer.from("p2b-preview");
  await mkdir(dirname(options.outputPath), { recursive: true, mode: 0o700 });
  await writeFile(options.outputPath, bytes);
  const tree = requiredTree(pkg);
  return { output: { path: options.outputPath, sha256: digest(bytes) }, receipt: receipt(pkg, "preview.frame", "browser", { path: options.outputPath, sha256: digest(bytes), atMs: options.atMs }, tree) };
}
async function successfulFinal(input: { pkg: MotionPackage; outputPath: string; frameLane: "browser" }) {
  const bytes = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisomP2B")]);
  await mkdir(dirname(input.outputPath), { recursive: true, mode: 0o700 });
  await writeFile(input.outputPath, bytes);
  const tree = requiredTree(input.pkg);
  return {
    frameLane: "browser" as const,
    receipt: receipt(input.pkg, "render.final", "ffmpeg", {
      path: input.outputPath, sha256: digest(bytes),
      frameTransport: { delivery: "streamed", frameLane: "browser", producer: { frameLane: "browser", evidence: { stableInputHashUnion: { "admitted-package-tree": tree }, stableInputHashKeysOmitted: 0, stableInputHashConflictKeys: [], stableInputHashConflictKeysOmitted: 0 } } }
    }, tree)
  };
}
function receipt(pkg: MotionPackage, operation: string, lane: string, output: Record<string, unknown>, tree: string): OperationReceipt {
  return { schema: "shellx-motion/receipt@1", id: `${operation}-${tree.slice(0, 12)}`, operation, status: "passed", packageId: pkg.manifest.id, inputHashes: { "admitted-package-tree": tree }, createdAt: "2026-08-22T12:00:00.000Z", lane, output, warnings: [] };
}
function requiredTree(pkg: MotionPackage): string {
  const tree = loadedPackageInputHashes(pkg)?.["admitted-package-tree"];
  if (!tree) throw new Error("P2B test expected Core's immutable admitted execution snapshot.");
  return tree;
}
function canvasSelection(): unknown {
  return { schema: "shellx-canvas/frame-selection@1", selectedFrameId: "frame", project: { id: "p2b", name: "P2B" }, brand: { tokens: { color: { accent: "#38bdf8" } } }, frames: [{ id: "frame", name: "Frame", durationMs: 1000, fps: 2, width: 640, height: 360, background: "#111827", layers: [{ id: "title", kind: "text", text: "Canvas P2B", startMs: 0, durationMs: 1000, transform: { x: 40, y: 40, width: 400, height: 80 }, style: { fontSize: 36, color: "#ffffff" } }] }], imageEditorOutputs: [] };
}
function canvasSelectionWithAsset(bytes: Buffer): any {
  const selection = canvasSelection() as any;
  selection.frames[0].layers.push({ id: "asset", kind: "image", assetId: "asset-product", startMs: 0, durationMs: 1000, transform: { x: 0, y: 0, width: 40, height: 40 } });
  selection.imageEditorOutputs = [{ id: "asset-output", assetId: "asset-product", kind: "image", path: "assets/product.png", mimeType: "image/png", width: 40, height: 40, sha256: digest(bytes), receiptId: "asset-receipt", editStack: [] }];
  return selection;
}
function scriptedVideo(title: string): unknown {
  return { schema: "shellx-motion/scripted-video@1", id: "p2b-script", name: "P2B Script", sourceApp: "shellx-cut", workflow: "generate", width: 640, height: 360, fps: 2, frames: [{ id: "frame", title, body: "immutable input", durationMs: 1000, background: "#111827", accent: "#38bdf8" }] };
}
function sourceMarkdown(): string {
  return buildSourceImportDocument({ url: "https://example.invalid/p2b", title: "P2B Source", kind: "article", markdown: "P2B source content must become a reviewable storyboard." }).markdown;
}
async function json(path: string): Promise<any> { return JSON.parse(await readFile(path, "utf8")); }
function digest(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
