import { readdir, readFile } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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

/**
 * The families this tree is expected to hold, derived from the ONE contract rather than repeated.
 *
 * The implementation tree can retain additional withheld families while the public tree contains
 * only the published contract. Deriving the local set keeps the same tests valid in both trees.
 */
const EXPECTED_PRODUCT_PACK_DIRS = readdirSync(PRODUCT_PACK_ROOT, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

/**
 * Families the export manifest withholds, read as DATA rather than imported.
 *
 * `scripts/template-product-pack-catalog.ts` owns the same derivation, but core cannot import from
 * `scripts/` -- its tsconfig rootDir is `packages/core/src`, and a cross-boundary import fails
 * typecheck in both trees. Reading the manifest JSON keeps the single source of truth (the manifest)
 * without creating a module dependency that does not belong.
 */
function withheldFamilies(): Set<string> {
  const manifestPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../scripts/public-export-manifest.json");
  // Absent in the published tree: the published tree does not carry the export manifest (it is implementation-side release machinery), and by definition nothing is withheld there -- the withheld families are simply absent. An empty set is the correct answer, not an error.
  if (!existsSync(manifestPath)) return new Set<string>();
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { excludeWithin: Array<{ glob: string }> };
  const prefix = "**/templates/shellx-product-pack/";
  return new Set(
    manifest.excludeWithin
      .map((entry) => entry.glob)
      .filter((glob) => glob.startsWith(prefix) && glob.endsWith("/**"))
      .map((glob) => glob.slice(prefix.length, -"/**".length))
  );
}

/** Families present here, so a test needing a withheld family can skip in the published tree. */
const PRESENT_FAMILIES = new Set(EXPECTED_PRODUCT_PACK_DIRS);

/** Withheld families that are still on disk in THIS tree (all three in the implementation repo, none in the export). */
const WITHHELD_PRESENT = [...withheldFamilies()].filter((dir) => PRESENT_FAMILIES.has(dir)).sort();

describe("ShellX product template pack", () => {
  it("loads every promoted starter template with catalog-ready metadata", async () => {
    const entries = await readdir(PRODUCT_PACK_ROOT, { withFileTypes: true });
    const packageDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();

    expect(packageDirs).toEqual(EXPECTED_PRODUCT_PACK_DIRS);
    // The PUBLIC pack is 12 families. Asserted as "present minus withheld" so the same line is true
    // in both trees -- the implementation repo holds 15 with 3 withheld, the export holds 12 with 0
    // withheld -- and so a family silently disappearing is caught here rather than at publish time.
    // The family ROSTER itself is enforced by assertProductTemplateContract in the pack gates; core
    // cannot import that (rootDir boundary), so this pins the count it can prove from here.
    expect(packageDirs.length - WITHHELD_PRESENT.length, "the published pack must be 12 families").toBe(12);

    const packages = await Promise.all(packageDirs.map((dir) => loadMotionPackage(join(PRODUCT_PACK_ROOT, dir))));
    // Derived from the directories present, not a frozen 15-name list: the published tree ships 12 of
    // these families and the implementation tree 15, so a hard-coded roster is wrong in one of them.
    // What is asserted is the RELATIONSHIP -- every family's package id is its directory name in the
    // pkg_shellx_<dir> form -- which is the naming contract the list was really encoding, and which
    // holds in both trees.
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

    // Split by whether the family ships. The published pack must still cover every design family it
    // promises; the three withheld families are only asserted where they exist, so this test states
    // the public contract in the export and the fuller contract in the implementation tree.
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
    for (const [dir, phrase] of [
      ["lower-third-modern", "lower third"],
      ["data-report-brief", "data report"],
      ["tutorial-overlay", "tutorial overlay"]
    ] as const) {
      if (PRESENT_FAMILIES.has(dir)) expect(searchText, `${dir} present but uncovered`).toContain(phrase);
    }
  });

  it("passes the quality bar for new non-audio starter templates with expected evidence", async () => {
    // Filtered to what this tree holds: three of these are withheld from the published pack, and a
    // test that hard-codes them is red in the export for a reason that has nothing to do with quality.
    const dirs = [
      "data-report-brief",
      "feature-announcement",
      "kinetic-type",
      "launch-bumper",
      "lower-third-modern",
      "social-stat-card",
      "tutorial-overlay"
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
    // media-launch, not tutorial-overlay: the media-slot contract must be covered by a family that
    // actually ships, or the published tree loses the coverage entirely.
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

  it.skipIf(!PRESENT_FAMILIES.has("tutorial-overlay"))("loads tutorial-overlay with package-local media slot metadata", async () => {
    const pkg = await loadMotionPackage(join(PRODUCT_PACK_ROOT, "tutorial-overlay"));

    expect(pkg.manifest).toMatchObject({
      id: "pkg_shellx_tutorial_overlay",
      // The bundled Inter faces are declared alongside the media slot: every family that names a
      // real font family carries the weights it renders with.
      assets: [
        "assets/placeholders/tutorial-screen.svg",
        "assets/fonts/inter-latin-700-normal.woff2",
        "assets/fonts/inter-latin-900-normal.woff2"
      ]
    });
    expect(pkg.motion.layers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "screen",
        type: "image",
        source: "assets/placeholders/tutorial-screen.svg",
        assetRef: "assets/placeholders/tutorial-screen.svg"
      })
    ]));
    expect(pkg.template?.params).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "screenMedia",
        type: "media",
        defaultValue: "assets/placeholders/tutorial-screen.svg"
      })
    ]));
    expect(pkg.template?.metadata?.assetsAttribution).toEqual([
      expect.objectContaining({
        name: "Tutorial Screen Placeholder",
        path: "assets/placeholders/tutorial-screen.svg"
      }),
      expect.objectContaining({
        license: "SIL-OFL-1.1",
        path: "assets/fonts/inter-latin-700-normal.woff2"
      }),
      expect.objectContaining({
        license: "SIL-OFL-1.1",
        path: "assets/fonts/inter-latin-900-normal.woff2"
      })
    ]);
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
        lanes: ["browser", "ffmpeg"],
        hosts: ["shellx-motion", "shellx-canvas", "shellx-cut"]
      }
    });
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

  it("loads the product-metric-card data template with batch rows and social overrides", async () => {
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
    // Row 0 is the shipped design itself: it carries no layer patches, so the expanded job must be
    // byte-identical to the literal document apart from the ids/provenance expansion adds.
    expect(jobs[0].motion.layers).toEqual(pkg.motion.layers);
    expect(jobs[0].motion.layers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "metric-value", text: "1,200" }),
      expect.objectContaining({ id: "progress-fill", width: 496 })
    ]));
    // Row 1 re-themes and re-numbers the same 16:9 layout: same canvas, different accent and a
    // different progress geometry out of the same source layer.
    expect(jobs[1].motion).toMatchObject({
      width: 1920,
      height: 1080,
      layers: expect.arrayContaining([
        expect.objectContaining({ id: "metric-value", text: "3.2" }),
        expect.objectContaining({ id: "progress-fill", width: 558, fill: "#f7b93f" }),
        expect.objectContaining({ id: "eyebrow", text: "CAMPAIGN METRICS" })
      ])
    });
    // Row 2 is the 1:1 social re-layout: new canvas, its own title transform, its own progress
    // geometry, and 26 layers dropped because the rail/channel/timeline blocks do not fit a square.
    expect(jobs[2].motion).toMatchObject({
      width: 1080,
      height: 1080,
      layers: expect.arrayContaining([
        expect.objectContaining({ id: "title", transform: { x: 72, y: 152 } }),
        expect.objectContaining({ id: "progress-fill", width: 518 })
      ])
    });
    expect(jobs[2].motion.layers.filter((layer) => layer.visible === false).map((layer) => layer.id))
      .toEqual(expect.arrayContaining(["rail-panel", "channel-1-fill", "timeline-progress"]));
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
