import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createIntegrationEnvelope, renderableLayerTypes, renderLanesFor } from "@shellx-motion/core";
import {
  CANVAS_FIXTURE_EXAMPLE,
  CanvasFixtureError,
  canvasFixtureContract,
  convertCanvasFrameToMotionPackage,
  type CanvasFixtureProblem
} from "./index";

describe("Canvas frame adapter", () => {
  async function loadFixture(): Promise<unknown> {
    const path = resolve("../../fixtures/canvas/frame-selection.json");
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  }

  /** Every problem the parser reported for `fixture`, or a failure if it accepted the document. */
  function captureProblems(fixture: unknown): CanvasFixtureProblem[] {
    try {
      convertCanvasFrameToMotionPackage(fixture);
    } catch (error) {
      if (error instanceof CanvasFixtureError) return error.problems;
      throw error;
    }
    throw new Error("expected the fixture to be rejected");
  }

  it("converts the selected Canvas frame into a Motion package", async () => {
    const fixture = await loadFixture();

    const result = convertCanvasFrameToMotionPackage(fixture);

    expect(result.manifest).toMatchObject({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_canvas_launch_campaign_frame_story_hero",
      name: "Launch Campaign - Story Hero",
      motion: "motion.json",
      sourceApp: "shellx-canvas",
      compatibility: {
        lanes: ["canvas", "browser", "ffmpeg"],
        hosts: ["shellx-motion", "shellx-canvas", "shellx-cut"]
      }
    });
    expect(result.motion).toMatchObject({
      schema: "shellx-motion/motion@1",
      id: "motion_canvas_frame_story_hero",
      name: "Story Hero",
      durationMs: 5000,
      fps: 30,
      width: 1080,
      height: 1920,
      background: "#f8fafc",
      provenance: {
        sourceApp: "shellx-canvas",
        createdBy: "canvas-adapter",
        projectId: "canvas_launch_campaign",
        selectedFrameId: "frame_story_hero"
      }
    });
    expect(result.motion.layers.map((layer) => layer.id)).toEqual(["hero_image", "headline", "cta_badge"]);
    expect(result.motion.layers[0]).toMatchObject({
      type: "image",
      assetId: "asset_product_retouched",
      startMs: 0,
      durationMs: 5000,
      fit: "cover",
      transform: { x: 80, y: 220, width: 920, height: 1020, rotation: 0, opacity: 1 }
    });
    expect(result.motion.layers[1]).toMatchObject({
      type: "text",
      text: "Launch faster with ShellX",
      style: { fontFamily: "Inter", fontSize: 76, color: "{color.brandPrimary}" }
    });
    expect(result.motion.layers[2]).toMatchObject({
      type: "shape",
      shape: "rounded-rect",
      style: { fill: "{color.accent}", radius: "{radius.badge}" }
    });
  });

  it("converts all Canvas frames into Motion scenes with offset layer timing", async () => {
    const fixture = await loadFixture();

    const result = convertCanvasFrameToMotionPackage(fixture, {
      includeAllFrames: true,
      createdAt: "2026-07-03T00:00:00.000Z"
    });

    expect(result.manifest).toMatchObject({
      id: "pkg_canvas_launch_campaign_all_frames",
      name: "Launch Campaign - All Frames",
      motion: "motion.json",
      sourceApp: "shellx-canvas"
    });
    expect(result.motion).toMatchObject({
      id: "motion_canvas_all_frames",
      name: "Launch Campaign",
      durationMs: 9000,
      fps: 30,
      width: 1080,
      height: 1920,
      scenes: [
        { id: "frame_story_hero", name: "Story Hero", startMs: 0, durationMs: 5000 },
        { id: "frame_unselected_square", name: "Square Cutdown", startMs: 5000, durationMs: 4000 }
      ],
      provenance: {
        sourceApp: "shellx-canvas",
        projectId: "canvas_launch_campaign",
        workflow: "canvas-page"
      }
    });
    expect(result.motion.layers.map((layer) => layer.id)).toEqual([
      "frame_story_hero_hero_image",
      "frame_story_hero_headline",
      "frame_story_hero_cta_badge",
      "frame_unselected_square_square_title"
    ]);
    expect(result.motion.layers[3]).toMatchObject({
      id: "frame_unselected_square_square_title",
      type: "text",
      text: "Not selected",
      startMs: 5000,
      durationMs: 4000
    });
    expect(result.receipt.output).toMatchObject({
      selectedFrameId: "frame_story_hero",
      frameCount: 2,
      frameIds: ["frame_story_hero", "frame_unselected_square"],
      layerCount: 4
    });
  });

  it("advertises generated renderer lanes for compatible Canvas frame packages", async () => {
    const fixture = await loadFixture();

    const result = convertCanvasFrameToMotionPackage(fixture);

    expect(result.manifest.compatibility.lanes).toEqual(["canvas", "browser", "ffmpeg"]);
    expect(result.manifest.compatibility.hosts).toEqual(["shellx-motion", "shellx-canvas", "shellx-cut"]);
    // Native is absent for a reason the cards state, not by accident: the headline sets a custom
    // text.font.family, which the native card does not support.
    expect(result.manifest.compatibility.lanes).toEqual(["canvas", ...renderLanesFor(result.motion)]);
  });

  // Superseded behaviour: this adapter kept its own GENERATED_RENDERER_LAYER_TYPES set which had
  // drifted from the capability cards — it omitted particles/shader/scene3d/camera/adjustment/
  // environment, so a package built from those kinds advertised lanes: ["canvas"] while the browser
  // and ffmpeg lanes rendered it. An agent reading the field concluded its package could not be
  // rendered by the lane that could. Proven end to end in
  // artifacts/lane-truth-defects/falsifier-lanes.ts, which renders this very package on the browser
  // lane.
  it("advertises the lanes that render kinds newer than any hand-written list", async () => {
    const fixture = await loadFixture() as Record<string, any>;
    fixture.frames[0].layers = [
      { id: "stage", kind: "scene3d", startMs: 0, durationMs: 5000 },
      { id: "sparks", kind: "particles", startMs: 0, durationMs: 5000 }
    ];

    const result = convertCanvasFrameToMotionPackage(fixture);

    expect(result.manifest.compatibility.lanes).toEqual(["canvas", "browser", "ffmpeg"]);
    expect(result.manifest.compatibility.lanes).toEqual(["canvas", ...renderLanesFor(result.motion)]);
  });

  it("withholds a render lane only when that lane genuinely refuses the document", async () => {
    const fixture = await loadFixture() as Record<string, any>;
    // audio is a renderable kind the import accepts, but the browser card has no audio layer type,
    // so only ffmpeg claims the whole document.
    fixture.frames[0].layers = [{ id: "vo", kind: "audio", startMs: 0, durationMs: 5000, source: "assets/vo.wav" }];

    const result = convertCanvasFrameToMotionPackage(fixture);

    expect(result.manifest.compatibility.lanes).toEqual(["canvas", "ffmpeg"]);
    expect(result.manifest.compatibility.lanes).toEqual(["canvas", ...renderLanesFor(result.motion)]);
  });

  // Superseded behaviour: an unknown kind used to be packaged with `lanes: ["canvas"]`, a label no
  // consumer in the repo reads. The package was therefore accepted, validated as valid, and then
  // refused by every render lane. The import now refuses it and names the accepted kinds.
  it("refuses unknown Canvas layer kinds instead of packaging a canvas-only label", async () => {
    const fixture = await loadFixture() as Record<string, any>;
    fixture.frames[0].layers.push({
      id: "unknown-widget",
      kind: "plugin-widget",
      startMs: 0,
      durationMs: 5000
    });

    expect(() => convertCanvasFrameToMotionPackage(fixture)).toThrow(CanvasFixtureError);
    const problems = captureProblems(fixture);
    expect(problems).toEqual([
      {
        path: "frames[0].layers[3].kind",
        message: `no Motion render lane supports "plugin-widget" layers; accepted kinds are ${renderableLayerTypes().join(", ")}`
      }
    ]);
  });

  it("carries Canvas brand tokens into MotionIR design tokens", async () => {
    const fixture = await loadFixture();

    const result = convertCanvasFrameToMotionPackage(fixture);

    expect(result.motion.designTokens).toEqual({
      color: {
        brandPrimary: "#0f3d5e",
        accent: "#f97316",
        surface: "#f8fafc",
        ink: "#0f172a"
      },
      typography: {
        heading: { fontFamily: "Inter", fontWeight: 800 },
        body: { fontFamily: "Inter", fontWeight: 500 }
      },
      spacing: { framePadding: 64, badgeInset: 18 },
      radius: { badge: 28, image: 36 }
    });
  });

  it("carries Canvas frame safe areas into MotionIR and receipt metadata", async () => {
    const fixture = await loadFixture() as Record<string, any>;
    fixture.frames[0].safeAreas = {
      title: { top: 96, right: 128, bottom: 108, left: 128 },
      action: { top: 48, right: 64, bottom: 64, left: 64 }
    };

    const result = convertCanvasFrameToMotionPackage(fixture, {
      createdAt: "2026-07-02T00:10:00.000Z"
    });

    expect(result.motion.safeAreas).toEqual({
      title: { top: 96, right: 128, bottom: 108, left: 128 },
      action: { top: 48, right: 64, bottom: 64, left: 64 }
    });
    expect(result.receipt.output).toMatchObject({
      safeAreaCount: 2
    });
  });

  it("maps image-editor outputs into AssetIR-like Motion assets", async () => {
    const fixture = await loadFixture();

    const result = convertCanvasFrameToMotionPackage(fixture);

    expect(result.manifest.assets).toEqual(["assets/product-retouched.png"]);
    expect(result.motion.assets).toEqual([
      {
        schema: "shellx-motion/asset@1",
        id: "asset_product_retouched",
        kind: "image",
        source: {
          app: "shellx-canvas/image-editor",
          path: "assets/product-retouched.png",
          mimeType: "image/png"
        },
        hash: {
          sha256: "0f6b7b32792c8f8217a78fd375d2f26d51e39bf25f21b8c07b9713f22b3c4f4a"
        },
        size: { width: 920, height: 1020 },
        editStack: [
          { op: "crop", rect: { x: 80, y: 0, width: 920, height: 1020 } },
          { op: "color-adjust", exposure: 0.15, saturation: 1.08 },
          { op: "background-remove", model: "shellx-bg-cutout-v1" }
        ],
        provenance: {
          sourceFrameId: "frame_story_hero",
          imageEditorOutputId: "image_edit_product_1",
          receiptId: "receipt_canvas_image_editor_1"
        }
      }
    ]);
  });

  it("collects Canvas media assets referenced through assetRef, source, and src aliases", async () => {
    const fixture = await loadFixture() as Record<string, any>;
    const baseLayer = fixture.frames[0].layers[0];
    fixture.frames[0].layers = [
      {
        ...baseLayer,
        id: "asset_ref_image",
        assetId: undefined,
        assetRef: "asset_product_retouched"
      },
      {
        ...baseLayer,
        id: "source_image",
        assetId: undefined,
        source: "assets/source-image.png"
      },
      {
        ...baseLayer,
        id: "src_image",
        assetId: undefined,
        src: "assets/src-image.png"
      }
    ];

    const result = convertCanvasFrameToMotionPackage(fixture);

    expect(result.manifest.assets).toEqual([
      "assets/product-retouched.png",
      "assets/source-image.png",
      "assets/src-image.png"
    ]);
    expect(result.motion.assets.map((asset) => (asset as Record<string, unknown>).id)).toEqual([
      "asset_product_retouched"
    ]);
    expect(result.motion.layers).toMatchObject([
      { id: "asset_ref_image", assetRef: "asset_product_retouched" },
      { id: "source_image", source: "assets/source-image.png" },
      { id: "src_image", src: "assets/src-image.png" }
    ]);
  });

  it("emits an export receipt with selected-frame and fixture hash evidence", async () => {
    const fixture = await loadFixture();

    const result = convertCanvasFrameToMotionPackage(fixture, {
      createdAt: "2026-06-29T20:30:00.000Z"
    });

    expect(result.receipt).toMatchObject({
      schema: "shellx-motion/receipt@1",
      id: "receipt_canvas_export_frame_story_hero",
      operation: "export.final",
      status: "passed",
      packageId: "pkg_canvas_launch_campaign_frame_story_hero",
      createdAt: "2026-06-29T20:30:00.000Z",
      lane: "canvas",
      output: {
        sourceApp: "shellx-canvas",
        projectId: "canvas_launch_campaign",
        selectedFrameId: "frame_story_hero",
        motionId: "motion_canvas_frame_story_hero",
        manifestId: "pkg_canvas_launch_campaign_frame_story_hero",
        layerCount: 3,
        assetCount: 1
      },
      warnings: []
    });
    expect(Object.keys(result.receipt.inputHashes)).toEqual(["fixtures/canvas/frame-selection.json"]);
    expect(result.receipt.inputHashes["fixtures/canvas/frame-selection.json"]).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects a missing selected frame", async () => {
    const fixture = await loadFixture();

    expect(() => convertCanvasFrameToMotionPackage(fixture, { selectedFrameId: "frame_missing" })).toThrow(
      /Selected Canvas frame not found: frame_missing/
    );
  });

  it("accepts the canonical Motion-owned Canvas schema with a verified envelope", async () => {
    const fixture = await loadFixture() as Record<string, any>;
    fixture.schema = "shellx-motion/canvas-frame-selection@1";
    fixture.integration = createIntegrationEnvelope({
      producer: "shellx-canvas",
      consumer: "shellx-motion",
      mode: "canvas.bridge",
      payloadSchema: fixture.schema,
      requiredFeatures: ["artifact.attestation"]
    });
    fixture.identity = {
      schema: "shellx-motion/package-identity@1",
      packageId: "pkg_canvas_launch_campaign_frame_story_hero",
      motionId: "motion_canvas_frame_story_hero"
    };

    const result = convertCanvasFrameToMotionPackage(fixture);

    expect(result.motion.provenance).toMatchObject({ integrationProtocol: 1 });
  });

  it("keeps the legacy Canvas schema as an explicit compatibility adapter", async () => {
    const fixture = await loadFixture();
    const result = convertCanvasFrameToMotionPackage(fixture);
    expect(result.motion.provenance).toMatchObject({ compatibilityAdapter: "shellx-canvas/frame-selection@1" });
  });

  it("rejects canonical Canvas payloads with unsupported protocol or no envelope", async () => {
    const fixture = await loadFixture() as Record<string, any>;
    fixture.schema = "shellx-motion/canvas-frame-selection@1";
    expect(() => convertCanvasFrameToMotionPackage(fixture)).toThrow("Integration envelope must be an object");

    fixture.integration = createIntegrationEnvelope({
      producer: "shellx-canvas",
      consumer: "shellx-motion",
      mode: "canvas.bridge",
      payloadSchema: fixture.schema
    });
    fixture.identity = {
      schema: "shellx-motion/package-identity@1",
      packageId: "pkg_canvas_launch_campaign_frame_story_hero",
      motionId: "motion_canvas_frame_story_hero"
    };
    fixture.integration.binding.protocol = 2;
    expect(() => convertCanvasFrameToMotionPackage(fixture)).toThrow("does not match negotiated protocol");
  });

  it("rejects canonical Canvas payloads whose package identity was retargeted", async () => {
    const fixture = await loadFixture() as Record<string, any>;
    fixture.schema = "shellx-motion/canvas-frame-selection@1";
    fixture.integration = createIntegrationEnvelope({
      producer: "shellx-canvas",
      consumer: "shellx-motion",
      mode: "canvas.bridge",
      payloadSchema: fixture.schema
    });
    fixture.identity = {
      schema: "shellx-motion/package-identity@1",
      packageId: "pkg_other",
      motionId: "motion_other"
    };
    expect(() => convertCanvasFrameToMotionPackage(fixture)).toThrow("package identity does not match");
  });
});

/**
 * Regression suite for the two agent-facing defects a blind external agent reproduced against the
 * live MCP server during cross-host verification:
 *
 *   Invalid layer kind — a fixture using `kind: "rect"` packaged cleanly, `motion.package.validate` answered
 *        `valid: true`, and then preview and render both refused it ("Lane browser does not support
 *        rect layers"). The engine told the author the package was valid and would not draw it.
 *   Incomplete fixture shape — each call revealed exactly one missing field, so
 *        learning the contract took thirteen round trips.
 */
describe("Canvas fixture contract", () => {
  const rectFixture = {
    schema: "shellx-canvas/frame-selection@1",
    selectedFrameId: "frame_intro",
    project: { id: "rect_probe", name: "Rect Probe" },
    brand: { tokens: {} },
    frames: [
      {
        id: "frame_intro",
        name: "Intro",
        durationMs: 1000,
        fps: 2,
        width: 640,
        height: 360,
        layers: [
          { id: "box", kind: "rect", startMs: 0, durationMs: 1000 },
          { id: "dot", kind: "ellipse", startMs: 0, durationMs: 1000 }
        ]
      }
    ],
    imageEditorOutputs: []
  };

  function problemsFor(fixture: unknown): CanvasFixtureProblem[] {
    try {
      convertCanvasFrameToMotionPackage(fixture);
    } catch (error) {
      if (error instanceof CanvasFixtureError) return error.problems;
      throw error;
    }
    throw new Error("expected the fixture to be rejected");
  }

  it("refuses kind:rect and kind:ellipse, naming the exact correction for each", () => {
    expect(problemsFor(rectFixture)).toEqual([
      {
        path: "frames[0].layers[0].kind",
        message: `no Motion render lane supports "rect" layers; accepted kinds are ${renderableLayerTypes().join(", ")}`,
        correction: 'write {"kind":"shape","shape":"rect"} instead of {"kind":"rect"}'
      },
      {
        path: "frames[0].layers[1].kind",
        message: `no Motion render lane supports "ellipse" layers; accepted kinds are ${renderableLayerTypes().join(", ")}`,
        correction: 'write {"kind":"shape","shape":"ellipse"} instead of {"kind":"ellipse"}'
      }
    ]);
  });

  it("refuses an unrenderable kind on a hidden layer too", () => {
    const hidden = structuredClone(rectFixture) as any;
    hidden.frames[0].layers = [{ id: "box", kind: "rect", startMs: 0, durationMs: 1000, visible: false }];

    expect(problemsFor(hidden).map((problem) => problem.path)).toEqual(["frames[0].layers[0].kind"]);
  });

  it("accepts the corrected form the rejection names", () => {
    const corrected = structuredClone(rectFixture) as any;
    corrected.frames[0].layers[0] = { id: "box", kind: "shape", shape: "rect", startMs: 0, durationMs: 1000 };
    corrected.frames[0].layers[1] = { id: "dot", kind: "shape", shape: "ellipse", startMs: 0, durationMs: 1000 };

    const result = convertCanvasFrameToMotionPackage(corrected);

    expect(result.motion.layers.map((layer) => [layer.type, layer.shape])).toEqual([["shape", "rect"], ["shape", "ellipse"]]);
  });

  it("accepts only layer kinds a registered renderer lane can consume", () => {
    // The gate reads renderableLayerTypes(), so this asserts agreement with the lane cards rather
    // than with a list written down twice.
    for (const kind of renderableLayerTypes()) {
      const fixture = structuredClone(rectFixture) as any;
      fixture.frames[0].layers = [{ id: "probe", kind, startMs: 0, durationMs: 1000 }];
      expect(() => convertCanvasFrameToMotionPackage(fixture), `kind ${kind} should be accepted`).not.toThrow();
    }
  });

  it("reports every problem in an empty document in one answer, not one per call", () => {
    const problems = problemsFor({});

    // The thirteen-round-trip binary search collapses to a single call.
    expect(problems.map((problem) => problem.path)).toEqual([
      "fixture.schema",
      "fixture.selectedFrameId",
      "project",
      "brand",
      "fixture.frames",
      "fixture.imageEditorOutputs"
    ]);
  });

  it("reports every problem across nested frames and layers in one answer", () => {
    const problems = problemsFor({
      schema: "shellx-canvas/frame-selection@1",
      selectedFrameId: "f1",
      project: { id: "p" },
      brand: {},
      frames: [{ id: "f1", layers: [{ id: "l1", kind: "rect" }] }],
      imageEditorOutputs: []
    });

    expect(problems.map((problem) => problem.path)).toEqual([
      "project.name",
      "brand.tokens",
      "frames[0].name",
      "frames[0].durationMs",
      "frames[0].fps",
      "frames[0].width",
      "frames[0].height",
      "frames[0].layers[0].kind",
      "frames[0].layers[0].startMs",
      "frames[0].layers[0].durationMs"
    ]);
  });

  it("names both accepted schema ids when the schema id is wrong", () => {
    const problems = problemsFor({ ...rectFixture, schema: "canvas/frame@1" });

    expect(problems[0]).toEqual({
      path: "fixture.schema",
      message: "Unsupported Canvas fixture schema: canvas/frame@1",
      correction: "use one of shellx-motion/canvas-frame-selection@1 or shellx-canvas/frame-selection@1"
    });
  });

  it("publishes a contract whose example actually converts", () => {
    const contract = canvasFixtureContract();

    expect(contract.schemas).toEqual(["shellx-motion/canvas-frame-selection@1", "shellx-canvas/frame-selection@1"]);
    expect(contract.layerKinds).toEqual([...renderableLayerTypes()]);
    expect(contract.requiredFields.layer).toEqual(["id", "kind", "startMs", "durationMs"]);
    // An example an agent copies must be one the engine accepts; assert it, do not assume it.
    const result = convertCanvasFrameToMotionPackage(structuredClone(CANVAS_FIXTURE_EXAMPLE));
    expect(result.motion.layers.map((layer) => layer.type)).toEqual(["shape"]);
    expect(result.manifest.compatibility.lanes).toContain("browser");
  });
});
