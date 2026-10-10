import { readdir, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateGeneratedAssetReceipt } from "./asset-provenance";
import { expandMotionPackageRows, loadPackageDataRows } from "./data";
import { hashPackageFile, loadMotionPackage, resolvePackageAsset } from "./package";
import { applyTemplateValues, replaceTemplateMedia } from "./template";
import { assessTemplateQuality, summarizeTemplateQuality } from "./template-quality";

const PRODUCT_PACK_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../templates/shellx-product-pack"
);

/** The shipped product roster is shared with the public template proof and asset inventory. */
const EXPECTED_PRODUCT_PACK_DIRS = JSON.parse(readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../../scripts/public/public-template-roster.json"), "utf8"
)) as string[];
const PRESENT_FAMILIES = new Set(EXPECTED_PRODUCT_PACK_DIRS);

describe("ShellX product template pack", () => {
  it("loads every promoted starter template with catalog-ready metadata", async () => {
    const entries = await readdir(PRODUCT_PACK_ROOT, { withFileTypes: true });
    const onDisk = new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
    const packageDirs = EXPECTED_PRODUCT_PACK_DIRS.filter((dir) => onDisk.has(dir));

    expect(packageDirs).toEqual(EXPECTED_PRODUCT_PACK_DIRS);
    expect(packageDirs.length, "all shipped product families must be present").toBe(12);

    const packages = await Promise.all(packageDirs.map((dir) => loadMotionPackage(join(PRODUCT_PACK_ROOT, dir))));
    // Each family's package id follows its directory name.
    expect(packages.map((pkg) => pkg.manifest.id).sort()).toEqual(
      packageDirs.map((dir) => `pkg_shellx_${dir.replace(/-/g, "_")}`).sort()
    );

    for (const pkg of packages) {
      const template = pkg.template;
      expect(template, pkg.manifest.id).toBeDefined();
      expect(pkg.manifest).toMatchObject({
        template: "template.json",
        compatibility: { lanes: expect.arrayContaining(["browser", "ffmpeg"]), hosts: expect.arrayContaining(["shellx-motion"]) }
      });
      expect(template?.compatibleHosts).toEqual(expect.arrayContaining(["shellx-motion"]));
      expect(template?.compatibleLanes).toEqual(expect.arrayContaining(["browser", "ffmpeg"]));
      expect(template?.params.length).toBeGreaterThan(0);
      expect(template?.controls.length).toBe(template?.params.length);
      expect(template?.bindings.length).toBeGreaterThan(0);
      expect(template?.metadata).toMatchObject({
        inputSchema: expect.any(Object),
        outputBounds: {
          aspectRatios: expect.arrayContaining(["16:9"])
        },
        suitability: {
          bestFor: expect.any(Array),
          notFor: expect.any(Array)
        },
        license: {
          attributionRequired: false,
          redistributionAllowed: true,
          commercialUse: true
        },
        preview: {
          poster: "preview/poster.png",
          thumbnail: "preview/poster.png"
        },
        provenance: {
          source: expect.stringContaining("shellx-product-pack-"),
          sourceHash: expect.any(String)
        },
        performance: {
          recommendedLane: expect.any(String),
          renderCost: expect.stringMatching(/^(low|medium|high)$/),
          previewFps: expect.any(Number)
        }
      });
    }
  });

  it("covers the intended first-pack design families", async () => {
    const packages = await Promise.all(EXPECTED_PRODUCT_PACK_DIRS.map((dir) => loadMotionPackage(join(PRODUCT_PACK_ROOT, dir))));
    const searchText = packages
      .flatMap((pkg) => [
        pkg.template?.name,
        ...(pkg.template?.metadata?.suitability?.bestFor ?? []),
        ...(pkg.template?.metadata?.suitability?.notFor ?? [])
      ])
      .filter((value): value is string => typeof value === "string")
      .join(" ")
      .toLowerCase();

    // Require the product's design families; check additional local families
    // when their directories are present.
    for (const phrase of [
      "saas launch",
      "feature announcement",
      "social stat",
      "kinetic typography",
      "audio",
      "media-rich",
      "metric",
      "editorial liquid surface",
      "cinematic title",
      "keyed subject promo",
      "tracked callout"
    ]) {
      expect(searchText, `public design-family coverage lost: ${phrase}`).toContain(phrase);
    }
  });

  it("passes the quality bar for new non-audio starter templates with expected evidence", async () => {
    // Evaluate each named shipped family.
    const dirs = [
      "feature-announcement",
      "kinetic-type",
      "launch-bumper",
      "social-stat-card"
    ].filter((dir) => PRESENT_FAMILIES.has(dir));
    expect(dirs.length, "no non-audio starter families present to assess").toBeGreaterThan(0);

    for (const dir of dirs) {
      const pkg = await loadMotionPackage(join(PRODUCT_PACK_ROOT, dir));
      const assessment = assessTemplateQuality(pkg, {
        contactSheetPath: `.scratch/template-quality/${pkg.manifest.id}/contact-sheet.png`,
        renderedOutputs: [
          { path: `.scratch/template-quality/${pkg.manifest.id}/fhd.mp4`, width: 1920, height: 1080, container: "mp4" },
          { path: `.scratch/template-quality/${pkg.manifest.id}/square.mp4`, width: 1080, height: 1080, container: "mp4" }
        ],
        textFit: { status: "passed", receiptPath: `.scratch/template-quality/${pkg.manifest.id}/text-fit.receipt.json` },
        safeAreas: { status: "passed", receiptPath: `.scratch/template-quality/${pkg.manifest.id}/safe-area.receipt.json` }
      });

      expect(summarizeTemplateQuality(assessment), dir).toEqual({
        status: "passed",
        passed: 5,
        failed: 0,
        warning: 0,
        notApplicable: 2
      });
    }
  });

  it("loads a shipped media-slot family with package-local media slot metadata", async () => {
    // The media-slot contract is covered by a shipped family.
    const pkg = await loadMotionPackage(join(PRODUCT_PACK_ROOT, "media-launch"));

    expect(pkg.manifest).toMatchObject({
      id: "pkg_shellx_media_launch",
      assets: [
        "assets/generated/shellx-media-launch-hero-1080p.jpg",
        "assets/generated/shellx-media-launch-hero-alt.jpg",
        "assets/fonts/inter-latin-600-normal.woff2",
        "assets/fonts/inter-latin-800-normal.woff2",
        "assets/fonts/inter-latin-900-normal.woff2"
      ]
    });
    expect(pkg.template?.params.some((param) => param.type === "media")).toBe(true);
  });

  it("loads the media-launch template with package-local generated asset provenance", async () => {
    const pkg = await loadMotionPackage(join(PRODUCT_PACK_ROOT, "media-launch"));

    expect(pkg.manifest).toMatchObject({
      id: "pkg_shellx_media_launch",
      template: "template.json",
      compatibility: { lanes: ["browser", "ffmpeg"], hosts: ["shellx-motion"] }
    });
    // The default hero and declared asset must point at the bundled generated JPEG, while its
    // public-safe receipt binds the slot-exact 1920x1080 bytes by content hash.
    expect(pkg.motion.layers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "generated-hero",
        type: "image",
        source: "assets/generated/shellx-media-launch-hero-1080p.jpg",
        assetRef: "assets/generated/shellx-media-launch-hero-1080p.jpg"
      })
    ]));
    expect(pkg.template?.params).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "heroMedia",
        type: "media",
        defaultValue: "assets/generated/shellx-media-launch-hero-1080p.jpg"
      })
    ]));

    const receipt = JSON.parse(await readFile(resolvePackageAsset(pkg, "receipts/generated-hero.receipt.json"), "utf8"));
    const validated = validateGeneratedAssetReceipt(receipt);
    expect(validated.ok).toBe(true);
    if (!validated.ok) throw new Error("expected generated asset receipt to validate");
    expect(validated.receipt.contentSha256).toBe(await hashPackageFile(resolvePackageAsset(pkg, "assets/generated/shellx-media-launch-hero-1080p.jpg")));
  });

  it("loads the cinematic rain template with semantic scene and agent-review metadata", async () => {
    const pkg = await loadMotionPackage(join(PRODUCT_PACK_ROOT, "cinematic-rain-launch"));

    expect(pkg.manifest).toMatchObject({
      id: "pkg_shellx_cinematic_rain_launch",
      compatibility: {
        lanes: ["browser", "ffmpeg", "gpu"],
        hosts: ["shellx-motion", "shellx-canvas", "shellx-cut"]
      }
    });
    expect(pkg.template?.compatibleLanes).toEqual(["browser", "ffmpeg", "gpu"]);
    expect(pkg.template?.metadata).toMatchObject({
      story: {
        kind: "cinematic-product-promo",
        beats: [
          expect.objectContaining({ id: "establish", mediaParamIds: ["heroMedia"] }),
          expect.objectContaining({ id: "promise" }),
          expect.objectContaining({ id: "resolve" })
        ]
      },
      mediaSlots: [
        expect.objectContaining({
          paramId: "heroMedia",
          role: "hero-background-scene",
          acceptedKinds: ["image"],
          rightsRequired: true
        })
      ],
      qualityTargets: {
        manifest: "quality/representative-frames.json",
        representativeFramesMs: [300, 1500, 3200, 5200],
        minDistinctFrames: 4,
        maxBlankFrames: 0,
        requireTextFit: true,
        requireSafeAreas: true
      }
    });
    expect(pkg.motion.layers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "hero-scene", type: "image", fit: "fill" }),
      expect.objectContaining({
        id: "rain-stage",
        type: "environment",
        environment: expect.objectContaining({
          kind: "rain",
          mode: "scene",
          sceneSourceLayerId: "hero-scene",
          effectMaskLayerId: "rain-mask"
        })
      }),
      expect.objectContaining({ id: "title", textFit: { policy: "auto-fit", safeAreaId: "title", minFontSize: 54 } })
    ]));

    const applied = applyTemplateValues(pkg, {
      title: "Rain becomes part of the product story",
      rainIntensity: 0.68,
      accentColor: "#a7f3d0"
    });
    expect(applied).toMatchObject({
      ok: true,
      changedParams: ["title", "rainIntensity", "accentColor"],
      changedBindings: [
        expect.objectContaining({ path: "/layers/6/text", newValue: "Rain becomes part of the product story" }),
        expect.objectContaining({ path: "/layers/2/environment/intensity", newValue: 0.68 }),
        expect.objectContaining({ path: "/layers/8/fill", newValue: "#a7f3d0" })
      ]
    });

    const replaced = replaceTemplateMedia(pkg, { paramId: "heroMedia", assetRef: "assets/user/night-exterior.png" });
    expect(replaced).toMatchObject({
      ok: true,
      assetRef: "assets/user/night-exterior.png",
      manifestAssets: expect.arrayContaining(["assets/user/night-exterior.png"]),
      changedBindings: [
        expect.objectContaining({ path: "/layers/0/source", newValue: "assets/user/night-exterior.png" }),
        expect.objectContaining({ path: "/layers/0/assetRef", newValue: "assets/user/night-exterior.png" })
      ]
    });
  });

  it("passes the cinematic rain template quality bar with frame and connector evidence", async () => {
    const pkg = await loadMotionPackage(join(PRODUCT_PACK_ROOT, "cinematic-rain-launch"));
    const assessment = assessTemplateQuality(pkg, {
      contactSheetPath: ".scratch/template-quality/pkg_shellx_cinematic_rain_launch/contact-sheet.png",
      renderedOutputs: [
        { path: ".scratch/template-quality/pkg_shellx_cinematic_rain_launch/fhd.mp4", width: 1920, height: 1080, container: "mp4" },
        { path: ".scratch/template-quality/pkg_shellx_cinematic_rain_launch/vertical.mp4", width: 1080, height: 1920, container: "mp4" }
      ],
      textFit: { status: "passed", receiptPath: ".scratch/template-quality/pkg_shellx_cinematic_rain_launch/text-fit.receipt.json" },
      safeAreas: { status: "passed", receiptPath: ".scratch/template-quality/pkg_shellx_cinematic_rain_launch/safe-area.receipt.json" },
      connectorReceipts: [
        { host: "shellx-canvas", status: "passed", receiptPath: ".scratch/template-quality/pkg_shellx_cinematic_rain_launch/canvas.receipt.json" },
        { host: "shellx-cut", status: "passed", receiptPath: ".scratch/template-quality/pkg_shellx_cinematic_rain_launch/cut.receipt.json" }
      ]
    });

    expect(summarizeTemplateQuality(assessment)).toEqual({
      status: "passed",
      passed: 6,
      failed: 0,
      warning: 0,
      notApplicable: 1
    });
  });

  it("passes the starter-pack quality bar with expected media evidence", async () => {
    const pkg = await loadMotionPackage(join(PRODUCT_PACK_ROOT, "media-launch"));

    const assessment = assessTemplateQuality(pkg, {
      contactSheetPath: "preview/contact-sheet.png",
      renderedOutputs: [
        { path: ".scratch/template-quality/pkg_shellx_media_launch/fhd.mp4", width: 1920, height: 1080, container: "mp4" },
        { path: ".scratch/template-quality/pkg_shellx_media_launch/square.mp4", width: 1080, height: 1080, container: "mp4" }
      ],
      textFit: { status: "passed", receiptPath: ".scratch/template-quality/pkg_shellx_media_launch/text-fit.receipt.json" },
      safeAreas: { status: "passed", receiptPath: ".scratch/template-quality/pkg_shellx_media_launch/safe-area.receipt.json" },
      generatedAssetReceiptPaths: ["receipts/generated-hero.receipt.json"]
    });

    expect(summarizeTemplateQuality(assessment)).toEqual({
      status: "passed",
      passed: 5,
      failed: 0,
      warning: 0,
      notApplicable: 2
    });
  });

  it("loads the audio-launch template with package audio controls", async () => {
    const pkg = await loadMotionPackage(join(PRODUCT_PACK_ROOT, "audio-launch"));

    expect(pkg.manifest).toMatchObject({
      id: "pkg_shellx_audio_launch",
      template: "template.json",
      assets: [
        "assets/audio/shellx-launch-tone.wav",
        "assets/fonts/inter-latin-600-normal.woff2",
        "assets/fonts/inter-latin-800-normal.woff2",
        "assets/fonts/inter-latin-900-normal.woff2"
      ],
      compatibility: { lanes: ["browser", "ffmpeg"], hosts: ["shellx-motion"] }
    });
    expect(pkg.motion.layers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "music-bed",
        type: "audio",
        source: "assets/audio/shellx-launch-tone.wav",
        volume: 0.72,
        fadeInMs: 180,
        fadeOutMs: 360
      })
    ]));
    expect(pkg.template?.params).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "musicVolume", type: "number", defaultValue: 0.72 })
    ]));
  });

  it("passes the starter-pack quality bar for audio-launch when audio proof exists", async () => {
    const pkg = await loadMotionPackage(join(PRODUCT_PACK_ROOT, "audio-launch"));

    const assessment = assessTemplateQuality(pkg, {
      contactSheetPath: "preview/contact-sheet.png",
      renderedOutputs: [
        { path: ".scratch/template-quality/pkg_shellx_audio_launch/fhd.mp4", width: 1920, height: 1080, container: "mp4" },
        { path: ".scratch/template-quality/pkg_shellx_audio_launch/square.mp4", width: 1080, height: 1080, container: "mp4" }
      ],
      textFit: { status: "passed", receiptPath: ".scratch/template-quality/pkg_shellx_audio_launch/text-fit.receipt.json" },
      safeAreas: { status: "passed", receiptPath: ".scratch/template-quality/pkg_shellx_audio_launch/safe-area.receipt.json" },
      audio: { status: "passed", streamCount: 1, receiptPath: ".scratch/template-quality/pkg_shellx_audio_launch/audio.receipt.json" }
    });

    expect(summarizeTemplateQuality(assessment)).toEqual({
      status: "passed",
      passed: 6,
      failed: 0,
      warning: 0,
      notApplicable: 1
    });
  });

  it("ships product-metric-card as a literal document that renders complete with no data file", async () => {
    const pkg = await loadMotionPackage(join(PRODUCT_PACK_ROOT, "product-metric-card"));

    // The whole point of the template rework: `render <package>` with no rows must paint the
    // finished card, so nothing in the shipped package may carry a mustache placeholder. Scanning
    // the serialized documents (rather than a layer allow-list) is what makes this total.
    expect(JSON.stringify(pkg.motion)).not.toMatch(/\{\{/);
    expect(JSON.stringify(pkg.manifest)).not.toMatch(/\{\{/);
    expect(JSON.stringify(pkg.template)).not.toMatch(/\{\{/);
    expect(pkg.motion.layers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "metric-value", text: "1,200" }),
      expect.objectContaining({ id: "progress-fill", width: 496 }),
      expect.objectContaining({ id: "cta", text: "View full report" })
    ]));
    // Every text layer in the base document has real copy — an empty string would render as a hole
    // in exactly the way a missing row value used to.
    for (const layer of pkg.motion.layers.filter((candidate) => candidate.type === "text")) {
      expect(typeof layer.text, layer.id).toBe("string");
      expect(String(layer.text).trim().length, layer.id).toBeGreaterThan(0);
    }
  });

  it("loads the product-metric-card data template with compiler-backed batch rows and social overrides", async () => {
    const pkg = await loadMotionPackage(join(PRODUCT_PACK_ROOT, "product-metric-card"));
    const rows = await loadPackageDataRows(pkg);
    const jobs = expandMotionPackageRows(pkg, rows);

    expect(pkg.manifest).toMatchObject({
      id: "pkg_shellx_product_metric_card",
      template: "template.json",
      compatibility: { lanes: ["browser", "ffmpeg"], hosts: ["shellx-motion"] },
      data: { rows: "data/product-metrics.batch.json" }
    });
    expect(rows.map((row) => row.id)).toEqual(["motion_renderer_lane", "cut_generate_lane", "canvas_export_lane"]);
    expect(pkg.template?.metadata?.outputBounds?.aspectRatios).toEqual(["16:9", "1:1"]);
    // The literal package remains a standalone render, while every shipped row carries the sealed
    // data block that materializes its metric/report visuals through the chart compilers.
    expect(jobs[0].motion.layers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "chart_product_metric_metric_value", text: "1,200" }),
      expect.objectContaining({ id: "chart_product_metric_metric_progress_fill", width: 500 })
    ]));
    // Row 1 re-themes and re-numbers the same 16:9 layout through the same data compiler.
    expect(jobs[1].motion).toMatchObject({
      width: 1920,
      height: 1080,
      layers: expect.arrayContaining([
        expect.objectContaining({ id: "chart_product_metric_metric_value", text: "320 min" }),
        expect.objectContaining({ id: "chart_product_metric_metric_progress_fill", width: 563, fill: "#f7b93f" }),
        expect.objectContaining({ id: "eyebrow", text: "CAMPAIGN METRICS" })
      ])
    });
    // Row 2 is the 1:1 social re-layout: its data becomes a comparison chart and the legacy
    // rail/metric layers are replaced rather than having stale geometry carried forward.
    expect(jobs[2].motion).toMatchObject({
      width: 1080,
      height: 1080,
      layers: expect.arrayContaining([
        expect.objectContaining({ id: "title", transform: { x: 72, y: 152 } }),
        expect.objectContaining({ id: "chart_product_metric_metric_value", text: "553" }),
        expect.objectContaining({ id: "chart_product_metric_comparison_published_current", width: 504 })
      ])
    });
    expect(jobs[2].motion.layers.map((layer) => layer.id))
      .not.toEqual(expect.arrayContaining(["rail-panel", "channel-1-fill", "timeline-progress", "metric-value"]));
    // The three rows must stay visibly different from each other, not just from the base document.
    expect(new Set(jobs.map((job) => JSON.stringify(job.motion.layers))).size).toBe(3);
  });

  it("passes the starter-pack quality bar for product-metric-card with batch output proof", async () => {
    const pkg = await loadMotionPackage(join(PRODUCT_PACK_ROOT, "product-metric-card"));

    const assessment = assessTemplateQuality(pkg, {
      contactSheetPath: ".scratch/template-quality/pkg_shellx_product_metric_card/contact-sheet.png",
      renderedOutputs: [
        { path: ".scratch/template-quality/pkg_shellx_product_metric_card/render/pkg_shellx_product_metric_card_motion_renderer_lane.mp4", width: 1920, height: 1080, container: "mp4" },
        { path: ".scratch/template-quality/pkg_shellx_product_metric_card/render/pkg_shellx_product_metric_card_canvas_export_lane.mp4", width: 1080, height: 1080, container: "mp4" }
      ],
      textFit: { status: "passed", receiptPath: ".scratch/template-quality/pkg_shellx_product_metric_card/text-fit.receipt.json" },
      safeAreas: { status: "passed", receiptPath: ".scratch/template-quality/pkg_shellx_product_metric_card/safe-area.receipt.json" }
    });

    expect(summarizeTemplateQuality(assessment)).toEqual({
      status: "passed",
      passed: 5,
      failed: 0,
      warning: 0,
      notApplicable: 2
    });
  });
});
