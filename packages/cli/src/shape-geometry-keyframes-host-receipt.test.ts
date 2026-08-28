import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OperationReceipt } from "@shellx-motion/core";
import { withCliSourceWorkspaceAnchor } from "./debug-context-cli.js";
import { createCliShapeGeometryKeyframeHostReceiptStore } from "./shape-geometry-keyframes-host-receipt.js";

const UPSERT = "motion.timeline.shape.geometry-keyframes.upsert" as const;
const roots: string[] = [];

afterEach(async () => await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))));

describe("CLI shape geometry keyframe host receipt store", () => {
  it("isolates concurrent operation receipts in independently transaction-published private scopes", async () => {
    const workspace = await scratch();
    const first = requiredStore(workspace);
    const second = requiredStore(workspace);

    expect(first.receiptsRoot).not.toBe(second.receiptsRoot);
    const [firstPath, secondPath] = await Promise.all([
      writeStore(first, receipt("first")),
      writeStore(second, receipt("second")),
    ]);

    expect(firstPath).toBe(join(first.receiptsRoot, "host.receipt.json"));
    expect(secondPath).toBe(join(second.receiptsRoot, "host.receipt.json"));
    await expect(readFile(firstPath, "utf8")).resolves.toContain('"id": "first"');
    await expect(readFile(secondPath, "utf8")).resolves.toContain('"id": "second"');
  });

  it("refuses a requested receipt root other than the host-minted operation scope", async () => {
    const workspace = await scratch();
    const store = requiredStore(workspace);

    await expect(writeStore(store, receipt("wrong-root"), join(workspace, "caller-selected")))
      .rejects.toThrow("unexpected receipt root");
    await expect(lstat(store.receiptsRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a symlinked receipt route without reaching the target", async () => {
    const workspace = await scratch();
    const outside = await scratch();
    await symlink(outside, join(workspace, ".scratch"));
    const store = requiredStore(workspace);

    await expect(writeStore(store, receipt("symlink")))
      .rejects.toThrow(/topology is unsafe|canonical non-symlink/i);
    await expect(lstat(join(outside, "cli-host-receipts"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform === "win32")("refuses a shared-writable receipt parent before publication", async () => {
    const workspace = await scratch();
    const shared = join(workspace, ".scratch");
    await mkdir(shared, { mode: 0o700 });
    await chmod(shared, 0o777);
    const store = requiredStore(workspace);

    await expect(writeStore(store, receipt("shared")))
      .rejects.toThrow(/group- or world-writable/i);
    await expect(lstat(store.receiptsRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a private-stage replacement and never removes the replacement", async () => {
    const workspace = await scratch();
    const retained = join(workspace, "retained-stage");
    let replacementPath: string | undefined;
    const store = requiredStore(workspace, {
      afterStageWritten: async ({ stagingPath }) => {
        await rename(stagingPath, retained);
        await mkdir(stagingPath, { mode: 0o700 });
        replacementPath = join(stagingPath, "replacement.txt");
        await writeFile(replacementPath, "competitor", "utf8");
      },
    });

    await expect(writeStore(store, receipt("replacement")))
      .rejects.toThrow(/changed after Motion captured its identity/i);
    await expect(readFile(join(retained, "host.receipt.json"), "utf8")).resolves.toContain('"id": "replacement"');
    await expect(readFile(replacementPath!, "utf8")).resolves.toBe("competitor");
    await expect(lstat(store.receiptsRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(process.cwd(), ".shellx-motion-cli-shape-receipt-"));
  roots.push(root);
  return root;
}

function requiredStore(workspaceRoot: string, options: Parameters<typeof createCliShapeGeometryKeyframeHostReceiptStore>[1] = {}) {
  const store = createCliShapeGeometryKeyframeHostReceiptStore(UPSERT, { workspaceRoot, ...options });
  if (!store) throw new Error("expected the shape geometry keyframe host receipt store");
  return store;
}

async function writeStore(store: ReturnType<typeof requiredStore>, value: OperationReceipt, requestedRoot = store.receiptsRoot): Promise<string> {
  return await withCliSourceWorkspaceAnchor([store.receiptsRoot], async () => await store.writeReceipt(requestedRoot, value));
}

function receipt(id: string): OperationReceipt {
  return {
    schema: "shellx-motion/receipt@1", id, operation: "timeline.shape.geometry-keyframes.upsert", status: "passed",
    packageId: "pkg-test", inputHashes: {}, createdAt: "2026-08-19T00:00:00.000Z", lane: "cli", output: {}, warnings: [],
  };
}
