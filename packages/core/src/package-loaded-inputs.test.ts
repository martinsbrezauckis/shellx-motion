import { describe, expect, it } from "vitest";
import type { MotionPackage } from "./types.js";
import { requiredLoadedPackageDocumentHashes, requiredLoadedPackageInputHashes } from "./index.js";
import { rememberLoadedPackageHashes } from "./package-loaded-inputs.js";

describe("loader-owned package input hashes", () => {
  it("returns only the exact manifest and selected Motion document hashes", () => {
    const pkg = { manifest: { motion: "timeline/main.json" } } as MotionPackage;
    rememberLoadedPackageHashes(pkg, {
      "manifest.json": "a".repeat(64),
      "timeline/main.json": "b".repeat(64),
      "template.json": "c".repeat(64)
    });

    expect(requiredLoadedPackageDocumentHashes(pkg, "Test operation")).toEqual({
      "manifest.json": "a".repeat(64),
      "timeline/main.json": "b".repeat(64)
    });
    expect(requiredLoadedPackageInputHashes(pkg, "Test operation")["template.json"])
      .toBe("c".repeat(64));
  });

  it("refuses packages that did not come from the stable loader", () => {
    const pkg = { manifest: { motion: "motion.json" } } as MotionPackage;
    expect(() => requiredLoadedPackageDocumentHashes(pkg, "Test operation"))
      .toThrow("Test operation requires loader-owned manifest and Motion input hashes.");
  });
});
