import { describe, expect, it } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MotionDocument, MotionPackage } from "@shellx-motion/core";
import {
  canonicalJsonSha256,
  comparePngBuffers,
  hashPackageFile,
  inspectPngBuffer,
  loadMotionPackage,
} from "@shellx-motion/core";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { renderMotionBrowserFrame } from "@shellx-motion/renderer-browser";
import { debugCommandDefinition } from "../command-registry.js";
import { TIMELINE_TEXT_RUNS_COMMAND_METADATA } from "../command-metadata-timeline-text-runs.js";
import { dispatchDebugCommand } from "../index.js";
import { readTimelineLayerCreateArg } from "./timeline-layer-create-args.js";
import {
  applyTimelineTextRunsIntent,
  dispatchTimelineTextRunsAuthoringCommand,
  type TimelineTextRunsAuthoringServices,
  type TimelineTextRunsCore,
} from "./timeline-text-runs-authoring.js";
import { readTimelineTextRunsIntent, TIMELINE_TEXT_RUNS_COMMANDS, type TimelineTextRunsIntent } from "./timeline-text-runs.js";
import { dispatchTimelineStructuralCommand } from "./timeline-structural-dispatch.js";

const trustedCOW = process.platform === "win32" || typeof process.getuid === "function" ? it : it.skip;
const browserTextRunsHostProof = process.env.MOTION_BROWSER_TEXT_RUNS_HOST_FIXTURE === "1" ? trustedCOW : it.skip;

describe("timeline text-runs Debug authoring", () => {
  it("parses exactly inspect, replace, and content-preserving remove", () => {
    expect(readTimelineTextRunsIntent(TIMELINE_TEXT_RUNS_COMMANDS.inspect, { packageRoot: "/pkg", layerId: "title" })).toEqual({ ok: true, intent: { kind: "inspect", layerId: "title" } });
    expect(readTimelineTextRunsIntent(TIMELINE_TEXT_RUNS_COMMANDS.replace, common())).toEqual({ ok: true, intent: { kind: "replace", layerId: "title", textRuns: runs() } });
    expect(readTimelineTextRunsIntent(TIMELINE_TEXT_RUNS_COMMANDS.remove, { packageRoot: "/pkg", outDir: "/out", layerId: "title", expectedPlainText: "Hello world" })).toEqual({ ok: true, intent: { kind: "remove", layerId: "title", expectedPlainText: "Hello world" } });
    expect(readTimelineTextRunsIntent(TIMELINE_TEXT_RUNS_COMMANDS.replace, common({ accidental: true }))).toEqual({ ok: false, problem: "Unknown argument: accidental." });
    expect(readTimelineTextRunsIntent(TIMELINE_TEXT_RUNS_COMMANDS.replace, common({ textRuns: { schema: "shellx-motion/text-runs@1", runs: [{ text: "bad", fontAssetId: "brand", weight: 700 }] } }))).toEqual({ ok: false, problem: "textRuns.runs[0] does not support weight." });
    expect(Object.values(TIMELINE_TEXT_RUNS_COMMANDS).map((command) => debugCommandDefinition(command))).toEqual([
      expect.objectContaining({ permission: "read_motion", mutates: false }),
      expect.objectContaining({ permission: "edit_motion", mutates: true }),
      expect.objectContaining({ permission: "edit_motion", mutates: true }),
    ]);
  });

  it("refuses hostile data before loading and strips parser-only kind before Core", async () => {
    let loads = 0;
    const hostile = new Proxy(common(), { ownKeys: () => { throw new Error("no reflection"); } });
    const result = await dispatchTimelineTextRunsAuthoringCommand(TIMELINE_TEXT_RUNS_COMMANDS.replace, hostile, { packageLoader: async () => { loads += 1; throw new Error("must not load"); } });
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_args", message: "Arguments must be plain JSON data." } });
    expect(loads).toBe(0);
    const calls: unknown[] = [];
    const parsed = readTimelineTextRunsIntent(TIMELINE_TEXT_RUNS_COMMANDS.replace, common());
    if (!parsed || !parsed.ok || parsed.intent.kind !== "replace") throw new Error("expected replacement intent");
    applyTimelineTextRunsIntent(motion(), parsed.intent, { textRuns: recordingCore(calls) });
    expect(calls).toEqual([expect.not.objectContaining({ kind: expect.anything() })]);
  });

  it("bounds the replace envelope before a hostile Proxy can request descriptors", async () => {
    let descriptors = 0;
    let valueGets = 0;
    const hostile = new Proxy({}, {
      ownKeys: () => Array.from({ length: 10_000 }, (_, index) => `unexpected${index}`),
      getOwnPropertyDescriptor: () => { descriptors += 1; return undefined; },
      get: () => { valueGets += 1; return undefined; },
    });
    const parsed = readTimelineTextRunsIntent(TIMELINE_TEXT_RUNS_COMMANDS.replace, hostile);
    expect(parsed).toEqual({ ok: false, problem: "Arguments exceeds the 7-field command allowance." });
    expect({ descriptors, valueGets }).toEqual({ descriptors: 0, valueGets: 0 });
    let loads = 0;
    const result = await dispatchTimelineTextRunsAuthoringCommand(TIMELINE_TEXT_RUNS_COMMANDS.replace, hostile, { packageLoader: async () => { loads += 1; throw new Error("must not load"); } });
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    expect(loads).toBe(0);
  });

  it("refuses throwing reflection and accessor envelopes for inspect, replace, and remove without loading or reading values", async () => {
    for (const command of Object.values(TIMELINE_TEXT_RUNS_COMMANDS)) {
      for (const hostile of hostileEnvelopes(command)) {
        let loads = 0;
        const parsed = readTimelineTextRunsIntent(command, hostile.value);
        expect(parsed).toMatchObject({ ok: false });
        expect(hostile.mutations()).toBe(0);
        const result = await dispatchTimelineTextRunsAuthoringCommand(command, hostile.value, { packageLoader: async () => { loads += 1; throw new Error("must not load"); } });
        expect(result).toMatchObject({ ok: false, error: { code: "invalid_args" } });
        expect(loads).toBe(0);
        expect(hostile.mutations()).toBe(0);
      }
    }
  });

  it("shares the 32-run descriptor cap with Core before Debug can load a package", async () => {
    let elementDescriptors = 0, ownKeys = 0;
    const runs = new Proxy(Array.from({ length: 100_000 }, () => ({ text: "x", fontAssetId: "brand-regular" })), {
      ownKeys(target) { ownKeys += 1; return Reflect.ownKeys(target); },
      getOwnPropertyDescriptor(target, key) {
        if (typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key)) elementDescriptors += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      }
    });
    const parsed = readTimelineTextRunsIntent(TIMELINE_TEXT_RUNS_COMMANDS.replace, common({ textRuns: { schema: "shellx-motion/text-runs@1", runs } }));
    expect(parsed).toEqual({ ok: false, problem: "textRuns.runs must contain 1..32 non-empty runs." });
    expect({ elementDescriptors, ownKeys }).toEqual({ elementDescriptors: 0, ownKeys: 0 });
    let loads = 0;
    const result = await dispatchTimelineTextRunsAuthoringCommand(TIMELINE_TEXT_RUNS_COMMANDS.replace, common({ textRuns: { schema: "shellx-motion/text-runs@1", runs } }), { packageLoader: async () => { loads += 1; throw new Error("must not load"); } });
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    expect(loads).toBe(0);
  });

  it("keeps inspection receipt-free through production structural routing and admits typed create without field loss", async () => {
    const pkg = packageFor(fixtureRoot);
    const result = await dispatchTimelineStructuralCommand(TIMELINE_TEXT_RUNS_COMMANDS.inspect, { packageRoot: pkg.root, layerId: "title" }, {
      authoringInputRoots: [pkg.root], packageLoader: async () => pkg,
    });
    if (!result || !result.ok) throw new Error(result && !result.ok ? result.error.message : "expected inspection");
    expect(result).toMatchObject({ ok: true, result: { inspection: { plainText: "Hello world", fontAssetIds: ["brand-bold", "brand-regular"] } } });
    expect("receiptId" in result).toBe(false);
    expect(readTimelineLayerCreateArg({ layer: { id: "created", type: "text", startMs: 0, durationMs: 1000, textRuns: runs() } }, {})).toEqual({ ok: true, layer: expect.objectContaining({ textRuns: runs() }) });
    expect(readTimelineLayerCreateArg({ layer: { id: "bad", type: "text", startMs: 0, durationMs: 1000, text: "legacy", textRuns: runs() } }, {})).toEqual({ ok: false, problem: expect.stringContaining("mutually exclusive") });
  });

  it("keeps metadata one-to-one with the closed command vocabulary", () => {
    expect(Object.keys(TIMELINE_TEXT_RUNS_COMMAND_METADATA).sort()).toEqual(Object.values(TIMELINE_TEXT_RUNS_COMMANDS).sort());
    expect(TIMELINE_TEXT_RUNS_COMMAND_METADATA[TIMELINE_TEXT_RUNS_COMMANDS.inspect]).not.toHaveProperty("expectedReceipts");
  });

  trustedCOW("uses the production Debug route to COW, reopen, and receipt both styled-run replacement and removal", async () => {
    await inTrustedTextRunsWorkspace(async ({ root, source }) => {
      const sourceManifest = await readFile(join(source, "manifest.json"));
      const sourceMotion = await readFile(join(source, "motion.json"));
      const sourceRegularFont = await readFile(join(source, "assets", "fonts", "inter-latin-400-normal.woff2"));
      const sourceBoldFont = await readFile(join(source, "assets", "fonts", "inter-latin-700-normal.woff2"));
      const replaceOut = join(root, "replace");
      const removeOut = join(root, "remove");
      const receiptsRoot = join(root, "host-receipts");
      const context = productionContext(root, receiptsRoot);
      const replaced = await dispatchDebugCommand(TIMELINE_TEXT_RUNS_COMMANDS.replace, {
        packageRoot: source, outDir: replaceOut, layerId: "title", textRuns: interRuns(),
      }, context);
      if (!replaced.ok) throw new Error(replaced.error.message);

      const replaceReceipt = await readReceipt(replaceOut, "timeline-text-runs-replace.receipt.json");
      const replacedPackage = await loadMotionPackage(replaceOut);
      expect(replaceReceipt).toEqual((replaced.result as { receipt: unknown }).receipt);
      expect(replaceReceipt).toMatchObject({
        schema: "shellx-motion/receipt@1",
        operation: "timeline.layer.text-runs.replace",
        status: "passed",
        packageId: "pkg_editable_lower_third",
        lane: "debug-api",
        inputHashes: {
          "manifest.json": await hashPackageFile(join(source, "manifest.json")),
          "motion.json": await hashPackageFile(join(source, "motion.json")),
        },
        output: {
          packageDir: replaceOut,
          manifestPath: join(replaceOut, "manifest.json"),
          motionPath: join(replaceOut, "motion.json"),
          action: "replaced",
          layerId: "title",
          changedPaths: [
            "/layers/title/text",
            "/layers/title/textRuns",
            "/layers/title/style/fontFamily",
            "/layers/title/style/fontWeight",
          ],
          plainText: "Anna Valdez",
          fontAssetIds: ["font_inter_400", "font_inter_700"],
          textRuns: {
            action: "replaced",
            plainTextSha256: canonicalJsonSha256("Anna Valdez"),
            fontAssetIds: ["font_inter_400", "font_inter_700"],
          },
          outputMotionSha256: canonicalJsonSha256(replacedPackage.motion),
        },
        warnings: [],
      });
      expect(await readdir(join(replaceOut, "receipts"))).toEqual(["timeline-text-runs-replace.receipt.json"]);

      const replacedTitle = titleLayer(replacedPackage.motion);
      expect(replacedPackage.manifest.id).toBe("pkg_editable_lower_third");
      expect(replacedPackage.motion.id).toBe("motion_editable_lower_third");
      expect(await readFile(join(replaceOut, "manifest.json"))).toEqual(sourceManifest);
      expect(replacedTitle).toMatchObject({ id: "title", type: "text", textRuns: interRuns() });
      expect(replacedTitle).not.toHaveProperty("text");

      const removed = await dispatchDebugCommand(TIMELINE_TEXT_RUNS_COMMANDS.remove, {
        packageRoot: replaceOut, outDir: removeOut, layerId: "title", expectedPlainText: "Anna Valdez",
      }, context);
      if (!removed.ok) throw new Error(removed.error.message);

      const removeReceipt = await readReceipt(removeOut, "timeline-text-runs-remove.receipt.json");
      const removedPackage = await loadMotionPackage(removeOut);
      expect(removeReceipt).toEqual((removed.result as { receipt: unknown }).receipt);
      expect(removeReceipt).toMatchObject({
        schema: "shellx-motion/receipt@1",
        operation: "timeline.layer.text-runs.remove",
        status: "passed",
        packageId: "pkg_editable_lower_third",
        lane: "debug-api",
        inputHashes: {
          "manifest.json": await hashPackageFile(join(replaceOut, "manifest.json")),
          "motion.json": await hashPackageFile(join(replaceOut, "motion.json")),
        },
        output: {
          packageDir: removeOut,
          manifestPath: join(removeOut, "manifest.json"),
          motionPath: join(removeOut, "motion.json"),
          action: "removed",
          layerId: "title",
          changedPaths: ["/layers/title/textRuns", "/layers/title/text"],
          plainText: "Anna Valdez",
          fontAssetIds: ["font_inter_400", "font_inter_700"],
          textRuns: {
            action: "removed",
            previousFingerprint: (replaceReceipt.output as { textRuns: { fingerprint: string } }).textRuns.fingerprint,
            plainTextSha256: canonicalJsonSha256("Anna Valdez"),
            fontAssetIds: ["font_inter_400", "font_inter_700"],
          },
          outputMotionSha256: canonicalJsonSha256(removedPackage.motion),
        },
        warnings: [],
      });
      expect((removeReceipt.output as { textRuns: Record<string, unknown> }).textRuns).not.toHaveProperty("fingerprint");
      expect((await readdir(join(removeOut, "receipts"))).sort()).toEqual(["timeline-text-runs-remove.receipt.json", "timeline-text-runs-replace.receipt.json"]);

      const removedTitle = titleLayer(removedPackage.motion);
      expect(removedPackage.manifest.id).toBe("pkg_editable_lower_third");
      expect(removedPackage.motion.id).toBe("motion_editable_lower_third");
      expect(await readFile(join(removeOut, "manifest.json"))).toEqual(sourceManifest);
      expect(removedTitle).toMatchObject({ id: "title", type: "text", text: "Anna Valdez" });
      expect(removedTitle).not.toHaveProperty("textRuns");

      expect(await readFile(join(source, "manifest.json"))).toEqual(sourceManifest);
      expect(await readFile(join(source, "motion.json"))).toEqual(sourceMotion);
      expect(await readFile(join(source, "assets", "fonts", "inter-latin-400-normal.woff2"))).toEqual(sourceRegularFont);
      expect(await readFile(join(source, "assets", "fonts", "inter-latin-700-normal.woff2"))).toEqual(sourceBoldFont);
    });
  });

  browserTextRunsHostProof("renders a COW styled-run package with real manifest fonts, changed pixels, and Chromium attestation", async () => {
    await inTrustedTextRunsWorkspace(async ({ root, source }) => {
      const replaceOut = join(root, "replace");
      const receiptsRoot = join(root, "host-receipts");
      const frameOut = join(root, "frames");
      const replaced = await dispatchDebugCommand(TIMELINE_TEXT_RUNS_COMMANDS.replace, {
        packageRoot: source, outDir: replaceOut, layerId: "title", textRuns: interRuns(),
      }, productionContext(root, receiptsRoot));
      if (!replaced.ok) throw new Error(replaced.error.message);

      const original = await renderMotionBrowserFrame(await loadMotionPackage(source), {
        atMs: 1_000, outDir: frameOut, outputPath: join(frameOut, "plain.png"),
      });
      const styled = await renderMotionBrowserFrame(await loadMotionPackage(replaceOut), {
        atMs: 1_000, outDir: frameOut, outputPath: join(frameOut, "styled.png"),
      });
      const styledPng = await readFile(styled.output.path);
      const quality = inspectPngBuffer(styledPng);
      const difference = comparePngBuffers(styledPng, await readFile(original.output.path));

      expect(quality).toMatchObject({ ok: true, blank: false });
      expect(difference).toMatchObject({ ok: true });
      if (!difference.ok) throw new Error("expected comparable styled and plain Browser frames");
      expect(difference.changedPixels).toBeGreaterThan(0);
      expect(styled.receipt).toMatchObject({
        operation: "preview.frame",
        status: "passed",
        packageId: "pkg_editable_lower_third",
        lane: "browser",
        inputHashes: {
          "assets/fonts/inter-latin-400-normal.woff2": expect.stringMatching(/^[a-f0-9]{64}$/),
          "assets/fonts/inter-latin-700-normal.woff2": expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        output: {
          typography: {
            authority: "chromium",
            attestation: "verified",
            scopes: [expect.objectContaining({ kind: "motion-ir", attestation: "verified", layerIds: expect.arrayContaining(["title"]) })],
            runs: [
              expect.objectContaining({ layerId: "title", index: 0, fontAssetId: "font_inter_400", family: "Inter", weight: 400, style: "normal", primaryFontAvailable: true, fontProvenance: "manifest-bound" }),
              expect.objectContaining({ layerId: "title", index: 1, fontAssetId: "font_inter_700", family: "Inter", weight: 700, style: "normal", primaryFontAvailable: true, fontProvenance: "manifest-bound" }),
            ],
            fontAssets: [
              { id: "font_inter_400", family: "Inter", sha256: styled.receipt.inputHashes["assets/fonts/inter-latin-400-normal.woff2"] },
              { id: "font_inter_700", family: "Inter", sha256: styled.receipt.inputHashes["assets/fonts/inter-latin-700-normal.woff2"] },
            ],
          },
        },
        warnings: [],
      });
    });
  });

  it.skipIf(process.platform === "win32")("refuses an actually group-writable parent before styled text output and preserves the source", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-m26011-text-runs-cow-evidence-"));
    try {
      const anchor = await createTrustedWorkspaceAnchor(root);
      const source = await writeTextPackage(join(root, "source"));
      const before = await readFile(join(source, "motion.json"), "utf8");
      const outputRoot = join(root, "output-root");
      const unsafeParent = join(outputRoot, "group-writable");
      const outDir = join(unsafeParent, "output");
      await mkdir(outputRoot, { mode: 0o700 });
      await mkdir(unsafeParent, { mode: 0o700 });
      await chmod(unsafeParent, 0o777);
      const result = await withTrustedWorkspaceAnchor(anchor, async () => await dispatchTimelineTextRunsAuthoringCommand(TIMELINE_TEXT_RUNS_COMMANDS.replace, {
        packageRoot: source, outDir, layerId: "title", textRuns: runs(),
      }, {
        authoringInputRoots: [root], authoringOutputRoots: [outputRoot], packageLoader: loadMotionPackage,
        isUnsafePackageOutputDirectory: async () => false,
        isEmptyOrAbsentDirectory: async (path) => (await readDirectoryOrAbsent(path)).length === 0,
      }));
      expect(result).toMatchObject({ ok: false, error: { code: "timeline_text_runs_failed", message: expect.stringMatching(/group- or world-writable/i) } });
      expect(existsSync(outDir)).toBe(false);
      expect(await readFile(join(source, "motion.json"), "utf8")).toBe(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function common(values: Record<string, unknown> = {}): Record<string, unknown> { return { packageRoot: "/pkg", outDir: "/out", layerId: "title", textRuns: runs(), ...values }; }
function runs() { return { schema: "shellx-motion/text-runs@1" as const, runs: [{ text: "Hello ", fontAssetId: "brand-regular", color: "#ffffff" }, { text: "world", fontAssetId: "brand-bold", fontSizePx: 28, letterSpacingPx: 1 }] }; }
function hostileEnvelopes(command: typeof TIMELINE_TEXT_RUNS_COMMANDS[keyof typeof TIMELINE_TEXT_RUNS_COMMANDS]): Array<{ value: unknown; mutations: () => number }> {
  const values = command === TIMELINE_TEXT_RUNS_COMMANDS.inspect
    ? { packageRoot: "/pkg", layerId: "title" }
    : command === TIMELINE_TEXT_RUNS_COMMANDS.replace
      ? common()
      : { packageRoot: "/pkg", outDir: "/out", layerId: "title", expectedPlainText: "Hello world" };
  const accessorKey = command === TIMELINE_TEXT_RUNS_COMMANDS.replace ? "textRuns" : command === TIMELINE_TEXT_RUNS_COMMANDS.remove ? "expectedPlainText" : "layerId";
  let accessorMutations = 0;
  const accessor = { ...values } as Record<string, unknown>;
  delete accessor[accessorKey];
  Object.defineProperty(accessor, accessorKey, {
    enumerable: true,
    get() { accessorMutations += 1; Object.defineProperty(accessor, "observed", { value: true, enumerable: true }); return "must not be read"; },
  });
  const descriptor = new Proxy(values, { getOwnPropertyDescriptor: () => { throw new Error("descriptor trap"); } });
  const ownKeys = new Proxy(values, { ownKeys: () => { throw new Error("ownKeys trap"); } });
  const prototype = new Proxy(values, { getPrototypeOf: () => { throw new Error("prototype trap"); } });
  return [
    { value: ownKeys, mutations: () => 0 },
    { value: prototype, mutations: () => 0 },
    { value: descriptor, mutations: () => 0 },
    { value: Object.freeze(accessor), mutations: () => accessorMutations },
  ];
}
function motion(): MotionDocument { return { schema: "shellx-motion/motion@1", id: "text-runs", name: "Text runs", durationMs: 1000, fps: 30, width: 100, height: 100, layers: [{ id: "title", type: "text", startMs: 0, durationMs: 1000, textRuns: runs() }], assets: [{ id: "brand-regular", type: "font", family: "Brand Regular", source: { path: "assets/regular.woff2", mimeType: "font/woff2" } }, { id: "brand-bold", type: "font", family: "Brand Bold", source: { path: "assets/bold.woff2", mimeType: "font/woff2" }, weight: 700 }], provenance: { sourceApp: "test", createdBy: "test" } } as MotionDocument; }
const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../fixtures/packages/gpu-g9-particle-cathedral");
const textRunsPackageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../fixtures/packages/editable-lower-third");
function packageFor(root = "/pkg"): MotionPackage { return { root, manifest: { schema: "shellx-motion/package-manifest@1", id: "pkg_text_runs", name: "Text runs", motion: "motion.json", assets: ["assets/regular.woff2", "assets/bold.woff2"], sourceApp: "test", compatibility: { lanes: ["browser"], hosts: ["motion"] } }, motion: motion() }; }
function recordingCore(calls: unknown[]): TimelineTextRunsCore { const result = { motion: motion(), layerId: "title", layer: motion().layers[0]!, action: "replaced" as const, changedPaths: ["/layers/title/textRuns"], previousFingerprint: "before", fingerprint: "after", plainText: "Hello world", fontAssetIds: ["brand-bold", "brand-regular"], outputMotionSha256: "a".repeat(64) }; return { inspectMotionTextRuns: () => ({ layerId: "title", textRuns: runs(), plainText: "Hello world", fingerprint: "x", fontAssetIds: ["brand-bold", "brand-regular"] }), replaceMotionTextRuns: (_motion, input) => { calls.push(input); return result; }, removeMotionTextRuns: (_motion, input) => { calls.push(input); return { ...result, action: "removed" as const, fingerprint: null }; } }; }
async function writeTextPackage(root: string): Promise<string> {
  await mkdir(root, { mode: 0o700 });
  await writeFile(join(root, "manifest.json"), `${JSON.stringify({ schema: "shellx-motion/package-manifest@1", id: "pkg_text_runs_cow", name: "Text runs COW", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["browser"], hosts: ["motion"] } }, null, 2)}\n`);
  await writeFile(join(root, "motion.json"), `${JSON.stringify(plainMotion(), null, 2)}\n`);
  return root;
}
function plainMotion(): MotionDocument { const document = motion(); const layer = document.layers[0]!; delete layer.textRuns; layer.text = "Hello world"; return document; }
async function readDirectoryOrAbsent(path: string): Promise<string[]> {
  try { return await readdir(path); }
  catch (error) { if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return []; throw error; }
}
function interRuns() {
  return {
    schema: "shellx-motion/text-runs@1" as const,
    runs: [
      { text: "Anna ", fontAssetId: "font_inter_400", color: "#ff3344", fontSizePx: 58 },
      { text: "Valdez", fontAssetId: "font_inter_700", color: "#3cff7a", fontSizePx: 58, letterSpacingPx: 1 },
    ],
  };
}
function productionContext(root: string, receiptsRoot: string) {
  return {
    tier: "edit_motion" as const,
    authoringInputRoots: [root],
    authoringOutputRoots: [root],
    receiptsRoot,
  };
}
function titleLayer(motion: MotionDocument): MotionDocument["layers"][number] {
  const layer = motion.layers.find((candidate) => candidate.id === "title");
  if (!layer) throw new Error("expected title layer");
  return layer;
}
async function readReceipt(packageRoot: string, name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(packageRoot, "receipts", name), "utf8")) as Record<string, unknown>;
}
async function inTrustedTextRunsWorkspace<T>(operation: (workspace: { root: string; source: string }) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-m26011-text-runs-workspace-"));
  try {
    const source = join(root, "source");
    await cp(textRunsPackageRoot, source, { recursive: true });
    const run = async () => await operation({ root, source });
    if (process.platform === "win32" || typeof process.getuid !== "function") return await run();
    return await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(root), run);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
