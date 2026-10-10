/**
 * Platform applicability is exact and narrow: Windows may omit the two commands in the README's
 * explicitly POSIX checkout-authority block, while every other command still has to resolve.
 */
import { describe, expect, it } from "vitest";

import { platformInapplicableReason } from "./readme-command-platform.mjs";

describe("README command platform applicability", () => {
  it.each(["umask 0077", "chmod go-w shellx-motion"])(
    "marks the exact POSIX-only command inapplicable on Windows: %s",
    (command) => {
      expect(platformInapplicableReason(command, "win32")).toMatch(/POSIX-only/);
      expect(platformInapplicableReason(command, "linux")).toBeNull();
      expect(platformInapplicableReason(command, "darwin")).toBeNull();
    }
  );

  it("does not exempt the cross-platform clone command", () => {
    expect(
      platformInapplicableReason(
        "git clone https://github.com/martinsbrezauckis/shellx-motion.git shellx-motion",
        "win32"
      )
    ).toBeNull();
  });

  it("does not turn similar or edited commands into an exemption", () => {
    expect(platformInapplicableReason("umask 0027", "win32")).toBeNull();
    expect(platformInapplicableReason("chmod -R go-w shellx-motion", "win32")).toBeNull();
    expect(platformInapplicableReason("missing-program", "win32")).toBeNull();
  });
});
