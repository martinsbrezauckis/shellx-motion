import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OutputDirectoryTransaction, PublicationCommitUncertainError } from "@shellx-motion/core";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { CANVAS_FIXTURE_EXAMPLE } from "@shellx-motion/adapters-canvas";
import { dispatchIntegrationCommand } from "./integration.js";

const roots: string[] = [];
const itLinux = process.platform === "linux" ? it : it.skip;
afterEach(async () => await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))));

describe("motion.canvas.package publication boundary", () => {
  itLinux("commits the same final receipt it mirrors, and reports mirror failure only as an observer warning", async () => {
    const root = await workspace();
    const packageDir = join(root, "package");
    const receiptsRoot = join(root, "host-receipts");
    const mirrored: unknown[] = [];
    await mkdir(receiptsRoot, { recursive: true, mode: 0o700 });
    const result = await trusted(root, async () => await dispatchIntegrationCommand("motion.canvas.package", {
      selection: structuredClone(CANVAS_FIXTURE_EXAMPLE), packageDir, receiptsRoot
    }, {
      authoringOutputRoots: [root],
      writeReceipt: async (_root, receipt) => {
        mirrored.push(receipt);
        const path = join(receiptsRoot, "mirror.json");
        await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
        return path;
      }
    }));

    expect(result).toMatchObject({ ok: true, result: { missingAssetRefs: [] }, warnings: [] });
    const packageReceipt = JSON.parse(await readFile(join(packageDir, "receipts", "canvas-export.receipt.json"), "utf8"));
    expect(mirrored).toEqual([packageReceipt]);
    expect(await readFile(join(receiptsRoot, "mirror.json"), "utf8")).toBe(`${JSON.stringify(packageReceipt, null, 2)}\n`);

    const warningPackage = join(root, "warning-package");
    const warning = await trusted(root, async () => await dispatchIntegrationCommand("motion.canvas.package", {
      selection: structuredClone(CANVAS_FIXTURE_EXAMPLE), packageDir: warningPackage, receiptsRoot
    }, {
      authoringOutputRoots: [root],
      writeReceipt: async () => { throw new Error("injected mirror failure"); }
    }));
    expect(warning).toMatchObject({
      ok: true,
      result: { packageDir: warningPackage, hostReceipt: { status: "mirror_failed", message: /injected mirror failure/ } },
      warnings: [expect.stringMatching(/Canvas package committed, but host receipt mirror failed/)]
    });
    await expect(readFile(join(warningPackage, "receipts", "canvas-export.receipt.json"), "utf8")).resolves.toContain('"operation": "export.final"');
  });

  itLinux("keeps file-backed selection locators logical inside the committed receipt", async () => {
    const root = await workspace();
    const selectionPath = join(root, "approved-input", "frame-selection.json");
    const packageDir = join(root, "package");
    await mkdir(join(root, "approved-input"), { recursive: true, mode: 0o700 });
    await writeFile(selectionPath, `${JSON.stringify(CANVAS_FIXTURE_EXAMPLE, null, 2)}\n`, "utf8");
    let observedReadRoot: string | undefined;

    const result = await trusted(root, async () => await dispatchIntegrationCommand("motion.canvas.package", {
      canvasSelectionPath: selectionPath,
      packageDir
    }, {
      authoringInputRoots: [root],
      authoringOutputRoots: [root],
      readJson: async (path, withinRoot) => {
        observedReadRoot = withinRoot;
        return JSON.parse(await readFile(path, "utf8"));
      }
    }));

    expect(result).toMatchObject({ ok: true, result: { packageDir, receiptPath: join(packageDir, "receipts", "canvas-export.receipt.json") } });
    expect(observedReadRoot).toBe(root);
    const packageReceipt = JSON.parse(await readFile(join(packageDir, "receipts", "canvas-export.receipt.json"), "utf8"));
    expect(packageReceipt.inputHashes).toEqual({ "input/canvas-selection.json": expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(packageReceipt.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "canvas_frame_selection", path: "input/canvas-selection.json", status: "available" })
    ]));
    expect(JSON.stringify(packageReceipt)).not.toContain(selectionPath);
    expect(JSON.stringify(packageReceipt)).not.toContain(root);
  });

  itLinux("propagates a post-rename commit uncertainty with canonical exact-tree evidence", async () => {
    const root = await workspace();
    const packageDir = join(root, "uncertain-package");
    const spy = vi.spyOn(OutputDirectoryTransaction.prototype, "commit").mockImplementation(async function (this: OutputDirectoryTransaction, expectedInventory) {
      throw new PublicationCommitUncertainError({
        publicPath: this.outputPath,
        kind: "directory",
        expectedIdentity: { dev: 101, ino: 202 },
        expected: {
          sha256: "a".repeat(64),
          entryCount: expectedInventory?.length ?? 0,
          entries: (expectedInventory ?? []).map((entry) => entry.path),
          inventory: expectedInventory
        }
      }, new Error("injected post-rename observation failure"));
    });
    try {
      const result = await trusted(root, async () => await dispatchIntegrationCommand("motion.canvas.package", {
        selection: structuredClone(CANVAS_FIXTURE_EXAMPLE), packageDir
      }, { authoringOutputRoots: [root] }));
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "publication_commit_uncertain",
          detail: {
            possiblyCommitted: true,
            packageDir,
            publicPaths: [packageDir],
            expectedClosedTree: { entryCount: 4, entries: expect.arrayContaining(["manifest.json", "motion.json", "resource-catalog.json", "receipts/canvas-export.receipt.json"]) }
          }
        },
        result: { possiblyCommitted: true, expectedPublications: [expect.objectContaining({ publicPath: packageDir, kind: "directory" })] }
      });
    } finally {
      spy.mockRestore();
    }
  });

  it.runIf(process.platform === "darwin")("macOS refuses closed-tree publication before creating an output or stage", async () => {
    await expectClosedTreeRefusal();
  });

  it.runIf(process.platform === "win32")("Windows refuses closed-tree publication before creating an output or stage", async () => {
    await expectClosedTreeRefusal();
  });
});

async function expectClosedTreeRefusal(): Promise<void> {
  const root = await workspace();
  const packageDir = join(root, "unsupported-package");
  const result = await trusted(root, async () => await dispatchIntegrationCommand("motion.canvas.package", {
    selection: structuredClone(CANVAS_FIXTURE_EXAMPLE), packageDir
  }, { authoringOutputRoots: [root] }));

  expect(result).toMatchObject({
    ok: false,
    error: {
      code: "canvas_package_failed",
      message: /closed-tree publication requires a Linux descriptor-relative primitive/i
    }
  });
  await expect(stat(packageDir)).rejects.toMatchObject({ code: "ENOENT" });
  expect((await readdir(root)).some((name) => name.startsWith(".unsupported-package.shellx-motion-stage-"))).toBe(false);
}

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-debug-canvas-publication-"));
  roots.push(root);
  return root;
}

async function trusted<T>(root: string, action: () => Promise<T>): Promise<T> {
  if (process.platform === "win32") return await action();
  return await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(root), action);
}
