import { describe, expect, it } from "vitest";
import { cp, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { dispatchDebugCommand, readMotionAgentSnapshotResource, type MotionDebugContext } from "./index.js";
import { hasStableReceiptStoreCapability } from "./receipt-store-stable-reader.js";

const RECEIPTS_ROOT = "/host-owned-receipts";
const PACKAGE_SOURCE = fileURLToPath(new URL("../../../fixtures/packages/lower-third/", import.meta.url));
const UNSUPPORTED_STABLE_RECEIPT_PLATFORMS = ["darwin", "win32"] as const;

describe("stable receipt-store capability", () => {
  it("exposes the single descriptor-relative capability predicate", () => {
    expect(hasStableReceiptStoreCapability("darwin")).toBe(false);
    expect(hasStableReceiptStoreCapability("win32")).toBe(false);
    expect(hasStableReceiptStoreCapability("linux", () => false)).toBe(false);
    expect(hasStableReceiptStoreCapability("linux", () => true)).toBe(true);
    expect(typeof hasStableReceiptStoreCapability()).toBe("boolean");
  });

  it("refuses every receipt-backed debug path before it can read or control a receipt store", async () => {
    const cases: Array<[Parameters<typeof dispatchDebugCommand>[0], unknown]> = [
      ["motion.receipts.list", { receiptsRoot: RECEIPTS_ROOT }],
      ["motion.receipts.panel", { receiptsRoot: RECEIPTS_ROOT }],
      ["motion.receipts.read", { receiptsRoot: RECEIPTS_ROOT, receiptId: "receipt-1" }],
      ["motion.agent.snapshot", { receiptsRoot: RECEIPTS_ROOT }],
      ["motion.agent.transcript", { receiptsRoot: RECEIPTS_ROOT }],
      ["motion.prompt.queue", { receiptsRoot: RECEIPTS_ROOT }],
      ["motion.prompt.cancel", { receiptsRoot: RECEIPTS_ROOT, receiptId: "prompt-1" }],
      ["motion.prompt.retry", { receiptsRoot: RECEIPTS_ROOT, receiptId: "prompt-1" }],
      ["motion.render.status", { receiptsRoot: RECEIPTS_ROOT }],
      ["motion.render.queue", { receiptsRoot: RECEIPTS_ROOT }],
      ["motion.render.cancel", { receiptsRoot: RECEIPTS_ROOT, receiptId: "render-1" }],
      ["motion.render.retry", { receiptsRoot: RECEIPTS_ROOT, receiptId: "render-1" }],
      ["motion.state", { packageRoot: "/host-owned-package", receiptsRoot: RECEIPTS_ROOT }],
      ["motion.platform.verification.panel", { receiptsRoot: RECEIPTS_ROOT }],
      ["motion.export.panel", { receiptsRoot: RECEIPTS_ROOT }],
      ["motion.export.plan", { receiptsRoot: RECEIPTS_ROOT }],
      ["motion.support.bundle", { outDir: "/host-owned-scratch/support", receiptsRoot: RECEIPTS_ROOT }],
      ["motion.agent.revision.plan", { packageId: "package-1", receiptsRoot: RECEIPTS_ROOT, qualityReceiptId: "quality-1" }]
    ];

    for (const platform of UNSUPPORTED_STABLE_RECEIPT_PLATFORMS) {
      for (const [command, args] of cases) {
        await expect(dispatchDebugCommand(command, args, {
          tier: "push_remote",
          receiptsRoot: RECEIPTS_ROOT,
          stableReceiptStorePlatform: platform
        })).resolves.toMatchObject({
          ok: false,
          error: {
            code: "capability_unavailable",
            message: expect.stringContaining("Linux descriptor-relative no-follow receipt-store capability")
          }
        });
      }
    }
  });

  it("refuses the fixed receipt-backed snapshot resource on an unsupported host", async () => {
    for (const platform of UNSUPPORTED_STABLE_RECEIPT_PLATFORMS) {
      await expect(readMotionAgentSnapshotResource({ receiptsRoot: RECEIPTS_ROOT }, {
        tier: "push_remote",
        receiptsRoot: RECEIPTS_ROOT,
        stableReceiptStorePlatform: platform
      })).resolves.toMatchObject({
        ok: false,
        error: { code: "capability_unavailable" }
      });
    }
  });

  it("keeps root-free lifecycle and snapshot reads available on an unsupported host", async () => {
    const rootFree: MotionDebugContext = { tier: "read_motion", stableReceiptStorePlatform: "darwin", callerId: "root-free-reader" };
    await expect(dispatchDebugCommand("motion.prompt.queue", {}, rootFree)).resolves.toMatchObject({ ok: true, result: { jobCount: 0 } });
    await expect(dispatchDebugCommand("motion.render.status", {}, rootFree)).resolves.toMatchObject({ ok: true, result: { jobCount: 0 } });
    await expect(dispatchDebugCommand("motion.agent.snapshot", {}, rootFree)).resolves.toMatchObject({ ok: true });
  });

  it("keeps package-only state available and blocks a receipt-backed state before any stable reader call", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-stable-store-preflight-"));
    const packageRoot = join(root, "package");
    const receiptsRoot = join(root, "receipts");
    let readerCalls = 0;
    try {
      await cp(PACKAGE_SOURCE, packageRoot, { recursive: true });
      await mkdir(receiptsRoot);
      const workspaceAnchor = await createTrustedWorkspaceAnchor(root);
      const packageOnly: MotionDebugContext = { tier: "read_motion", stableReceiptStorePlatform: "darwin" };
      const packageOnlyState = await withTrustedWorkspaceAnchor(workspaceAnchor, async () =>
        await dispatchDebugCommand("motion.state", { packageRoot }, packageOnly)
      );
      expect(packageOnlyState.ok, JSON.stringify(packageOnlyState)).toBe(true);
      expect(packageOnlyState).toMatchObject({
        ok: true,
        result: { packageOpen: true, receipts: { receiptCount: 0 } }
      });

      const receiptBacked: MotionDebugContext = {
        ...packageOnly,
        receiptsRoot,
        stableReceiptStoreReadTestServices: {
          afterReaddir: async () => { readerCalls += 1; }
        }
      };
      await expect(withTrustedWorkspaceAnchor(workspaceAnchor, async () =>
        await dispatchDebugCommand("motion.state", { packageRoot }, receiptBacked)
      )).resolves.toMatchObject({
        ok: false,
        error: { code: "capability_unavailable" }
      });
      expect(readerCalls).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(UNSUPPORTED_STABLE_RECEIPT_PLATFORMS)("refuses a receipt-backed support bundle before receipt discovery or output creation on %s", async (platform) => {
    await expectUnsupportedSupportBundlePreflight(platform);
  });

  it("refuses a receipt-backed support bundle before receipt discovery or output creation on Linux without procfs", async () => {
    await expectUnsupportedSupportBundlePreflight("linux", () => false);
  });
});

async function expectUnsupportedSupportBundlePreflight(
  platform: NodeJS.Platform,
  procSelfFdUsable?: () => boolean
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-stable-store-support-preflight-"));
  const receiptsRoot = join(root, "receipts");
  const outDir = join(root, "support-bundle");
  let readerCalls = 0;
  try {
    await mkdir(receiptsRoot);
    const result = await dispatchDebugCommand(
      "motion.support.bundle",
      { outDir, receiptsRoot },
      {
        tier: "write_local",
        scratchRoot: root,
        receiptsRoot,
        stableReceiptStorePlatform: platform,
        ...(procSelfFdUsable ? { stableReceiptStoreProcSelfFdUsable: procSelfFdUsable } : {}),
        stableReceiptStoreReadTestServices: {
          afterReaddir: async () => { readerCalls += 1; }
        }
      }
    );
    expect(result).toMatchObject({ ok: false, error: { code: "capability_unavailable" } });
    expect(readerCalls).toBe(0);
    expect(await readdir(root)).toEqual(["receipts"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
