import { describe, expect, it } from "vitest";
import { runMotionPrompt, type MotionPromptRuntime } from "./index";

describe("failed prompt receipt linkage", () => {
  it("preserves a failed agent receipt and links it from the failed prompt receipt", async () => {
    const runtime: MotionPromptRuntime = { runPrompt: async () => ({
      ok: false, error: { code: "agent_process_failed", message: "fake exited 17" },
      receipt: {
        schema: "shellx-motion/receipt@1", id: "agent-failed-001", operation: "agent.prompt", status: "failed", packageId: "lower-third",
        inputHashes: { prompt: "a".repeat(64), context: "b".repeat(64) }, createdAt: "2026-06-29T20:36:00.000Z", lane: "agent",
        output: { agentId: "fake", label: "Fake Agent", transport: "local-cli", billing: "cli-subscription", command: { executable: "fake", args: ["run"], shell: false }, transcript: [], permission: "render_motion" }, warnings: ["process exited 17"]
      }
    }) };
    const result = await runMotionPrompt({ request: "preview current package", tier: "render_motion", agentId: "fake", runtime, packageId: "lower-third", now: () => "2026-06-29T20:36:00.000Z" });
    expect(result).toMatchObject({
      ok: false, agent: { receipt: { id: "agent-failed-001", status: "failed" } },
      receipt: { output: { agentId: "fake", agentReceiptId: "agent-failed-001", linkedReceiptIds: ["agent-failed-001"] } }
    });
  });
});
