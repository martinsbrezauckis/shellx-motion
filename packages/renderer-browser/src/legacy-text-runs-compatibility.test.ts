import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJsonSha256, type MotionPackage } from "@shellx-motion/core";
import { buildGeneratedMotionHtml } from "./index";
import { collectMotionTypographyEvidence } from "./typography-attestation";
import { launchConfiguredTestBrowser } from "./test-support/configured-browser";

describe("legacy simple text remains byte-stable without text-runs", () => {
  it("pins generated HTML plus typography evidence omission without a package output", async () => {
    const generated = await buildGeneratedMotionHtml(legacyPackage(), 0);
    expect(generated.assetRefs).toEqual([]);
    expect(generated.assetHashes).toEqual({});
    expect(generated.html).not.toContain("data-motion-text-runs");
    expect(sha256(generated.html)).toBe("adec97f6885899cd5658ac147c547f1400bc9442cc511cdc6f87819b1804a984");

    // This is deliberately a no-output Chromium probe. The managed host's
    // OutputPathTopology guard owns package-copy/final-frame evidence; this
    // pins the production lowering and collector bytes without bypassing it.
    const browser = await launchConfiguredTestBrowser();
    try {
      const page = await browser.newPage({ viewport: { width: 320, height: 180 } });
      await page.setContent(generated.html);
      const typography = await collectMotionTypographyEvidence(page, "ready");
      expect(typography).not.toHaveProperty("runs");
      expect(typography.layers).toEqual([expect.objectContaining({ layerId: "legacy-title", requestedFontFamily: "sans-serif", fontProvenance: "unverified" })]);
      expect(canonicalJsonSha256(typography)).toBe("f6cebf2b9948a4bc76762dfa0a99374c93ce720c3a2bb7bbd73bde8e3a1af1b9");
    } finally {
      await browser.close();
    }
  });
});

function legacyPackage(): MotionPackage {
  return {
    root: "/package", manifest: {
      schema: "shellx-motion/package-manifest@1", id: "pkg_legacy_text_runs", name: "Legacy simple text", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["browser"], hosts: ["motion"] }
    },
    motion: {
      schema: "shellx-motion/motion@1", id: "motion_legacy_text_runs", name: "Legacy simple text", durationMs: 1_000, fps: 30, width: 320, height: 180, background: "#020617", assets: [],
      layers: [{
        id: "legacy-title", type: "text", text: "Legacy <simple> text", startMs: 0, durationMs: 1_000,
        transform: { x: 24, y: 40, width: 272, height: 64 }, style: { fontFamily: "sans-serif", fontSize: 32, color: "#ffffff", textAlign: "center" }
      }],
      provenance: { sourceApp: "test", createdBy: "test" }
    }
  };
}

function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
