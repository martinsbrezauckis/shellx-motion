import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadedPackageInputHashes, type MotionPackage, type OperationReceipt } from "@shellx-motion/core";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";

const privateFaults = vi.hoisted(() => ({
  preview: undefined as undefined | ((pkg: any, options: any) => Promise<any>),
  final: undefined as undefined | ((input: any) => Promise<any>),
  handle: undefined as undefined | ((input: any, actual: (input: any) => Promise<any>) => Promise<any>),
}));

vi.mock("@shellx-motion/renderer-browser", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@shellx-motion/renderer-browser")>();
  return { ...actual, renderMotionBrowserFrame: async (pkg: any, options: any) => {
    if (!privateFaults.preview) throw new Error("P2A test did not install an internal Browser preview producer.");
    return await privateFaults.preview(pkg, options);
  } };
});

vi.mock("./streaming-final", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./streaming-final")>();
  return { ...actual, renderConnectorStreamingArtifact: async (input: any) => {
    if (!privateFaults.final) throw new Error("P2A test did not install an internal streaming producer.");
    return await privateFaults.final(input);
  } };
});

vi.mock("./artifact-handle", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./artifact-handle")>();
  return { ...actual, finalizeConnectorArtifactHandle: async (input: any) => privateFaults.handle
    ? await privateFaults.handle(input, actual.finalizeConnectorArtifactHandle as (value: any) => Promise<any>)
    : await actual.finalizeConnectorArtifactHandle(input) };
});

import { runTemplateToCutConnector } from "./template-to-cut";

const roots: string[] = [];
afterEach(async () => {
  privateFaults.preview = undefined;
  privateFaults.final = undefined;
  privateFaults.handle = undefined;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// Internal producer seams prove only structural/atomic assembly. Real Browser+FFmpeg acceptance is
// the Linux `connector:template-cut-render-smoke` platform gate, never this mocked suite.
describe.runIf(process.platform === "linux")("Template-to-Cut P2A structural atomic assembly coverage", () => {
  it("assembles one exact nested package/media/H/C/F tree from immutable Browser evidence", async () => {
    const { source, outDir } = await fixture();
    installSuccessfulPrivateProducers();
    const result = await run(source, outDir);
    const connector = await readJson(result.receiptPath);
    const render = await readJson(result.render.receiptPath);
    const plan = await readJson(result.cutPlanPath);
    const reference = plan.operations[0].renderedMedia.handle;
    const handle = await readJson(join(outDir, reference.rootRelativePath));
    const leaves = (await readdir(outDir, { recursive: true })).filter((path): path is string => typeof path === "string").sort();

    expect(result).toMatchObject({ ok: true, preview: { ok: true, lane: "browser" }, render: { ok: true, required: true, dryRun: false, frameLane: "browser" } });
    expect(connector.inputHashes["admitted-package-tree"]).toBe(connector.output.template.publishedTree.sha256);
    expect(render.inputHashes["admitted-package-tree"]).toBe(connector.output.template.publishedTree.sha256);
    expect(plan.receipt.inputHashes["admitted-package-tree"]).toBe(connector.output.template.publishedTree.sha256);
    expect(handle.rootRelativePath).toBe("render/pkg_editable_lower_third.mp4");
    expect(reference.rootRelativePath).toBe("artifacts/rendered-media.artifact.json");
    expect(leaves).toEqual(expect.arrayContaining(["artifacts", "artifacts/rendered-media.artifact.json", "connector-run.receipt.json", "cut-import-plan.json", "preview", "receipts", "render"]));
    const publicText = JSON.stringify({ result, connector, render, plan, handle });
    expect(publicText).not.toContain(source);
    expect(publicText).not.toContain(".stage");
  });

  it("keeps F private until H exists and writes C only after the exact H reference", async () => {
    const { source, outDir } = await fixture();
    installSuccessfulPrivateProducers();
    privateFaults.handle = async (input, actual) => {
      await expect(stat(input.connectorReceiptPath)).resolves.toMatchObject({ isFile: expect.any(Function) });
      await expect(stat(input.descriptorPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(join(outDir, "connector-run.receipt.json"))).rejects.toMatchObject({ code: "ENOENT" });
      const finalized = await actual(input);
      await expect(stat(input.descriptorPath)).resolves.toMatchObject({ isFile: expect.any(Function) });
      await expect(stat(join(input.root, "cut-import-plan.json"))).rejects.toMatchObject({ code: "ENOENT" });
      return finalized;
    };
    const result = await run(source, outDir);
    const plan = await readJson(result.cutPlanPath);
    expect(plan.operations[0].renderedMedia.handle.rootRelativePath).toBe("artifacts/rendered-media.artifact.json");
  });

  it.each(["media producer", "artifact handle"])("aborts without public output on %s failure", async (kind) => {
    const { source, outDir } = await fixture();
    privateFaults.preview = successfulPreview;
    if (kind === "media producer") privateFaults.final = async () => { throw new Error("media failure"); };
    else privateFaults.handle = async () => { throw new Error("handle failure"); };
    await expect(run(source, outDir)).rejects.toThrow();
    await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses P2A-only unsupported modes before any output transaction", async () => {
    const { source, outDir } = await fixture();
    await expect(runTemplateToCutConnector(hostileInput({ packageRoot: source, outDir, values: { title: "x" }, previewLane: "native", cutImportMode: "rendered_media" }))).rejects.toThrow(/browser-preview-only/i);
    await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(runTemplateToCutConnector(hostileInput({ packageRoot: source, outDir, values: { title: "x" }, frameLane: "gpu", cutImportMode: "rendered_media" }))).rejects.toThrow(/browser final lane/i);
    await expect(runTemplateToCutConnector(hostileInput({ packageRoot: source, outDir, values: { title: "x" }, dryRunRender: true, cutImportMode: "rendered_media" }))).rejects.toThrow(/real browser-to-ffmpeg/i);
  });

  it.each([
    ["active script", "../../fixtures/packages/web-card", "web", /active agent scripts/i],
    ["audio layer", "../../fixtures/packages/gpu-g9-mixed-media-atlas", "audio", /refuses audio/i],
    ["includeAudio layer", undefined, "includeAudio", /refuses audio/i],
    ["shader layer", "../../fixtures/packages/gpu-material-admitted", "shader", /refuses shader layer/i],
    ["scene3d layer", "../../fixtures/packages/fixed-scene3d", "scene3d", /refuses scene3d layer/i],
    ["environment layer", "../../fixtures/packages/environment-fog-cinematic", "environment", /refuses environment layer/i]
  ] as const)("refuses P2A %s content before any output transaction", async (_label, fixtureRelative, layerType, expected) => {
    const { root, source, outDir } = await fixture();
    const motionPath = join(source, "motion.json");
    const motion = await readJson(motionPath) as { layers: Array<Record<string, unknown>> };
    if (layerType === "includeAudio") {
      motion.layers[0] = { ...motion.layers[0], includeAudio: true };
    } else {
      const fixtureMotion = await readJson(resolve(fixtureRelative!, "motion.json")) as { layers: Array<Record<string, unknown>> };
      const layer = fixtureMotion.layers.find((candidate) => candidate.type === layerType);
      if (!layer) throw new Error(`test fixture has no ${layerType} layer`);
      motion.layers.push(layer);
    }
    await writeFile(motionPath, `${JSON.stringify(motion, null, 2)}\n`, "utf8");

    await expect(runWithTrustedRoot(root, { packageRoot: source, outDir, values: { title: "x" } })).rejects.toThrow(expected);
    await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a source package leaf that would exceed P1 final-path depth before any output transaction", async () => {
    const { root, source, outDir } = await fixture();
    const sourceRelativePath = `${Array.from({ length: 15 }, (_, index) => `d${index}`).join("/")}/leaf.txt`;
    await mkdir(dirname(join(source, sourceRelativePath)), { recursive: true, mode: 0o700 });
    await writeFile(join(source, sourceRelativePath), "depth sentinel", "utf8");

    await expect(runWithTrustedRoot(root, { packageRoot: source, outDir, values: { title: "x" } })).rejects.toThrow(/at most 16 final root-relative path components/i);
    await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves collision sentinels and refuses force", async () => {
    const { source, outDir } = await fixture(true);
    const sentinel = join(outDir, "caller-sentinel.txt");
    await writeFile(sentinel, "keep", "utf8");
    await expect(run(source, outDir)).rejects.toThrow();
    expect(await readFile(sentinel, "utf8")).toBe("keep");
    await expect(runTemplateToCutConnector(hostileInput({ packageRoot: source, outDir, values: { title: "x" }, force: true, cutImportMode: "rendered_media" }))).rejects.toThrow(/does not support force/i);
    expect(await readFile(sentinel, "utf8")).toBe("keep");
  });

  it("does not invoke legacy caller renderer hooks smuggled through an untyped input", async () => {
    const { root, source, outDir } = await fixture();
    installSuccessfulPrivateProducers();
    let invoked = false;
    const untypedInput = {
      packageRoot: source, outDir, values: { title: "x" },
      streamingRenderer: async () => { invoked = true; throw new Error("legacy renderer must not run"); },
      ffmpegRunner: async () => { invoked = true; throw new Error("legacy runner must not run"); }
    } as unknown as Parameters<typeof runTemplateToCutConnector>[0];
    const anchor = await createTrustedWorkspaceAnchor(root);
    const result = await withTrustedWorkspaceAnchor(anchor, async () => await runTemplateToCutConnector(untypedInput));
    expect(result.ok).toBe(true);
    expect(invoked).toBe(false);
  });

  it("refuses source empty directories before staging", async () => {
    const { source, outDir } = await fixture();
    await mkdir(join(source, "empty"), { mode: 0o700 });
    await expect(run(source, outDir)).rejects.toThrow(/empty package directory/i);
    await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("Template-to-Cut P2A portable early refusals", () => {
  it("refuses native preview and force before any output transaction", async () => {
    const { source, outDir } = await fixture();
    await expect(runTemplateToCutConnector(hostileInput({ packageRoot: source, outDir, values: { title: "x" }, previewLane: "native", cutImportMode: "rendered_media" }))).rejects.toThrow(/browser-preview-only/i);
    await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(runTemplateToCutConnector(hostileInput({ packageRoot: source, outDir, values: { title: "x" }, force: true, cutImportMode: "rendered_media" }))).rejects.toThrow(/does not support force/i);
    await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.runIf(process.platform !== "linux")("refuses accepted P2A delivery on unsupported hosts before source admission", async () => {
    const { source, outDir } = await fixture();
    await expect(runTemplateToCutConnector({ packageRoot: source, outDir, values: { title: "x" } })).rejects.toThrow(/Linux-only/i);
    await expect(stat(outDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function fixture(precreateOutput = false): Promise<{ root: string; source: string; outDir: string }> {
  const root = await mkdtemp(join(process.cwd(), ".tmp-shellx-motion-template-p2a-"));
  roots.push(root);
  const source = join(root, "source"), outDir = join(root, "delivery");
  await cp(resolve("../../fixtures/packages/editable-lower-third"), source, { recursive: true });
  // A Git checkout created under umask 0002 has group-writable directory modes. The copied source
  // is an authority fixture, so normalize every copied directory instead of inheriting host modes.
  await makeDirectoryTreePrivate(source);
  if (precreateOutput) await mkdir(outDir, { mode: 0o700 });
  return { root, source, outDir };
}

async function run(source: string, outDir: string) {
  if (!privateFaults.preview) privateFaults.preview = successfulPreview;
  if (!privateFaults.final) privateFaults.final = successfulFinal;
  return await runWithTrustedRoot(dirname(source), {
    packageRoot: source, outDir, values: { title: "P2A immutable title" }
  });
}

async function runWithTrustedRoot(root: string, input: Parameters<typeof runTemplateToCutConnector>[0]) {
  const anchor = await createTrustedWorkspaceAnchor(root);
  return await withTrustedWorkspaceAnchor(anchor, async () => await runTemplateToCutConnector(input));
}

function hostileInput(input: Record<string, unknown>): Parameters<typeof runTemplateToCutConnector>[0] {
  return input as unknown as Parameters<typeof runTemplateToCutConnector>[0];
}

function installSuccessfulPrivateProducers(): void { privateFaults.preview = successfulPreview; privateFaults.final = successfulFinal; }

async function successfulPreview(pkg: MotionPackage, options: { outputPath: string; atMs: number }) {
  const bytes = Buffer.from("p2a-preview");
  await mkdir(dirname(options.outputPath), { recursive: true, mode: 0o700 });
  await writeFile(options.outputPath, bytes);
  const sha256 = digest(bytes), tree = requiredTree(pkg);
  return { output: { path: options.outputPath, sha256 }, receipt: makeReceipt(pkg, "preview.frame", "browser", { path: options.outputPath, sha256, atMs: options.atMs }, tree) };
}

async function successfulFinal(input: { pkg: MotionPackage; outputPath: string; frameLane: "browser" }) {
  const bytes = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x18]), Buffer.from("ftypisom\u0000\u0000\u0002\u0000isomiso2")]);
  await mkdir(dirname(input.outputPath), { recursive: true, mode: 0o700 });
  await writeFile(input.outputPath, bytes);
  const sha256 = digest(bytes), tree = requiredTree(input.pkg);
  return { frameLane: input.frameLane, receipt: makeReceipt(input.pkg, "render.final", "ffmpeg", {
    path: input.outputPath, sha256,
    frameTransport: { delivery: "streamed", frameLane: "browser", producer: { frameLane: "browser", evidence: {
      stableInputHashUnion: { "admitted-package-tree": tree }, stableInputHashKeysOmitted: 0,
      stableInputHashConflictKeys: [], stableInputHashConflictKeysOmitted: 0
    } } }
  }, tree) };
}

function makeReceipt(pkg: MotionPackage, operation: string, lane: string, output: Record<string, unknown>, tree: string): OperationReceipt {
  return { schema: "shellx-motion/receipt@1", id: `${operation}-${tree.slice(0, 12)}`, operation, status: "passed", packageId: pkg.manifest.id, inputHashes: { "admitted-package-tree": tree }, createdAt: "2026-08-21T12:00:00.000Z", lane, output, warnings: [] };
}

function requiredTree(pkg: MotionPackage): string {
  const tree = loadedPackageInputHashes(pkg)?.["admitted-package-tree"];
  if (!tree) throw new Error("test expected a Core-minted admitted execution snapshot");
  return tree;
}
function digest(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
async function readJson(path: string): Promise<any> { return JSON.parse(await readFile(path, "utf8")); }

async function makeDirectoryTreePrivate(root: string): Promise<void> {
  await chmod(root, 0o700);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory()) await makeDirectoryTreePrivate(join(root, entry.name));
  }
}
