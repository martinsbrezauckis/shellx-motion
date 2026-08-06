import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateLayerKeyingAndRoto } from "./keying";
import { loadMotionPackage, resolvePackageAsset } from "./package";
import { applyTemplateValues, replaceTemplateMedia } from "./template";
import { assessTemplateQuality, summarizeTemplateQuality } from "./template-quality";
import type { MotionLayer, MotionPackage } from "./types";

const PACK_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../templates/shellx-product-pack"
);
// `generatedAssetReceiptPaths` lists package-local generated-asset receipts. It is empty
// for families whose media are bundled still-image samples (source-asset-provenance passes
// without receipts because no `/generated/` asset is used) and carries the real receipt for
// keyed-subject-promo, whose `backgroundMedia` slot now ships real generated fog-rays footage
// `packageUsesGeneratedAssets` is then true, so the quality bar
// requires the generated-asset receipt as evidence.
const RICH_FAMILIES = [
  {
    dir: "cinematic-fog-title",
    packageId: "pkg_shellx_cinematic_fog_title",
    mediaParamIds: ["heroMedia"],
    qualityFrames: [500, 1500, 3500, 5000],
    generatedAssetReceiptPaths: [] as string[]
  },
  {
    dir: "editorial-liquid-surface",
    packageId: "pkg_shellx_editorial_liquid_surface",
    mediaParamIds: ["heroMedia"],
    qualityFrames: [500, 1500, 3500, 5000],
    generatedAssetReceiptPaths: [] as string[]
  },
  {
    dir: "keyed-subject-promo",
    packageId: "pkg_shellx_keyed_subject_promo",
    mediaParamIds: ["backgroundMedia", "subjectMedia"],
    qualityFrames: [500, 1500, 3500, 5000],
    generatedAssetReceiptPaths: ["receipts/generated-background.receipt.json"]
  },
  {
    dir: "tracked-callout-overlay",
    packageId: "pkg_shellx_tracked_callout_overlay",
    mediaParamIds: ["heroMedia"],
    qualityFrames: [500, 1500, 3500, 5000],
    generatedAssetReceiptPaths: [] as string[]
  }
] as const;

describe("footage-rich product template families", () => {
  it("loads semantic stories, replaceable media, provenance and deterministic quality targets", async () => {
    for (const family of RICH_FAMILIES) {
      const pkg = await loadFamily(family.dir);
      expect(pkg.manifest).toMatchObject({
        id: family.packageId,
        compatibility: {
          lanes: ["browser", "ffmpeg"],
          hosts: ["shellx-motion", "shellx-canvas", "shellx-cut"]
        }
      });
      expect(pkg.template?.metadata).toMatchObject({
        license: {
          attributionRequired: false,
          redistributionAllowed: true,
          commercialUse: true,
          notes: expect.stringContaining("sans-serif")
        },
        provenance: {
          source: `shellx-product-pack-${family.dir}`,
          sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/)
        },
        story: { beats: expect.arrayContaining([expect.objectContaining({ id: expect.any(String) })]) },
        qualityTargets: {
          manifest: "quality/representative-frames.json",
          representativeFramesMs: [...family.qualityFrames],
          minDistinctFrames: 4,
          maxBlankFrames: 0,
          requireTextFit: true,
          requireSafeAreas: true
        }
      });
      expect(pkg.template?.metadata?.story?.beats).toHaveLength(3);
      expect(pkg.template?.metadata?.mediaSlots?.map((slot) => slot.paramId)).toEqual([...family.mediaParamIds]);
      expect(pkg.template?.metadata?.mediaSlots?.every((slot) => slot.rightsRequired)).toBe(true);
      expect(pkg.template?.params.filter((param) => param.type === "media").map((param) => param.id)).toEqual([...family.mediaParamIds]);

      const quality = JSON.parse(await readFile(resolvePackageAsset(pkg, "quality/representative-frames.json"), "utf8"));
      expect(quality.samples.map((sample: { atMs: number }) => sample.atMs)).toEqual([...family.qualityFrames]);
    }
  });

  it("keeps every visible text layer auto-fit inside a declared safe area", async () => {
    for (const family of RICH_FAMILIES) {
      const pkg = await loadFamily(family.dir);
      const textLayers = pkg.motion.layers.filter((layer) => layer.type === "text");
      expect(textLayers.length).toBeGreaterThan(1);
      for (const layer of textLayers) {
        expect(layer.textFit?.policy, `${family.dir}:${layer.id}`).toBe("auto-fit");
        expect(layer.textFit?.minFontSize, `${family.dir}:${layer.id}`).toBeGreaterThan(0);
        expect(pkg.motion.safeAreas, `${family.dir}:${layer.id}`).toHaveProperty(layer.textFit?.safeAreaId ?? "missing");
      }
    }
  });

  it("exercises scene-aware water and fog, professional keying and synchronized callout motion", async () => {
    const liquid = await loadFamily("editorial-liquid-surface");
    expect(layer(liquid, "water-stage").environment).toMatchObject({
      kind: "water",
      mode: "scene",
      sceneSourceLayerId: "hero-scene",
      surface: { waveOctaves: 4 },
      optics: { caustics: expect.any(Number), refractionStrength: expect.any(Number) }
    });

    const fog = await loadFamily("cinematic-fog-title");
    expect(layer(fog, "fog-stage").environment).toMatchObject({
      kind: "fog",
      mode: "scene",
      sceneSourceLayerId: "hero-scene",
      fog: { depthLayers: 4, lightStrength: expect.any(Number) }
    });

    const keyed = await loadFamily("keyed-subject-promo");
    const subject = layer(keyed, "subject");
    expect(validateLayerKeyingAndRoto(subject, "/layers/subject")).toEqual([]);
    expect(subject.keying).toMatchObject({
      schema: "shellx-motion/chroma-key@1",
      keyColor: "#00ff00",
      spillSuppression: 0.72,
      matte: { denoiseRadiusPx: 1, chokePx: 1, featherPx: 2 }
    });

    const tracked = await loadFamily("tracked-callout-overlay");
    for (const id of ["callout-ring", "callout-core", "callout-leader", "callout-panel", "callout-title", "callout-detail"]) {
      expect(layer(tracked, id).keyframes?.["transform.x"], id).toEqual(expect.arrayContaining([expect.objectContaining({ atMs: 3600 })]));
    }
  });

  it("applies rich controls and updates every bound package-local media reference", async () => {
    const liquid = await loadFamily("editorial-liquid-surface");
    expect(applyTemplateValues(liquid, { title: "Surface becomes story", waveHeight: 0.58, accentColor: "#fb7185" })).toMatchObject({
      ok: true,
      changedParams: ["title", "waveHeight", "accentColor"],
      changedBindings: expect.arrayContaining([
        expect.objectContaining({ path: "/layers/4/text", newValue: "Surface becomes story" }),
        expect.objectContaining({ path: "/layers/1/environment/surface/waveHeight", newValue: 0.58 }),
        expect.objectContaining({ path: "/layers/6/fill", newValue: "#fb7185" })
      ])
    });

    const fog = await loadFamily("cinematic-fog-title");
    expect(applyTemplateValues(fog, { fogDensity: 0.74 })).toMatchObject({
      ok: true,
      changedBindings: [expect.objectContaining({ path: "/layers/1/environment/fog/density", newValue: 0.74 })]
    });

    const keyed = await loadFamily("keyed-subject-promo");
    expect(applyTemplateValues(keyed, { spillSuppression: 0.88 })).toMatchObject({
      ok: true,
      changedBindings: [expect.objectContaining({ path: "/layers/2/keying/spillSuppression", newValue: 0.88 })]
    });
    expect(replaceTemplateMedia(keyed, { paramId: "subjectMedia", assetRef: "assets/user/presenter.png" })).toMatchObject({
      ok: true,
      manifestAssets: expect.arrayContaining(["assets/user/presenter.png"]),
      changedBindings: [
        expect.objectContaining({ path: "/layers/2/source", newValue: "assets/user/presenter.png" }),
        expect.objectContaining({ path: "/layers/2/assetRef", newValue: "assets/user/presenter.png" })
      ]
    });

    const tracked = await loadFamily("tracked-callout-overlay");
    expect(replaceTemplateMedia(tracked, { paramId: "heroMedia", assetRef: "assets/user/device-frame.png" })).toMatchObject({
      ok: true,
      changedBindings: [
        expect.objectContaining({ path: "/layers/0/source", newValue: "assets/user/device-frame.png" }),
        expect.objectContaining({ path: "/layers/0/assetRef", newValue: "assets/user/device-frame.png" })
      ]
    });
  });

  it("passes the promoted quality bar when representative renders and both host receipts are supplied", async () => {
    for (const family of RICH_FAMILIES) {
      const pkg = await loadFamily(family.dir);
      const root = `.scratch/template-quality/${family.packageId}`;
      const assessment = assessTemplateQuality(pkg, {
        contactSheetPath: `${root}/contact-sheet.png`,
        renderedOutputs: [
          { path: `${root}/fhd.mp4`, width: 1920, height: 1080, container: "mp4" },
          { path: `${root}/vertical.mp4`, width: 1080, height: 1920, container: "mp4" }
        ],
        textFit: { status: "passed", receiptPath: `${root}/text-fit.receipt.json` },
        safeAreas: { status: "passed", receiptPath: `${root}/safe-area.receipt.json` },
        // keyed-subject-promo ships real generated background footage, so its generated-asset
        // receipt is supplied here; the bundled-sample families pass an empty list.
        generatedAssetReceiptPaths: [...family.generatedAssetReceiptPaths],
        connectorReceipts: [
          { host: "shellx-canvas", status: "passed", receiptPath: `${root}/canvas.receipt.json` },
          { host: "shellx-cut", status: "passed", receiptPath: `${root}/cut.receipt.json` }
        ]
      });
      expect(summarizeTemplateQuality(assessment), family.dir).toEqual({
        status: "passed",
        passed: 6,
        failed: 0,
        warning: 0,
        notApplicable: 1
      });
    }
  });
});

async function loadFamily(dir: string): Promise<MotionPackage> {
  return loadMotionPackage(join(PACK_ROOT, dir));
}

function layer(pkg: MotionPackage, id: string): MotionLayer {
  const found = pkg.motion.layers.find((entry) => entry.id === id);
  if (!found) throw new Error(`missing layer ${id}`);
  return found;
}
