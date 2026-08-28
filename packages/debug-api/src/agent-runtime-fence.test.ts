import { describe, expect, it } from "vitest";
import { dispatchDebugCommand } from "./index";

describe("debug API agent runtime fence", () => {
  it("refuses prompt and agent execution until the debug host injects their runtimes", async () => {
    await expect(dispatchDebugCommand("motion.agent.health", {}, { tier: "read_motion" })).resolves.toMatchObject({
      ok: false,
      error: {
        code: "capability_unavailable",
        message: "Agent health is unavailable because this host did not inject an agent runtime."
      }
    });

    await expect(dispatchDebugCommand("motion.prompt.run", { request: "inspect the package" }, { tier: "draft_motion" })).resolves.toMatchObject({
      ok: false,
      error: {
        code: "capability_unavailable",
        message: "Prompt execution is unavailable because this host did not inject a prompt runtime."
      }
    });
  });
});
