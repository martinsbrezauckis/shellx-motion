import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { diagnoseAdapterImport, lowerStaticLottieToMotion } from "./adapter-diagnostics";
import { loadSchema, validateDocument } from "./validate";

describe("adapter diagnostics", () => {
  it("diagnoses SVG path-animation imports with explicit unsupported features and lossiness receipts", async () => {
    const sourcePath = resolve("../../fixtures/imports/svg-path-animation/input.svg");
    const sourceText = await readFile(sourcePath, "utf8");

    const diagnostics = diagnoseAdapterImport({
      adapterId: "adapter.svg",
      sourcePath,
      sourceText,
      normalizedPackagePath: "packages/svg-path-animation",
      createdAt: "2026-07-06T18:00:00.000Z"
    });

    expect(diagnostics).toMatchObject({
      schema: "shellx-motion/adapter-diagnostics@1",
      adapterId: "adapter.svg",
      format: "svg",
      source: {
        path: sourcePath,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/)
      },
      normalizedPackagePath: "packages/svg-path-animation",
      recommendedFallbackLane: "browser",
      lossiness: {
        level: "high",
        unsupportedCount: 4,
        warningCount: 1,
        supportedCount: 5
      },
      suggestedNextAction: "Use browser capture for this SVG, or remove every reported unsupported feature before lowering to Motion shapes."
    });
    expect(diagnostics.supportedFeatures).toEqual(expect.arrayContaining([
      { path: "svg.path#hero-streak", feature: "svg.path.d", status: "supported", reason: "Path geometry can be lowered to Motion shape path data." },
      { path: "svg.path#hero-streak", feature: "svg.path.stroke", status: "supported", reason: "Stroke color maps to Motion shape style." }
    ]));
    expect(diagnostics.unsupportedFeatures).toEqual(expect.arrayContaining([
      { path: "svg.path#hero-streak", feature: "svg.animate.attributeName:d", status: "unsupported", reason: "SVG path morphing requires a path-keyframe renderer contract and is not lowered as a static path." },
      { path: "svg.defs.filter#softGlow", feature: "svg.filter", status: "unsupported", reason: "SVG filters are not lowered to Motion effects in this adapter slice." },
      { path: "svg.mask#revealMask", feature: "svg.mask", status: "unsupported", reason: "SVG masks require browser fallback until mask path lowering is implemented." },
      { path: "svg.script", feature: "svg.script", status: "unsupported", reason: "Scripts are refused for deterministic local adapter imports." }
    ]));
    expect(diagnostics.receipt).toMatchObject({
      schema: "shellx-motion/receipt@1",
      id: expect.stringMatching(/^adapter-diagnostics-svg-/),
      operation: "adapter.diagnostics",
      status: "warning",
      packageId: "packages/svg-path-animation",
      lane: "adapter",
      inputHashes: {
        source: diagnostics.source.sha256
      },
      output: {
        adapterId: "adapter.svg",
        format: "svg",
        normalizedPackagePath: "packages/svg-path-animation",
        unsupportedFeatures: diagnostics.unsupportedFeatures,
        lossiness: diagnostics.lossiness,
        suggestedNextAction: diagnostics.suggestedNextAction
      },
      warnings: [
        "Curved path geometry is recognized, but exact curve interpolation still needs fixture-level visual QA.",
        "SVG path morphing requires a path-keyframe renderer contract and is not lowered as a static path.",
        "SVG filters are not lowered to Motion effects in this adapter slice.",
        "SVG masks require browser fallback until mask path lowering is implemented.",
        "Scripts are refused for deterministic local adapter imports."
      ]
    });
  });

  it("diagnoses fixture-backed Lottie shapes, transforms, and complex text without pretending to lower them", async () => {
    const sourcePath = resolve("../../fixtures/imports/lottie-static-shape/input.json");
    const sourceText = await readFile(sourcePath, "utf8");

    const diagnostics = diagnoseAdapterImport({
      adapterId: "adapter.lottie",
      sourcePath,
      sourceText,
      normalizedPackagePath: "packages/lottie-static-shape",
      createdAt: "2026-07-12T03:10:00.000Z"
    });

    expect(diagnostics).toMatchObject({
      schema: "shellx-motion/adapter-diagnostics@1",
      adapterId: "adapter.lottie",
      format: "lottie",
      recommendedFallbackLane: "none",
      lossiness: {
        level: "low",
        unsupportedCount: 0,
        warningCount: 2
      },
      suggestedNextAction: "Lower the fixture-backed static Lottie subset, then verify rendered frames and the lossiness receipt."
    });
    expect(diagnostics.supportedFeatures).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "lottie", feature: "lottie.composition", status: "supported" }),
      expect.objectContaining({ path: "lottie.layers[0]#Accent path", feature: "lottie.shape.layer", status: "supported" }),
      expect.objectContaining({ feature: "lottie.shape.path", status: "supported" }),
      expect.objectContaining({ feature: "lottie.shape.stroke", status: "supported" }),
      expect.objectContaining({ path: "lottie.layers[1]#Arabic title", feature: "lottie.text.basic", status: "supported" })
    ]));
    expect(diagnostics.warningFeatures).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "lottie.layers[1]#Arabic title", feature: "lottie.text.shaping", status: "warning" }),
      expect.objectContaining({ path: "lottie.layers[1]#Arabic title", feature: "lottie.text.layout", status: "warning" })
    ]));
    expect(diagnostics.receipt).toMatchObject({
      operation: "adapter.diagnostics",
      status: "warning",
      packageId: "packages/lottie-static-shape",
      lane: "adapter",
      warnings: [
        "Complex-script text must render through the Chromium shaping lane and requires font evidence.",
        "Lottie and browser font metrics can differ; representative-frame text layout QA is required."
      ]
    });
  });

  it("keeps first-match Lottie image asset semantics while indexing malformed and duplicate declarations once", () => {
    const diagnostics = diagnoseAdapterImport({
      adapterId: "adapter.lottie",
      sourcePath: "duplicate-assets.json",
      sourceText: JSON.stringify({
        w: 32, h: 32, fr: 30, ip: 0, op: 30,
        layers: [
          { ty: 2, nm: "Hero", refId: "hero" },
          { ty: 2, nm: "Empty id", refId: "" },
          { ty: 2, nm: "Malformed id", refId: 7 },
          { ty: 2, nm: "Missing id" }
        ],
        assets: [
          { id: "hero", p: "first.png" },
          null,
          { id: "hero" },
          { id: "", p: "empty.png" },
          { id: 7, p: "malformed.png" }
        ]
      }),
      normalizedPackagePath: "packages/duplicate-assets"
    });

    expect(diagnostics.supportedFeatures).toContainEqual(expect.objectContaining({ feature: "lottie.image.asset", status: "supported" }));
    expect(diagnostics.unsupportedFeatures).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "lottie.layers[1]#Empty id", feature: "lottie.image.asset", status: "unsupported" }),
      expect.objectContaining({ path: "lottie.layers[2]#Malformed id", feature: "lottie.image.asset", status: "unsupported" }),
      expect.objectContaining({ path: "lottie.layers[3]#Missing id", feature: "lottie.image.asset", status: "unsupported" })
    ]));
  });

  it("bounds Lottie image diagnostics to linear asset lookup work", () => {
    const count = 10_000;
    const sourceText = JSON.stringify({
      w: 32, h: 32, fr: 30, ip: 0, op: 30,
      layers: Array.from({ length: count }, () => ({ ty: 2, refId: "last" })),
      assets: [...Array.from({ length: count - 1 }, () => ({})), { id: "last", p: "last.png" }]
    });
    const started = process.hrtime.bigint();
    expect(() => diagnoseAdapterImport({
      adapterId: "adapter.lottie",
      sourcePath: "bounded-image-assets.json",
      sourceText,
      normalizedPackagePath: "packages/bounded-image-assets"
    })).toThrow(/4096-feature output limit/);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    expect(elapsedMs, `completed in ${elapsedMs.toFixed(1)} ms`).toBeLessThan(3_000);
  });

  it("lowers the proven static Lottie subset into a validated, source-bound Motion document", async () => {
    const sourcePath = resolve("../../fixtures/imports/lottie-static-shape/input.json");
    const sourceText = await readFile(sourcePath, "utf8");

    const lowered = lowerStaticLottieToMotion({
      adapterId: "adapter.lottie",
      sourcePath,
      sourceText,
      normalizedPackagePath: "packages/lottie-static-shape",
      createdBy: "adapter-test",
      createdAt: "2026-07-12T03:20:00.000Z"
    });

    expect(await validateDocument(await loadSchema("motion"), lowered.motion)).toEqual({ ok: true });
    expect(lowered.motion).toMatchObject({
      schema: "shellx-motion/motion@1",
      id: expect.stringMatching(/^motion_lottie_[a-f0-9]{16}$/),
      name: "Static shape and RTL title",
      durationMs: 3000,
      fps: 30,
      width: 640,
      height: 360,
      provenance: { sourceApp: "lottie", createdBy: "adapter-test", sourceSchema: "5.12.2" }
    });
    expect(lowered.motion.layers).toEqual([
      expect.objectContaining({
        id: "arabic-title",
        type: "text",
        text: "مرحبا بالعالم",
        style: expect.objectContaining({ direction: "auto", textAlign: "start", fontFamily: "NotoSansArabic" })
      }),
      expect.objectContaining({
        id: "accent-path",
        type: "shape",
        shape: "path",
        "x-path": expect.stringContaining("C"),
        "x-path-viewBox": "200 140 240 40",
        style: expect.objectContaining({ stroke: "#00d4ffff", strokeWidth: 12 })
      })
    ]);
    expect(lowered.receipt).toMatchObject({
      operation: "adapter.lower",
      status: "warning",
      packageId: "packages/lottie-static-shape",
      inputHashes: { source: lowered.source.sha256 },
      output: {
        adapterId: "adapter.lottie",
        motionId: lowered.motion.id,
        motionSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        layerCount: 2,
        acceptedWarningFeatures: expect.arrayContaining([
          { path: "lottie.layers[1]#Arabic title", feature: "lottie.text.shaping" },
          { path: "lottie.layers[1]#Arabic title", feature: "lottie.text.layout" }
        ])
      }
    });
  });

  it("lowers fixture-backed alpha mattes and static effects with explicit approximation receipts", async () => {
    const sourcePath = resolve("../../fixtures/imports/lottie-matte-effects/input.json");
    const sourceText = await readFile(sourcePath, "utf8");
    const lowered = lowerStaticLottieToMotion({
      adapterId: "adapter.lottie",
      sourcePath,
      sourceText,
      normalizedPackagePath: "packages/lottie-matte-effects",
      createdAt: "2026-07-12T18:00:00.000Z"
    });

    expect(await validateDocument(await loadSchema("motion"), lowered.motion)).toEqual({ ok: true });
    expect(lowered.diagnostics.unsupportedFeatures).toEqual([]);
    expect(lowered.diagnostics.supportedFeatures).toEqual(expect.arrayContaining([
      expect.objectContaining({ feature: "lottie.trackMatte.alpha", status: "supported" }),
      expect.objectContaining({ feature: "lottie.effect.gaussianBlur", status: "supported" }),
      expect.objectContaining({ feature: "lottie.effect.brightnessContrast", status: "supported" })
    ]));
    expect(lowered.motion.layers).toEqual([
      expect.objectContaining({
        id: "blurred-effect-square",
        effects: { blur: 6, brightness: 1.2, contrast: 1.25 }
      }),
      expect.objectContaining({
        id: "masked-green-field",
        matte: { type: "alpha", sourceLayerId: "matte-window" }
      }),
      expect.objectContaining({
        id: "matte-window",
        type: "shape",
        style: { fill: "#ffffff" }
      })
    ]);
    expect(lowered.receipt).toMatchObject({
      status: "warning",
      output: {
        acceptedWarningFeatures: expect.arrayContaining([
          expect.objectContaining({ feature: "lottie.effect.gaussianBlur.approximation" }),
          expect.objectContaining({ feature: "lottie.effect.brightnessContrast.approximation" })
        ])
      }
    });
  });

  it("lowers fixture-backed luma and inverted-luma matte pairs", async () => {
    const sourcePath = resolve("../../fixtures/imports/lottie-luma-mattes/input.json");
    const sourceText = await readFile(sourcePath, "utf8");
    const lowered = lowerStaticLottieToMotion({
      adapterId: "adapter.lottie",
      sourcePath,
      sourceText,
      normalizedPackagePath: "packages/lottie-luma-mattes",
      createdAt: "2026-07-12T20:00:00.000Z"
    });

    expect(await validateDocument(await loadSchema("motion"), lowered.motion)).toEqual({ ok: true });
    expect(lowered.diagnostics.unsupportedFeatures).toEqual([]);
    expect(lowered.diagnostics.supportedFeatures).toEqual(expect.arrayContaining([
      expect.objectContaining({ feature: "lottie.trackMatte.luma", status: "supported" }),
      expect.objectContaining({ feature: "lottie.trackMatte.lumaInverted", status: "supported" })
    ]));
    expect(lowered.motion.layers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "luma-consumer", matte: { type: "luma", sourceLayerId: "luma-source" } }),
      expect.objectContaining({ id: "inverted-luma-consumer", matte: { type: "luma-inverted", sourceLayerId: "inverted-luma-source" } }),
      expect.objectContaining({ id: "luma-source", style: { fill: "#808080" } })
    ]));
    expect(lowered.receipt).toMatchObject({
      status: "warning",
      output: { acceptedWarningFeatures: expect.arrayContaining([
        expect.objectContaining({ feature: "lottie.trackMatte.luma.approximation" })
      ]) }
    });
  });

  it("lowers static rectangle and ellipse primitives to bounded paths", async () => {
    const sourcePath = resolve("../../fixtures/imports/lottie-primitives/input.json");
    const sourceText = await readFile(sourcePath, "utf8");
    const lowered = lowerStaticLottieToMotion({
      adapterId: "adapter.lottie",
      sourcePath,
      sourceText,
      normalizedPackagePath: "packages/lottie-primitives",
      createdAt: "2026-07-12T21:00:00.000Z"
    });

    expect(await validateDocument(await loadSchema("motion"), lowered.motion)).toEqual({ ok: true });
    expect(lowered.diagnostics.unsupportedFeatures).toEqual([]);
    expect(lowered.diagnostics.supportedFeatures).toEqual(expect.arrayContaining([
      expect.objectContaining({ feature: "lottie.shape.rectangle", status: "supported" }),
      expect.objectContaining({ feature: "lottie.shape.ellipse", status: "supported" })
    ]));
    expect(lowered.motion.layers).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Rectangle", type: "shape", shape: "path", "x-path": expect.stringMatching(/^M /) }),
      expect.objectContaining({ name: "Ellipse", type: "shape", shape: "path", "x-path": expect.stringContaining(" C ") })
    ]));
  });

  it("lowers a fixture-backed static Lottie linear gradient to an editable rectangle with explicit lossiness", async () => {
    const sourcePath = resolve("../../fixtures/imports/lottie-linear-gradient/input.json");
    const sourceText = await readFile(sourcePath, "utf8");
    const lowered = lowerStaticLottieToMotion({
      adapterId: "adapter.lottie",
      sourcePath,
      sourceText,
      normalizedPackagePath: "packages/lottie-linear-gradient",
      createdAt: "2026-07-13T12:00:00.000Z"
    });

    expect(await validateDocument(await loadSchema("motion"), lowered.motion)).toEqual({ ok: true });
    expect(lowered.diagnostics.unsupportedFeatures).toEqual([]);
    expect(lowered.diagnostics.lossiness).toMatchObject({ level: "low", unsupportedCount: 0, warningCount: 1 });
    expect(lowered.diagnostics.supportedFeatures).toEqual(expect.arrayContaining([
      expect.objectContaining({ feature: "lottie.shape.gradient.linear", status: "supported" })
    ]));
    expect(lowered.motion.layers).toEqual([
      expect.objectContaining({
        id: "cinematic-gradient-panel",
        name: "Gradient panel",
        type: "shape",
        shape: "rect",
        transform: expect.objectContaining({ x: 30, y: 35, width: 260, height: 110 }),
        gradient: {
          type: "linear",
          angle: 90,
          stops: [
            { offset: 0, color: "#05297aff" },
            { offset: 0.5, color: "#7d2eebff" },
            { offset: 1, color: "#ff405cff" }
          ]
        }
      })
    ]);
    expect(lowered.receipt).toMatchObject({
      status: "warning",
      output: {
        lossiness: { level: "low", unsupportedCount: 0, warningCount: 1 },
        acceptedWarningFeatures: [expect.objectContaining({ feature: "lottie.shape.gradient.linear.approximation" })]
      }
    });
  });

  it("fails closed on Lottie gradients outside the bounded editable subset", async () => {
    const fixtureText = await readFile(resolve("../../fixtures/imports/lottie-linear-gradient/input.json"), "utf8");
    const cases: Array<{ name: string; mutate: (fixture: any) => void; reason: string; extraFeature?: string }> = [
      {
        name: "radial-gradient",
        mutate: (fixture) => { fixture.layers[0].shapes[0].it[1].t = 2; },
        reason: "requires a linear gradient fill"
      },
      {
        name: "gradient-opacity-stops",
        mutate: (fixture) => { fixture.layers[0].shapes[0].it[1].g.k.k.push(0, 100, 1, 100); },
        reason: "without separate opacity stops"
      },
      {
        name: "partial-gradient-span",
        mutate: (fixture) => { fixture.layers[0].shapes[0].it[1].s.k = [80, 90]; },
        reason: "edge-to-edge horizontal or vertical gradient endpoints"
      },
      {
        name: "rotated-gradient",
        mutate: (fixture) => { fixture.layers[0].shapes[0].it[2].r.k = 45; },
        reason: "in 90-degree increments"
      },
      {
        name: "skewed-gradient",
        mutate: (fixture) => { fixture.layers[0].shapes[0].it[2].sk = { a: 0, k: 15 }; },
        reason: "requires static gradient rectangle transforms",
        extraFeature: "lottie.transform.skew"
      }
    ];

    for (const testCase of cases) {
      const fixture = JSON.parse(fixtureText);
      testCase.mutate(fixture);
      const sourceText = JSON.stringify(fixture);
      const diagnostics = diagnoseAdapterImport({
        adapterId: "adapter.lottie",
        sourcePath: `${testCase.name}.json`,
        sourceText,
        normalizedPackagePath: `packages/${testCase.name}`
      });

      expect(diagnostics.unsupportedFeatures).toContainEqual(expect.objectContaining({
        feature: "lottie.shape.gradient.linear",
        status: "unsupported",
        reason: expect.stringContaining(testCase.reason)
      }));
      if (testCase.extraFeature) {
        expect(diagnostics.unsupportedFeatures).toContainEqual(expect.objectContaining({ feature: testCase.extraFeature }));
      }
      expect(() => lowerStaticLottieToMotion({
        adapterId: "adapter.lottie",
        sourcePath: `${testCase.name}.json`,
        sourceText,
        normalizedPackagePath: `packages/${testCase.name}`
      })).toThrow(/Lottie lowering refused unsupported features/);
    }
  });

  it("lowers fixture-proven Lottie blend modes without lossiness", async () => {
    const sourcePath = resolve("../../fixtures/imports/lottie-blend-modes/input.json");
    const sourceText = await readFile(sourcePath, "utf8");
    const lowered = lowerStaticLottieToMotion({
      adapterId: "adapter.lottie",
      sourcePath,
      sourceText,
      normalizedPackagePath: "packages/lottie-blend-modes",
      createdAt: "2026-07-13T11:15:00.000Z"
    });

    expect(await validateDocument(await loadSchema("motion"), lowered.motion)).toEqual({ ok: true });
    expect(lowered.diagnostics.lossiness.level).toBe("none");
    expect(lowered.diagnostics.unsupportedFeatures).toEqual([]);
    expect(lowered.diagnostics.supportedFeatures).toEqual(expect.arrayContaining([
      expect.objectContaining({ feature: "lottie.blendMode.multiply", status: "supported" }),
      expect.objectContaining({ feature: "lottie.blendMode.screen", status: "supported" }),
      expect.objectContaining({ feature: "lottie.blendMode.plus-lighter", status: "supported" })
    ]));
    expect(lowered.motion.layers).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Multiply cyan", blendMode: "multiply" }),
      expect.objectContaining({ name: "Screen pink", blendMode: "screen" }),
      expect.objectContaining({ name: "Add white", blendMode: "plus-lighter" })
    ]));
    expect(lowered.receipt.output).toMatchObject({
      layerCount: 3,
      lossiness: { level: "none", unsupportedCount: 0, warningCount: 0 }
    });
  });

  it("fails closed on Lottie blend modes without an exact Motion equivalent", () => {
    const sourceText = JSON.stringify({
      w: 32, h: 32, fr: 30, ip: 0, op: 30,
      layers: [{
        ind: 1, ty: 1, nm: "Hard mix", ip: 0, op: 30, sw: 32, sh: 32, sc: "#ffffff", bm: 17,
        ks: { p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } }
      }]
    });
    const diagnostics = diagnoseAdapterImport({
      adapterId: "adapter.lottie",
      sourcePath: "hard-mix.json",
      sourceText,
      normalizedPackagePath: "packages/hard-mix"
    });

    expect(diagnostics.unsupportedFeatures).toContainEqual(expect.objectContaining({ path: "lottie.layers[0]#Hard mix.bm", feature: "lottie.blendMode" }));
    expect(() => lowerStaticLottieToMotion({
      adapterId: "adapter.lottie",
      sourcePath: "hard-mix.json",
      sourceText,
      normalizedPackagePath: "packages/hard-mix"
    })).toThrow(/Lottie lowering refused unsupported features/);
  });

  it("fails closed on Lottie expressions, mattes, effects, and prototype-shaped JSON", () => {
    const sourceText = JSON.stringify({
      w: 320,
      h: 180,
      fr: 30,
      ip: 0,
      op: 30,
      layers: [{
        ind: 1,
        ty: 4,
        nm: "Unsafe",
        ks: { p: { a: 0, k: [0, 0], x: "wiggle(2, 10)" } },
        shapes: [],
        tt: 1,
        ef: [{ ty: 5 }]
      }]
    });

    const diagnostics = diagnoseAdapterImport({
      adapterId: "adapter.lottie",
      sourcePath: "unsafe.json",
      sourceText,
      normalizedPackagePath: "packages/unsafe"
    });

    expect(diagnostics.recommendedFallbackLane).toBe("browser");
    expect(diagnostics.lossiness.level).toBe("high");
    expect(diagnostics.unsupportedFeatures.map((item) => item.feature)).toEqual(expect.arrayContaining([
      "lottie.trackMatte",
      "lottie.effect:unknown",
      "lottie.expression"
    ]));
    expect(() => lowerStaticLottieToMotion({
      adapterId: "adapter.lottie",
      sourcePath: "unsafe.json",
      sourceText,
      normalizedPackagePath: "packages/unsafe"
    })).toThrow(/Lottie lowering refused unsupported features/);
    expect(() => diagnoseAdapterImport({
      adapterId: "adapter.lottie",
      sourcePath: "polluted.json",
      sourceText: '{"w":1,"h":1,"fr":1,"ip":0,"op":1,"layers":[],"__proto__":{"polluted":true}}',
      normalizedPackagePath: "packages/polluted"
    })).toThrow("Invalid Lottie source: forbidden object key __proto__.");
  });

  /**
   * Adversarial performance fixtures. Motion runs adapter diagnostics on untrusted packages, so an
   * SVG whose shape the author chooses must not be able to park the event loop. The bound is loose
   * on purpose — these complete in single-digit milliseconds here, and the implementations they
   * replaced took the times noted per case.
   */
  describe("adversarial SVG inputs", () => {
    /** Loose enough for a loaded machine, tight enough that the old 0.5 s – 68 s times all fail. */
    const BUDGET_MS = 2_000;

    function diagnoseWithin(sourceText: string): { elapsedMs: number; unsupported: number; supported: number } {
      const started = process.hrtime.bigint();
      const diagnostics = diagnoseAdapterImport({
        adapterId: "adapter.svg",
        sourcePath: "adversarial.svg",
        sourceText,
        normalizedPackagePath: "packages/adversarial",
        createdAt: "2026-08-02T00:00:00.000Z"
      });
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
      expect(elapsedMs, `completed in ${elapsedMs.toFixed(1)} ms, budget ${BUDGET_MS} ms`).toBeLessThan(BUDGET_MS);
      return {
        elapsedMs,
        unsupported: diagnostics.unsupportedFeatures.length,
        supported: diagnostics.supportedFeatures.length
      };
    }

    it("diagnoses 42 KB of attributed <path> tags that never close", () => {
      // 3.06 s before the bounded rewrite.
      const sourceText = `<svg viewBox="0 0 10 10">${"<path d=\"M0 0\"><animate attributeName=\"d\"/>".repeat(980)}`;
      expect(sourceText.length).toBeGreaterThan(40_000);
      expect(diagnoseWithin(sourceText).supported).toBe(981);
    });

    it("diagnoses 41 KB of bare <path> tags that never close", () => {
      // 68.4 s before the bounded rewrite: the pair regex retried every `>` for every start.
      const sourceText = `<svg viewBox="0 0 10 10">${"<path>".repeat(6_800)}`;
      expect(sourceText.length).toBeGreaterThan(40_000);
      expect(diagnoseWithin(sourceText).supported).toBe(1);
    });

    it("diagnoses 41 KB of closed <path> pairs carrying unsupported animation", () => {
      // 0.45 s before the rewrite, and this shape is the one real SVGs take.
      const unit = "<path id=\"p\" d=\"M0 0 C1 1 2 2 3 3\" stroke=\"#fff\"><animate attributeName=\"d\" dur=\"1s\"/></path>";
      const sourceText = `<svg viewBox="0 0 10 10">${unit.repeat(440)}</svg>`;
      expect(sourceText.length).toBeGreaterThan(40_000);
      expect(diagnoseWithin(sourceText).unsupported).toBeGreaterThan(0);
    });

    it("diagnoses a 400 KB attribute run that never reaches an equals sign", () => {
      // 50.9 s before the rewrite; the SVG importers accept 8 MiB, so this was a hang, not a stall.
      const sourceText = `<svg viewBox="0 0 10 10"><path ${"a".repeat(400_000)}>`;
      expect(diagnoseWithin(sourceText).supported).toBe(1);
    });
  });
});
