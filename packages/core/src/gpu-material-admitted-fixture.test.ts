import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compileGpuScene2dPlan } from "./gpu-scene-2d-plan";
import { decodePngRgba } from "./png-rgba-decode";
import { hashPackageFile } from "./package";
import { loadSchema, validateDocument } from "./validate";
import { validateMotionDocumentInStages } from "./motion-validation";
import type { MotionDocument } from "./types";

const fixtureRoot = fileURLToPath(new URL("../../../fixtures/packages/gpu-material-admitted", import.meta.url));
const posterAsset = "assets/poster.png";
const fontAsset = "assets/fonts/inter-latin-700-normal.woff2";

describe("GPU material admitted fixture", () => {
  it("has only declared package resources and lowers its material, PNG, shape, and manifest-bound text at canonical timestamps", async () => {
    const manifest = JSON.parse(await readFile(resolve(fixtureRoot, "manifest.json"), "utf8"));
    const motion = JSON.parse(await readFile(resolve(fixtureRoot, "motion.json"), "utf8")) as MotionDocument;

    expect(await validateDocument(await loadSchema("packageManifest"), manifest)).toEqual({ ok: true });
    expect(await validateMotionDocumentInStages(motion)).toMatchObject({ ok: true });
    expect(manifest.compatibility.lanes).toEqual(["gpu"]);
    expect(manifest.assets).toEqual([
      posterAsset,
      fontAsset,
      "assets/fonts/LICENSE-Inter.txt",
      "assets/material-fallback.glsl"
    ]);

    const [posterBytes, posterSha256, fontSha256] = await Promise.all([
      readFile(resolve(fixtureRoot, posterAsset)),
      hashPackageFile(resolve(fixtureRoot, posterAsset)),
      hashPackageFile(resolve(fixtureRoot, fontAsset))
    ]);
    const poster = decodePngRgba(posterBytes);
    expect({ posterSha256, fontSha256, width: poster.width, height: poster.height }).toEqual({
      posterSha256: "05266a8fc2ede54ba11cc764a4d038459d4def99d757f7717291786ed881cf56",
      fontSha256: "6f56409fd3d64bb85f7d070bce20749db2d66b6d63cec586cc22d1c761be2491",
      width: 1920,
      height: 1080
    });

    const images = new Map([[posterAsset, {
      resourceId: "image-poster", assetRef: posterAsset, width: poster.width, height: poster.height, sha256: posterSha256
    }]]);
    const fonts = new Map([["inter", [{
      resourceId: "font-inter-700", assetRef: fontAsset, family: "Inter", weight: 700, style: "normal" as const, mimeType: "font/woff2" as const, sha256: fontSha256
    }]]]);
    const plans = [0, 800, 1_599].map((atMs) => compileGpuScene2dPlan(motion, atMs, { images, fonts }));

    for (const plan of plans) {
      expect(plan.ok).toBe(true);
      if (!plan.ok) throw new Error(plan.failure.message);
      expect(plan.plan).toMatchObject({ visualLayerCount: 4, imageCount: 1, materialCount: 1, shapeCount: 1, textCount: 1 });
      expect(plan.plan.frame.draws.map((draw) => `${draw.kind}:${draw.id}`)).toEqual([
        "image:poster", "material:material-field", "styledRect:title-panel", "text:title"
      ]);
    }
  });
});
