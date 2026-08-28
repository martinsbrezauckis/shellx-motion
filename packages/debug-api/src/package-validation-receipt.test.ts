import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compositingGraphFingerprint,
  loadMotionPackage,
  type MotionCompositingGraph,
  type OperationReceipt,
} from "@shellx-motion/core";
import { dispatchWorkspaceCommand } from "./domains/workspace.js";
import { dispatchDebugCommand } from "./index.js";

const roots: string[] = [];
const fixture = resolve("../../fixtures/packages/environment-rain-cinematic");
const compositingFixture = resolve("../../fixtures/packages/editable-lower-third");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function copiedPackage(source = fixture): Promise<{ root: string; packageRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-debug-validate-receipt-"));
  roots.push(root);
  const packageRoot = join(root, "package");
  await cp(source, packageRoot, { recursive: true });
  return { root, packageRoot };
}

/** Schema-valid output whose compile metadata is deliberately not the graph's real compilation. */
async function forgeCompositingMetadata(packageRoot: string): Promise<void> {
  const motionPath = join(packageRoot, "motion.json");
  const motion = JSON.parse(await readFile(motionPath, "utf8"));
  const graph: MotionCompositingGraph = {
    schema: "shellx-motion/compositing-graph@1",
    id: "graph",
    nodes: [{ id: "source", type: "source", layerId: "title" }, { id: "output", type: "output" }],
    edges: [{ id: "edge", from: { nodeId: "source", port: "output" }, to: { nodeId: "output", port: "input" } }],
  };
  const fingerprint = compositingGraphFingerprint(graph);
  motion.compositing = graph;
  motion.layers = motion.layers.map((layer: Record<string, unknown>) => layer.id === "title"
    ? { ...layer, visible: false, "x-compositing-source-visible": "unset" }
    : layer.id === "subtitle"
      ? { ...layer, "x-compositing-generated": { schema: "shellx-motion/compositing-compile@1", graphId: graph.id, fingerprint } }
      : layer);
  motion["x-compositing-compile"] = {
    schema: "shellx-motion/compositing-compile@1",
    graphId: graph.id,
    fingerprint,
    nodeOrder: ["source", "output"],
    sourceLayerIds: ["title"],
    outputLayerIds: ["subtitle"],
    estimate: { nodeCount: 2, edgeCount: 1, sourceCount: 1, maxDepth: 2, maxFanOut: 1, pixelOperations: 1, workingBytes: 1 },
  };
  await writeFile(motionPath, `${JSON.stringify(motion, null, 2)}\n`, "utf8");
}

describe("motion.package.validate receipts", () => {
  it("persists both the passed and failed verdict through the host receipt writer", async () => {
    const { root, packageRoot } = await copiedPackage();
    const receiptsRoot = join(root, "host-receipts");
    const passed = await dispatchDebugCommand("motion.package.validate", { packageRoot }, {
      tier: "read_motion",
      receiptsRoot
    });

    expect(passed).toMatchObject({ ok: true, receiptId: expect.stringMatching(/^package-validate-/) });
    if (!passed.ok) throw new Error("unreachable");
    const passedBody = passed.result as { receiptPath: string };
    expect(JSON.parse(await readFile(passedBody.receiptPath, "utf8"))).toMatchObject({
      operation: "package.validate", status: "passed", lane: "validation"
    });

    const motionPath = join(packageRoot, "motion.json");
    const motion = JSON.parse(await readFile(motionPath, "utf8"));
    // A renderable package whose only fault is structural, so this reaches the universal schema
    // failure rather than either specialised validation refusal.
    const environment = motion.layers.find((layer: { type: string }) => layer.type === "environment");
    environment.environment.backgroundColor = "midnightblue";
    await writeFile(motionPath, `${JSON.stringify(motion, null, 2)}\n`, "utf8");
    const failed = await dispatchDebugCommand("motion.package.validate", { packageRoot }, {
      tier: "read_motion",
      receiptsRoot
    });

    expect(failed).toMatchObject({ ok: false, error: { code: "invalid_motion_document" }, receiptId: expect.any(String) });
    if (failed.ok) throw new Error("unreachable");
    const failedBody = failed.result as { receiptPath: string };
    expect(JSON.parse(await readFile(failedBody.receiptPath, "utf8"))).toMatchObject({
      operation: "package.validate", status: "failed", output: { error: { code: "invalid_motion_document" } }
    });
  });

  it("rejects a host receipt root inside the source package", async () => {
    const { packageRoot } = await copiedPackage();
    const result = await dispatchDebugCommand("motion.package.validate", { packageRoot }, {
      tier: "read_motion",
      receiptsRoot: join(packageRoot, "receipts")
    });

    expect(result).toMatchObject({ ok: false, error: { code: "invalid_args" } });
  });

  it("rejects forged compositing output and persists the exact failed Debug verdict", async () => {
    const { root, packageRoot } = await copiedPackage(compositingFixture);
    await forgeCompositingMetadata(packageRoot);
    const result = await dispatchDebugCommand("motion.package.validate", { packageRoot }, {
      tier: "read_motion",
      receiptsRoot: join(root, "host-receipts"),
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "invalid_motion_document",
        message: expect.stringContaining("deterministic graph compilation"),
        detail: { validation: "compositing_compile_integrity" },
      },
      result: { valid: false, compositingIntegrity: "invalid" },
      receiptId: expect.stringMatching(/^package-validate-/),
    });
    if (result.ok) throw new Error("unreachable");
    const body = result.result as { receiptPath: string };
    const receipt = JSON.parse(await readFile(body.receiptPath, "utf8"));
    expect(receipt).toMatchObject({
      operation: "package.validate",
      status: "failed",
      output: {
        validation: { valid: false, compositingIntegrity: "invalid" },
        error: {
          code: result.error.code,
          message: result.error.message,
          detail: result.error.detail,
        },
      },
    });
  });

  it("uses one loaded package for its verdict and receipt, never a competing second snapshot", async () => {
    const { root, packageRoot } = await copiedPackage();
    let loaderCalls = 0;
    let secondSnapshotSupplied = false;
    let redundantSummaryCalls = 0;
    let persisted: OperationReceipt | undefined;
    const services = {
      // This former service boundary must not be consulted: it could have returned a summary from
      // different bytes than the package that is subsequently hashed into the receipt.
      validatePackage: async () => {
        redundantSummaryCalls += 1;
        return { packageId: "pkg_from_a_different_load", motionId: "motion_from_a_different_load" };
      },
      packageLoader: async (requestedRoot: string) => {
        loaderCalls += 1;
        const snapshot = await loadMotionPackage(requestedRoot);
        if (loaderCalls === 1) return snapshot;
        secondSnapshotSupplied = true;
        return { ...snapshot, motion: { ...snapshot.motion, id: "motion_from_a_second_load" } };
      },
      receiptsRoot: join(root, "host-receipts"),
      isUnsafePackageOutputDirectory: async () => false,
      writeReceipt: async (_root: string, receipt: OperationReceipt) => {
        persisted = receipt;
        return join(root, "host-receipts", `${receipt.id}.receipt.json`);
      },
    };

    const result = await dispatchWorkspaceCommand("motion.package.validate", { packageRoot }, services);

    expect(result).toMatchObject({ ok: true, result: { motionId: "motion_environment_rain_cinematic" } });
    expect(loaderCalls).toBe(1);
    expect(secondSnapshotSupplied).toBe(false);
    expect(redundantSummaryCalls).toBe(0);
    expect(persisted).toMatchObject({
      packageId: "pkg_environment_rain_cinematic",
      output: { validation: { motionId: "motion_environment_rain_cinematic" } },
    });
  });

  it("uses its one loaded snapshot for a failed compositing verdict and receipt too", async () => {
    const { root, packageRoot } = await copiedPackage(compositingFixture);
    await forgeCompositingMetadata(packageRoot);
    let loaderCalls = 0;
    let persisted: OperationReceipt | undefined;
    const result = await dispatchWorkspaceCommand("motion.package.validate", { packageRoot }, {
      packageLoader: async (requestedRoot: string) => {
        loaderCalls += 1;
        return await loadMotionPackage(requestedRoot);
      },
      receiptsRoot: join(root, "host-receipts"),
      isUnsafePackageOutputDirectory: async () => false,
      writeReceipt: async (_root: string, receipt: OperationReceipt) => {
        persisted = receipt;
        return join(root, "host-receipts", `${receipt.id}.receipt.json`);
      },
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "invalid_motion_document", detail: { validation: "compositing_compile_integrity" } },
      result: { valid: false, compositingIntegrity: "invalid" },
    });
    expect(loaderCalls).toBe(1);
    expect(persisted).toMatchObject({
      operation: "package.validate",
      status: "failed",
      output: {
        validation: { valid: false, compositingIntegrity: "invalid" },
        error: { code: "invalid_motion_document", detail: { validation: "compositing_compile_integrity" } },
      },
    });
  });
});
