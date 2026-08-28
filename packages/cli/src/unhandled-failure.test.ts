import { describe, expect, it } from "vitest";
import { LocalMotionJobError } from "@shellx-motion/core";
import { unhandledFailure } from "./unhandled-failure";

describe("CLI bounded input failure", () => {
  it("keeps host-capacity refusals typed and actionable", () => {
    expect(unhandledFailure(new LocalMotionJobError(
      "job_input_budget_exceeded",
      "This document exceeds the portable point tier.",
    ))).toMatchObject({
      ok: false,
      error: {
        code: "job_input_budget_exceeded",
        message: "This document exceeds the portable point tier.",
        suggestedAction: expect.stringContaining("motion.capabilities.match"),
      },
    });
  });
});
