import { describe, expect, it } from "vitest";
import { dispatchDebugCommand } from "./index.js";

const REFUSAL = "motion.package.patch reserves /layoutGapAnimation for the typed layout gap animation lifecycle.";

describe("layout-gap generic package-patch reservation", () => {
  it("refuses root insertion, removal, and nested mutation before source, output, or host receipt I/O", async () => {
    for (const patch of [
      [{ op: "add", path: "/layoutGapAnimation", value: { schema: "shellx-motion/layout-gap-animation@1", tracks: [] } }],
      [{ op: "remove", path: "/layoutGapAnimation" }],
      [{ op: "replace", path: "/layoutGapAnimation/tracks/0", value: {} }],
    ]) {
      await expect(dispatchDebugCommand("motion.package.patch", {
        packageRoot: "/unreachable-source",
        outDir: "/unreachable-output",
        patch,
      }, { tier: "edit_motion" })).resolves.toEqual({
        ok: false,
        error: { code: "invalid_args", message: REFUSAL },
        warnings: [],
      });
    }
  });
});
