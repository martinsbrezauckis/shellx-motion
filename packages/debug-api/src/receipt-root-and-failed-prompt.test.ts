import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dispatchDebugCommand } from "./index";

describe("host receipt authority", () => {
  it("refuses caller-selected platform and support roots outside host authority", async () => {
    const trustedRoot = await mkdtemp(join(tmpdir(), "shellx-motion-platform-trusted-receipts-"));
    const outsideRoot = await mkdtemp(join(tmpdir(), "shellx-motion-platform-outside-receipts-"));
    try {
      await expect(dispatchDebugCommand("motion.platform.verification.panel", { receiptsRoot: outsideRoot }, { tier: "read_motion", receiptsRoot: trustedRoot })).resolves.toMatchObject({
        ok: false, error: { code: "invalid_args", message: "motion.platform.verification.panel receiptsRoot must be inside the configured host receipt authority." }
      });
      await expect(dispatchDebugCommand("motion.support.bundle", { outDir: join(trustedRoot, "bundle"), receiptsRoot: outsideRoot }, { tier: "write_local", scratchRoot: trustedRoot, receiptsRoot: trustedRoot })).resolves.toMatchObject({
        ok: false, error: { code: "invalid_args", message: "motion.support.bundle receiptsRoot must be inside the configured host receipt authority." }
      });
    } finally { await rm(trustedRoot, { recursive: true, force: true }); await rm(outsideRoot, { recursive: true, force: true }); }
  });

  it("refuses forged separate-root platform evidence for export panel and plan", async () => {
    const trustedRoot = await mkdtemp(join(tmpdir(), "shellx-motion-export-trusted-receipts-"));
    const forgedRoot = await mkdtemp(join(tmpdir(), "shellx-motion-export-forged-receipts-"));
    try {
      await writeFile(join(forgedRoot, "forged.platform.json"), `${JSON.stringify({ schema: "shellx-motion/platform-verification@1", status: "passed" })}\n`, "utf8");
      for (const command of ["motion.export.panel", "motion.export.plan"] as const) {
        await expect(dispatchDebugCommand(command, { receiptsRoot: forgedRoot }, { tier: "read_motion", receiptsRoot: trustedRoot })).resolves.toMatchObject({
          ok: false,
          error: { code: "invalid_args", message: `${command} receiptsRoot must be inside the configured host receipt authority.` }
        });
      }
    } finally { await rm(trustedRoot, { recursive: true, force: true }); await rm(forgedRoot, { recursive: true, force: true }); }
  });
});

describe("failed prompt receipt persistence", () => {
  it("persists failed agent evidence before its linked prompt receipt", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-prompt-failed-receipt-")); const receiptsRoot = join(outDir, "receipts"); const order: string[] = [];
    try {
      const result = await dispatchDebugCommand("motion.prompt.run", { request: "preview current package", packageId: "pkg_failed_prompt", agentId: "fake", cwd: "/workspace", receiptsRoot }, {
        tier: "render_motion", scratchRoot: outDir, promptCwdRoots: ["/workspace"],
        hostReceiptWriter: async (root, receipt) => { order.push(receipt.id); const path = join(root, `${receipt.id}.receipt.json`); await mkdir(root, { recursive: true }); await writeFile(path, `${JSON.stringify(receipt)}\n`, "utf8"); return path; },
        promptRuntime: { runPrompt: async (input) => ({
          ok: false, error: { code: "agent_process_failed", message: "fake exited 17" },
          receipt: { schema: "shellx-motion/receipt@1", id: "agent-debug-failed-001", operation: "agent.prompt", status: "failed", packageId: input.packageId ?? "unknown", inputHashes: { prompt: "a".repeat(64), context: "b".repeat(64) }, createdAt: "2026-07-01T00:00:00.000Z", lane: "agent", output: { agentId: input.agentId ?? "fake", label: "Fake Agent", transport: "local-cli", billing: "cli-subscription", command: { executable: "fake", args: ["run"], shell: false }, transcript: [], permission: input.permission }, warnings: ["process exited 17"] }
        }) }
      });
      expect(result).toMatchObject({ ok: false, error: { code: "agent_process_failed" }, receiptId: expect.stringMatching(/^prompt-/) });
      expect(order).toEqual(["agent-debug-failed-001", expect.stringMatching(/^prompt-/)]);
      if (!result.ok) expect(result.result).toMatchObject({ agent: { receipt: { id: "agent-debug-failed-001" } }, agentReceiptPath: join(receiptsRoot, "agent-debug-failed-001.receipt.json"), receipt: { output: { agentReceiptId: "agent-debug-failed-001", agentReceiptPath: join(receiptsRoot, "agent-debug-failed-001.receipt.json"), linkedReceiptIds: ["agent-debug-failed-001"] } } });
    } finally { await rm(outDir, { recursive: true, force: true }); }
  });
});
