import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertTrackingAnalysis,
  assertTrackingAnalysisLifecycle,
  assertTrackingAnalysisRequest,
  compileTrackingStabilization,
  completeTrackingAnalysis,
  createTrackingAnalysisLifecycle,
  createTrackingOperationReceipt,
  invalidateTrackingAnalysis,
  retryTrackingAnalysis,
  startTrackingAnalysis,
  stopTrackingAnalysis,
  trackingSettingsSha256,
  validateTrackingAnalysis,
  type TrackingAnalysis,
} from "./tracking-analysis";
import { loadSchema, validateDocument } from "./validate";

async function fixture(name: string): Promise<TrackingAnalysis> {
  const value: unknown = JSON.parse(await readFile(resolve("../../fixtures/tracking", name), "utf8"));
  assertTrackingAnalysis(value);
  return value;
}

describe("bounded tracking analysis contracts", () => {
  it("validates fixture-known similarity and homography transforms", async () => {
    const similarity = await fixture("similarity-known.tracking.json");
    const homography = await fixture("homography-known.tracking.json");

    expect(similarity).toMatchObject({ mode: "planar", model: "similarity", status: "partial" });
    expect(homography).toMatchObject({ mode: "planar", model: "homography", status: "succeeded" });
    expect(validateTrackingAnalysis(similarity)).toEqual([]);
    expect(validateTrackingAnalysis(homography)).toEqual([]);
    const schema = await loadSchema("trackingAnalysis");
    expect(schema).toEqual({
      name: "trackingAnalysis",
      schema: "shellx-motion/tracking-analysis@1",
      required: ["schema", "id", "source", "mode", "model", "status", "reference", "settings", "settingsSha256", "solver", "samples", "spans", "createdAt"],
    });
    expect(await validateDocument(schema, similarity)).toEqual({ ok: true });
  });

  it("compiles confidence-qualified stabilization into gap-separated ordinary keyframes", async () => {
    const analysis = await fixture("similarity-known.tracking.json");

    const plan = compileTrackingStabilization({
      analysis,
      targetLayerId: "footage_layer",
      baseTransform: { x: 100, y: 50, scale: 1, rotation: 0 },
    });

    expect(plan).toMatchObject({
      schema: "shellx-motion/stabilization-plan@1",
      status: "partial",
      fidelity: "exact-similarity",
      sourceSha256: "a".repeat(64),
      segments: [
        { startMs: 0, endMs: 100 },
        { startMs: 400, endMs: 400 },
      ],
      excludedSpans: [
        { state: "low-confidence", startMs: 200, endMs: 200 },
        { state: "lost", startMs: 300, endMs: 300 },
      ],
      warnings: ["Lost or low-confidence spans remain explicit segment gaps and are not interpolated."],
    });
    expect(plan.segments[0].keyframes["transform.x"]).toEqual([
      { atMs: 0, value: 100, easing: "linear" },
      { atMs: 100, value: 90, easing: "linear" },
    ]);
    expect(plan.segments[0].keyframes["transform.y"]).toEqual([
      { atMs: 0, value: 50, easing: "linear" },
      { atMs: 100, value: 45, easing: "linear" },
    ]);
  });

  it("labels bounded homography stabilization as a local similarity approximation", async () => {
    const plan = compileTrackingStabilization({
      analysis: await fixture("homography-known.tracking.json"),
      targetLayerId: "plate",
    });

    expect(plan).toMatchObject({
      status: "ready",
      fidelity: "approximated-homography",
      excludedSpans: [],
      warnings: [expect.stringContaining("locally approximated")],
    });
    expect(plan.segments).toHaveLength(1);
    expect(plan.segments[0].keyframes["transform.rotation"]).toHaveLength(3);
  });

  it("preserves the last good result through source invalidation, retry, and cancellation", async () => {
    const analysis = await fixture("similarity-known.tracking.json");
    let lifecycle = createTrackingAnalysisLifecycle({
      id: analysis.id,
      source: analysis.source,
      now: "2026-07-13T21:10:00.000Z",
    });
    lifecycle = startTrackingAnalysis(lifecycle, "2026-07-13T21:10:01.000Z");
    lifecycle = completeTrackingAnalysis(lifecycle, analysis, "2026-07-13T21:10:02.000Z");
    expect(lifecycle).toMatchObject({ state: "partial", attempt: 1, lastGood: { id: analysis.id } });

    const changedSource = { ...analysis.source, sha256: "f".repeat(64) };
    lifecycle = invalidateTrackingAnalysis(lifecycle, changedSource, "2026-07-13T21:10:03.000Z");
    expect(lifecycle).toMatchObject({
      state: "stale",
      requestedSource: changedSource,
      lastGood: { source: { sha256: "a".repeat(64) } },
      failure: { code: "source_changed" },
    });
    lifecycle = retryTrackingAnalysis(lifecycle, { now: "2026-07-13T21:10:04.000Z" });
    lifecycle = startTrackingAnalysis(lifecycle, "2026-07-13T21:10:05.000Z");
    lifecycle = stopTrackingAnalysis(lifecycle, {
      state: "cancelled",
      code: "user_cancelled",
      message: "User cancelled the replacement analysis.",
      now: "2026-07-13T21:10:06.000Z",
    });
    expect(lifecycle).toMatchObject({
      state: "cancelled",
      attempt: 2,
      lastGood: { source: { sha256: "a".repeat(64) } },
    });
    expect(createTrackingOperationReceipt({
      operation: "analysis.tracking.verify",
      packageId: "pkg_tracking",
      lifecycle,
      now: "2026-07-13T21:10:07.000Z",
    })).toMatchObject({ status: "failed", lane: "analysis", inputHashes: { source: "f".repeat(64) } });
    expect(() => assertTrackingAnalysisLifecycle(lifecycle)).not.toThrow();
    const lifecycleSchema = await loadSchema("trackingLifecycle");
    expect(lifecycleSchema).toMatchObject({ schema: "shellx-motion/tracking-lifecycle@1" });
    expect(await validateDocument(lifecycleSchema, lifecycle)).toEqual({ ok: true });
  });

  it("validates requests before decode and permits explicit reruns of a last-good result", async () => {
    const analysis = await fixture("homography-known.tracking.json");
    expect(() => assertTrackingAnalysisRequest({
      id: analysis.id,
      source: analysis.source,
      mode: analysis.mode,
      model: analysis.model,
      reference: analysis.reference,
      settings: analysis.settings,
    })).not.toThrow();
    expect(() => assertTrackingAnalysisRequest({
      id: analysis.id,
      source: analysis.source,
      mode: "point",
      model: "homography",
      reference: analysis.reference,
      settings: analysis.settings,
    })).toThrow("point mode requires the translation model");

    let lifecycle = createTrackingAnalysisLifecycle({ id: analysis.id, source: analysis.source });
    lifecycle = completeTrackingAnalysis(startTrackingAnalysis(lifecycle), analysis);
    const rerun = retryTrackingAnalysis(lifecycle);
    expect(rerun).toMatchObject({ state: "queued", attempt: 2, lastGood: { id: analysis.id } });
  });

  it("hashes settings by value, not by the order the fields were written", async () => {
    const analysis = await fixture("similarity-known.tracking.json");
    // Same nine values, rebuilt in the reverse order a hand-written caller might use.
    const rebuilt = {
      deterministicSeed: analysis.settings.deterministicSeed,
      confidenceFloor: analysis.settings.confidenceFloor,
      maxIterations: analysis.settings.maxIterations,
      pyramidLevels: analysis.settings.pyramidLevels,
      searchRadiusPx: analysis.settings.searchRadiusPx,
      direction: analysis.settings.direction,
      stepMs: analysis.settings.stepMs,
      endMs: analysis.settings.endMs,
      startMs: analysis.settings.startMs,
    } as typeof analysis.settings;

    expect(JSON.stringify(rebuilt)).not.toBe(JSON.stringify(analysis.settings));
    expect(trackingSettingsSha256(rebuilt)).toBe(analysis.settingsSha256);
    expect(validateTrackingAnalysis({ ...analysis, settings: rebuilt })).toEqual([]);
  });

  it("says on the receipt when a hashed setting could not reach the solver", async () => {
    const analysis = await fixture("similarity-known.tracking.json");
    const seeded = { ...analysis, settings: { ...analysis.settings, deterministicSeed: 4_242 } };
    seeded.settingsSha256 = trackingSettingsSha256(seeded.settings);
    const inert = { ...analysis, settings: { ...analysis.settings, deterministicSeed: 0 } };
    inert.settingsSha256 = trackingSettingsSha256(inert.settings);

    const receiptFor = (value: TrackingAnalysis) => createTrackingOperationReceipt({
      operation: "analysis.tracking.inspect",
      packageId: "pkg_tracking",
      lifecycle: completeTrackingAnalysis(
        startTrackingAnalysis(createTrackingAnalysisLifecycle({ id: value.id, source: value.source, now: "2026-08-02T00:00:00.000Z" }), "2026-08-02T00:00:01.000Z"),
        value,
        "2026-08-02T00:00:02.000Z"
      ),
      now: "2026-08-02T00:00:03.000Z",
    });

    expect(receiptFor(seeded).warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("deterministicSeed=4242 was accepted and hashed into settingsSha256 but did not affect the result"),
    ]));
    // A seed of 0 asks for nothing, so there is nothing to warn about.
    expect(receiptFor(inert).warnings.some((warning) => warning.includes("deterministicSeed"))).toBe(false);
    // The identity story stays coherent: same source, same samples, different requested settings,
    // therefore different settings hash and a different receipt content address.
    expect(receiptFor(seeded).inputHashes.lifecycle).not.toBe(receiptFor(inert).inputHashes.lifecycle);
    expect(receiptFor(seeded).inputHashes.source).toBe(receiptFor(inert).inputHashes.source);
  });

  it("rejects unbounded, singular, or semantically misleading analysis samples", async () => {
    const valid = await fixture("similarity-known.tracking.json");
    const hostile = structuredClone(valid) as any;
    hostile.status = "succeeded";
    hostile.samples[1].matrix = [1, 0, 0, 0, 0, 0, 0, 0, 0];
    hostile.samples[2].matrix[6] = 0.5;
    hostile.samples[3].matrix = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    hostile.settings.searchRadiusPx = 1_000_000;
    hostile.settingsSha256 = "0".repeat(64);

    expect(validateTrackingAnalysis(hostile)).toEqual(expect.arrayContaining([
      "settings.searchRadiusPx must be an integer from 1 to 512",
      "settingsSha256 does not match settings",
      "samples.1.matrix must be invertible",
      "samples.2.matrix perspective terms exceed the bounded homography limit",
      "samples.3.matrix must be absent while lost",
      "status must be partial when samples are low-confidence or lost",
    ]));
  });
});
