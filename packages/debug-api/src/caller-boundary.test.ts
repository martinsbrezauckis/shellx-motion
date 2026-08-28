import { describe, expect, it } from "vitest";
import { callerSuppliedReceiptsRoot, refuseCallerReceiptsRoot } from "./caller-boundary.js";

describe("caller receipt-root boundary", () => {
  it("does not reinterpret whitespace-only caller input as an omitted host choice", async () => {
    const requested = callerSuppliedReceiptsRoot({ receiptsRoot: "   " });
    expect(requested).toBe("   ");
    const refusal = await refuseCallerReceiptsRoot(
      "motion.package.validate",
      requested,
      { receiptsRoot: "/host/receipts" },
      async () => false,
    );
    expect(refusal).toMatchObject({ ok: false, error: { code: "invalid_args" } });
  });
});
