import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CUT_EDITABLE_RECEIVER_SLICE, planCutImport } from "@shellx-motion/adapters-cut";
import { loadMotionPackage } from "@shellx-motion/core";
import { cutTargetCapabilitiesForMode } from "./cut-import-mode";

describe("ShellX Cut import capability profile", () => {
  it("bounds auto editable lowering to Motion features Cut can preserve", async () => {
    const capabilities = cutTargetCapabilitiesForMode({
      targetId: "shellx-cut",
      mode: "auto"
    });

    expect(capabilities).toMatchObject({
      targetId: "shellx-cut",
      modes: ["editable_lowering", "rendered_media"],
      lowerableLayerTypes: ["text", "shape", "video", "audio"]
    });
    expect(capabilities.lowerableFeatures).toEqual(expect.arrayContaining([
      "document.background",
      "layer.opacity",
      "keyframe.opacity",
      "keyframe.transform.x",
      "keyframe.transform.y",
      "transition.fade",
      "video.trim",
      "audio.trim",
      "shape.rect",
      "shape.radius",
      "shape.stroke"
    ]));
    expect(capabilities.lowerableFeatures).not.toContain("*");
    expect(capabilities.lowerableFeatures).not.toEqual(expect.arrayContaining([
      "transform.rotation",
      "transition.*",
      "keyframe.*",
      "image.crop",
      "video.trim",
      "audio.volume"
    ]));

    const pkg = await loadMotionPackage(resolve("../../fixtures/packages/lower-third"));
    pkg.motion.layers = [
      {
        id: "blurred-title",
        type: "text",
        text: "Blurred",
        startMs: 0,
        durationMs: 1200,
        effects: { blur: 8 }
      }
    ];

    const autoPlan = planCutImport(pkg, capabilities);
    expect(autoPlan).toMatchObject({
      ok: true,
      mode: "rendered_media",
      operations: [
        { verb: "cut.media.import_rendered" }
      ]
    });

    const editableOnlyPlan = planCutImport(pkg, cutTargetCapabilitiesForMode({
      targetId: "shellx-cut",
      mode: "editable_lowering"
    }));
    expect(editableOnlyPlan).toMatchObject({
      ok: false,
      mode: null,
      operations: [],
      unsupported: expect.arrayContaining([
        expect.objectContaining({
          layerId: "blurred-title",
          feature: "effect.blur",
          reason: "Target shellx-cut cannot lower effect.blur on layer blurred-title."
        })
      ])
    });
  });

  it("selects editable lowering for uniform x/y automation and renders mixed easing", async () => {
    const capabilities = cutTargetCapabilitiesForMode({ targetId: "shellx-cut", mode: "auto" });
    const pkg = await loadMotionPackage(resolve("../../fixtures/packages/lower-third"));
    delete pkg.motion.background;
    pkg.motion.durationMs = 1200;
    pkg.motion.layers = [{
      id: "moving-title",
      type: "text",
      text: "Moving",
      startMs: 0,
      durationMs: 1200,
      transform: { x: 40, y: 80, scale: 1, rotation: 0 },
      style: { color: "#ffffff", fontSize: 48 },
      keyframes: {
        "transform.x": [
          { atMs: 0, value: -200, easing: "ease-out" },
          { atMs: 1200, value: 40 }
        ],
        "transform.y": [
          { atMs: 0, value: 180, easing: "ease-out" },
          { atMs: 1200, value: 80 }
        ]
      }
    }];

    expect(planCutImport(pkg, capabilities)).toMatchObject({
      ok: true,
      mode: "editable_lowering",
      operations: [{
        sourceLayerId: "moving-title",
        payload: {
          keyframes: {
            "transform.x": expect.any(Array),
            "transform.y": expect.any(Array)
          }
        }
      }]
    });

    pkg.motion.layers[0].keyframes!["transform.x"] = [
      { atMs: 0, value: -200, easing: "ease-out" },
      { atMs: 600, value: 0, easing: "hold" },
      { atMs: 1200, value: 40 }
    ];
    const rendered = planCutImport(pkg, capabilities);
    expect(rendered.mode).toBe("rendered_media");
    expect(rendered.unsupported).toEqual(expect.arrayContaining([
      expect.objectContaining({ feature: "keyframe.transform.x.uniformEasing" })
    ]));
  });

  it("selects native video only for an existing Cut asset reference", async () => {
    const capabilities = cutTargetCapabilitiesForMode({ targetId: "shellx-cut", mode: "auto" });
    const pkg = await loadMotionPackage(resolve("../../fixtures/packages/lower-third"));
    delete pkg.motion.background;
    pkg.motion.durationMs = 1200;
    pkg.motion.layers = [{
      id: "footage",
      type: "video",
      source: "cut-asset:a1",
      startMs: 0,
      durationMs: 1200,
      trimStartMs: 250,
      trimDurationMs: 1200,
      playbackRate: 1,
      includeAudio: false,
      fit: "cover",
      transform: { scale: 1, rotation: 0 },
      style: {}
    }];

    expect(planCutImport(pkg, capabilities)).toMatchObject({
      ok: true,
      mode: "editable_lowering",
      operations: [{
        verb: "cut.media.create",
        sourceLayerId: "footage",
        payload: {
          kind: "video",
          source: "cut-asset:a1",
          trimStartMs: 250,
          trimDurationMs: 1200
        }
      }]
    });

    pkg.motion.layers[0].source = "assets/portable.mp4";
    expect(planCutImport(pkg, capabilities).mode).toBe("rendered_media");
    pkg.motion.layers[0].source = "cut-asset:a1";
    pkg.motion.background = "#000000";
    expect(planCutImport(pkg, capabilities).mode).toBe("rendered_media");

    delete pkg.motion.background;
    pkg.motion.layers = [{
      id: "music",
      type: "audio",
      source: "cut-asset:a2",
      startMs: 0,
      durationMs: 1200,
      trimStartMs: 500,
      trimDurationMs: 1200,
      playbackRate: 1,
      loop: false,
      muted: false,
      normalizeLoudness: false
    }];
    expect(planCutImport(pkg, capabilities)).toMatchObject({
      ok: true,
      mode: "editable_lowering",
      operations: [{
        verb: "cut.audio.create",
        sourceLayerId: "music",
        payload: { source: "cut-asset:a2", trimStartMs: 500, trimDurationMs: 1200 }
      }]
    });
    pkg.motion.layers[0].volume = 0.5;
    expect(planCutImport(pkg, capabilities).mode).toBe("rendered_media");
  });

  it("selects editable lowering only for the receiver's exact static text/shape subset", async () => {
    const capabilities = cutTargetCapabilitiesForMode({ targetId: "shellx-cut", mode: "auto" });
    const pkg = await loadMotionPackage(resolve("../../fixtures/packages/lower-third"));
    pkg.motion.layers = [
      {
        id: "panel",
        type: "shape",
        shape: "rectangle",
        startMs: 0,
        durationMs: 1200,
        width: 480,
        height: 160,
        transform: { x: 40, y: 80, scale: 1, rotation: 0 },
        style: { fill: "#123456", radius: 12 },
        transitions: {
          in: { type: "fade", durationMs: 200, easing: "ease-out" },
          out: { type: "fade", durationMs: 200, easing: "ease-out" }
        }
      },
      {
        id: "title",
        type: "text",
        text: "Exact native title",
        opacity: 0.9,
        startMs: 0,
        durationMs: 1200,
        keyframes: {
          opacity: [
            { atMs: 0, value: 0, easing: "ease-out" },
            { atMs: 300, value: 0.9, easing: "ease-out" },
            { atMs: 1200, value: 0.9 }
          ]
        },
        transform: { x: 80, y: 120, scale: 1, rotation: 0 },
        style: { color: "#ffffff", fontSize: 48 }
      }
    ];

    const editable = planCutImport(pkg, capabilities);
    expect(editable).toMatchObject({
      ok: true,
      mode: "editable_lowering",
      operations: [
        {
          verb: "cut.shape.create",
          sourceLayerId: "panel",
          payload: {
            shape: "rect",
            transitions: expect.any(Object),
            transform: { x: 40, y: 80, width: 480, height: 160, scale: 1, rotation: 0 }
          }
        },
        {
          verb: "cut.title.create",
          sourceLayerId: "title",
          payload: { opacity: 0.9, keyframes: { opacity: expect.any(Array) } }
        }
      ]
    });

    const opacityFrames = pkg.motion.layers[1].keyframes?.opacity;
    if (!opacityFrames) throw new Error("test fixture lost its opacity keyframes");
    opacityFrames[1].easing = "hold";
    const mixedEasing = planCutImport(pkg, capabilities);
    expect(mixedEasing).toMatchObject({
      ok: true,
      mode: "rendered_media",
      operations: [{ verb: "cut.media.import_rendered" }]
    });
    opacityFrames[1].easing = "ease-out";
    const panelTransitions = pkg.motion.layers[0].transitions;
    if (!panelTransitions?.in || !panelTransitions.out) throw new Error("test fixture lost its fade transitions");
    panelTransitions.out.easing = "ease-in";
    expect(planCutImport(pkg, capabilities).mode).toBe("rendered_media");
    panelTransitions.out.easing = "ease-out";
    panelTransitions.in.durationMs = 700;
    panelTransitions.out.durationMs = 700;
    expect(planCutImport(pkg, capabilities).mode).toBe("rendered_media");
    panelTransitions.in.durationMs = 200;
    panelTransitions.out.durationMs = 200;
    pkg.motion.layers[0].keyframes = { opacity: [{ atMs: 0, value: 1 }] };
    expect(planCutImport(pkg, capabilities).mode).toBe("rendered_media");
    delete pkg.motion.layers[0].keyframes;
    pkg.motion.layers[1].style = { color: "#ffffff", fontSize: 48, fontFamily: "Inter" };
    const rendered = planCutImport(pkg, capabilities);
    expect(rendered).toMatchObject({
      ok: true,
      mode: "rendered_media",
      operations: [{ verb: "cut.media.import_rendered" }]
    });

    const refused = planCutImport(pkg, cutTargetCapabilitiesForMode({
      targetId: "shellx-cut",
      mode: "editable_lowering"
    }));
    expect(refused).toMatchObject({
      ok: false,
      mode: null,
      unsupported: [
        expect.objectContaining({ layerId: "title", feature: "text.style.fontFamily" })
      ]
    });
  });
});

describe("every real ShellX Cut target declares its editable receiver", () => {
  it("carries the receiver marker for each import mode", () => {
    // Without this the planner cannot check a lowering against the field set Cut actually
    // accepts, and editable_lowering silently becomes a promise that fails on arrival — the
    // exact defect this marker exists to prevent.
    for (const mode of ["auto", "editable_lowering", "live_overlay", "rendered_media"] as const) {
      const capabilities = cutTargetCapabilitiesForMode({ targetId: "shellx-cut", mode });
      expect(capabilities.editableReceiver).toBe(CUT_EDITABLE_RECEIVER_SLICE);
    }
  });
});
