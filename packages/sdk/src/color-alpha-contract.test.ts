import { describe, expect, it } from "vitest";
import { createLocalMotionSdk } from "./local";

describe("local SDK colour and alpha capability propagation", () => {
  it("returns a mutable copy of the current observable contract", async () => {
    const first = await createLocalMotionSdk().capabilities();
    expect(first.colorAlpha).toMatchObject({
      schema: "shellx-motion/color-alpha@1",
      status: "current-observable",
      unprofiledRaster: { assumption: "sdr-srgb-encoded", embeddedProfiles: "unsupported-undefined" },
      lanes: {
        native: { alphaBoundary: "straight-rgba-png" },
        browser: { alphaBoundary: "browser-managed-before-png-capture" },
        ffmpeg: { delivery: { profile: "sdr-bt709", readback: "ffprobe-observed-tags" } }
      }
    });

    (first.colorAlpha.lanes.browser.unsupported as string[]).push("caller-mutation");
    const second = await createLocalMotionSdk().capabilities();
    expect(second.colorAlpha.lanes.browser.unsupported).not.toContain("caller-mutation");
  });
});
