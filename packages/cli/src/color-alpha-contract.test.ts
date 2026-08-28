import { describe, expect, it } from "vitest";
import { runCli } from "./main";

describe("CLI colour and alpha capability propagation", () => {
  it("prints the canonical native colour/alpha card through the debug wrapper", async () => {
    const response = await runCli(
      ["debug", "capabilities-panel", "--output", "png-frame", "--target", "preview", "--needs-alpha"],
      { trustedLocalTier: true }
    );

    expect(response).toMatchObject({ ok: true, command: "debug.capabilities-panel" });
    const panel = response.result as { cards: unknown[] };
    expect(panel.cards).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "renderer.native",
        colorAlpha: expect.objectContaining({
          alphaBoundary: "straight-rgba-png",
          filterDomain: "temporary-premultiplied-encoded-srgb",
          blendDomain: "encoded-srgb",
          crossRendererConformance: false
        })
      })
    ]));
  });
});
