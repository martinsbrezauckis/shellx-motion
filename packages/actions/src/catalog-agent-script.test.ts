import { describe, expect, it } from "vitest";
import { ACTIONS } from "./catalog";
import { AGENT_SCRIPT_ACTION } from "./catalog-agent-script";

describe("approved-agent-entry action catalog", () => {
  it("publishes the host-gated authoring action with its required receipt verification", () => {
    expect(ACTIONS.find((entry) => entry.id === "motion.package.script.author")).toEqual(AGENT_SCRIPT_ACTION);
    expect(AGENT_SCRIPT_ACTION).toMatchObject({
      permission: "write_local",
      mutates: true,
      calls: ["motion.package.script.author", "motion.preview.frame", "motion.receipts.read"],
      surfaces: ["packages"]
    });
    expect(AGENT_SCRIPT_ACTION.verify.join(" ")).toContain("requested and active script mode");
  });
});
