import { describe, expect, it } from "vitest";
import { dispatchDebugCommand } from "./index";

describe("debug/MCP colour and alpha capability propagation", () => {
  it("returns the canonical browser colour/alpha card without a rendering request", async () => {
    const response = await dispatchDebugCommand(
      "motion.capabilities.panel",
      { output: "jpeg-frame", target: "preview", needsAlpha: true },
      { tier: "read_motion" }
    );

    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.visibleState).toMatchObject({
      panel: "capabilities",
      operation: "capabilities.panel",
      recommendedLane: "browser"
    });
    const panel = response.result as { cards: unknown[] };
    expect(panel.cards).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "renderer.browser",
        colorAlpha: expect.objectContaining({
          sourceEncoding: "sdr-srgb-encoded",
          rasterInput: "unprofiled-srgb-assumed",
          embeddedProfiles: "unsupported-undefined",
          alphaBoundary: "browser-managed-before-png-capture",
          filterDomain: "chromium-managed",
          blendDomain: "chromium-managed",
          crossRendererConformance: false,
          unsupported: expect.arrayContaining(["hdr", "wide-gamut"])
        })
      })
    ]));
  });
});
