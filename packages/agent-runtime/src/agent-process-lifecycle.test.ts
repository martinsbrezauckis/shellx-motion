import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAgentRuntime, type AgentAdapter } from "./index";

describe("agent process lifecycle", () => {
  it.skipIf(process.platform === "win32")("does not complete while a leader-first signal-resistant descendant remains", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-agent-leader-first-"));
    try {
      const grandchildPidPath = join(outDir, "grandchild.pid");
      const parentCode = [
        "const { spawn } = require('node:child_process')",
        "const { writeFileSync } = require('node:fs')",
        "const child = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"], { stdio: 'ignore' })",
        "writeFileSync(process.argv[1], String(child.pid))",
        "setTimeout(() => process.exit(0), 50)"
      ].join("; ");
      const adapter: AgentAdapter = {
        id: "leader-first",
        label: "Leader-first Agent",
        transport: "local-cli",
        billing: "cli-subscription",
        probeCommand: () => ({ executable: process.execPath, args: ["-e", "process.stdout.write('ok')"], shell: false }),
        promptCommand: (input) => ({ executable: process.execPath, args: ["-e", parentCode, grandchildPidPath], stdin: input.prompt, timeoutMs: 1_000, shell: false }),
      };

      const result = await buildAgentRuntime({ adapters: [adapter] }).runPrompt({
        agentId: "leader-first",
        prompt: "prove leader-first teardown",
        packageId: "lower-third",
        permission: "render_motion",
      });

      // This test owns containment, not the subsequent prompt-output diagnosis.
      // Linux reaches the empty-stdout parser path after the group is gone;
      // Darwin can surface the contained terminal failure first. Both are
      // explicit fail-closed outcomes, while `index.test.ts` owns the direct
      // `agent_invalid_output` contract.
      expect(result).toMatchObject({ ok: false, receipt: { status: "failed" } });
      if (result.ok) throw new Error("Expected the leader-first agent run to fail closed.");
      expect(["agent_invalid_output", "agent_failed"]).toContain(result.error.code);
      const grandchildPid = Number(await readFile(grandchildPidPath, "utf8"));
      expect(Number.isSafeInteger(grandchildPid)).toBe(true);
      await expectProcessToExit(grandchildPid);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  }, 45_000);
});

async function expectProcessToExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  throw new Error(`Agent descendant ${pid} remained alive after contained termination.`);
}
