/**
 * The class guard for tier refusals.
 *
 * The reported defect was one sentence — "Retry with write_local permission." — but it was emitted
 * by the dispatch gate, so EVERY command above the caller's tier said it. Fixing the sentence in
 * one place and pinning it with one test would leave the class open: a future gate that builds its
 * own refusal inline would reintroduce the dead end without failing anything.
 *
 * So this sweeps the registry instead of sampling it: every command that refuses at the lowest tier
 * must produce a refusal a caller can act on. The assertions are about the PROPERTY (addressed to
 * someone who can act, never "retry"), not about the wording, so improving the wording later does
 * not require editing this file.
 */
import { describe, expect, it } from "vitest";
import { DEBUG_COMMANDS, debugCommandDefinition } from "../command-registry.js";
import { dispatchDebugCommand } from "../index.js";

/** Every command that needs more than the lowest tier, so dispatch refuses it at read_motion. */
const GATED_COMMANDS = DEBUG_COMMANDS.filter((command) => debugCommandDefinition(command)?.permission !== "read_motion");

describe("every tier refusal the Debug API can emit", () => {
  it("covers a meaningful part of the surface", () => {
    // A sweep over an empty list passes vacuously; this is the guard against that.
    expect(GATED_COMMANDS.length).toBeGreaterThan(50);
  });

  it("never suggests an action the refused caller could perform", async () => {
    const offenders: string[] = [];
    for (const command of GATED_COMMANDS) {
      // Empty args on purpose: the tier gate runs before argument validation, so this reaches the
      // refusal for every gated command without needing per-command fixtures.
      const result = await dispatchDebugCommand(command, {}, { tier: "read_motion", jobView: null });
      if (result.ok) {
        offenders.push(`${command}: expected permission_denied at read_motion`);
        continue;
      }
      if (result.error.code !== "permission_denied") {
        offenders.push(`${command}: expected permission_denied, got ${result.error.code}`);
        continue;
      }
      const suggestion = result.error.suggestedAction ?? "";
      // The three properties that make a refusal actionable rather than a loop.
      if (/retry with/i.test(suggestion)) offenders.push(`${command}: suggests retrying`);
      if (!suggestion.includes("cannot raise its own permission tier")) offenders.push(`${command}: does not say self-elevation is impossible`);
      if (!suggestion.includes("the host operator must")) offenders.push(`${command}: does not name who can act`);
      const detail = result.error.detail as { requiredTier?: string; grantedTier?: string; resolvedBy?: string } | undefined;
      if (detail?.resolvedBy !== "host_operator") offenders.push(`${command}: detail does not route to the host operator`);
      if (detail?.grantedTier !== "read_motion") offenders.push(`${command}: detail does not report the held tier`);
      if (detail?.requiredTier !== debugCommandDefinition(command)?.permission) offenders.push(`${command}: detail reports the wrong required tier`);
    }

    expect(offenders).toEqual([]);
  }, 120000);
});
