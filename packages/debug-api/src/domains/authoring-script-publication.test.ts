import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OutputDirectoryTransaction, PublicationCommitUncertainError } from "@shellx-motion/core";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { writeScriptedMotionPackage } from "@shellx-motion/adapters-script";
import { dispatchAuthoringCommand } from "./authoring.js";

const roots: string[] = [];
const itLinux = process.platform === "linux" ? it : it.skip;
afterEach(async () => await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))));

describe("motion.script.compile publication boundary", () => {
  itLinux("mirrors the exact committed receipt and reports post-commit mirror failure only as a warning", async () => {
    const root = await workspace();
    const packageDir = join(root, "package");
    const receiptsRoot = join(root, "host-receipts");
    const mirrored: unknown[] = [];
    await mkdir(receiptsRoot, { recursive: true, mode: 0o700 });
    const result = await trusted(root, async () => await dispatchAuthoringCommand("motion.script.compile", {
      script: scriptedVideo(), packageDir, receiptsRoot, createdAt: "2026-08-22T00:00:00.000Z"
    }, {
      authoringInputRoots: [root], authoringOutputRoots: [root], scriptedPackageWriter: writeScriptedMotionPackage,
      receiptActor: { kind: "agent", label: "Debug publication test", transport: "mcp", sessionId: "session-test", grantedTier: "write_local" },
      writeReceipt: async (_root, receipt) => {
        mirrored.push(receipt);
        const path = join(receiptsRoot, "mirror.json");
        await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
        return path;
      }
    }));

    expect(result).toMatchObject({ ok: true, receiptId: "receipt_script_compile_pkg_script_debug_publication", result: { receipt: { actor: { kind: "agent", label: "Debug publication test", transport: "mcp" } } }, warnings: [] });
    const packageReceipt = JSON.parse(await readFile(join(packageDir, "receipts", "script-compile.receipt.json"), "utf8"));
    expect(mirrored).toEqual([packageReceipt]);
    expect(await readFile(join(receiptsRoot, "mirror.json"), "utf8")).toBe(`${JSON.stringify(packageReceipt, null, 2)}\n`);

    const warningPackage = join(root, "warning-package");
    const warning = await trusted(root, async () => await dispatchAuthoringCommand("motion.script.compile", {
      script: scriptedVideo(), packageDir: warningPackage, receiptsRoot
    }, {
      authoringInputRoots: [root], authoringOutputRoots: [root], scriptedPackageWriter: writeScriptedMotionPackage,
      writeReceipt: async () => { throw new Error("injected mirror failure"); }
    }));
    expect(warning).toMatchObject({
      ok: true,
      result: { packageDir: warningPackage, hostReceipt: { status: "mirror_failed", message: /injected mirror failure/ } },
      warnings: [expect.stringMatching(/Script package committed, but host receipt mirror failed/)]
    });
    await expect(readFile(join(warningPackage, "receipts", "script-compile.receipt.json"), "utf8")).resolves.toContain('"operation": "script.compile"');
  });

  itLinux("propagates post-rename uncertainty with the canonical public package path and exact three-leaf evidence", async () => {
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
      const result = await trusted(root, async () => await dispatchAuthoringCommand("motion.script.compile", {
        script: scriptedVideo(), packageDir
      }, { authoringInputRoots: [root], authoringOutputRoots: [root], scriptedPackageWriter: writeScriptedMotionPackage }));
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "publication_commit_uncertain",
          detail: {
            possiblyCommitted: true,
            packageDir,
            publicPaths: [packageDir],
            expectedClosedTree: {
              entryCount: 3,
              entries: ["manifest.json", "motion.json", "receipts/script-compile.receipt.json"]
            }
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
  const result = await trusted(root, async () => await dispatchAuthoringCommand("motion.script.compile", {
    script: scriptedVideo(), packageDir
  }, {
    authoringInputRoots: [root], authoringOutputRoots: [root], scriptedPackageWriter: writeScriptedMotionPackage
  }));

  expect(result).toMatchObject({
    ok: false,
    error: {
      code: "script_compile_failed",
      message: /closed-tree publication requires a Linux descriptor-relative primitive/i
    }
  });
  await expect(stat(packageDir)).rejects.toMatchObject({ code: "ENOENT" });
  expect((await readdir(root)).some((name) => name.startsWith(".unsupported-package.shellx-motion-stage-"))).toBe(false);
}

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-debug-script-publication-"));
  roots.push(root);
  return root;
}

async function trusted<T>(root: string, action: () => Promise<T>): Promise<T> {
  if (process.platform === "win32") return await action();
  return await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(root), action);
}

function scriptedVideo(): Record<string, unknown> {
  return {
    schema: "shellx-motion/scripted-video@1",
    id: "debug-publication",
    name: "Debug publication",
    sourceApp: "shellx-motion",
    workflow: "generate",
    width: 1280,
    height: 720,
    fps: 24,
    frames: [{ id: "one", title: "One", durationMs: 1000 }]
  };
}
