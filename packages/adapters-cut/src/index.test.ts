import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadMotionPackage, type MotionLayer, type MotionPackage, type PackageRenderLineage } from "@shellx-motion/core";
import { attachRenderedMediaToCutPlan, placeRenderedMediaInCutPlan, planCutImport, type CutTargetCapabilities } from "./index";

const fullCutCapabilities: CutTargetCapabilities = {
  targetId: "cut-fixture",
  modes: ["editable_lowering", "live_overlay", "rendered_media"],
  lowerableLayerTypes: ["text", "shape", "caption", "image", "video"]
};

describe("Cut import planner", () => {
  it("lowers supported lower-third text, shape, and caption layers to editable Cut operations", async () => {
    const pkg = withLowerThirdNativeLayers(await loadMotionPackage(resolve("../../fixtures/packages/lower-third")));
    const expected = JSON.parse(await readFile(resolve("../../fixtures/cut/import-plan.expected.json"), "utf8"));

    const plan = planCutImport(pkg, fullCutCapabilities);

    expect(stablePlan(plan)).toEqual(expected);
    expect(plan.integration).toMatchObject({
      schema: "shellx-motion/integration-envelope@1",
      producer: { host: "shellx-motion" },
      binding: {
        protocol: 1,
        producer: "shellx-motion",
        consumer: "shellx-cut",
        mode: "cut.import.plan",
        payloadSchema: "shellx-motion/cut-import-plan@1",
        requiredFeatures: ["artifact.attestation"]
      }
    });
  });

  it("requires rendered-media mode for web-card packages", async () => {
    const pkg = await loadMotionPackage(resolve("../../fixtures/packages/web-card"));

    const plan = planCutImport(pkg, fullCutCapabilities);

    expect(plan.ok).toBe(true);
    expect(plan.mode).toBe("rendered_media");
    expect(plan.operations).toEqual([
      {
        verb: "cut.media.import_rendered",
        source: { packageId: "pkg_web_card", motionId: "motion_web_card", render: "required" },
        startMs: 0,
        durationMs: 2000,
        media: { width: 1280, height: 720, fps: 30 }
      }
    ]);
    expect(plan.unsupported).toEqual([
      {
        layerId: "web-card",
        feature: "layer.type:web",
        reason: "Layer web-card uses browser-rendered web content; Cut import requires rendered_media mode."
      }
    ]);
  });

  it("keeps machine-readable rich-feature reasons when exact native lowering falls back", async () => {
    const pkg = await loadMotionPackage(resolve("../../fixtures/packages/holographic-lab-promo"));

    const plan = planCutImport(pkg, {
      ...fullCutCapabilities,
      modes: ["editable_lowering", "rendered_media"]
    });

    expect(plan.ok).toBe(true);
    expect(plan.mode).toBe("rendered_media");
    expect(plan.unsupported).toEqual(expect.arrayContaining([
      {
        layerId: "hologram-field",
        feature: "layer.type:shader",
        reason: "Target cut-fixture cannot lower shader layers to editable Cut operations."
      },
      {
        layerId: "particles",
        feature: "layer.type:particles",
        reason: "Target cut-fixture cannot lower particles layers to editable Cut operations."
      }
    ]));
    expect(plan.receipt.output).toMatchObject({
      mode: "rendered_media",
      unsupportedCount: plan.unsupported.length
    });
  });

  it("can bind rendered-media artifact metadata to a Cut import plan", async () => {
    const pkg = await loadMotionPackage(resolve("../../fixtures/packages/web-card"));
    const plan = planCutImport(pkg, fullCutCapabilities);

    const withArtifact = attachRenderedMediaToCutPlan(plan, {
      plannedPath: "/tmp/shellx-motion/render/pkg_web_card.mp4",
      receiptPath: "/tmp/shellx-motion/receipts/ffmpeg-render.receipt.json",
      dryRun: true
    });

    expect(withArtifact.operations).toEqual([
      {
        verb: "cut.media.import_rendered",
        source: { packageId: "pkg_web_card", motionId: "motion_web_card", render: "dry_run" },
        startMs: 0,
        durationMs: 2000,
        media: { width: 1280, height: 720, fps: 30 },
        renderedMedia: {
          plannedPath: "/tmp/shellx-motion/render/pkg_web_card.mp4",
          receiptPath: "/tmp/shellx-motion/receipts/ffmpeg-render.receipt.json",
          dryRun: true
        }
      }
    ]);
    expect(withArtifact.receipt.output).toMatchObject({
      mode: "rendered_media",
      renderedMedia: {
        dryRun: true,
        plannedPath: "/tmp/shellx-motion/render/pkg_web_card.mp4",
        receiptPath: "/tmp/shellx-motion/receipts/ffmpeg-render.receipt.json"
      }
    });
  });

  it("records explicit Cut timeline placement in rendered-media plans", async () => {
    const pkg = await loadMotionPackage(resolve("../../fixtures/packages/web-card"));
    const plan = placeRenderedMediaInCutPlan(planCutImport(pkg, fullCutCapabilities), {
      startMs: 1250,
      durationMs: 1800,
      track: "overlay-2"
    });

    expect(plan.operations).toEqual([
      expect.objectContaining({
        verb: "cut.media.import_rendered",
        startMs: 1250,
        durationMs: 1800,
        track: "overlay-2"
      })
    ]);
    expect(plan.receipt.inputHashes.placement).toMatch(/^[a-f0-9]{64}$/);
    expect(plan.receipt.output).toMatchObject({
      placement: { startMs: 1250, durationMs: 1800, track: "overlay-2" }
    });
    expect(() => placeRenderedMediaInCutPlan(plan, { startMs: -1 })).toThrow(/non-negative/);
    expect(() => placeRenderedMediaInCutPlan(plan, { durationMs: 0 })).toThrow(/positive/);
    expect(() => placeRenderedMediaInCutPlan(plan, { track: " " })).toThrow(/non-empty/);
  });

  it("binds the descriptor, operation, and complete package lineage into the Cut receipt", async () => {
    const pkg = await loadMotionPackage(resolve("../../fixtures/packages/web-card"));
    const lineage: PackageRenderLineage = {
      schema: "shellx-motion/package-render-lineage@1",
      manifestSha256: "a".repeat(64),
      motionSha256: "b".repeat(64),
      adapterId: "adapter.gltf",
      sourceSha256: "c".repeat(64),
      normalizedSourceSha256: "d".repeat(64),
      loweringReceiptSha256: "e".repeat(64),
    };
    const base = planCutImport(pkg, fullCutCapabilities);
    const handle = {
      schema: "shellx-motion/artifact-handle-ref@1" as const,
      id: "artifact-0123456789abcdef01234567",
      operationHash: "f".repeat(64),
      rootRelativePath: "artifacts/rendered.artifact.json",
      sha256: "0".repeat(64),
      packageLineage: lineage,
    };
    const plan = attachRenderedMediaToCutPlan(base, { dryRun: false, handle });

    expect(plan.receipt.inputHashes).toEqual({
      motion: expect.stringMatching(/^[a-f0-9]{64}$/),
      targetCapabilities: expect.stringMatching(/^[a-f0-9]{64}$/),
      artifactDescriptorSha256: "0".repeat(64),
      artifactOperationHash: "f".repeat(64),
      manifestSha256: "a".repeat(64),
      motionSha256: "b".repeat(64),
      sourceSha256: "c".repeat(64),
      normalizedSourceSha256: "d".repeat(64),
      loweringReceiptSha256: "e".repeat(64),
    });
    expect(plan.operations).toEqual([
      expect.objectContaining({
        verb: "cut.media.import_rendered",
        source: { packageId: pkg.manifest.id, motionId: pkg.motion.id, render: "artifact" },
        startMs: 0,
        durationMs: pkg.motion.durationMs,
        media: { width: pkg.motion.width, height: pkg.motion.height, fps: pkg.motion.fps },
      }),
    ]);
    expect(plan.receipt.id).toMatch(/^cut-import-[a-f0-9]{16}$/);
    expect(plan.receipt.id).not.toBe(base.receipt.id);
    expect(attachRenderedMediaToCutPlan(base, { dryRun: false, handle: { ...handle, sha256: "1".repeat(64) } }).receipt.id).not.toBe(plan.receipt.id);
    expect(attachRenderedMediaToCutPlan(base, { dryRun: false, handle: { ...handle, packageLineage: { ...lineage, motionSha256: "2".repeat(64) } } }).receipt.id).not.toBe(plan.receipt.id);
  });

  it("lowers image layers to editable Cut media operations", async () => {
    const pkg = await loadMotionPackage(resolve("../../fixtures/packages/lower-third"));
    pkg.motion.layers = [
      {
        id: "product",
        type: "image",
        assetRef: "assets/product.png",
        fit: "cover",
        startMs: 250,
        durationMs: 1750,
        width: 640,
        height: 360,
        crop: { x: 24, y: 12, width: 320, height: 180 },
        transitions: {
          in: { type: "fade", durationMs: 250, easing: "ease-out" },
          out: { type: "fade", durationMs: 300 }
        },
        mask: {
          type: "rect",
          inset: { top: 0, right: 80, bottom: 0, left: 0 },
          radius: 12
        },
        effects: { blur: 2, brightness: 0.9 },
        transform: { x: 64, y: 96, scale: 1, rotation: 0 },
        style: { opacity: 0.92, radius: 12 }
      }
    ];

    const plan = planCutImport(pkg, fullCutCapabilities);

    expect(plan).toMatchObject({
      ok: true,
      mode: "editable_lowering",
      operations: [
        {
          verb: "cut.media.create",
          sourceLayerId: "product",
          startMs: 250,
          durationMs: 1750,
          payload: {
            source: "assets/product.png",
            fit: "cover",
            width: 640,
            height: 360,
            crop: { x: 24, y: 12, width: 320, height: 180 },
            transitions: {
              in: { type: "fade", durationMs: 250, easing: "ease-out" },
              out: { type: "fade", durationMs: 300 }
            },
            mask: {
              type: "rect",
              inset: { top: 0, right: 80, bottom: 0, left: 0 },
              radius: 12
            },
            effects: { blur: 2, brightness: 0.9 },
            transform: { x: 64, y: 96, scale: 1, rotation: 0 },
            style: { opacity: 0.92, radius: 12 }
          }
        }
      ],
      unsupported: []
    });
  });

  it("lowers video layers to editable Cut media operations", async () => {
    const pkg = await loadMotionPackage(resolve("../../fixtures/packages/lower-third"));
    pkg.motion.layers = [
      {
        id: "clip",
        type: "video",
        assetRef: "assets/clip.mp4",
        fit: "cover",
        startMs: 500,
        durationMs: 1500,
        width: 640,
        height: 360,
        crop: { x: 24, y: 12, width: 320, height: 180 },
        trimStartMs: 120,
        trimDurationMs: 900,
        loop: true,
        playbackRate: 1.5,
        includeAudio: true,
        transform: { x: 64, y: 96, scale: 1, rotation: 0 },
        style: { opacity: 0.9, radius: 12 }
      }
    ];

    const plan = planCutImport(pkg, fullCutCapabilities);

    expect(plan).toMatchObject({
      ok: true,
      mode: "editable_lowering",
      operations: [
        {
          verb: "cut.media.create",
          sourceLayerId: "clip",
          startMs: 500,
          durationMs: 1500,
          payload: {
            kind: "video",
            source: "assets/clip.mp4",
            fit: "cover",
            width: 640,
            height: 360,
            crop: { x: 24, y: 12, width: 320, height: 180 },
            trimStartMs: 120,
            trimDurationMs: 900,
            loop: true,
            playbackRate: 1.5,
            includeAudio: true,
            transform: { x: 64, y: 96, scale: 1, rotation: 0 },
            style: { opacity: 0.9, radius: 12 }
          }
        }
      ],
      unsupported: []
    });
  });

  it("lowers image and video fit aliases to editable Cut media operations", async () => {
    const pkg = await loadMotionPackage(resolve("../../fixtures/packages/lower-third"));
    pkg.motion.layers = [
      {
        id: "product",
        type: "image",
        assetRef: "assets/product.png",
        startMs: 250,
        durationMs: 750,
        transform: { x: 64, y: 96, width: 320, height: 180 },
        style: { objectFit: "scale-down" }
      },
      {
        id: "clip",
        type: "video",
        assetRef: "assets/clip.mp4",
        startMs: 1000,
        durationMs: 1000,
        transform: { x: 120, y: 96, width: 320, height: 180 },
        style: { fit: "none" }
      }
    ];

    const plan = planCutImport(pkg, fullCutCapabilities);

    expect(plan).toMatchObject({
      ok: true,
      mode: "editable_lowering",
      operations: [
        {
          verb: "cut.media.create",
          sourceLayerId: "product",
          payload: {
            source: "assets/product.png",
            fit: "scale-down"
          }
        },
        {
          verb: "cut.media.create",
          sourceLayerId: "clip",
          payload: {
            kind: "video",
            source: "assets/clip.mp4",
            fit: "none"
          }
        }
      ],
      unsupported: []
    });
  });

  it("defaults editable media fit to renderer-compatible cover", async () => {
    const pkg = await loadMotionPackage(resolve("../../fixtures/packages/lower-third"));
    pkg.motion.layers = [
      {
        id: "product",
        type: "image",
        assetRef: "assets/product.png",
        startMs: 0,
        durationMs: 1000
      },
      {
        id: "clip",
        type: "video",
        assetRef: "assets/clip.mp4",
        startMs: 1000,
        durationMs: 1000
      }
    ];

    const plan = planCutImport(pkg, fullCutCapabilities);

    expect(plan).toMatchObject({
      ok: true,
      mode: "editable_lowering",
      operations: [
        {
          sourceLayerId: "product",
          payload: {
            fit: "cover"
          }
        },
        {
          sourceLayerId: "clip",
          payload: {
            fit: "cover"
          }
        }
      ],
      unsupported: []
    });
  });

  it("rejects editable media lowering when a media layer has no source reference", async () => {
    const pkg = await loadMotionPackage(resolve("../../fixtures/packages/lower-third"));
    pkg.motion.layers = [
      {
        id: "missing-source",
        type: "image",
        startMs: 0,
        durationMs: 1000
      }
    ];

    const plan = planCutImport(pkg, {
      targetId: "cut-editable-media",
      modes: ["editable_lowering"],
      lowerableLayerTypes: ["image", "video"]
    });

    expect(plan.ok).toBe(false);
    expect(plan.mode).toBeNull();
    expect(plan.operations).toEqual([]);
    expect(plan.unsupported).toEqual([
      {
        layerId: "missing-source",
        feature: "media.source",
        reason:
          "Layer missing-source cannot lower to editable Cut media because it has no assetRef, source, src, or assetId."
      }
    ]);
    expect(plan.receipt.status).toBe("failed");
  });

  it("preserves editable layer keyframes and top-level opacity", async () => {
    const pkg = await loadMotionPackage(resolve("../../fixtures/packages/lower-third"));
    pkg.motion.layers = [
      {
        id: "animated-title",
        type: "text",
        text: "Animated",
        startMs: 100,
        durationMs: 1400,
        opacity: 0.72,
        transform: { x: 24, y: 42, scale: 1 },
        style: { fontSize: 42, color: "#ffffff" },
        keyframes: {
          "transform.x": [
            { atMs: 100, value: 24, easing: "ease-out" },
            { atMs: 800, value: 160 }
          ],
          opacity: [
            { atMs: 100, value: 0, easing: "linear" },
            { atMs: 300, value: 0.72 }
          ]
        }
      }
    ];

    const plan = planCutImport(pkg, fullCutCapabilities);

    expect(plan).toMatchObject({
      ok: true,
      mode: "editable_lowering",
      operations: [
        {
          verb: "cut.title.create",
          sourceLayerId: "animated-title",
          payload: {
            opacity: 0.72,
            keyframes: {
              "transform.x": [
                { atMs: 100, value: 24, easing: "ease-out" },
                { atMs: 800, value: 160 }
              ],
              opacity: [
                { atMs: 100, value: 0, easing: "linear" },
                { atMs: 300, value: 0.72 }
              ]
            }
          }
        }
      ],
      unsupported: []
    });
  });

  it("rejects editable lowering when the Cut target cannot preserve required Motion features", async () => {
    const pkg = await loadMotionPackage(resolve("../../fixtures/packages/lower-third"));
    pkg.motion.layers = [
      {
        id: "animated-title",
        type: "text",
        text: "Animated",
        startMs: 100,
        durationMs: 1400,
        transform: { x: 24, y: 42, scale: 1 },
        keyframes: {
          opacity: [
            { atMs: 100, value: 0 },
            { atMs: 300, value: 1 }
          ]
        }
      }
    ];

    const plan = planCutImport(pkg, {
      targetId: "cut-static-text",
      modes: ["editable_lowering"],
      lowerableLayerTypes: ["text"],
      lowerableFeatures: []
    });

    expect(plan.ok).toBe(false);
    expect(plan.mode).toBeNull();
    expect(plan.operations).toEqual([]);
    expect(plan.unsupported).toEqual(expect.arrayContaining([
      {
        layerId: "*",
        feature: "document.background",
        reason: "Target cut-static-text cannot preserve the Motion document background in editable Cut operations."
      },
      {
        layerId: "animated-title",
        feature: "keyframe.opacity",
        reason: "Target cut-static-text cannot lower keyframe.opacity on layer animated-title."
      }
    ]));
  });

  it("falls back to rendered media when editable feature limits would lose Motion data", async () => {
    const pkg = await loadMotionPackage(resolve("../../fixtures/packages/lower-third"));
    pkg.motion.layers = [
      {
        id: "animated-title",
        type: "text",
        text: "Animated",
        startMs: 100,
        durationMs: 1400,
        transform: { x: 24, y: 42, scale: 1 },
        keyframes: {
          opacity: [
            { atMs: 100, value: 0 },
            { atMs: 300, value: 1 }
          ]
        }
      }
    ];

    const plan = planCutImport(pkg, {
      targetId: "cut-static-text-rendered",
      modes: ["editable_lowering", "rendered_media"],
      lowerableLayerTypes: ["text"],
      lowerableFeatures: []
    });

    expect(plan.ok).toBe(true);
    expect(plan.mode).toBe("rendered_media");
    expect(plan.operations).toEqual([
      {
        verb: "cut.media.import_rendered",
        source: { packageId: "pkg_lower_third", motionId: "motion_lower_third", render: "required" },
        startMs: 0,
        durationMs: 4000,
        media: { width: 1920, height: 1080, fps: 30 }
      }
    ]);
  });

  it("keeps tracking stabilization as rendered fallback until Cut proves scale and rotation keyframe parity", async () => {
    const pkg = await loadMotionPackage(resolve("../../fixtures/packages/lower-third"));
    delete pkg.motion.background;
    pkg.motion.layers = [{
      id: "tracked-footage",
      type: "video",
      assetRef: "cut-asset:plate",
      startMs: 0,
      durationMs: 1000,
      transform: { scale: 1, rotation: 0 },
      keyframes: {
        "transform.x": [{ atMs: 0, value: 0, easing: "linear" }, { atMs: 1000, value: -12, easing: "linear" }],
        "transform.y": [{ atMs: 0, value: 0, easing: "linear" }, { atMs: 1000, value: -8, easing: "linear" }],
        "transform.scale": [{ atMs: 0, value: 1, easing: "linear" }, { atMs: 1000, value: 1.04, easing: "linear" }],
        "transform.rotation": [{ atMs: 0, value: 0, easing: "linear" }, { atMs: 1000, value: -1.5, easing: "linear" }],
      },
      "x-tracking-stabilization": {
        schema: "shellx-motion/tracking-stabilization-attachment@1",
        analysisId: "plate-track",
        sourceSha256: "a".repeat(64),
        targetLayerId: "tracked-footage",
        segmentIndex: 0,
        segmentStartMs: 0,
        segmentEndMs: 1000,
        fidelity: "exact-similarity",
        previousKeyframes: {},
        appliedKeyframes: {},
      },
    }];

    const plan = planCutImport(pkg, {
      targetId: "cut-tracking-parity-fixture",
      modes: ["editable_lowering", "rendered_media"],
      lowerableLayerTypes: ["video"],
      lowerableFeatures: ["video.source.cutAssetRef", "keyframe.transform.x", "keyframe.transform.y"],
    });

    expect(plan).toMatchObject({ ok: true, mode: "rendered_media" });
    expect(plan.unsupported).toEqual(expect.arrayContaining([
      {
        layerId: "tracked-footage",
        feature: "keyframe.transform.scale",
        reason: "Target cut-tracking-parity-fixture cannot lower keyframe.transform.scale on layer tracked-footage.",
      },
      {
        layerId: "tracked-footage",
        feature: "keyframe.transform.rotation",
        reason: "Target cut-tracking-parity-fixture cannot lower keyframe.transform.rotation on layer tracked-footage.",
      },
    ]));
  });

  it("preserves editable layer blend modes for Cut compositing", async () => {
    const pkg = await loadMotionPackage(resolve("../../fixtures/packages/lower-third"));
    pkg.motion.layers = [
      {
        id: "multiply-panel",
        type: "shape",
        shape: "rect",
        startMs: 0,
        durationMs: 1000,
        blendMode: "multiply",
        transform: { x: 40, y: 80, width: 320, height: 90 },
        style: { fill: "#ffff00" }
      }
    ];

    const plan = planCutImport(pkg, fullCutCapabilities);

    expect(plan).toMatchObject({
      ok: true,
      mode: "editable_lowering",
      operations: [
        {
          verb: "cut.shape.create",
          sourceLayerId: "multiply-panel",
          payload: {
            blendMode: "multiply"
          }
        }
      ],
      unsupported: []
    });
  });

  it("preserves path shape geometry in editable Cut operations", async () => {
    const pkg = await loadMotionPackage(resolve("../../fixtures/packages/lower-third"));
    pkg.motion.layers = [
      {
        id: "route-badge",
        type: "shape",
        shape: "path",
        "x-path": "M 10 50 L 50 10 L 90 50 L 70 90 L 30 90 Z",
        startMs: 0,
        durationMs: 1000,
        transform: { x: 40, y: 80, width: 160, height: 100 },
        style: { fill: "#00aaff", stroke: "#ffffff", width: 4 }
      }
    ];

    const plan = planCutImport(pkg, fullCutCapabilities);

    expect(plan).toMatchObject({
      ok: true,
      mode: "editable_lowering",
      operations: [
        {
          verb: "cut.shape.create",
          sourceLayerId: "route-badge",
          payload: {
            shape: "path",
            path: "M 10 50 L 50 10 L 90 50 L 70 90 L 30 90 Z"
          }
        }
      ],
      unsupported: []
    });
  });

  it("preserves video audio controls in editable Cut media operations", async () => {
    const pkg = await loadMotionPackage(resolve("../../fixtures/packages/lower-third"));
    pkg.motion.layers = [
      {
        id: "clip-audio",
        type: "video",
        assetRef: "assets/clip.mp4",
        startMs: 0,
        durationMs: 2000,
        includeAudio: true,
        volume: 0.35,
        pan: -0.2,
        muted: false,
        fadeInMs: 120,
        fadeOutMs: 240,
        normalizeLoudness: true
      }
    ];

    const plan = planCutImport(pkg, fullCutCapabilities);

    expect(plan.operations[0]).toMatchObject({
      verb: "cut.media.create",
      payload: {
        kind: "video",
        includeAudio: true,
        volume: 0.35,
        pan: -0.2,
        muted: false,
        fadeInMs: 120,
        fadeOutMs: 240,
        normalizeLoudness: true
      }
    });
  });

  it("preserves document background metadata for editable Cut imports", async () => {
    const pkg = await loadMotionPackage(resolve("../../fixtures/packages/lower-third"));
    pkg.motion.background = "#123456";
    pkg.motion.layers = [
      {
        id: "title",
        type: "text",
        text: "Background",
        startMs: 0,
        durationMs: 1000
      }
    ];

    const plan = planCutImport(pkg, fullCutCapabilities);

    expect(plan).toMatchObject({
      document: {
        width: 1920,
        height: 1080,
        fps: 30,
        durationMs: 4000,
        background: "#123456"
      },
      receipt: {
        output: {
          document: {
            width: 1920,
            height: 1080,
            fps: 30,
            durationMs: 4000,
            background: "#123456"
          }
        }
      }
    });
  });

  it("preserves document safe-area metadata for Cut timeline handoff", async () => {
    const pkg = await loadMotionPackage(resolve("../../fixtures/packages/lower-third"));
    pkg.motion.safeAreas = {
      title: { top: 96, right: 128, bottom: 108, left: 128 },
      action: { top: 48, right: 64, bottom: 64, left: 64 }
    };
    pkg.motion.layers = [
      {
        id: "title",
        type: "text",
        text: "Safe",
        startMs: 0,
        durationMs: 1000
      }
    ];

    const plan = planCutImport(pkg, fullCutCapabilities);

    expect(plan).toMatchObject({
      document: {
        safeAreas: {
          title: { top: 96, right: 128, bottom: 108, left: 128 },
          action: { top: 48, right: 64, bottom: 64, left: 64 }
        }
      },
      receipt: {
        output: {
          document: {
            safeAreas: {
              title: { top: 96, right: 128, bottom: 108, left: 128 },
              action: { top: 48, right: 64, bottom: 64, left: 64 }
            }
          }
        }
      }
    });
  });

  it.each(["html", "canvas"] as const)("requires rendered-media mode for %s browser-lane layers", async (type) => {
    const pkg = await loadMotionPackage(resolve("../../fixtures/packages/web-card"));
    pkg.motion.layers[0] = {
      ...pkg.motion.layers[0],
      id: `${type}-layer`,
      type
    };

    const plan = planCutImport(pkg, fullCutCapabilities);

    expect(plan.ok).toBe(true);
    expect(plan.mode).toBe("rendered_media");
    expect(plan.operations[0]).toMatchObject({ verb: "cut.media.import_rendered" });
  });

  it("can import a Motion package as a live overlay when editable lowering is unavailable", async () => {
    const pkg = await loadMotionPackage(resolve("../../fixtures/packages/lower-third"));

    const plan = planCutImport(pkg, {
      targetId: "cut-live-overlay",
      modes: ["live_overlay"],
      lowerableLayerTypes: []
    });

    expect(plan.ok).toBe(true);
    expect(plan.mode).toBe("live_overlay");
    expect(plan.operations).toEqual([
      {
        verb: "cut.motion_overlay.create",
        source: { packageId: "pkg_lower_third", motionId: "motion_lower_third" },
        startMs: 0,
        durationMs: 4000,
        overlay: { width: 1920, height: 1080, fps: 30 }
      }
    ]);
  });

  it("returns exact unsupported reasons when no target mode can import the package", async () => {
    const pkg = withLowerThirdNativeLayers(await loadMotionPackage(resolve("../../fixtures/packages/lower-third")));

    const plan = planCutImport(pkg, {
      targetId: "cut-text-only",
      modes: ["editable_lowering"],
      lowerableLayerTypes: ["text"]
    });

    expect(plan.ok).toBe(false);
    expect(plan.mode).toBeNull();
    expect(plan.operations).toEqual([]);
    expect(plan.unsupported).toEqual([
      {
        layerId: "bar",
        feature: "layer.type:shape",
        reason: "Target cut-text-only cannot lower shape layers to editable Cut operations."
      },
      {
        layerId: "subtitle",
        feature: "layer.type:caption",
        reason: "Target cut-text-only cannot lower caption layers to editable Cut operations."
      }
    ]);
    expect(plan.receipt).toMatchObject({
      operation: "cut.import.plan",
      status: "failed",
      lane: "cut",
      output: {
        mode: null,
        targetId: "cut-text-only",
        operationCount: 0,
        unsupportedCount: 2
      }
    });
  });

  it("records the chosen import mode in the import receipt", async () => {
    const pkg = await loadMotionPackage(resolve("../../fixtures/packages/lower-third"));

    const plan = planCutImport(pkg, fullCutCapabilities);

    expect(plan.receipt).toMatchObject({
      operation: "cut.import.plan",
      status: "passed",
      packageId: "pkg_lower_third",
      lane: "cut",
      output: {
        mode: "editable_lowering",
        targetId: "cut-fixture",
        operationCount: 1,
        unsupportedCount: 0
      }
    });
  });

  it("preserves timeline metadata and layer track refs in Cut import plans", async () => {
    const pkg = await loadMotionPackage(resolve("../../fixtures/packages/lower-third"));
    pkg.motion.tracks = [
      { id: "overlay", type: "overlay", name: "Overlay", order: 1, layerIds: ["title"] }
    ];
    pkg.motion.scenes = [
      { id: "intro", name: "Intro", startMs: 0, durationMs: 4000, trackIds: ["overlay"], markerIds: ["beat"] }
    ];
    pkg.motion.markers = [
      { id: "beat", atMs: 500, label: "Beat", type: "beat" }
    ];
    pkg.motion.layers[0].trackId = "overlay";

    const plan = planCutImport(pkg, fullCutCapabilities);

    expect(plan.operations[0]).toMatchObject({
      verb: "cut.timeline.track.create",
      sourceTrackId: "overlay",
      payload: {
        type: "overlay",
        name: "Overlay",
        order: 1,
        layerIds: ["title"]
      }
    });
    expect(plan.operations[1]).toMatchObject({
      verb: "cut.timeline.scene.create",
      sourceSceneId: "intro",
      startMs: 0,
      durationMs: 4000,
      payload: {
        name: "Intro",
        trackIds: ["overlay"],
        markerIds: ["beat"]
      }
    });
    expect(plan.operations[2]).toMatchObject({
      verb: "cut.timeline.marker.create",
      sourceMarkerId: "beat",
      atMs: 500,
      payload: {
        label: "Beat",
        type: "beat"
      }
    });
    expect(plan.operations[3]).toMatchObject({
      verb: "cut.title.create",
      payload: {
        trackId: "overlay"
      }
    });
    expect(plan.timeline).toEqual({
      tracks: pkg.motion.tracks,
      scenes: pkg.motion.scenes,
      markers: pkg.motion.markers
    });
    expect(plan.receipt.output).toMatchObject({
      timeline: {
        trackCount: 1,
        sceneCount: 1,
        markerCount: 1,
        tracks: pkg.motion.tracks,
        scenes: pkg.motion.scenes,
        markers: pkg.motion.markers
      }
    });
  });
});

function withLowerThirdNativeLayers(pkg: MotionPackage): MotionPackage {
  const shapeLayer: MotionLayer = {
    id: "bar",
    type: "shape",
    shape: "rect",
    startMs: 0,
    durationMs: 4000,
    transform: { x: 96, y: 792, scale: 1, rotation: 0 },
    style: { fill: "#0f6fff", opacity: 0.92, radius: 12 }
  };
  const captionLayer: MotionLayer = {
    id: "subtitle",
    type: "caption",
    text: "Senior editor",
    startMs: 350,
    durationMs: 3200,
    transform: { x: 120, y: 900, scale: 1, rotation: 0 },
    style: { fontFamily: "Inter", fontSize: 34, color: "#dce7ff" }
  };

  return {
    ...pkg,
    motion: {
      ...pkg.motion,
      layers: [pkg.motion.layers[0], shapeLayer, captionLayer]
    }
  };
}

function stablePlan(plan: ReturnType<typeof planCutImport>): unknown {
  const { integration: _integration, ...stable } = plan;
  return {
    ...stable,
    receipt: {
      operation: plan.receipt.operation,
      status: plan.receipt.status,
      packageId: plan.receipt.packageId,
      lane: plan.receipt.lane,
      output: plan.receipt.output,
      warnings: plan.receipt.warnings
    }
  };
}
