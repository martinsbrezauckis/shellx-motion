import { describe, expect, it } from "vitest";
import {
  assessTemplateQuality,
  listTemplateQualityRules,
  summarizeTemplateQuality
} from "./template-quality";
import type { MotionPackage } from "./types";

describe("template quality bar", () => {
  it("lists the public starter-pack quality rules in stable order", () => {
    expect(listTemplateQualityRules().map((rule) => rule.id)).toEqual([
      "template-sidecar-complete",
      "preview-poster-contact-sheet",
      "fhd-social-output-bounds",
      "text-fit-safe-areas",
      "source-asset-provenance",
      "audio-stream-proof",
      "cut-canvas-connector-receipts"
    ]);
  });

  it("passes a template package only when required visual, provenance, and host evidence exists", () => {
    const result = assessTemplateQuality(compliantTemplatePackage(), {
      contactSheetPath: ".scratch/reviews/shellx-product-pack/contact-sheet.png",
      renderedOutputs: [
        { path: ".scratch/renders/launch-fhd.mp4", width: 1920, height: 1080, container: "mp4" },
        { path: ".scratch/renders/launch-square.mp4", width: 1080, height: 1080, container: "mp4" }
      ],
      textFit: { status: "passed", receiptPath: ".scratch/quality/text-fit.json" },
      safeAreas: { status: "passed", receiptPath: ".scratch/quality/safe-areas.json" },
      generatedAssetReceiptPaths: [".scratch/receipts/generated-hero.json"],
      audio: { status: "passed", streamCount: 1, receiptPath: ".scratch/quality/audio.json" },
      connectorReceipts: [
        { host: "shellx-cut", status: "passed", receiptPath: ".scratch/cut/template-to-cut.receipt.json" },
        { host: "shellx-canvas", status: "passed", receiptPath: ".scratch/canvas/canvas-mp4.receipt.json" }
      ]
    });

    expect(result.status).toBe("passed");
    expect(result.results.every((item) => item.status === "passed")).toBe(true);
    expect(summarizeTemplateQuality(result)).toEqual({
      status: "passed",
      passed: 7,
      failed: 0,
      warning: 0,
      notApplicable: 0
    });
  });

  it("reports exact missing evidence for immature templates", () => {
    const result = assessTemplateQuality({
      ...compliantTemplatePackage(),
      template: undefined,
      motion: {
        ...compliantTemplatePackage().motion,
        layers: [
          ...compliantTemplatePackage().motion.layers,
          { id: "music", type: "audio", startMs: 0, durationMs: 4000, source: "assets/music.wav" }
        ]
      },
      manifest: {
        ...compliantTemplatePackage().manifest,
        compatibility: { lanes: ["browser", "ffmpeg"], hosts: ["shellx-cut", "shellx-canvas"] }
      }
    }, {
      renderedOutputs: [{ path: ".scratch/renders/launch-720p.mp4", width: 1280, height: 720, container: "mp4" }],
      textFit: { status: "failed" },
      safeAreas: { status: "missing" },
      audio: { status: "missing", streamCount: 0 },
      connectorReceipts: [{ host: "shellx-cut", status: "passed", receiptPath: ".scratch/cut.receipt.json" }]
    });

    expect(result.status).toBe("failed");
    expect(result.results.filter((item) => item.status === "failed").map((item) => item.ruleId)).toEqual([
      "template-sidecar-complete",
      "preview-poster-contact-sheet",
      "fhd-social-output-bounds",
      "text-fit-safe-areas",
      "source-asset-provenance",
      "audio-stream-proof",
      "cut-canvas-connector-receipts"
    ]);
    expect(result.results.find((item) => item.ruleId === "audio-stream-proof")).toMatchObject({
      message: "Audio layers require ffprobe/audio quality evidence with at least one audio stream."
    });
  });
});

function compliantTemplatePackage(): MotionPackage {
  return {
    root: "/tmp/pkg",
    manifest: {
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_product_launch",
      name: "Product Launch",
      motion: "motion.json",
      template: "template.json",
      assets: ["assets/generated/hero.png", "assets/music.wav"],
      sourceApp: "shellx-motion",
      compatibility: {
        lanes: ["browser", "ffmpeg"],
        hosts: ["shellx-motion", "shellx-cut", "shellx-canvas"]
      }
    },
    motion: {
      schema: "shellx-motion/motion@1",
      id: "motion_product_launch",
      name: "Product Launch",
      durationMs: 4000,
      fps: 30,
      width: 1920,
      height: 1080,
      safeAreas: {
        title: { top: 90, right: 120, bottom: 90, left: 120 }
      },
      layers: [
        { id: "hero", type: "image", startMs: 0, durationMs: 4000, source: "assets/generated/hero.png", assetRef: "assets/generated/hero.png" },
        { id: "title", type: "text", startMs: 0, durationMs: 4000, text: "ShellX Motion", style: { fontSize: 88 } },
        { id: "music", type: "audio", startMs: 0, durationMs: 4000, source: "assets/music.wav" }
      ],
      assets: [{ id: "hero", ref: "assets/generated/hero.png" }],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    },
    template: {
      schema: "shellx-motion/template@1",
      id: "template_product_launch",
      name: "Product Launch",
      motion: "motion.json",
      compatibleLanes: ["browser", "ffmpeg"],
      compatibleHosts: ["shellx-motion", "shellx-cut", "shellx-canvas"],
      metadata: {
        inputSchema: {
          type: "object",
          required: ["title"],
          properties: { title: { type: "string", maxLength: 44 } }
        },
        inputExamples: [{ title: "ShellX Motion" }],
        outputBounds: {
          minWidth: 720,
          maxWidth: 3840,
          minHeight: 720,
          maxHeight: 2160,
          minDurationMs: 1500,
          maxDurationMs: 12000,
          aspectRatios: ["16:9", "1:1"]
        },
        suitability: {
          bestFor: ["launch clips", "product announcements"],
          notFor: ["long-form tutorials"]
        },
        license: {
          id: "shellx-sample",
          commercialUse: true,
          redistributionAllowed: true,
          attributionRequired: false
        },
        assetsAttribution: [
          { name: "Generated hero", license: "generated-local", path: "assets/generated/hero.png" }
        ],
        preview: {
          poster: "preview/poster.png",
          thumbnail: "preview/thumb.webp"
        },
        provenance: {
          source: "shellx-product-pack",
          sourceHash: "a".repeat(64),
          generatedBy: "codex-subscription-cli"
        },
        performance: {
          recommendedLane: "browser",
          renderCost: "medium",
          previewFps: 30
        }
      },
      groups: [{ id: "content", label: "Content" }],
      params: [{ id: "title", label: "Title", type: "text", defaultValue: "ShellX Motion" }],
      controls: [{ paramId: "title", widget: "text", label: "Title" }],
      bindings: [{ paramId: "title", target: { kind: "motion_path", path: "/layers/1/text", layerId: "title" } }]
    }
  };
}
