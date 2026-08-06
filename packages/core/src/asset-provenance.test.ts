import { describe, expect, it } from "vitest";
import {
  buildGeneratedAssetReceipt,
  generatedAssetReceiptId,
  validateGeneratedAssetReceipt
} from "./asset-provenance";

describe("generated asset provenance", () => {
  it("builds deterministic package-local receipts for bundled sample image assets", () => {
    const receipt = buildGeneratedAssetReceipt({
      packageId: "pkg_launch_media",
      generatorRoute: "bundled-sample",
      assetRef: "assets/generated/launch-hero.png",
      mediaType: "image/png",
      promptSummary: "Saturated ShellX product-family launch background with UI motion streaks.",
      toolLabel: "bundled sample asset",
      provenanceNote: "Bundled AI-generated sample asset used under the generator's applicable terms.",
      contentSha256: "a".repeat(64),
      width: 1920,
      height: 1080,
      createdAt: "2026-07-06T12:00:00.000Z"
    });

    expect(receipt).toEqual({
      schema: "shellx-motion/generated-asset-receipt@1",
      id: "generated_asset_pkg_launch_media_assets_generated_launch_hero_png",
      packageId: "pkg_launch_media",
      generatorRoute: "bundled-sample",
      assetRef: "assets/generated/launch-hero.png",
      mediaType: "image/png",
      promptSummary: "Saturated ShellX product-family launch background with UI motion streaks.",
      toolLabel: "bundled sample asset",
      provenanceNote: "Bundled AI-generated sample asset used under the generator's applicable terms.",
      contentSha256: "a".repeat(64),
      width: 1920,
      height: 1080,
      createdAt: "2026-07-06T12:00:00.000Z",
      status: "available"
    });
  });

  it("supports generated video assets with duration evidence", () => {
    const receipt = buildGeneratedAssetReceipt({
      packageId: "pkg_rain_loop",
      generatorRoute: "grok-build-cli",
      assetRef: "assets/generated/rain-loop.mp4",
      mediaType: "video/mp4",
      promptSummary: "Short rain-on-glass loop for a Motion template background.",
      toolLabel: "grok build",
      provenanceNote: "Generated source video imported into package assets before render.",
      contentSha256: "b".repeat(64),
      width: 1280,
      height: 720,
      durationMs: 3500,
      createdAt: "2026-07-06T12:05:00.000Z"
    });

    expect(receipt.durationMs).toBe(3500);
    expect(validateGeneratedAssetReceipt(receipt)).toEqual({ ok: true, receipt });
  });

  it("rejects unsafe asset refs and missing provenance before package import", () => {
    expect(() => buildGeneratedAssetReceipt({
      packageId: "pkg_bad",
      generatorRoute: "grok-build-cli",
      assetRef: "../outside.png",
      mediaType: "image/png",
      promptSummary: "Bad path",
      toolLabel: "grok imagine",
      provenanceNote: "Generated source",
      contentSha256: "c".repeat(64)
    })).toThrow("assetRef must be a package-local assets/ path");

    const result = validateGeneratedAssetReceipt({
      schema: "shellx-motion/generated-asset-receipt@1",
      packageId: "pkg_bad",
      generatorRoute: "codex-subscription-cli",
      assetRef: "assets/generated/missing.png",
      mediaType: "image/png",
      promptSummary: "",
      toolLabel: "",
      provenanceNote: "",
      contentSha256: "not-a-sha"
    });

    expect(result).toEqual({
      ok: false,
      errors: [
        "id must be a non-empty string.",
        "promptSummary must be a non-empty string.",
        "toolLabel must be a non-empty string.",
        "provenanceNote must be a non-empty string.",
        "contentSha256 must be a 64-character lowercase sha256 hash.",
        "createdAt must be a non-empty string.",
        "status must be available, planned, or failed."
      ]
    });
  });

  it("keeps receipt ids stable across runs for the same package asset", () => {
    expect(generatedAssetReceiptId("pkg_launch_media", "assets/generated/launch-hero.png")).toBe("generated_asset_pkg_launch_media_assets_generated_launch_hero_png");
  });
});
