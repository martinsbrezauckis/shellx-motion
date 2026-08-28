import { describe, expect, it } from "vitest";
import { dispatchDebugCommand } from "./index.js";

describe("Canvas-to-MP4 permission", () => {
  it("refuses below write_local before creating connector output", async () => {
    const result = await dispatchDebugCommand("motion.connector.canvas_to_mp4", {
      canvasSelectionPath: "selection.json", outDir: "output", dryRunRender: true
    }, { tier: "render_motion" });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "permission_denied", detail: { requiredTier: "write_local", grantedTier: "render_motion" } }
    });
  });
});
