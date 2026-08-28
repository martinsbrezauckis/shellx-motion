import { loadMotionPackage } from "@shellx-motion/core";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withTestAuthoringRoots } from "../authoring-test-context.test-support.js";
import { dispatchCompositingGraphAuthoringCommand } from "./authoring-compositing-graph.js";

const roots: string[] = [];

describe("compositing graph authoring commands", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("sets, inspects, recompiles, and removes a graph through atomic package copies", async () => {
    const root = await fixtureRoot();
    const sourceRoot = join(root, "source");
    const compiledRoot = join(root, "compiled");
    const recompiledRoot = join(root, "recompiled");
    const restoredRoot = join(root, "restored");
    await writePackage(sourceRoot);
    const sourceText = await readFile(join(sourceRoot, "motion.json"), "utf8");
    const graph = unaryGraph(12);
    const services = authoringServices(root);

    const set = await dispatchCompositingGraphAuthoringCommand(
      "motion.compositing.graph.set",
      { packageRoot: sourceRoot, outDir: compiledRoot, graph },
      services,
    );
    expect(set).toMatchObject({
      ok: true,
      result: {
        state: {
          compiled: true,
          fingerprint: expect.stringMatching(/^[a-f0-9]{16}$/),
          validation: { ok: true },
          metadata: { graphId: "hero", outputLayerIds: ["cg.hero.blur"] },
        },
      },
      visibleState: { panel: "compositingGraph", operation: "compositing.graph.set" },
    });
    expect(await readFile(join(sourceRoot, "motion.json"), "utf8")).toBe(sourceText);
    const compiled = await loadMotionPackage(compiledRoot);
    expect(compiled.motion.layers).toHaveLength(2);
    expect(compiled.motion.layers[0]).toMatchObject({ id: "plate", visible: false });
    expect(compiled.motion.layers[1]).toMatchObject({ id: "cg.hero.blur", effects: { blur: 12 } });

    const inspect = await dispatchCompositingGraphAuthoringCommand(
      "motion.compositing.graph.inspect",
      { packageRoot: compiledRoot },
      services,
    );
    expect(inspect).toMatchObject({ ok: true, result: { state: { graph, compiled: true } } });

    const recompiled = await dispatchCompositingGraphAuthoringCommand(
      "motion.compositing.graph.set",
      { packageRoot: compiledRoot, outDir: recompiledRoot, graph: unaryGraph(4) },
      services,
    );
    expect(recompiled).toMatchObject({ ok: true });
    const reopened = await loadMotionPackage(recompiledRoot);
    expect(reopened.motion.layers).toHaveLength(2);
    expect(reopened.motion.layers[1]).toMatchObject({ id: "cg.hero.blur", effects: { blur: 4 } });

    const removed = await dispatchCompositingGraphAuthoringCommand(
      "motion.compositing.graph.remove",
      { packageRoot: recompiledRoot, outDir: restoredRoot },
      services,
    );
    expect(removed).toMatchObject({
      ok: true,
      result: { state: { graph: null, compiled: false, metadata: null } },
    });
    const restored = await loadMotionPackage(restoredRoot);
    expect(restored.motion.layers).toEqual([(await loadMotionPackage(sourceRoot)).motion.layers[0]]);
    expect(restored.motion.compositing).toBeUndefined();
    expect(restored.motion["x-compositing-compile"]).toBeUndefined();
  });

  it("rejects invalid graphs before creating output and preserves occupied destinations", async () => {
    const root = await fixtureRoot();
    const sourceRoot = join(root, "source");
    const invalidRoot = join(root, "invalid");
    const occupiedRoot = join(root, "occupied");
    await writePackage(sourceRoot);
    const graph = unaryGraph(4);
    graph.edges = [
      { id: "a_b", from: { nodeId: "blur", port: "output" }, to: { nodeId: "output", port: "input" } },
      { id: "b_a", from: { nodeId: "output", port: "output" }, to: { nodeId: "blur", port: "input" } },
    ];
    const invalid = await dispatchCompositingGraphAuthoringCommand(
      "motion.compositing.graph.set",
      { packageRoot: sourceRoot, outDir: invalidRoot, graph },
      authoringServices(root),
    );
    expect(invalid).toMatchObject({
      ok: false,
      error: { code: "compositing_graph_set_failed", message: expect.stringMatching(/must|invalid|acyclic|input|incompatible/i) },
    });
    expect(await stat(invalidRoot).catch(() => null)).toBeNull();

    await mkdir(occupiedRoot, { mode: 0o700 });
    await writeFile(join(occupiedRoot, "keep.txt"), "user-owned", "utf8");
    const occupied = await dispatchCompositingGraphAuthoringCommand(
      "motion.compositing.graph.set",
      { packageRoot: sourceRoot, outDir: occupiedRoot, graph: unaryGraph(4) },
      authoringServices(root),
    );
    expect(occupied).toMatchObject({ ok: false, error: { code: "output_not_empty" } });
    expect(await readFile(join(occupiedRoot, "keep.txt"), "utf8")).toBe("user-owned");
  });
});

function unaryGraph(radius: number) {
  return {
    schema: "shellx-motion/compositing-graph@1" as const,
    id: "hero",
    nodes: [
      { id: "source", type: "source" as const, layerId: "plate" },
      { id: "blur", type: "blur" as const, radius },
      { id: "output", type: "output" as const },
    ],
    edges: [
      { id: "source_blur", from: { nodeId: "source", port: "output" as const }, to: { nodeId: "blur", port: "input" as const } },
      { id: "blur_output", from: { nodeId: "blur", port: "output" as const }, to: { nodeId: "output", port: "input" as const } },
    ],
  };
}

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-compositing-authoring-"));
  roots.push(root);
  return root;
}

function authoringServices(root: string) {
  return withTestAuthoringRoots({ packageLoader: loadMotionPackage }, {
    inputRoots: [root],
    outputRoots: [root],
  });
}

async function writePackage(root: string): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeJson(join(root, "manifest.json"), {
    schema: "shellx-motion/package-manifest@1",
    id: "compositing-fixture",
    name: "Compositing fixture",
    motion: "motion.json",
    assets: [],
    sourceApp: "shellx-motion-test",
    compatibility: { lanes: ["browser"], hosts: ["shellx-motion"] },
  });
  await writeJson(join(root, "motion.json"), {
    schema: "shellx-motion/motion@1",
    id: "compositing-motion",
    name: "Compositing fixture",
    durationMs: 1_000,
    fps: 30,
    width: 320,
    height: 180,
    layers: [{
      id: "plate",
      type: "shape",
      shape: "rectangle",
      startMs: 0,
      durationMs: 1_000,
      width: 320,
      height: 180,
      fill: "#336699",
    }],
    assets: [],
    provenance: { sourceApp: "shellx-motion", createdBy: "test" },
  });
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
