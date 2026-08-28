import { loadMotionPackage } from "@shellx-motion/core";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalMotionSdk } from "./local.js";
import { withTestAuthoringRoots } from "./local-test-authoring-context.test-support.js";

const roots: string[] = [];

describe("local compositing SDK", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("inspects, compiles, verifies, and removes a graph through package revisions", async () => {
    const root = await fixtureRoot();
    const sourceRoot = join(root, "source");
    const compiledRoot = join(root, "compiled");
    const removedRoot = join(root, "removed");
    await writePackage(sourceRoot);
    const sourceMotion = await readFile(join(sourceRoot, "motion.json"), "utf8");
    const sdk = createLocalMotionSdk(withTestAuthoringRoots({}, {
      inputRoots: [root],
      outputRoots: [root],
    }));

    const before = await sdk.compositingInspect({ packageRoot: sourceRoot });
    expect(before).toMatchObject({
      ok: true,
      output: { packageRoot: sourceRoot, state: { graph: null, compiled: false } },
    });

    const set = await sdk.compositingSet({
      packageRoot: sourceRoot,
      outDir: compiledRoot,
      graph: graph(),
      createdBy: "sdk-test",
    });
    expect(set).toMatchObject({
      ok: true,
      output: {
        packageRoot: compiledRoot,
        state: {
          graph: { id: "hero" },
          compiled: true,
          validation: { ok: true },
          fingerprint: expect.stringMatching(/^[a-f0-9]{16}$/),
        },
        receipt: {
          operation: "compositing.graph.set",
          path: expect.stringContaining("compositing-graph-set.receipt.json"),
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      },
    });
    expect(await readFile(join(sourceRoot, "motion.json"), "utf8")).toBe(sourceMotion);
    expect((await loadMotionPackage(compiledRoot)).motion.layers).toHaveLength(2);

    const inspected = await sdk.compositingInspect({ packageRoot: compiledRoot });
    expect(inspected).toMatchObject({
      ok: true,
      output: { state: { graph: { id: "hero" }, compiled: true } },
    });

    const removed = await sdk.compositingRemove({
      packageRoot: compiledRoot,
      outDir: removedRoot,
    });
    expect(removed).toMatchObject({
      ok: true,
      output: {
        state: { graph: null, compiled: false, metadata: null },
        receipt: { operation: "compositing.graph.remove" },
      },
    });
    const reopened = await loadMotionPackage(removedRoot);
    expect(reopened.motion.layers).toHaveLength(1);
    expect(reopened.motion.layers[0]).toMatchObject({ id: "plate" });
    expect(reopened.motion.layers[0].visible).toBeUndefined();
  });

  it("rejects executable or cyclic graph shapes before invoking local mutation", async () => {
    const sdk = createLocalMotionSdk();
    const executable = { ...graph(), execute: "code" };
    const invalid = await sdk.compositingSet({
      packageRoot: "/tmp/source",
      outDir: "/tmp/output",
      graph: executable as never,
    });
    expect(invalid).toMatchObject({
      ok: false,
      error: { code: "invalid_request", message: expect.stringContaining("unsupported field") },
    });
  });
});

function graph() {
  return {
    schema: "shellx-motion/compositing-graph@1" as const,
    id: "hero",
    nodes: [
      { id: "source", type: "source" as const, layerId: "plate" },
      { id: "grade", type: "color" as const, contrast: 1.2, saturate: 0.9 },
      { id: "output", type: "output" as const },
    ],
    edges: [
      { id: "source_grade", from: { nodeId: "source", port: "output" as const }, to: { nodeId: "grade", port: "input" as const } },
      { id: "grade_output", from: { nodeId: "grade", port: "output" as const }, to: { nodeId: "output", port: "input" as const } },
    ],
  };
}

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-sdk-compositing-"));
  roots.push(root);
  return root;
}

async function writePackage(root: string): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeJson(join(root, "manifest.json"), {
    schema: "shellx-motion/package-manifest@1",
    id: "sdk-compositing",
    name: "SDK compositing",
    motion: "motion.json",
    assets: [],
    sourceApp: "shellx-motion-test",
    compatibility: { lanes: ["browser"], hosts: ["shellx-motion"] },
  });
  await writeJson(join(root, "motion.json"), {
    schema: "shellx-motion/motion@1",
    id: "sdk-compositing-motion",
    name: "SDK compositing",
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
    provenance: { sourceApp: "shellx-motion-test", createdBy: "test" },
  });
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
