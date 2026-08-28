import { describe, expect, it } from "vitest";
import { runCli } from "./main";

describe("enforced-untrusted renderer host boundary", () => {
  it("does not let a CLI caller select the renderer-host policy", async () => {
    // The parser rejects this before it attempts to read the supplied package path or start a
    // renderer. A CLI is an agent-facing door, never a trusted renderer host configuration source.
    await expect(runCli(["preview", "/package-is-never-read", "--untrusted-execution"])).resolves.toEqual({
      ok: false,
      command: "preview",
      error: {
        code: "invalid_args",
        message: "Unsupported preview option: --untrusted-execution. Use --at-ms for the capture time."
      }
    });
  });
});
