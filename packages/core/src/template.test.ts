import { describe, expect, it } from "vitest";
import { loadMotionPackage } from "./package";
import { applyTemplateValues, listTemplateControls, replaceTemplateMedia } from "./template";

describe("template controls", () => {
  it("lists host-editable controls from a template sidecar", async () => {
    const pkg = await loadMotionPackage("../../fixtures/packages/editable-lower-third");

    const controls = listTemplateControls(pkg);

    expect(controls).toMatchObject({
      ok: true,
      packageId: "pkg_editable_lower_third",
      templateId: "template_editable_lower_third",
      compatibleHosts: ["shellx-motion", "shellx-canvas", "shellx-cut"],
      params: expect.arrayContaining([
        expect.objectContaining({ id: "title", type: "text", defaultValue: "Anna Valdez" }),
        expect.objectContaining({ id: "accentColor", type: "color", defaultValue: "#13d3ff" })
      ]),
      controls: expect.arrayContaining([
        expect.objectContaining({ paramId: "title", widget: "text" }),
        expect.objectContaining({ paramId: "titleScale", widget: "slider" })
      ]),
      metadata: expect.objectContaining({
        suitability: {
          bestFor: ["speaker IDs", "product demos", "Cut Generate intros"],
          notFor: ["full-screen scene replacements", "long-form end cards"]
        }
      })
    });
  });

  it("does not name a param in changedParams when none of its bindings applied", async () => {
    // With one binding repointed at a missing layer, `template apply --set title=...` must not return
    // `changedParams: ["title"]` with
    // `changedBindings: []`, over a document that still held "Anna Valdez", and the CLI wrote a
    // receipt reading `passed`. `changedParams` was pushed at the TOP of the loop, before the
    // bindings were attempted, so it reported intent while claiming to report effect. A caller
    // comparing what it asked for against `changedParams` saw complete success on a no-op.
    //
    // This is the release's defining defect class -- a declaration the engine silently drops -- so
    // both halves are asserted here: the claim must shrink to what actually landed, and the warning
    // must still say what was lost.
    const pkg = await loadMotionPackage("../../fixtures/packages/editable-lower-third");
    const broken = {
      ...pkg,
      template: {
        ...pkg.template!,
        bindings: pkg.template!.bindings.map((binding) => binding.paramId === "title"
          ? { ...binding, target: { ...binding.target, path: "/layers/99/text" } }
          : binding)
      }
    };

    const result = applyTemplateValues(broken, { title: "REPLACED HEADLINE", accentColor: "#ff006e" });

    expect(result).toMatchObject({
      ok: true,
      // `title` is absent: nothing was applied for it. `accentColor` still lands, so one unappliable
      // binding does not suppress the params that did take.
      changedParams: ["accentColor"],
      changedBindings: [
        { paramId: "accentColor", path: "/layers/2/fill", oldValue: "#13d3ff", newValue: "#ff006e" }
      ],
      warnings: ["Template binding title target /layers/99/text was not applied: array index 99 is not present"]
    });
    if (!result.ok) throw new Error("expected template apply to pass");
    expect(result.motion.layers[0]).toMatchObject({ id: "title", text: "Anna Valdez" });
  });

  it("applies template params through MotionIR JSON-pointer bindings", async () => {
    const pkg = await loadMotionPackage("../../fixtures/packages/editable-lower-third");

    const result = applyTemplateValues(pkg, {
      title: "Dr. Mira Chen",
      accentColor: "#ff006e",
      titleScale: 1.2
    });

    expect(result).toMatchObject({
      ok: true,
      changedParams: ["title", "accentColor", "titleScale"],
      changedBindings: [
        { paramId: "title", path: "/layers/0/text", oldValue: "Anna Valdez", newValue: "Dr. Mira Chen" },
        { paramId: "accentColor", path: "/layers/2/fill", oldValue: "#13d3ff", newValue: "#ff006e" },
        { paramId: "titleScale", path: "/layers/0/transform/scale", oldValue: 1, newValue: 1.2 }
      ],
      warnings: []
    });
    if (!result.ok) throw new Error("expected template apply to pass");
    expect(result.motion.layers[0]).toMatchObject({
      id: "title",
      text: "Dr. Mira Chen",
      transform: { scale: 1.2 }
    });
    expect(result.motion.layers[2]).toMatchObject({
      id: "accent",
      fill: "#ff006e"
    });
  });

  it("rejects unknown template params before mutating motion", async () => {
    const pkg = await loadMotionPackage("../../fixtures/packages/editable-lower-third");

    const result = applyTemplateValues(pkg, { missing: "value" });

    expect(result).toEqual({
      ok: false,
      errors: [{ paramId: "missing", message: "unknown template param" }]
    });
  });

  it("replaces template media slots through MotionIR bindings and manifest asset refs", async () => {
    const pkg = await loadMotionPackage("../../fixtures/packages/editable-lower-third");
    const mediaPkg = {
      ...pkg,
      manifest: {
        ...pkg.manifest,
        assets: ["assets/default-headshot.png"]
      },
      motion: {
        ...pkg.motion,
        assets: [{ id: "default-headshot", ref: "assets/default-headshot.png" }],
        layers: [
          ...pkg.motion.layers,
          {
            id: "headshot",
            type: "image",
            source: "assets/default-headshot.png",
            assetRef: "assets/default-headshot.png",
            startMs: 0,
            durationMs: 3000
          }
        ]
      },
      template: {
        ...pkg.template!,
        params: [
          ...pkg.template!.params,
          { id: "headshot", label: "Headshot", type: "media" as const, defaultValue: "assets/default-headshot.png", group: "content", order: 3 }
        ],
        controls: [
          ...pkg.template!.controls,
          { paramId: "headshot", widget: "media", label: "Headshot" }
        ],
        bindings: [
          ...pkg.template!.bindings,
          { paramId: "headshot", target: { kind: "motion_path", path: "/layers/3/source", layerId: "headshot" } },
          { paramId: "headshot", target: { kind: "motion_path", path: "/layers/3/assetRef", layerId: "headshot" } }
        ]
      }
    };

    const result = replaceTemplateMedia(mediaPkg, { paramId: "headshot", assetRef: "assets/new-headshot.png" });

    expect(result).toMatchObject({
      ok: true,
      packageId: "pkg_editable_lower_third",
      templateId: "template_editable_lower_third",
      paramId: "headshot",
      assetRef: "assets/new-headshot.png",
      changedParams: ["headshot"],
      changedBindings: [
        { paramId: "headshot", path: "/layers/3/source", oldValue: "assets/default-headshot.png", newValue: "assets/new-headshot.png" },
        { paramId: "headshot", path: "/layers/3/assetRef", oldValue: "assets/default-headshot.png", newValue: "assets/new-headshot.png" }
      ],
      warnings: []
    });
    if (!result.ok) throw new Error("expected media replacement to pass");
    expect(result.manifest.assets).toEqual(["assets/default-headshot.png", "assets/new-headshot.png"]);
    expect(result.motion.layers[3]).toMatchObject({
      id: "headshot",
      source: "assets/new-headshot.png",
      assetRef: "assets/new-headshot.png"
    });
  });

  it("rejects invalid template media replacements before mutating motion", async () => {
    const pkg = await loadMotionPackage("../../fixtures/packages/editable-lower-third");

    expect(replaceTemplateMedia(pkg, { paramId: "missing", assetRef: "assets/image.png" })).toEqual({
      ok: false,
      errors: [{ paramId: "missing", message: "unknown template param" }]
    });
    expect(replaceTemplateMedia(pkg, { paramId: "title", assetRef: "assets/image.png" })).toEqual({
      ok: false,
      errors: [{ paramId: "title", message: "template param is not a media slot" }]
    });
    expect(replaceTemplateMedia(pkg, { paramId: "title", assetRef: "../image.png" })).toEqual({
      ok: false,
      errors: [
        { paramId: "title", message: "template param is not a media slot" },
        { paramId: "title", message: "assetRef must be a package-local assets/ path" }
      ]
    });
  });

  it.each(["__proto__", "prototype", "constructor"])(
    "rejects unsafe JSON-pointer template binding %s segments without polluting prototypes",
    async (unsafeSegment) => {
    const pkg = await loadMotionPackage("../../fixtures/packages/editable-lower-third");
    const objectPrototype = Object.prototype as Record<string, unknown>;
    delete objectPrototype.pollutedTemplateBinding;

    try {
      const result = applyTemplateValues({
        ...pkg,
        template: {
          ...pkg.template!,
          bindings: [
            { paramId: "title", target: { kind: "motion_path", path: `/${unsafeSegment}/pollutedTemplateBinding` } }
          ]
        }
      }, { title: "Unsafe" });

      expect(result).toMatchObject({
        ok: true,
        changedBindings: [],
        warnings: [
          `Template binding title target /${unsafeSegment}/pollutedTemplateBinding was not applied: target path contains unsafe segment ${unsafeSegment}`
        ]
      });
      expect(objectPrototype.pollutedTemplateBinding).toBeUndefined();
    } finally {
      delete objectPrototype.pollutedTemplateBinding;
    }
  });
});
