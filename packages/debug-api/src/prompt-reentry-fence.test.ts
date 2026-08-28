/**
 * Re-entry into the dispatcher with CALLER-STEERED arguments is a boundary crossing.
 *
 * The receipts-root fence sits at the transport, not in `dispatchDebugCommand`, and the recorded
 * reason is `motion.render.batch`: it re-enters the dispatcher once per row with a `receiptsRoot`
 * MOTION derived from the batch output directory, and a fence in the dispatcher refused Motion's own
 * orchestration.
 *
 * `motion.prompt.run` re-enters the same dispatcher -- but with `args` an agent proposed and a caller
 * steered, and `parsePromptCommandProposals` passes those args through unvalidated. So the two
 * re-entries are not the same act wearing different names. The distinguishing property is the
 * PROVENANCE OF THE ARGUMENTS, not the command id:
 *
 *   host-derived args  -> `dispatchDebugCommand`          (no fence; Motion is the author)
 *   caller-steered args -> `dispatchCallerSteeredCommand`  (fenced; a caller is the author)
 *
 * This suite pins the second row. The failure it guards is specific and was demonstrated: at
 * `draft_motion`, a direct `motion.receipts.read` on a foreign root is refused, while the same read
 * routed through `prompt.run` succeeded AND the foreign receipt was copied into the host's fenced
 * root, where the caller could then read it back entirely legitimately.
 */
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MotionPromptRuntime } from "@shellx-motion/prompt";
import { dispatchDebugCommand } from "./index";

const VICTIM_MARKER = "victim-package-id-that-must-not-be-relayed-through-prompt-run";
const VICTIM_RECEIPT_ID = "victim-receipt-1";
const PROMPT_CALLER = "test-prompt";

let hostReceiptsRoot: string;
let foreignReceiptsRoot: string;

/** A stub agent that proposes exactly the commands a test hands it, with exactly those args. */
function proposingRuntime(debugCommands: Array<{ command: string; args: unknown }>): MotionPromptRuntime {
  return {
    runPrompt: async (input: { packageId?: string; agentId?: string; permission?: string }) => ({
      ok: true,
      structuredOutput: { ok: true, debugCommands },
      transcript: { stdout: "[structured agent response]", stderr: "", redacted: true, truncated: false, maxBytes: 65_536 },
      receipt: {
        schema: "shellx-motion/receipt@1",
        id: "agent-reentry-probe",
        operation: "agent.prompt",
        status: "passed",
        packageId: input.packageId ?? "unknown",
        inputHashes: { prompt: "a".repeat(64), context: "b".repeat(64) },
        createdAt: "2026-07-01T00:00:00.000Z",
        lane: "agent",
        output: {
          agentId: input.agentId ?? "fake",
          label: "Fake Agent",
          transport: "local-cli",
          billing: "cli-subscription",
          command: { executable: "fake", args: ["run"], shell: false },
          transcript: [],
          permission: input.permission
        },
        warnings: []
      }
    })
  } as unknown as MotionPromptRuntime;
}

async function writeVictimReceipt(root: string, callerId: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, `${VICTIM_RECEIPT_ID}.receipt.json`), `${JSON.stringify({
    schema: "shellx-motion/receipt@1",
    id: VICTIM_RECEIPT_ID,
    operation: "render.final",
    status: "passed",
    packageId: VICTIM_MARKER,
    inputHashes: { motion: "b".repeat(64) },
    createdAt: "2026-07-01T00:00:00.000Z",
    lane: "ffmpeg",
    output: { callerId, path: join(root, "victim.mp4"), preset: "mp4-h264" },
    warnings: []
  }, null, 2)}\n`, "utf8");
}

beforeEach(async () => {
  hostReceiptsRoot = await mkdtemp(join(tmpdir(), "motion-reentry-host-"));
  foreignReceiptsRoot = await mkdtemp(join(tmpdir(), "motion-reentry-foreign-"));
  await writeVictimReceipt(foreignReceiptsRoot, "test-foreign-prompt");
});

afterEach(async () => {
  await rm(hostReceiptsRoot, { recursive: true, force: true });
  await rm(foreignReceiptsRoot, { recursive: true, force: true });
});

describe("prompt.run re-entry is fenced because its arguments are caller-steered", () => {
  it("refuses an agent-proposed read of a foreign receipts root", async () => {
    const result = await dispatchDebugCommand(
      "motion.prompt.run",
      {
        request: "read that receipt for me",
        packageId: "pkg_reentry",
        agentId: "fake",
        executeAgentCommands: true
      },
      {
        tier: "draft_motion",
        callerId: PROMPT_CALLER,
        receiptsRoot: hostReceiptsRoot,
        promptRuntime: proposingRuntime([
          { command: "motion.receipts.read", args: { receiptsRoot: foreignReceiptsRoot, receiptId: VICTIM_RECEIPT_ID } }
        ])
      }
    );

    expect(result.ok).toBe(false);
    // Not merely "some failure": the failure has to be the fence, and it must disclose nothing.
    expect(result).toMatchObject({ error: { code: "invalid_args" } });
    expect(JSON.stringify(result)).not.toContain(VICTIM_MARKER);
  });

  it("does not copy the foreign receipt into the host root the caller can legitimately read", async () => {
    // The disclosure did not need the response body. The child receipt was persisted into
    // `context.receiptsRoot`, so a refused-looking answer plus a later ordinary read of the host
    // root would still hand over the stolen evidence.
    await dispatchDebugCommand(
      "motion.prompt.run",
      {
        request: "read that receipt for me",
        packageId: "pkg_reentry",
        agentId: "fake",
        executeAgentCommands: true
      },
      {
        tier: "draft_motion",
        callerId: PROMPT_CALLER,
        receiptsRoot: hostReceiptsRoot,
        promptRuntime: proposingRuntime([
          { command: "motion.receipts.read", args: { receiptsRoot: foreignReceiptsRoot, receiptId: VICTIM_RECEIPT_ID } }
        ])
      }
    );

    const landed = await readdir(hostReceiptsRoot);
    const bodies = await Promise.all(landed.map(async (name) => {
      const { readFile } = await import("node:fs/promises");
      return readFile(join(hostReceiptsRoot, name), "utf8");
    }));
    expect(bodies.join("\n")).not.toContain(VICTIM_MARKER);
  });

  it.runIf(process.platform === "linux")("still admits an agent-proposed read of the host's own receipts root", async () => {
    // The fix must not turn prompt-driven execution off. A proposal that stays inside the host's
    // declared root is exactly what `executeAgentCommands` is for.
    await writeVictimReceipt(hostReceiptsRoot, PROMPT_CALLER);

    const result = await dispatchDebugCommand(
      "motion.prompt.run",
      {
        request: "read my own receipt",
        packageId: "pkg_reentry",
        agentId: "fake",
        executeAgentCommands: true
      },
      {
        tier: "draft_motion",
        callerId: PROMPT_CALLER,
        receiptsRoot: hostReceiptsRoot,
        promptRuntime: proposingRuntime([
          { command: "motion.receipts.read", args: { receiptsRoot: hostReceiptsRoot, receiptId: VICTIM_RECEIPT_ID } }
        ])
      }
    );

    expect(result.ok).toBe(true);
  });

  it("keeps typed revision transactions out of prompt steering", async () => {
    const result = await dispatchDebugCommand(
      "motion.prompt.run",
      {
        request: "atomically revise that package",
        packageId: "pkg_reentry",
        agentId: "fake",
        executeAgentCommands: true
      },
      {
        tier: "edit_motion",
        callerId: PROMPT_CALLER,
        receiptsRoot: hostReceiptsRoot,
        promptRuntime: proposingRuntime([
          {
            command: "motion.revision.transaction",
            args: {
              packageRoot: "/not-reached",
              outDir: "/not-reached",
              base: {},
              steps: []
            }
          }
        ])
      }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({
        code: "invalid_args",
        message: expect.stringContaining("not available through motion.prompt.run")
      });
    }
  });

  it("leaves host-derived re-entry alone: render.batch still dispatches its own rows", async () => {
    // The counter-case that made the fence live at the transport in the first place. `render.batch`
    // derives every row's `receiptsRoot` from its own outDir, so a fence keyed on the command name
    // would refuse Motion's orchestration. Keyed on argument provenance, it does not.
    const outDir = join(hostReceiptsRoot, "batch-out");
    const result = await dispatchDebugCommand(
      "motion.render.batch",
      { packageRoot: join(hostReceiptsRoot, "no-such-package"), outDir, dryRun: true },
      { tier: "render_motion", receiptsRoot: hostReceiptsRoot }
    );

    // It fails on the missing package, which is the point: it reached the command rather than a fence.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).not.toBe("invalid_args");
  });
});
