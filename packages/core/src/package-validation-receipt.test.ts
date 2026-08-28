import { join, resolve } from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createPackageValidationReceipt, packageValidationInputHashes } from "./package-validation-receipt.js";
import { loadMotionPackage } from "./package.js";

describe("package validation receipt vocabulary", () => {
  it("records a failed validation without inventing a package identity or an output artifact", async () => {
    const packageRoot = resolve("/governed/input/broken-package");
    const receipt = await createPackageValidationReceipt({
      packageRoot,
      valid: false,
      validation: { valid: false, packageRoot },
      error: {
        code: "invalid_motion_document",
        message: "Motion document does not satisfy shellx-motion/motion@1: 1 error(s).",
        suggestedAction: "Correct the named path."
      },
      createdAt: "2026-08-08T00:00:00.000Z"
    });

    expect(receipt).toMatchObject({
      schema: "shellx-motion/receipt@1",
      operation: "package.validate",
      status: "failed",
      packageId: "unknown-package",
      lane: "validation",
      output: {
        packageRoot,
        valid: false,
        inputHashScope: "resolved_package_root_identity_only",
        error: { code: "invalid_motion_document" }
      }
    });
    expect(receipt.inputHashes.resolvedPackageRootIdentity).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.warnings).toEqual(["Motion document does not satisfy shellx-motion/motion@1: 1 error(s)."]);
  });

  it("binds the receipt to the exact package bytes that produced the loaded verdict", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-validation-loaded-hashes-"));
    const manifest = {
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_loaded_hashes",
      name: "Loaded hashes",
      motion: "motion.json",
      assets: [],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["browser"], hosts: ["motion"] }
    };
    const motion = {
      schema: "shellx-motion/motion@1",
      id: "motion_loaded_hashes",
      name: "Loaded hashes",
      durationMs: 1000,
      fps: 30,
      width: 640,
      height: 360,
      background: "#101820",
      layers: [],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    };
    await writeFile(join(root, "manifest.json"), `${JSON.stringify(manifest)}\n`);
    await writeFile(join(root, "motion.json"), `${JSON.stringify(motion)}\n`);
    const pkg = await loadMotionPackage(root);
    const loadedHashes = await packageValidationInputHashes(pkg);

    await writeFile(join(root, "manifest.json"), `${JSON.stringify({ ...manifest, name: "Changed later" })}\n`);
    await writeFile(join(root, "motion.json"), `${JSON.stringify({ ...motion, name: "Changed later" })}\n`);
    const receipt = await createPackageValidationReceipt({
      packageRoot: root,
      package: pkg,
      valid: true,
      validation: { valid: true },
      createdAt: "2026-08-10T00:00:00.000Z"
    });

    expect(receipt.inputHashes).toEqual({
      "manifest.json": loadedHashes["manifest.json"],
      "motion.json": loadedHashes["motion.json"]
    });
  });
});
