import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dispatchDomainCommand } from "./router.js";

describe("authoring router legacy root fence", () => {
  it("keeps script compilation inside authoring read, package-write, and receipt ports", async () => {
    let writes = 0;
    expect(await dispatchDomainCommand(
      "authoring", "motion.script.compile", { script: { schema: "shellx-motion/scripted-video@1" }, packageDir: "/pkg" }
    )).toMatchObject({ ok: false, error: { code: "capability_unavailable" } });
    expect(await dispatchDomainCommand(
      "workspace", "motion.script.compile", { script: {}, packageDir: "/pkg" },
      { scriptedPackageWriter: async () => { writes += 1; throw new Error("must not run cross-domain"); } }
    )).toBeNull();
    const script = { schema: "shellx-motion/scripted-video@1", id: "domain-script", name: "Domain Script", sourceApp: "shellx-motion", workflow: "generate", width: 1280, height: 720, fps: 24, frames: [{ id: "one", title: "One", durationMs: 1000 }] };
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-router-script-"));
    const inputRoot = join(root, "input");
    const outputRoot = join(root, "output");
    const scriptPath = join(inputRoot, "script.json");
    const packageDir = join(outputRoot, "package");
    try {
      await Promise.all([mkdir(inputRoot), mkdir(outputRoot)]);
      await writeFile(scriptPath, "{}\n", "utf8");
      const result = await dispatchDomainCommand("authoring", "motion.script.compile", { scriptPath, packageDir, receiptsRoot: "/receipts" }, {
        authoringInputRoots: [inputRoot], authoringOutputRoots: [outputRoot],
        readJson: async (path) => { expect(path).toBe(scriptPath); return script; },
        scriptedPackageWriter: async (_compiled, options) => {
          writes += 1;
          expect(options.packageDir).toBe(packageDir);
          return {
            packageDir: options.packageDir,
            manifestPath: join(packageDir, "manifest.json"),
            motionPath: join(packageDir, "motion.json"),
            receiptPath: join(packageDir, "receipts", "script-compile.receipt.json"),
            receipt: { schema: "shellx-motion/receipt@1", id: "script-compile", operation: "script.compile", status: "passed", packageId: "pkg_script_domain_script", inputHashes: {}, createdAt: "2026-08-22T00:00:00.000Z", lane: "script", output: {}, warnings: [] }
          };
        },
        writeReceipt: async (receiptRoot, receipt) => {
          expect(receiptRoot).toBe("/receipts");
          expect(receipt.operation).toBe("script.compile");
          return "/receipts/compile.json";
        }
      });
      expect(writes).toBe(1);
      expect(result).toMatchObject({ ok: true, visibleState: { operation: "script.compile", packageId: "pkg_script_domain_script" }, result: { hostReceiptPath: "/receipts/compile.json" } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
