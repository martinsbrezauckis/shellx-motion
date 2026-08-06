/**
 * Caller-supplied sample counts are bounded before anything is allocated.
 *
 * Guards two sealed security review findings of the same shape: a compact request naming a huge
 * `sampleCount` / `recordingSampleCount` drove work far out of proportion to the request. Both
 * arguments had a floor and no ceiling.
 *
 * These assert the REFUSAL rather than measuring allocation, deliberately. A test that tried to
 * observe the unbounded behaviour would have to actually allocate it, which is the thing being
 * prevented -- so the invariant under test is "the request is rejected before the work starts",
 * which is exactly what the argument check provides.
 */
import { describe, expect, it } from "vitest";
import { dispatchDebugCommand } from "./index";

describe("read-tier easing panel sample bounds", () => {
  it("refuses a sample count above the documented maximum", async () => {
    const result = await dispatchDebugCommand(
      "motion.timeline.easing.panel",
      { packageRoot: "/nonexistent-package", sampleCount: 5_000_000 },
      { tier: "read_motion" }
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid_args");
    expect(result.error.message).toContain("512 or fewer");
  });

  it("still refuses a sample count below the documented minimum", async () => {
    // The floor predates the ceiling; keep both proved so a later edit cannot drop one silently.
    const result = await dispatchDebugCommand(
      "motion.timeline.easing.panel",
      { packageRoot: "/nonexistent-package", sampleCount: 1 },
      { tier: "read_motion" }
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid_args");
    expect(result.error.message).toContain("greater than or equal to 2");
  });

  it("rejects the oversized count before it ever touches the package root", async () => {
    // packageRoot below does not exist. A refusal that mentions the bound rather than a filesystem
    // error is the proof that the check runs before any load or allocation.
    const result = await dispatchDebugCommand(
      "motion.timeline.easing.panel",
      { packageRoot: "/definitely/not/a/real/package/root", sampleCount: 1_000_000 },
      { tier: "read_motion" }
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("512 or fewer");
    expect(result.error.message).not.toContain("ENOENT");
  });
});

describe("browser recording sample bounds", () => {
  it("refuses a recording sample count above the documented maximum", async () => {
    // Each sample is a browser render written to disk, so this bounds work and disk, not just memory.
    const result = await dispatchDebugCommand(
      "motion.browser.workflow.capture",
      { packageRoot: "/nonexistent-package", recordingSampleCount: 1_000_000 },
      { tier: "render_motion" }
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid_args");
    expect(result.error.message).toContain("240 or fewer");
  });
});

describe("published contracts state the bounds they enforce", () => {
  it("declares both maxima in the argument schemas agents read", async () => {
    // An agent plans from the contract, so a bound the contract omits is a bound the caller only
    // discovers by being refused. These assertions keep schema and enforcement from drifting apart.
    const { DEBUG_COMMAND_CONTRACTS } = await import("./index");
    const schemaFor = (command: string): Record<string, any> => {
      const contract = DEBUG_COMMAND_CONTRACTS.find((entry) => entry.command === command) as any;
      if (!contract) throw new Error(`Missing contract: ${command}`);
      return contract.argsSchema.properties;
    };

    expect(schemaFor("motion.timeline.easing.panel").sampleCount).toMatchObject({ minimum: 2, maximum: 512 });
    expect(schemaFor("motion.browser.workflow.capture").recordingSampleCount).toMatchObject({ minimum: 1, maximum: 240 });
  });
});
