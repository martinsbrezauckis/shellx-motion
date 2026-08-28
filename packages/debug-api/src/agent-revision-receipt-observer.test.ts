import { describe, expect, it } from "vitest";
import { dispatchAgentRevisionCommand } from "./domains/agent-revision.js";

describe("agent revision receipt observer", () => {
  it("keeps a committed plan observable when host receipt persistence fails", async () => {
    const planPath = "/trusted/revision-plan.json";
    const receiptsRoot = "/trusted/receipts";
    const order: string[] = [];

    const result = await dispatchAgentRevisionCommand(
      "motion.agent.revision.plan",
      {
        packageId: "pkg_revision_observer",
        planId: "revision-observer",
        createdAt: "2026-08-21T00:00:00.000Z",
        planPath,
        receiptsRoot
      },
      {
        isPathInsideTrustedRoot: async () => true,
        readAgentRevisionEvidence: async () => ({ ok: true, evidence: { qualityReceipts: [] } }),
        writeJson: async (path, value) => {
          order.push(`plan:${path}`);
          expect(value).toMatchObject({ planId: "revision-observer", packageId: "pkg_revision_observer" });
        },
        writeReceipt: async (root, receipt) => {
          order.push(`receipt:${root}`);
          expect(receipt).toMatchObject({ id: "revision-observer", operation: "agent.revision.plan" });
          throw new Error("injected host receipt failure after plan commit");
        }
      }
    );

    expect(order).toEqual([`plan:${planPath}`, `receipt:${receiptsRoot}`]);
    expect(result).toMatchObject({
      ok: false,
      receiptId: "revision-observer",
      error: {
        code: "agent_revision_plan_receipt_observer_failed",
        detail: {
          planCommitted: true,
          planPath,
          publicPaths: [planPath],
          receiptObserver: { status: "failed", receiptId: "revision-observer" }
        }
      },
      result: {
        planCommitted: true,
        planPath,
        plan: { planId: "revision-observer", packageId: "pkg_revision_observer" },
        expectedReceipt: { id: "revision-observer", operation: "agent.revision.plan" },
        receiptObserver: { status: "failed", receiptId: "revision-observer" }
      }
    });
  });
});
