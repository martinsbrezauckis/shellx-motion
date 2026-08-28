import { describe, expect, it } from "vitest";
import { consumeWorkbenchBootstrapClaim } from "./workbench-bootstrap-claim.js";

describe("Workbench bootstrap claim", () => {
  it("consumes a handoff only once and fails closed when cleanup fails", async () => {
    let claims = 0;
    const security = {
      workbenchBootstrapToken: "bootstrap",
      onWorkbenchBootstrapClaim: () => { claims += 1; }
    };
    await expect(consumeWorkbenchBootstrapClaim(security)).resolves.toBe(true);
    expect(security.workbenchBootstrapToken).toBeNull();
    await expect(consumeWorkbenchBootstrapClaim(security)).resolves.toBe(false);
    expect(claims).toBe(1);

    const failed = { workbenchBootstrapToken: "bootstrap", onWorkbenchBootstrapClaim: () => { throw new Error("cleanup"); } };
    await expect(consumeWorkbenchBootstrapClaim(failed)).resolves.toBe(false);
    expect(failed.workbenchBootstrapToken).toBeNull();
  });
});
