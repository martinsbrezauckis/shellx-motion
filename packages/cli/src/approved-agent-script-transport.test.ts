import { describe, expect, it } from "vitest";
import { debugCommandName } from "./debug-subcommands";

describe("approved-agent-entry CLI boundary", () => {
  it("does not publish a CLI subcommand that could self-declare an approved script author", () => {
    expect(debugCommandName("package-script-author")).toBeNull();
    expect(debugCommandName("script-author")).toBeNull();
  });
});
