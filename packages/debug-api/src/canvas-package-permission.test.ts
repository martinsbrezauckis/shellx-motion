import { describe, expect, it } from "vitest";
import { dispatchDebugCommand } from "./index.js";

describe("Canvas package permission", () => {
  it("requires write_local before validating or writing package inputs", async () => {
    const result = await dispatchDebugCommand(
      "motion.canvas.package",
      { canvasSelectionPath: "/must-not-read/frame-selection.json", packageDir: "/must-not-write/package" },
      { tier: "render_motion" }
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "permission_denied",
        message: "motion.canvas.package requires write_local; this session holds render_motion."
      }
    });
  });
});
