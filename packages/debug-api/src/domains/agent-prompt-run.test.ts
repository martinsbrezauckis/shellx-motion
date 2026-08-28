import { describe, expect, it } from "vitest";
import { createFakePromptRuntime } from "@shellx-motion/prompt/test-support";
import { dispatchAgentPromptRunCommand } from "./agent-prompt-run.js";

const RAW_REQUEST = "raw prompt that must never reach an unpurgeable receipt";
const HOST_RECEIPTS_ROOT = "/host/receipts";

function rawRetentionArgs(deleteAfter = new Date(Date.now() + 60 * 60 * 1000).toISOString()) {
  return {
    request: RAW_REQUEST,
    packageId: "pkg_raw_retention",
    agentId: "fake",
    retainRawRequest: true,
    rawRequestDeleteAfter: deleteAfter,
    rawRequestPurpose: "debugging"
  } as const;
}

describe("motion.prompt.run raw retention admission", () => {
  it("refuses an unavailable stable purge capability before prompt execution or receipt output", async () => {
    let runtimeCalls = 0;
    const writes: string[] = [];
    const runtime = createFakePromptRuntime();

    const result = await dispatchAgentPromptRunCommand(
      "motion.prompt.run",
      rawRetentionArgs(),
      {
        tier: "draft_motion",
        receiptsRoot: HOST_RECEIPTS_ROOT,
        hasStableReceiptPurgeCapability: () => false,
        promptRuntime: {
          runPrompt: async (input) => {
            runtimeCalls += 1;
            return await runtime.runPrompt(input);
          }
        },
        writeReceipt: async (_root, receipt) => {
          writes.push(receipt.id);
          return `${HOST_RECEIPTS_ROOT}/${receipt.id}.receipt.json`;
        }
      }
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "capability_unavailable", message: expect.stringContaining("stable receipt read-and-purge") }
    });
    expect(runtimeCalls).toBe(0);
    expect(writes).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(RAW_REQUEST);
  });

  it("does not emit an inline raw receipt when the host omitted governed receipt persistence", async () => {
    let runtimeCalls = 0;
    const runtime = createFakePromptRuntime();

    const result = await dispatchAgentPromptRunCommand(
      "motion.prompt.run",
      rawRetentionArgs(),
      {
        tier: "draft_motion",
        // The positive seam isolates this test from the local platform. The missing host receipt
        // root is the refusal under test: a raw receipt cannot be returned merely because the
        // stable reader would work somewhere else.
        hasStableReceiptPurgeCapability: () => true,
        promptRuntime: {
          runPrompt: async (input) => {
            runtimeCalls += 1;
            return await runtime.runPrompt(input);
          }
        }
      }
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "capability_unavailable", message: expect.stringContaining("host-configured receipt root") }
    });
    expect(runtimeCalls).toBe(0);
    expect(JSON.stringify(result)).not.toContain(RAW_REQUEST);
  });

  it("keeps ordinary summary-only prompts portable when raw retention is unavailable", async () => {
    let runtimeCalls = 0;
    const writes: string[] = [];
    const runtime = createFakePromptRuntime();

    const result = await dispatchAgentPromptRunCommand(
      "motion.prompt.run",
      { request: "describe the current Motion package", packageId: "pkg_summary", agentId: "fake" },
      {
        tier: "draft_motion",
        receiptsRoot: HOST_RECEIPTS_ROOT,
        hasStableReceiptPurgeCapability: () => false,
        promptRuntime: {
          runPrompt: async (input) => {
            runtimeCalls += 1;
            return await runtime.runPrompt(input);
          }
        },
        writeReceipt: async (_root, receipt) => {
          writes.push(receipt.id);
          return `${HOST_RECEIPTS_ROOT}/${receipt.id}.receipt.json`;
        }
      }
    );

    expect(result).toMatchObject({
      ok: true,
      result: { receipt: { output: { promptRetention: { mode: "summary_only", rawRequestRetained: false } } } }
    });
    expect(runtimeCalls).toBe(1);
    expect(writes).toHaveLength(2);
  });

  it.runIf(process.platform === "linux")("admits raw retention on Linux when the host provides a stable receipt reservation", async () => {
    const writes: string[] = [];
    let closed = false;

    const result = await dispatchAgentPromptRunCommand(
      "motion.prompt.run",
      rawRetentionArgs(),
      {
        tier: "draft_motion",
        receiptsRoot: HOST_RECEIPTS_ROOT,
        promptRuntime: createFakePromptRuntime(),
        writeReceipt: async (_root, receipt) => {
          writes.push(receipt.id);
          return `${HOST_RECEIPTS_ROOT}/${receipt.id}.receipt.json`;
        },
        reserveRawPromptReceiptRoot: async () => ({
          writeReceipt: async (receipt) => {
            writes.push(receipt.id);
            return `${HOST_RECEIPTS_ROOT}/${receipt.id}.receipt.json`;
          },
          close: async () => { closed = true; }
        })
      }
    );

    expect(result).toMatchObject({
      ok: true,
      result: {
        receipt: {
          output: {
            rawRequest: RAW_REQUEST,
            promptRetention: { mode: "raw_request", rawRequestRetained: true, purpose: "debugging" }
          }
        }
      }
    });
    expect(writes).toHaveLength(2);
    expect(closed).toBe(true);
  });

  it("redacts raw parents after a receipt write crosses the deadline in every prompt outcome", async () => {
    const createdAt = "2040-01-01T00:00:00.000Z";
    const deleteAfter = "2040-01-01T00:00:01.000Z";
    const expiredAt = "2040-01-01T00:00:02.000Z";
    for (const outcome of ["success", "failure", "proposal", "execution"] as const) {
      let now = createdAt;
      let executions = 0;
      const writes: string[] = [];
      const fake = createFakePromptRuntime();
      const result = await dispatchAgentPromptRunCommand(
        "motion.prompt.run",
        { ...rawRetentionArgs(deleteAfter), ...(outcome === "proposal" || outcome === "execution" ? { executeAgentCommands: true } : {}) },
        {
          tier: "draft_motion", receiptsRoot: HOST_RECEIPTS_ROOT, hasStableReceiptPurgeCapability: () => true, promptNow: () => now,
          promptRuntime: { runPrompt: async (input: Parameters<typeof fake.runPrompt>[0]) => {
            const agent = await fake.runPrompt(input);
            if (!agent.ok) throw new Error("fake prompt runtime unexpectedly failed");
            if (outcome === "failure") return { ok: false as const, error: { code: "agent_failed", message: "provider failed" }, receipt: { ...agent.receipt, status: "failed" as const } };
            return outcome === "proposal" ? { ...agent, structuredOutput: [] } : outcome === "execution" ? { ...agent, structuredOutput: { debugCommands: [] } } : agent;
          } },
          reserveRawPromptReceiptRoot: async () => ({
            writeReceipt: async (receipt) => {
              writes.push(JSON.stringify(receipt));
              if (receipt.operation === "agent.prompt") now = expiredAt;
              return `${HOST_RECEIPTS_ROOT}/${receipt.id}.receipt.json`;
            },
            close: async () => {}
          }),
          executePromptCommands: async () => {
            executions += 1;
            return { commandCount: 0, receiptIds: [], commands: [] };
          }
        }
      );

      expect(writes).toHaveLength(2);
      expect(writes.at(-1)).not.toContain(RAW_REQUEST);
      if (outcome === "proposal") {
        expect(result).toMatchObject({ ok: false, error: { code: "invalid_prompt_command_proposal" } });
      } else {
        expect(JSON.stringify((result as { result?: { receipt?: unknown } }).result?.receipt)).not.toContain(RAW_REQUEST);
        expect(result).toMatchObject({ result: { receipt: { output: { promptRetention: { rawRequestRetained: false, rawRequestRedactedAt: expiredAt } } } } });
      }
      expect(executions).toBe(outcome === "execution" ? 1 : 0);
    }
  });
});
