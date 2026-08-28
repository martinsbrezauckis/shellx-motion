import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { hashFile } from "@shellx-motion/core";
import { loadOtioExportInput } from "./otio-export-input.js";

describe("OTIO export loaded-input provenance", () => {
  it("retains the exact structural hashes parsed before a later pathname replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-otio-loaded-input-"));
    const packageRoot = join(root, "package");
    await cp(resolve("../../fixtures/packages/keyframed-lower-third"), packageRoot, { recursive: true });
    const manifest = JSON.parse(await readFile(join(packageRoot, "manifest.json"), "utf8")) as { motion: string };
    const motionPath = join(packageRoot, manifest.motion);
    const loadedMotionSha256 = await hashFile(motionPath);
    try {
      const input = await loadOtioExportInput(packageRoot, {
        afterPackageLoaded: async () => {
          await writeFile(motionPath, "{\"schema\":\"replaced-after-load\"}\n", "utf8");
        }
      });
      expect(input.pkg.motion.id).toBe("motion_keyframed_lower_third");
      expect(input.inputHashes[manifest.motion]).toBe(loadedMotionSha256);
      expect(input.inputHashes[manifest.motion]).not.toBe(await hashFile(motionPath));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
