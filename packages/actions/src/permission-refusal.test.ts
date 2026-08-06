/**
 * The wording contract for refusals.
 *
 * A `suggestedAction` is a promise that its READER can carry it out. "Retry with write_local
 * permission." broke that promise for every agent that received it — no elevation command exists,
 * requestedTier is capped at the host's startup grant — and an agent that believes a suggestion
 * retries it, so the false suggestion cost more than none.
 */
import { describe, expect, it } from "vitest";
import { debugServerGrantHint, requestedTierRefusal, tierRefusal, trustedRootRefusal } from "./catalog.js";
import type { MotionPermissionTier } from "./catalog.js";

const TIERS: MotionPermissionTier[] = ["read_motion", "draft_motion", "render_motion", "edit_motion", "write_local", "push_remote"];

describe("tier refusals", () => {
  it.each(TIERS)("never tells the caller to retry with %s", (tier) => {
    const refusal = tierRefusal({ subject: "motion.render.final", requiredTier: tier, grantedTier: "read_motion" });

    expect(refusal.suggestedAction).not.toMatch(/retry with/i);
    expect(refusal.suggestedAction).toContain("cannot raise its own permission tier");
    // The suggestion is re-addressed to the party that can act on it.
    expect(refusal.suggestedAction).toContain("the host operator must");
    expect(refusal.detail.resolvedBy).toBe("host_operator");
    expect(refusal.detail.selfElevation).toBe("unavailable");
  });

  it("names the concrete flag the host operator changes", () => {
    expect(debugServerGrantHint("edit_motion")).toBe("restart the Motion debug server with `--tier edit_motion --trusted-local-tier`");
    // push_remote is gated twice; a hint that named only --tier would send the operator into a
    // second refusal.
    expect(debugServerGrantHint("push_remote")).toContain("--allow-push-remote");
  });

  it("reports both the required and the held tier", () => {
    const refusal = tierRefusal({ subject: "motion.package.patch", requiredTier: "edit_motion", grantedTier: "read_motion" });

    expect(refusal.message).toBe("motion.package.patch requires edit_motion; this session holds read_motion.");
    expect(refusal.detail).toMatchObject({ requiredTier: "edit_motion", grantedTier: "read_motion" });
  });

  it("omits the held tier rather than guessing when the layer does not know it", () => {
    const refusal = tierRefusal({ subject: "motion.package.patch", requiredTier: "edit_motion" });

    expect(refusal.message).toBe("motion.package.patch requires edit_motion.");
    expect(refusal.detail.grantedTier).toBeUndefined();
  });

  it("lets an embedding host substitute its own grant instruction", () => {
    // The default names the shipped debug server's flags. A host that grants tiers some other way
    // must not be made to publish an instruction that does not apply to it.
    const refusal = tierRefusal({
      subject: "motion.render.final",
      requiredTier: "render_motion",
      grantedTier: "read_motion",
      hostGrantHint: "enable Motion rendering in ShellX settings"
    });

    expect(refusal.suggestedAction).toContain("enable Motion rendering in ShellX settings");
    expect(refusal.suggestedAction).not.toContain("--tier");
  });

  it("tells a would-be escalator to stop escalating", () => {
    const refusal = requestedTierRefusal({ requestedTier: "write_local", grantedTier: "read_motion" });

    // The leading sentence is unchanged: hosts match on it.
    expect(refusal.message).toContain("Requested Motion permission tier write_local exceeds the authenticated server grant read_motion.");
    expect(refusal.suggestedAction).toContain("at or below read_motion");
    expect(refusal.suggestedAction).not.toMatch(/retry with/i);
  });
});

describe("trusted root refusals", () => {
  it("lists the roots in force and who can add one", () => {
    const refusal = trustedRootRefusal({ subject: "motion.prompt.run", argument: "cwd", roots: ["/work/a", "/work/b"] });

    expect(refusal.message).toContain("Trusted roots for this session: /work/a, /work/b.");
    expect(refusal.suggestedAction).toContain("the host operator must");
    expect(refusal.detail.trustedRoots).toEqual(["/work/a", "/work/b"]);
  });

  it("does not tell a caller to pick from an empty list", () => {
    const refusal = trustedRootRefusal({ subject: "motion.prompt.run", argument: "cwd", roots: [] });

    expect(refusal.message).toContain("no trusted prompt working roots configured");
    // With no roots there is no path that would work, so the only honest instruction is to drop
    // the argument.
    expect(refusal.suggestedAction).toContain("Omit cwd");
  });
});
