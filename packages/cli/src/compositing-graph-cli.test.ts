import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  COMPOSITING_GRAPH_DEBUG_COMMANDS,
  compositingGraphDebugArgs,
} from "./compositing-graph-cli.js";

const roots: string[] = [];

describe("compositing graph CLI adapter", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("maps inspect and remove without graph payloads", async () => {
    expect(COMPOSITING_GRAPH_DEBUG_COMMANDS["compositing-graph-set"])
      .toBe("motion.compositing.graph.set");
    expect(await compositingGraphDebugArgs(
      "motion.compositing.graph.inspect",
      [],
      "/tmp/source",
    )).toEqual({ packageRoot: "/tmp/source" });
    expect(await compositingGraphDebugArgs(
      "motion.compositing.graph.remove",
      ["--out", "/tmp/restored", "--created-by", "agent"],
      "/tmp/source",
    )).toEqual({
      packageRoot: "/tmp/source",
      outDir: "/tmp/restored",
      receiptsRoot: undefined,
      createdBy: "agent",
    });
  });

  it("reads bounded graph JSON from inline or file input", async () => {
    const graph = { schema: "shellx-motion/compositing-graph@1", id: "hero", nodes: [], edges: [] };
    const inline = await compositingGraphDebugArgs(
      "motion.compositing.graph.set",
      ["--out", "/tmp/output", "--graph-json", JSON.stringify(graph)],
      "/tmp/source",
    );
    expect(inline).toMatchObject({ packageRoot: "/tmp/source", outDir: "/tmp/output", graph });

    const root = await mkdtemp(join(tmpdir(), "shellx-motion-graph-cli-"));
    roots.push(root);
    const path = join(root, "graph.json");
    await writeFile(path, JSON.stringify(graph), "utf8");
    const fromFile = await compositingGraphDebugArgs(
      "motion.compositing.graph.set",
      ["--out", "/tmp/output", "--graph-file", path],
      "/tmp/source",
    );
    expect(fromFile).toMatchObject({ graph });
    await expect(compositingGraphDebugArgs(
      "motion.compositing.graph.set",
      ["--graph-json", "{}", "--graph-file", path],
      "/tmp/source",
    )).rejects.toThrow(/either/);
  });
});
