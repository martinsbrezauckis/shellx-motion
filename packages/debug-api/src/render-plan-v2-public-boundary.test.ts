/** The source-only V2 preflight may not become a Debug command or host-context authorization seam. */
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import * as publicDebug from "./index.js";

describe("render-plan V2 public boundary", () => {
  it("exposes no V2 activation export, command, context/service field, or coordinator handoff", async () => {
    const indexSource = await readFile(new URL("./index.ts", import.meta.url), "utf8");
    const coordinatorSource = await readFile(new URL("./coordinator-submit-handler.ts", import.meta.url), "utf8");
    const activationSymbols = [
      "createPrivateCoordinatedRenderV2Capability",
      "coordinatedRenderV2Implementation",
      "assertV2Capability",
      "preflightV2CapabilityAuthority",
      "preflightV2CapabilityAuthorityForTest",
      "renderPlanV2SubmissionAuthority",
      "PrivateCoordinatedRenderV2Capability",
      "V2CapabilityPreflightImplementation",
      "V2CapabilityPreflightAuthority",
      "observeV2StreamedMp4Tools",
      "renderPlanV2",
      "planV2",
      "v2Permit",
      "v2Observer",
      "v2ToolRunner",
      "v2Authority",
      "v2Execute",
    ];

    // The read-only parser/schema exports remain valid historical inspection surface. Nothing
    // exported here may mint, bind, submit, or activate a V2 plan.
    expect(publicDebug).toHaveProperty("DEBUG_COMMANDS");
    expect((publicDebug.DEBUG_COMMANDS as readonly string[]).filter((command) => /v2/iu.test(command))).toEqual([]);
    for (const symbol of activationSymbols) {
      expect(publicDebug).not.toHaveProperty(symbol);
      expect(indexSource).not.toContain(symbol);
      expect(coordinatorSource).not.toContain(symbol);
    }
  });
});
