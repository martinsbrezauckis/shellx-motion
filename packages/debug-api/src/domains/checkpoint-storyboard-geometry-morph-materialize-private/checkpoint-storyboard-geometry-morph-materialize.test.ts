import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { canonicalJson, canonicalJsonSha256, loadMotionPackage } from "@shellx-motion/core";
import { compileCheckpointStoryboardGeometryMorphProfilePlan } from "@shellx-motion/core/internal/checkpoint-storyboard-geometry-morph-profile";
import { createCheckpointStoryboard, createTransitionRecipe } from "@shellx-motion/core/internal/checkpoint-storyboard-lifecycle-profile";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { snapshotPackageEditTree } from "../package-edit-tree-snapshot.js";
import { c6B6bCurrentInventory, c6B6bNonReceiptInventory } from "./checkpoint-storyboard-geometry-morph-materialize-facts-private.js";
import { C6B6B_RECEIPT_PATH } from "./checkpoint-storyboard-geometry-morph-materialize-receipt-private.js";
import {
  materializeCheckpointStoryboardGeometryMorph,
  prepareCheckpointStoryboardGeometryMorphMaterialization,
  reopenCheckpointStoryboardGeometryMorphMaterializationOutput,
} from "./checkpoint-storyboard-geometry-morph-materialize-private.js";

const TEST_PARENT = join(process.cwd(), `.c6b6b-geometry-morph-materialize-test-${process.pid}`);
const itLinux = process.platform === "linux" ? it : it.skip;
const fault = vi.hoisted(() => ({ output: "", renamed: false, postInstall: false, precommitSource: "" }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const path = await import("node:path");
  return {
    ...actual,
    rename: (async (...args: unknown[]) => {
      const result = await (actual.rename as (...inner: unknown[]) => Promise<void>)(...args);
      if (fault.postInstall && typeof args[0] === "string" && typeof args[1] === "string" && path.basename(args[0]) === "package" && path.resolve(args[1]) === fault.output) fault.renamed = true;
      return result;
    }) as typeof actual.rename,
    open: (async (...args: unknown[]) => {
      if (fault.postInstall && fault.renamed && typeof args[0] === "string" && path.resolve(args[0]) === path.join(fault.output, "manifest.json")) {
        fault.postInstall = false; fault.renamed = false;
        throw Object.assign(new Error("test-only installed reopen failure"), { code: "EIO" });
      }
      return await (actual.open as (...inner: unknown[]) => Promise<any>)(...args);
    }) as typeof actual.open,
    writeFile: (async (...args: unknown[]) => {
      const pathName = typeof args[0] === "string" ? path.resolve(args[0]) : "";
      if (fault.precommitSource && path.basename(pathName) === "motion.json" && pathName !== fault.precommitSource) {
        const source = JSON.parse(await actual.readFile(fault.precommitSource, "utf8"));
        source.name = "source drifted during COW";
        await actual.writeFile(fault.precommitSource, `${JSON.stringify(source, null, 2)}\n`, "utf8");
        fault.precommitSource = "";
      }
      return await (actual.writeFile as (...inner: unknown[]) => Promise<void>)(...args);
    }) as typeof actual.writeFile,
  };
});

const VIEW_BOX = { x: -100, y: -100, width: 400, height: 400 };
const START = polygon([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }]);
const END = polygon([{ x: 20, y: 20 }, { x: 120, y: 20 }, { x: 20, y: 120 }]);

function polygon(points: readonly { readonly x: number; readonly y: number }[]) {
  return { schema: "shellx-motion/shape-geometry@1" as const, kind: "polygon" as const, viewBox: { ...VIEW_BOX }, points: points.map((point) => ({ ...point })) };
}

function storyboard() {
  const recipe = createTransitionRecipe({ recipeId: "triangle-morph", seed: 2, exactBaseRequirements: [], intent: { kind: "checkpoint-geometry-morph", targets: [{ objectId: "triangle", easing: "linear" }] } });
  return createCheckpointStoryboard({
    seed: 1, capabilityRequirements: ["renderer.gpu"], objectCatalog: [{ objectId: "triangle", rootShapeKind: "geometry", propertyMask: [] }], recipes: [recipe],
    checkpoints: [
      { id: "start", atUs: 0, objects: [{ objectId: "triangle", state: "present", properties: [], geometry: START }] },
      { id: "finish", atUs: 1_000_000, objects: [{ objectId: "triangle", state: "present", properties: [], geometry: END }] },
    ],
    edges: [{ id: "start-finish", fromCheckpointId: "start", toCheckpointId: "finish", lifecycle: [{ kind: "preserve", objectId: "triangle" }], recipeIds: ["triangle-morph"] }],
  });
}

async function fixture({ receipts = "prior" }: { readonly receipts?: "prior" | "empty" } = {}) {
  await mkdir(TEST_PARENT, { recursive: true });
  const root = await mkdtemp(join(TEST_PARENT, "run-")), workspace = join(root, "workspace"), source = join(workspace, "source"), output = join(workspace, "out");
  await mkdir(join(source, "assets", "nested"), { recursive: true });
  await mkdir(join(source, "assets", "empty"), { recursive: true });
  await mkdir(receipts === "prior" ? join(source, "receipts", "empty") : join(source, "receipts"), { recursive: true });
  await writeJson(join(source, "manifest.json"), { schema: "shellx-motion/package-manifest@1", id: "package-1", name: "C6B6b triangle", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["gpu"], hosts: [] } });
  await writeJson(join(source, "motion.json"), {
    schema: "shellx-motion/motion@1", id: "motion-1", name: "C6B6b triangle", durationMs: 1_000, fps: 30, width: 1280, height: 720,
    layers: [{ id: "triangle", type: "shape", fill: "#4e8cff", startMs: 0, durationMs: 1_000, geometry: START }], assets: [], provenance: { sourceApp: "test", createdBy: "test" },
  });
  await writeFile(join(source, "assets", "nested", "leaf.txt"), "preserve me\n", "utf8");
  if (receipts === "prior") await writeFile(join(source, "receipts", "prior.json"), "{\"prior\":true}\n", "utf8");
  const authority = await createTrustedWorkspaceAnchor(workspace), host = { sourcePackageRoot: source, outputPackageRoot: output, packageWorkspaceRoot: workspace, packageWorkspaceAuthority: authority };
  const sealed = storyboard(), prepared = await prepareCheckpointStoryboardGeometryMorphMaterialization(host, sealed);
  return { root, workspace, source, output, authority, host, storyboard: sealed, prepared, request: { schema: "shellx-motion/private-checkpoint-storyboard-geometry-morph-materialization-request@1", expected: prepared.expected } };
}

function invoke(value: Awaited<ReturnType<typeof fixture>>, request: unknown = value.request) {
  return materializeCheckpointStoryboardGeometryMorph(value.host, value.prepared.approval, request);
}
function outputHost(value: Awaited<ReturnType<typeof fixture>>) {
  return { outputPackageRoot: value.output, packageWorkspaceRoot: value.workspace, packageWorkspaceAuthority: value.authority };
}

describe("private C6B6b geometry-morph exact-base COW materializer", () => {
  itLinux("installs one exact two-snapshot geometryKeyframes leaf, preserves source/leaves/empty directories, and reopens without source", async () => {
    const value = await fixture();
    try {
      const before = await snapshotPackageEditTree(value.source), result = await invoke(value), after = await snapshotPackageEditTree(value.source);
      const [source, output] = await withTrustedWorkspaceAnchor(value.authority, async () => await Promise.all([loadMotionPackage(value.source), loadMotionPackage(value.output)]));
      expect(Object.hasOwn(source.motion.layers[0] as object, "geometryKeyframes")).toBe(false);
      const sourceLayer = output.motion.layers[0] as { readonly geometry: unknown; readonly geometryKeyframes?: unknown };
      const plan = value.prepared.plan as { readonly projection: { readonly geometryKeyframes: unknown } };
      expect(after.entries).toEqual(before.entries);
      expect(sourceLayer.geometry).toEqual(START); expect(Object.hasOwn(sourceLayer, "geometryKeyframes")).toBe(true); expect(sourceLayer.geometryKeyframes).toEqual(plan.projection.geometryKeyframes);
      expect([...((await snapshotPackageEditTree(value.output)).entries).keys()].filter((path) => !before.entries.has(path))).toEqual([C6B6B_RECEIPT_PATH]);
      expect((await snapshotPackageEditTree(value.output)).entries.get("assets/empty")).toBe("dir");
      expect(result.receipt.output.changed).toEqual({ paths: ["motion.json", C6B6B_RECEIPT_PATH], count: 2, motionPropertyPaths: ["/layers/0/geometryKeyframes"], motionPropertyPathCount: 1 });
      expect(result.receipt.renderer).toEqual({ invoked: false, pixels: false });
      const reopened = await reopenCheckpointStoryboardGeometryMorphMaterializationOutput(outputHost(value));
      expect(reopened).toMatchObject({ geometry: { layerId: "triangle", layerIndex: 0, staticGeometrySha256: canonicalJsonSha256(START) }, materialization: { changedMotionRoot: "layers", changedLeafCount: 2, renderer: { invoked: false, pixels: false } } });
      expect(JSON.stringify(reopened)).not.toContain(value.source); expect(JSON.stringify(reopened)).not.toContain(value.output);
      await rm(value.source, { recursive: true, force: true });
      await expect(reopenCheckpointStoryboardGeometryMorphMaterializationOutput(outputHost(value))).resolves.toMatchObject({ geometry: { layerId: "triangle" } });
    } finally { await dispose(value.root); }
  });

  itLinux("replays deterministically to distinct outputs and never mutates either source", async () => {
    const first = await fixture(), replay = await fixture();
    try {
      const [firstBefore, replayBefore] = await Promise.all([snapshotPackageEditTree(first.source), snapshotPackageEditTree(replay.source)]);
      const [one, two] = await Promise.all([invoke(first), invoke(replay)]);
      expect(two.receipt).toEqual(one.receipt); expect(two.receipt.fingerprint).toBe(one.receipt.fingerprint);
      expect((await snapshotPackageEditTree(first.source)).entries).toEqual(firstBefore.entries);
      expect((await snapshotPackageEditTree(replay.source)).entries).toEqual(replayBefore.entries);
      expect(await readFile(join(first.output, "motion.json"), "utf8")).toEqual(await readFile(join(replay.output, "motion.json"), "utf8"));
    } finally { await dispose(first.root, replay.root); }
  });

  itLinux("materializes and reopens when receipts starts empty, restoring that empty marker in non-receipt inventory", async () => {
    const value = await fixture({ receipts: "empty" });
    try {
      const before = await snapshotPackageEditTree(value.source), result = await invoke(value), after = await snapshotPackageEditTree(value.output);
      expect(before.entries.get("receipts")).toBe("dir");
      expect([...before.entries.keys()].filter((path) => path.startsWith("receipts/"))).toEqual([]);
      expect(after.entries.get("receipts")).toBe("dir");
      expect([...after.entries.keys()].filter((path) => path.startsWith("receipts/"))).toEqual([C6B6B_RECEIPT_PATH]);
      const withoutReceipt = { ...after, entries: new Map(after.entries) };
      withoutReceipt.entries.delete(C6B6B_RECEIPT_PATH);
      expect(c6B6bCurrentInventory(withoutReceipt)).toEqual(c6B6bNonReceiptInventory(after));
      expect(result.receipt.output.nonReceiptInventory).toEqual(c6B6bNonReceiptInventory(after));
      await expect(reopenCheckpointStoryboardGeometryMorphMaterializationOutput(outputHost(value))).resolves.toMatchObject({ geometry: { layerId: "triangle" } });
    } finally { await dispose(value.root); }
  });

  itLinux("requires host-minted approval and an exact expected echo, and refuses prepare/stage/precommit source drift", async () => {
    const forged = await fixture(), expected = await fixture(), staged = await fixture(), precommit = await fixture(), receipt = await fixture();
    try {
      await expect(materializeCheckpointStoryboardGeometryMorph(forged.host, Object.freeze({}) as never, forged.request)).rejects.toThrow(/host-minted|approval/i);
      await expect(invoke(expected, { ...expected.request, expected: { ...expected.request.expected, planFingerprint: "a".repeat(64) } })).rejects.toThrow(/exact base|projection|changed/i);
      const changed = JSON.parse(await readFile(join(staged.source, "motion.json"), "utf8")); changed.layers[0].geometry.points[0].x = 1; await writeJson(join(staged.source, "motion.json"), changed);
      await expect(invoke(staged)).rejects.toThrow(/source|rederive|exact/i);
      fault.precommitSource = resolve(join(precommit.source, "motion.json"));
      await expect(invoke(precommit)).rejects.toThrow(/source|exact/i);
      await expect(lstat(precommit.output)).rejects.toMatchObject({ code: "ENOENT" });
      await writeFile(join(receipt.source, C6B6B_RECEIPT_PATH), "{}\n", "utf8");
      await expect(invoke(receipt)).rejects.toThrow(/receipt|inventory/i);
    } finally { fault.precommitSource = ""; await dispose(forged.root, expected.root, staged.root, precommit.root, receipt.root); }
  });

  itLinux("distinguishes absent source geometryKeyframes from every own-property form and rejects hostile path authority", async () => {
    const value = await fixture(), nullValue = await fixture(), malformed = await fixture(), sourceAlias = await fixture(), outputAlias = await fixture(), overlap = await fixture(), occupied = await fixture();
    try {
      const pkg = await withTrustedWorkspaceAnchor(value.authority, async () => await loadMotionPackage(value.source));
      const request = (motion: Record<string, unknown>) => ({ schema: "shellx-motion/private-checkpoint-storyboard-geometry-morph-profile-request@1", storyboard: value.storyboard, base: { packageId: "package-1", manifest: pkg.manifest, motion, persistedMotionSha256: "a".repeat(64) }, objectLayerBindings: [{ objectId: "triangle", layerId: "triangle" }] });
      const absent = structuredClone(pkg.motion) as unknown as Record<string, unknown>; expect(compileCheckpointStoryboardGeometryMorphProfilePlan(request(absent))).toBeTruthy();
      for (const geometryKeyframes of [null, undefined, { schema: "wrong", keyframes: [] }]) {
        const candidate = structuredClone(pkg.motion) as unknown as { layers: Array<Record<string, unknown>> };
        Object.defineProperty(candidate.layers[0]!, "geometryKeyframes", { value: geometryKeyframes, enumerable: true, configurable: true, writable: true });
        expect(() => compileCheckpointStoryboardGeometryMorphProfilePlan(request(candidate as unknown as Record<string, unknown>))).toThrow();
      }
      const nullMotion = JSON.parse(await readFile(join(nullValue.source, "motion.json"), "utf8")); nullMotion.layers[0].geometryKeyframes = null; await writeJson(join(nullValue.source, "motion.json"), nullMotion);
      const malformedMotion = JSON.parse(await readFile(join(malformed.source, "motion.json"), "utf8")); malformedMotion.layers[0].geometryKeyframes = { schema: "wrong", keyframes: [] }; await writeJson(join(malformed.source, "motion.json"), malformedMotion);
      await expect(prepareCheckpointStoryboardGeometryMorphMaterialization(nullValue.host, nullValue.storyboard)).rejects.toThrow(/geometry|authority|source/i);
      await expect(prepareCheckpointStoryboardGeometryMorphMaterialization(malformed.host, malformed.storyboard)).rejects.toThrow(/geometry|authority|source/i);
      await symlink(sourceAlias.workspace, join(sourceAlias.workspace, "alias"));
      await expect(prepareCheckpointStoryboardGeometryMorphMaterialization({ ...sourceAlias.host, sourcePackageRoot: join(sourceAlias.workspace, "alias", "source") }, sourceAlias.storyboard)).rejects.toMatchObject({ code: "unsafe_output" });
      await mkdir(join(outputAlias.root, "outside")); await symlink(join(outputAlias.root, "outside"), join(outputAlias.workspace, "alias"));
      await expect(materializeCheckpointStoryboardGeometryMorph({ ...outputAlias.host, outputPackageRoot: join(outputAlias.workspace, "alias", "out") }, outputAlias.prepared.approval, outputAlias.request)).rejects.toMatchObject({ code: "unsafe_output" });
      await expect(materializeCheckpointStoryboardGeometryMorph({ ...overlap.host, outputPackageRoot: join(overlap.source, "nested-output") }, overlap.prepared.approval, overlap.request)).rejects.toMatchObject({ code: "unsafe_output" });
      await mkdir(occupied.output); await expect(invoke(occupied)).rejects.toThrow(/absent|output/i);
    } finally { await dispose(value.root, nullValue.root, malformed.root, sourceAlias.root, outputAlias.root, overlap.root, occupied.root); }
  });

  itLinux("retains an installed output when the post-rename reopen is uncertain", async () => {
    const value = await fixture();
    try {
      fault.output = resolve(value.output); fault.postInstall = true; fault.renamed = false;
      const error = await invoke(value).catch((reason: unknown) => reason as { readonly code?: unknown; readonly evidence?: unknown });
      expect(error).toMatchObject({ code: "publication_commit_uncertain", evidence: { publicPath: value.output, kind: "directory" } });
      expect((await lstat(value.output)).isDirectory()).toBe(true);
      await expect(reopenCheckpointStoryboardGeometryMorphMaterializationOutput(outputHost(value))).resolves.toMatchObject({ geometry: { layerId: "triangle" } });
    } finally { fault.output = ""; fault.postInstall = false; fault.renamed = false; await dispose(value.root); }
  });

  itLinux("makes output-only reopen reject static geometry, keyframe sequence/order/easing, other Motion, receipt, leaves, empty directories, and symlinks", async () => {
    const staticGeometry = await fixture(), sequence = await fixture(), easing = await fixture(), otherMotion = await fixture(), receipt = await fixture(), extra = await fixture(), missing = await fixture(), empty = await fixture(), linked = await fixture();
    try {
      await Promise.all([invoke(staticGeometry), invoke(sequence), invoke(easing), invoke(otherMotion), invoke(receipt), invoke(extra), invoke(missing), invoke(empty), invoke(linked)]);
      const staticDocument = JSON.parse(await readFile(join(staticGeometry.output, "motion.json"), "utf8")); staticDocument.layers[0].geometry.points[0].x = 1; await writeJson(join(staticGeometry.output, "motion.json"), staticDocument);
      const sequenceDocument = JSON.parse(await readFile(join(sequence.output, "motion.json"), "utf8")); sequenceDocument.layers[0].geometryKeyframes.keyframes.reverse(); await writeJson(join(sequence.output, "motion.json"), sequenceDocument);
      const easingDocument = JSON.parse(await readFile(join(easing.output, "motion.json"), "utf8")); easingDocument.layers[0].geometryKeyframes.keyframes[0].easing = "ease-in"; await writeJson(join(easing.output, "motion.json"), easingDocument);
      const otherDocument = JSON.parse(await readFile(join(otherMotion.output, "motion.json"), "utf8")); otherDocument.layers[0].fill = "#ffffff"; await writeJson(join(otherMotion.output, "motion.json"), otherDocument);
      const parsedReceipt = JSON.parse(await readFile(join(receipt.output, C6B6B_RECEIPT_PATH), "utf8")); parsedReceipt.fingerprint = "0".repeat(64); await writeFile(join(receipt.output, C6B6B_RECEIPT_PATH), `${canonicalJson(parsedReceipt)}\n`, "utf8");
      await writeFile(join(extra.output, "extra.txt"), "unexpected\n", "utf8");
      await rm(join(missing.output, "assets", "nested", "leaf.txt"));
      await rm(join(empty.output, "assets", "empty"), { recursive: true });
      await rm(join(linked.output, "assets", "nested", "leaf.txt")); await symlink(join(linked.output, "motion.json"), join(linked.output, "assets", "nested", "leaf.txt"));
      for (const value of [staticGeometry, sequence, easing, otherMotion, receipt, extra, missing, empty, linked]) await expect(reopenCheckpointStoryboardGeometryMorphMaterializationOutput(outputHost(value))).rejects.toThrow(/C6B6b|geometry|receipt|inventory|symbolic/i);
    } finally { await dispose(staticGeometry.root, sequence.root, easing.root, otherMotion.root, receipt.root, extra.root, missing.root, empty.root, linked.root); }
  });

  it("keeps the private materializer unreachable from caller specifiers and public routes while using one Core internal handoff", async () => {
    const files = ["../../index.ts", "../../command-registry.ts", "../../command-metadata.ts", "../../../package.json", "../../../../core/src/index.ts", "../../../../core/package.json", "../../../../cli/src/main.ts", "../../../../sdk/src/index.ts", "../../../../actions/src/catalog.ts", "../../../../connectors/src/index.ts", "../../../../renderer-browser/src/index.ts", "../../../../renderer-native/src/index.ts"];
    const contents = await Promise.all(files.map(async (file) => await readFile(new URL(file, import.meta.url), "utf8")));
    expect(contents.filter((_text, index) => index !== 5).every((text) => !text.includes("checkpoint-storyboard.geometry-morph.materialize") && !text.includes("checkpoint-storyboard-geometry-morph-materialize"))).toBe(true);
    const corePackage = JSON.parse(contents[5]!) as { exports: Record<string, unknown>; publishConfig: { exports: Record<string, unknown> } };
    expect(corePackage.exports["./internal/checkpoint-storyboard-geometry-morph-profile"]).toBe("./src/internal/checkpoint-storyboard/checkpoint-storyboard-geometry-morph-materializer.ts");
    expect(corePackage.publishConfig.exports["./internal/checkpoint-storyboard-geometry-morph-profile"]).toEqual({
      types: "./dist/internal/checkpoint-storyboard/checkpoint-storyboard-geometry-morph-materializer.d.ts",
      default: "./dist/internal/checkpoint-storyboard/checkpoint-storyboard-geometry-morph-materializer.js",
    });
    const [writer, output] = await Promise.all([
      readFile(new URL("./checkpoint-storyboard-geometry-morph-materialize-private.ts", import.meta.url), "utf8"),
      readFile(new URL("./checkpoint-storyboard-geometry-morph-materialize-output-private.ts", import.meta.url), "utf8"),
    ]);
    expect(writer).toContain("@shellx-motion/core/internal/checkpoint-storyboard-geometry-morph-profile");
    expect(output).toContain("@shellx-motion/core/internal/checkpoint-storyboard-geometry-morph-profile");
    expect(`${writer}\n${output}`).not.toMatch(/vite-ignore|core\/src\/unadopted|import\s*\(/);
    expect(`${writer}\n${output}`).not.toMatch(/(?:module|import|compiler)(?:Path|Specifier|Url)\s*[:=]\s*(?:request|value|input|receipt)/i);
  });
});

async function dispose(...roots: readonly string[]): Promise<void> {
  await Promise.all(roots.map(async (root) => await rm(root, { recursive: true, force: true }))); await rm(TEST_PARENT, { recursive: true, force: true });
}
async function writeJson(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8"); }
