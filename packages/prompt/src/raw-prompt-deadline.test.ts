import { describe, expect, it } from "vitest";
import { RAW_PROMPT_REDACTION_WARNING_PREFIX, runMotionPrompt } from "./index.js";
import { createFakePromptRuntime } from "./index.test-support.js";

describe("raw prompt creation deadline", () => {
  it("redacts before returning when provider execution crosses the deadline", async () => {
    const request = "Project Cobalt provider-delayed replay";
    const times = ["2026-07-01T00:00:00.000Z", "2026-07-01T00:00:02.000Z"];
    const result = await runMotionPrompt({
      request, tier: "render_motion", agentId: "fake", runtime: createFakePromptRuntime(), packageId: "private-package",
      retention: { mode: "raw_request", purpose: "debugging", deleteAfter: "2026-07-01T00:00:01.000Z" },
      now: () => times.shift() ?? "2026-07-01T00:00:02.000Z"
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.stringify(result.receipt)).not.toContain(request);
    expect(result.receipt.output).toMatchObject({ promptRetention: {
      mode: "raw_request", rawRequestRetained: false, rawRequestRedactedAt: "2026-07-01T00:00:02.000Z"
    } });
    expect(result.receipt.warnings.some((warning) => warning.startsWith(RAW_PROMPT_REDACTION_WARNING_PREFIX))).toBe(true);
  });
});
