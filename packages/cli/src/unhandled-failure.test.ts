import { describe, expect, it } from "vitest";
import { LocalMotionJobError } from "@shellx-motion/core";
import {
  MAX_CLI_UNHANDLED_FAILURE_PUBLIC_BYTES,
  unhandledFailure
} from "./unhandled-failure";

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

  it("bounds and sanitizes an escaped throw without changing its error code", () => {
    const splitToken = `sk-proj-${"a".repeat(10)}\u001b[0m${"b".repeat(10)}`;
    const result = unhandledFailure(new Error(`${splitToken} C:\\Users\\TestUser\\private.txt /opt/fixture/private\u061c ${"x".repeat(128 * 1024)}`));

    expect(result).toMatchObject({ ok: false, error: { code: "internal_error", message: expect.stringContaining("[redacted]") } });
    const message = (result as unknown as { error: { message: string } }).error.message;
    expect(message).not.toContain("sk-proj-");
    expect(message).not.toContain("C:\\Users\\TestUser");
    expect(message).not.toContain("/opt/fixture/private");
    expect(message).not.toContain("\u001b");
    expect(message).not.toContain("\u061c");
    expect(Buffer.byteLength(message)).toBeLessThanOrEqual(MAX_CLI_UNHANDLED_FAILURE_PUBLIC_BYTES);
  });
});
