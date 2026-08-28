/** Contract tests for SDK envelopes, identity preservation, helpers, and Player state. */
import { describe, expect, it, vi } from "vitest";
import { compositingGraphFingerprint, type TemplateParam } from "@shellx-motion/core";
import {
  MOTION_SDK_SCHEMA,
  canonicalJson,
  createMotionPlayer,
  createMotionSdk,
  createMotionSdkHandlerTransport,
  createTemplateParameterSchema,
  migrateMotionSdkRequest,
  motionSdkCacheKey,
  type MotionPlayerSource,
  type MotionSdkOperation,
  type MotionSdkResponseMap,
  type MotionSdkTransport,
  type MotionSdkTransportRequest
} from "./index";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

describe("ShellX Motion SDK", () => {
  it("routes the core operation set through versioned, deterministic transport envelopes", async () => {
    const requests: MotionSdkTransportRequest[] = [];
    const transport = fakeTransport((request) => {
      requests.push(request);
      return successfulOutput(request.operation);
    });
    const sdk = createMotionSdk(transport);

    const results = await Promise.all([
      sdk.validate({ packageRoot: "/motion/pkg" }),
      sdk.compile({ script: { title: "Launch", frames: [] }, outDir: "/motion/compiled" }),
      sdk.preview({ packageRoot: "/motion/pkg", outDir: "/motion/preview", atMs: 125 }),
      sdk.render({ packageRoot: "/motion/pkg", outputPath: "/motion/out/final.webm", preset: "webm-vp9" }),
      sdk.status({ receiptsRoot: "/motion/receipts" }),
      sdk.cancel({ receiptsRoot: "/motion/receipts", jobId: "render-1", reason: "operator cancelled" }),
      sdk.timelineEdit({
        packageRoot: "/motion/pkg",
        outDir: "/motion/edited",
        edit: { kind: "keyframe.easing.apply", layerId: "title", target: "opacity", easing: "ease-in-out", atMs: 125 }
      }),
      sdk.trackingRequest({
        packageRoot: "/motion/pkg", outDir: "/motion/tracked", analysisId: "track-1", assetId: "plate",
        mode: "point", model: "translation", reference: trackingReference(), settings: trackingSettings()
      }),
      sdk.trackingInspect({ packageRoot: "/motion/tracked", analysisId: "track-1" }),
      sdk.trackingApply({ packageRoot: "/motion/tracked", outDir: "/motion/stabilized", analysisId: "track-1", layerId: "plate", segmentIndex: 0 }),
      sdk.trackingDetach({ packageRoot: "/motion/stabilized", outDir: "/motion/detached", layerId: "plate" }),
      sdk.trackingVerify({ packageRoot: "/motion/stabilized", layerId: "plate", analysisId: "track-1" }),
      sdk.keyingInspect({ packageRoot: "/motion/pkg", layerId: "plate" }),
      sdk.keyingApply({ packageRoot: "/motion/pkg", outDir: "/motion/keyed", layerId: "plate", keying: keyingControls() }),
      sdk.keyingRemove({ packageRoot: "/motion/keyed", outDir: "/motion/unkeyed", layerId: "plate" }),
      sdk.rotoUpsert({ packageRoot: "/motion/pkg", outDir: "/motion/roto", layerId: "plate", mask: rotoMask() }),
      sdk.rotoTrackingDetach({ packageRoot: "/motion/roto", outDir: "/motion/roto-detached", layerId: "plate" }),
      sdk.rotoRemove({ packageRoot: "/motion/roto-detached", outDir: "/motion/roto-removed", layerId: "plate" }),
      sdk.compositingInspect({ packageRoot: "/motion/pkg" }),
      sdk.compositingSet({ packageRoot: "/motion/pkg", outDir: "/motion/composited", graph: compositingGraph() }),
      sdk.compositingRemove({ packageRoot: "/motion/composited", outDir: "/motion/decomposited" })
    ]);

    expect(results.every((result) => result.ok)).toBe(true);
    expect(requests.map((request) => request.operation).sort()).toEqual([
      "validate", "compile", "preview", "render", "status", "cancel", "timelineEdit",
      "trackingRequest", "trackingInspect", "trackingApply", "trackingDetach", "trackingVerify",
      "keyingInspect", "keyingApply", "keyingRemove", "rotoUpsert", "rotoTrackingDetach", "rotoRemove",
      "compositingInspect", "compositingSet", "compositingRemove"
    ].sort());
    for (const request of requests) {
      expect(request).toMatchObject({
        schema: MOTION_SDK_SCHEMA,
        requestId: `sdk-${request.operation}-${request.cacheKey.slice(0, 20)}`,
        cacheKey: expect.stringMatching(/^[a-f0-9]{64}$/)
      });
    }
    const render = results[3];
    expect(render.ok && render.output.artifact).toMatchObject({
      packageId: "pkg_sdk",
      motionId: "motion_sdk",
      preset: "webm-vp9",
      sha256: SHA_C
    });
  });

  it("returns fail-closed errors for transport exceptions, metadata swaps, and malformed artifact identity", async () => {
    const thrown = await createMotionSdk({ execute: async () => { throw new Error("connection reset"); } }).validate({ packageRoot: "/pkg" });
    expect(thrown).toMatchObject({ ok: false, error: { code: "transport_error", retryable: true, message: "connection reset" } });

    const swapped = await createMotionSdk(fakeTransport((request) => successfulOutput(request.operation), { cacheKey: SHA_B })).status({ receiptsRoot: "/receipts" });
    expect(swapped).toMatchObject({ ok: false, error: { code: "invalid_transport_response", message: "Transport response cacheKey does not match the request." } });

    for (const validation of [{ ...validationReport(), structural: "failed", semantic: "passed" }, { ...validationReport(), structural: "not_run", semantic: "failed" }, { ...validationReport(), structural: "passed", semantic: "not_run" }]) {
      const invalidStages = await createMotionSdk(fakeTransport(() => ({ ...successfulOutput("validate"), validation }))).validate({ packageRoot: "/pkg" });
      expect(invalidStages).toMatchObject({ ok: false, error: { code: "invalid_transport_response", message: "SDK validate output requires a valid two-stage Motion validation report." } });
    }
    const malformed = await createMotionSdk(fakeTransport(() => ({
      ...successfulOutput("render"),
      artifact: { ...successfulOutput("render").artifact, motionId: "motion_swapped" }
    }))).render({ packageRoot: "/pkg", outputPath: "/out/final.webm", preset: "webm-vp9" });
    expect(malformed).toMatchObject({ ok: false, error: { code: "invalid_transport_response", message: "SDK render artifact identity is invalid or does not match the render." } });
    const missingCutBinding = await createMotionSdk(fakeTransport(() => successfulOutput("render"))).render({
      packageRoot: "/pkg",
      outputPath: "/out/final.webm",
      preset: "webm-vp9",
      cutHandoff: { target: "shellx-cut", mode: "rendered_media" }
    });
    expect(missingCutBinding).toMatchObject({
      ok: false,
      error: { code: "invalid_transport_response", message: "SDK render Cut handoff/reference identity is invalid or does not match the request and artifact." }
    });
    const swappedEditReceipt = await createMotionSdk(fakeTransport(() => successfulOutput("timelineEdit"))).timelineEdit({
      packageRoot: "/pkg",
      outDir: "/edited",
      edit: { kind: "keyframe.upsert", layerId: "title", target: "opacity", atMs: 125, value: 0.5 }
    });
    expect(swappedEditReceipt).toMatchObject({
      ok: false,
      error: { code: "invalid_transport_response", message: "SDK timelineEdit output requires a valid package, edit, and passed receipt identity." }
    });
    const swappedTrackingLayer = await createMotionSdk(fakeTransport(() => ({
      ...successfulOutput("trackingApply"), layerId: "other-layer"
    }))).trackingApply({
      packageRoot: "/motion/tracked", outDir: "/motion/stabilized", analysisId: "track-1", layerId: "plate", segmentIndex: 0
    });
    expect(swappedTrackingLayer).toMatchObject({
      ok: false,
      error: { code: "invalid_transport_response", message: "SDK trackingApply output requires a valid applied segment and receipt identity." }
    });

    let getterRuns = 0;
    const accessorGraph = Object.defineProperty({ ...compositingGraph() }, "execute", {
      enumerable: true,
      get: () => { getterRuns += 1; return "must-not-run"; },
    });
    const unsafeGraphOutput = successfulOutput("compositingSet");
    const unsafeGraph = await createMotionSdk(fakeTransport(() => ({
      ...unsafeGraphOutput,
      state: { ...unsafeGraphOutput.state, graph: accessorGraph },
    }))).compositingSet({ packageRoot: "/motion/pkg", outDir: "/motion/composited", graph: compositingGraph() });
    expect(unsafeGraph).toMatchObject({ ok: false, error: { code: "invalid_transport_response" } });
    expect(getterRuns).toBe(0);
  });

  it("rejects inherited request fields before transport execution", async () => {
    const execute = vi.fn();
    const inherited = Object.create({ packageRoot: "/outside" }) as { packageRoot: string };
    const result = await createMotionSdk({ execute }).validate(inherited);
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_request", retryable: false } });
    expect(execute).not.toHaveBeenCalled();
    const unknown = await createMotionSdk({ execute }).render({
      packageRoot: "/pkg", outputPath: "/out/final.mp4", preset: "mp4-h264", extra: true
    } as never);
    expect(unknown).toMatchObject({ ok: false, error: { code: "invalid_request", message: "SDK render input contains unsupported field extra." } });
    expect(execute).not.toHaveBeenCalled();
    const unsafeEdit = Object.create({ kind: "keyframe.delete" }) as { kind: "keyframe.delete"; layerId: string; target: string; atMs: number };
    unsafeEdit.layerId = "title";
    unsafeEdit.target = "opacity";
    unsafeEdit.atMs = 0;
    const rejectedEdit = await createMotionSdk({ execute }).timelineEdit({ packageRoot: "/pkg", outDir: "/edited", edit: unsafeEdit });
    expect(rejectedEdit).toMatchObject({ ok: false, error: { code: "invalid_request", message: "SDK timelineEdit edit must be a plain object." } });
    const prototypeKind = await createMotionSdk({ execute }).timelineEdit({
      packageRoot: "/pkg",
      outDir: "/edited",
      edit: { kind: "__proto__", layerId: "title", target: "opacity", atMs: 0 } as never
    });
    expect(prototypeKind).toMatchObject({ ok: false, error: { code: "invalid_request", message: "SDK timelineEdit edit kind is unsupported." } });
    const badSnap = await createMotionSdk({ execute }).timelineEdit({
      packageRoot: "/pkg",
      outDir: "/edited",
      edit: { kind: "keyframe.snap", layerId: "title", target: "opacity", mode: "random" } as never,
    });
    expect(badSnap).toMatchObject({ ok: false, error: { code: "invalid_request", message: "SDK timelineEdit keyframe.snap mode is unsupported." } });
    const unsafeTracking = await createMotionSdk({ execute }).trackingRequest({
      packageRoot: "/pkg", outDir: "/tracked", analysisId: "track-1", assetId: "plate",
      mode: "point", model: "homography", reference: trackingReference(), settings: trackingSettings()
    });
    expect(unsafeTracking).toMatchObject({
      ok: false,
      error: { code: "invalid_request", message: "SDK trackingRequest mode and model are incompatible." }
    });
    const unknownTrackingSetting = await createMotionSdk({ execute }).trackingRequest({
      packageRoot: "/pkg", outDir: "/tracked", analysisId: "track-1", assetId: "plate",
      mode: "point", model: "translation", reference: trackingReference(),
      settings: { ...trackingSettings(), arbitraryCode: "no" }
    } as never);
    expect(unknownTrackingSetting).toMatchObject({
      ok: false,
      error: { code: "invalid_request", message: "SDK trackingRequest requires complete bounded settings." }
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("uses canonical JSON for stable cross-transport cache keys", async () => {
    expect(canonicalJson({ z: 1, a: { y: 2, x: 3 }, omitted: undefined })).toBe('{"a":{"x":3,"y":2},"z":1}');
    await expect(Promise.all([
      motionSdkCacheKey("render", { preset: "webm-vp9", packageRoot: "/pkg" }),
      motionSdkCacheKey("render", { packageRoot: "/pkg", preset: "webm-vp9" })
    ])).resolves.toEqual([expect.stringMatching(/^[a-f0-9]{64}$/), expect.stringMatching(/^[a-f0-9]{64}$/)]);
    const [left, right] = await Promise.all([
      motionSdkCacheKey("render", { preset: "webm-vp9", packageRoot: "/pkg" }),
      motionSdkCacheKey("render", { packageRoot: "/pkg", preset: "webm-vp9" })
    ]);
    expect(left).toBe(right);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow("Cyclic cache-key value");
    expect(() => canonicalJson(new Date())).toThrow("must be plain JSON data");
    const accessor = Object.defineProperty({}, "secret", { enumerable: true, get: () => "should-not-run" });
    expect(() => canonicalJson(accessor)).toThrow("must not use accessors");
    expect(canonicalJson([1, , 3])).toBe("[1,null,3]");
    const arrayAccessor = Object.defineProperty([], "0", { enumerable: true, get: () => "should-not-run" });
    expect(() => canonicalJson(arrayAccessor)).toThrow("must not use accessors");
    // A non-enumerable own property is refused rather than validated and then dropped: canonical
    // JSON enumerates with Object.keys, so accepting it would let two different values share a key.
    const hidden = Object.defineProperty({ shown: 1 }, "hidden", { enumerable: false, value: 2 });
    expect(() => canonicalJson(hidden)).toThrow("must not use non-enumerable properties");
  });

  it("provides a local handler transport with echoed request identity and explicit missing capabilities", async () => {
    const transport = createMotionSdkHandlerTransport({
      validate: async (_input, request) => {
        expect(request.cacheKey).toMatch(/^[a-f0-9]{64}$/);
        return { ok: true, output: { package: packageIdentity(), validation: validationReport(), warnings: [] } };
      }
    });
    const sdk = createMotionSdk(transport);
    await expect(sdk.validate({ packageRoot: "/pkg" })).resolves.toMatchObject({ ok: true, output: { package: { packageId: "pkg_sdk" } } });
    await expect(sdk.render({ packageRoot: "/pkg", outputPath: "/out/final.mp4", preset: "mp4-h264" })).resolves.toMatchObject({
      ok: false,
      error: { code: "capability_unavailable", message: "Motion SDK render is unavailable on this transport.", retryable: false }
    });
  });

  it("generates portable template parameter JSON Schema and rejects duplicate ids", () => {
    const params: TemplateParam[] = [
      { id: "title", label: "Title", type: "text", defaultValue: null },
      { id: "accent", type: "color", defaultValue: "#38bdf8" },
      { id: "scale", type: "number", defaultValue: 1, min: 0.5, max: 2, step: 0.1 },
      { id: "layout", type: "select", defaultValue: "wide", options: [{ label: "Wide", value: "wide" }, { label: "Square", value: "square" }] }
    ];
    expect(createTemplateParameterSchema("template_launch", params)).toEqual({
      schema: "shellx-motion/template-parameters@1",
      templateId: "template_launch",
      jsonSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          title: { title: "Title", type: "string" },
          accent: { title: "accent", default: "#38bdf8", type: "string", pattern: "^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$", format: "color" },
          scale: { title: "scale", default: 1, type: "number", minimum: 0.5, maximum: 2, multipleOf: 0.1 },
          layout: { title: "layout", default: "wide", enum: ["wide", "square"], "x-shellx-option-labels": ["Wide", "Square"] }
        },
        required: ["title"],
        additionalProperties: false
      }
    });
    expect(() => createTemplateParameterSchema("duplicate", [params[0]!, params[0]!])).toThrow("empty or duplicated");
  });

  it("migrates explicit legacy request documents without silently accepting unknown versions", () => {
    expect(migrateMotionSdkRequest({
      schema: "shellx-motion/sdk-request@0",
      op: "render",
      payload: { root: "/pkg", output: "/out/final.mp4", preset: "mp4-h264" }
    })).toEqual({
      document: {
        schema: "shellx-motion/sdk-request@1",
        operation: "render",
        input: { packageRoot: "/pkg", outputPath: "/out/final.mp4", preset: "mp4-h264" }
      },
      warnings: ["Migrated shellx-motion/sdk-request@0 to @1; replace op/payload and legacy field aliases."]
    });
    expect(() => migrateMotionSdkRequest({ schema: "shellx-motion/sdk-request@9" })).toThrow("Unsupported Motion SDK request schema");
  });
});

describe("Motion Player", () => {
  it("preserves one attested artifact identity across load, play, seek, pause, end, and dispose", async () => {
    const calls: unknown[] = [];
    const player = createMotionPlayer({
      load: (source) => { calls.push(["load", source]); },
      play: () => { calls.push(["play"]); },
      pause: () => { calls.push(["pause"]); },
      seek: (timeMs) => { calls.push(["seek", timeMs]); },
      unload: () => { calls.push(["unload"]); }
    });
    const states: string[] = [];
    player.subscribe((state) => states.push(state.status));
    const source = playerSource();

    await player.load(source);
    await player.play();
    await player.seek(9_000);
    await player.pause();
    player.sync({ currentTimeMs: 2_000, ended: true });
    expect(player.snapshot()).toMatchObject({ status: "ended", source, currentTimeMs: 2_000, durationMs: 2_000 });
    expect(calls).toEqual([
      ["load", { uri: source.uri, mediaType: "video/webm", durationMs: 2_000 }],
      ["play"], ["seek", 2_000], ["pause"]
    ]);
    expect(states).toEqual(["ready", "playing", "ended", "paused", "ended"]);
    await player.dispose();
    expect(player.snapshot()).toEqual({ status: "disposed", source: null, currentTimeMs: 0, durationMs: 0 });
    expect(calls.at(-1)).toEqual(["unload"]);
  });

  it("rejects unattested, local-file, and post-disposal playback", async () => {
    const port = { load: vi.fn(), play: vi.fn(), pause: vi.fn(), seek: vi.fn(), unload: vi.fn() };
    const player = createMotionPlayer(port);
    await expect(player.load({ ...playerSource(), uri: "file:///tmp/final.webm" })).rejects.toThrow("HTTP(S) or blob-backed");
    await expect(player.load({ ...playerSource(), artifact: { ...playerSource().artifact, sha256: "bad" } })).rejects.toThrow("valid attested artifact identity");
    await player.load(playerSource());
    await player.dispose();
    await expect(player.play()).rejects.toThrow("disposed");
  });
});

function fakeTransport(
  output: (request: MotionSdkTransportRequest) => unknown,
  override: Partial<{ schema: string; operation: string; requestId: string; cacheKey: string }> = {}
): MotionSdkTransport {
  return {
    async execute<K extends MotionSdkOperation>(request: MotionSdkTransportRequest<K>) {
      return {
        schema: override.schema ?? request.schema,
        operation: override.operation ?? request.operation,
        requestId: override.requestId ?? request.requestId,
        cacheKey: override.cacheKey ?? request.cacheKey,
        ok: true,
        output: output(request as MotionSdkTransportRequest)
      } as never;
    }
  };
}

function successfulOutput<K extends MotionSdkOperation>(operation: K): MotionSdkResponseMap[K] {
  const outputs: Partial<MotionSdkResponseMap> = {
    validate: { package: packageIdentity(), validation: validationReport(), warnings: [] },
    compile: { packageRoot: "/motion/compiled/package", package: packageIdentity(), receiptPath: "/motion/compiled/receipt.json", warnings: [] },
    preview: {
      packageId: "pkg_sdk", motionId: "motion_sdk", lane: "browser", receiptId: "preview-1", warnings: [],
      frame: { path: "/motion/preview/frame.png", sha256: SHA_C, width: 1280, height: 720, atMs: 125, mediaType: "image/png" }
    },
    render: {
      jobId: "render-1", state: "succeeded", packageId: "pkg_sdk", motionId: "motion_sdk", preset: "webm-vp9",
      outputPath: "/motion/out/final.webm", receiptId: "render-receipt-1", warnings: [], artifact: artifactIdentity()
    },
    status: {
      jobs: [{ jobId: "render-1", state: "running", packageId: "pkg_sdk", operation: "render.final", receiptId: "render-receipt-1", retryCount: 0, warnings: [] }],
      stateCounts: { running: 1 }, warnings: []
    },
    cancel: { targetJobId: "render-1", state: "running", cancelRequested: true, warnings: [] },
    timelineEdit: {
      packageRoot: "/motion/edited",
      package: packageIdentity(),
      edit: { kind: "keyframe.easing.apply", layerId: "title", target: "opacity", easing: "ease-in-out", atMs: 125 },
      receipt: {
        schema: "shellx-motion/receipt@1",
        id: "timeline-edit-1",
        packageId: "pkg_sdk",
        operation: "timeline.keyframe.easing.apply",
        status: "passed",
        path: "/motion/edited/receipts/timeline-keyframe-easing-apply.receipt.json",
        sha256: SHA_C
      },
      warnings: []
    },
    trackingRequest: {
      packageRoot: "/motion/tracked", package: packageIdentity(), lifecyclePath: "/motion/tracked/analysis/tracking/track-1.lifecycle.json",
      lifecycle: trackingLifecycle(), receipt: trackingReceipt("analysis.tracking.request"), receiptPath: "/motion/tracked/receipts/tracking-request.json", warnings: []
    },
    trackingInspect: {
      packageRoot: "/motion/tracked", package: packageIdentity(), lifecyclePath: "/motion/tracked/analysis/tracking/track-1.lifecycle.json",
      lifecycle: trackingLifecycle(), source: trackingSourceInspection(), current: true,
      receipt: trackingReceipt("analysis.tracking.inspect"), warnings: []
    },
    trackingApply: {
      packageRoot: "/motion/stabilized", package: packageIdentity(), layerId: "plate", analysisId: "track-1",
      segment: { index: 0, startMs: 0, endMs: 2_000, keyframeCount: 3 }, fidelity: "exact-similarity",
      changedPaths: ["/layers/0/keyframes/transform.x"], receipt: trackingReceipt("analysis.tracking.apply"),
      receiptPath: "/motion/stabilized/receipts/tracking-apply.json", warnings: []
    },
    trackingDetach: {
      packageRoot: "/motion/detached", package: packageIdentity(), layerId: "plate", analysisId: "track-1",
      restoredPreviousKeyframes: true, changedPaths: ["/layers/0/keyframes/transform.x"],
      receipt: trackingReceipt("analysis.tracking.detach"), receiptPath: "/motion/detached/receipts/tracking-detach.json", warnings: []
    },
    trackingVerify: {
      packageRoot: "/motion/stabilized", package: packageIdentity(),
      verification: { attached: true, current: true, layerId: "plate", analysisId: "track-1", sourceSha256: SHA_A, segmentIndex: 0, mismatchedTargets: [], reasons: [] },
      lifecycle: trackingLifecycle(), source: trackingSourceInspection(), receipt: trackingReceipt("analysis.tracking.verify"), warnings: []
    },
    keyingInspect: { packageRoot: "/motion/pkg", package: packageIdentity(), state: keyingState(null, null), warnings: [] },
    keyingApply: keyingMutation("/motion/keyed", "keying.apply", keyingState(keyingControls(), null)),
    keyingRemove: keyingMutation("/motion/unkeyed", "keying.remove", keyingState(null, null)),
    rotoUpsert: keyingMutation("/motion/roto", "roto.upsert", keyingState(null, rotoMask())),
    rotoTrackingDetach: keyingMutation("/motion/roto-detached", "roto.tracking.detach", keyingState(null, detachedRotoMask())),
    rotoRemove: keyingMutation("/motion/roto-removed", "roto.remove", keyingState(null, null)),
    compositingInspect: {
      packageRoot: "/motion/pkg",
      package: packageIdentity(),
      state: compositingState(false),
      warnings: [],
    },
    compositingSet: compositingMutation(
      "/motion/composited",
      "compositing.graph.set",
      compositingState(true),
    ),
    compositingRemove: compositingMutation(
      "/motion/decomposited",
      "compositing.graph.remove",
      compositingState(false),
    ),
  };
  return outputs[operation] as MotionSdkResponseMap[K];
}
const validationReport = () => ({ contract: "shellx-motion/motion-validation@1" as const, structural: "passed" as const, semantic: "passed" as const, renderability: "not_proven" as const });

function packageIdentity() {
  return { packageId: "pkg_sdk", motionId: "motion_sdk", durationMs: 2_000, fps: 30, width: 1280, height: 720, manifestSha256: SHA_A, motionSha256: SHA_B };
}

function artifactIdentity() {
  return {
    schema: "shellx-motion/artifact-handle@1" as const,
    id: "artifact-sdk-1",
    packageId: "pkg_sdk",
    motionId: "motion_sdk",
    operationHash: SHA_A,
    preset: "webm-vp9",
    mediaType: "video/webm",
    byteLength: 4_096,
    sha256: SHA_C,
    createdAt: "2026-07-12T00:00:00.000Z"
  };
}

function trackingReference() {
  return { atMs: 0, bounds: { x: 10, y: 20, width: 40, height: 30 }, points: [{ x: 30, y: 35 }] };
}

/**
 * Bounded tracking settings for the SDK guards. `pyramidLevels: 2` matches `tracking-solver.test.ts`:
 * depth is not free accuracy — on the 6-point homography fixture depth 3 is 56x worse (10.879 px
 * versus 0.193 px). `deterministicSeed` is inert (no randomness) but is hashed into request identity.
 */
function trackingSettings() {
  return {
    startMs: 0, endMs: 2_000, stepMs: 100, direction: "forward" as const,
    searchRadiusPx: 16, pyramidLevels: 2, maxIterations: 20, confidenceFloor: 0.6, deterministicSeed: 42
  };
}

function trackingLifecycle() {
  return {
    schema: "shellx-motion/tracking-lifecycle-summary@1" as const,
    analysisId: "track-1",
    state: "succeeded" as const,
    attempt: 1,
    updatedAt: "2026-07-13T00:00:00.000Z",
    source: { assetId: "plate", sha256: SHA_A, byteLength: 4_096, width: 1280, height: 720, durationMs: 2_000 },
    lastGood: {
      status: "succeeded" as const,
      mode: "point" as const,
      model: "translation" as const,
      reference: trackingReference(),
      settings: trackingSettings(),
      samples: { total: 3, tracked: 3, lowConfidence: 0, lost: 0, recovered: 0, minConfidence: 0.8, meanConfidence: 0.9 },
      spanCount: 0,
      planStatus: "ready" as const,
      fidelity: "exact-similarity" as const,
      segments: [{ index: 0, startMs: 0, endMs: 2_000, keyframeCount: 3 }],
      warnings: []
    }
  };
}

function trackingSourceInspection() {
  return { assetId: "plate", assetRef: "assets/plate.mp4", sha256: SHA_A, byteLength: 4_096, current: true };
}

function trackingReceipt(operation: "analysis.tracking.request" | "analysis.tracking.inspect" | "analysis.tracking.apply" | "analysis.tracking.detach" | "analysis.tracking.verify") {
  const persisted = operation === "analysis.tracking.request" || operation === "analysis.tracking.apply" || operation === "analysis.tracking.detach";
  return {
    schema: "shellx-motion/receipt@1" as const,
    id: `receipt-${operation.split(".").at(-1)}`,
    packageId: "pkg_sdk",
    operation,
    status: "passed" as const,
    ...(persisted ? { sha256: SHA_C } : {})
  };
}

function keyingControls() {
  return { schema: "shellx-motion/chroma-key@1" as const, keyColor: "#00ff00", spillSuppression: 0.75 };
}

function rotoMask() {
  return {
    type: "roto", schema: "shellx-motion/roto-mask@1" as const, closed: true,
    frames: [{ atMs: 0, vertices: [{ id: "a", x: 0.1, y: 0.1 }, { id: "b", x: 0.9, y: 0.1 }, { id: "c", x: 0.5, y: 0.9 }] }],
    tracking: { schema: "shellx-motion/roto-tracking-attachment@1" as const, analysisId: "track-1", sourceSha256: SHA_A, segmentIndex: 0, model: "similarity" as const },
  };
}

function detachedRotoMask() {
  const { tracking: _tracking, ...mask } = rotoMask();
  return mask;
}

function keyingState(keying: ReturnType<typeof keyingControls> | null, roto: ReturnType<typeof rotoMask> | ReturnType<typeof detachedRotoMask> | null) {
  return { layerId: "plate", layerType: "video", keying, roto, trackingAttached: Boolean(roto && "tracking" in roto && roto.tracking) };
}

function keyingMutation(packageRoot: string, operation: "keying.apply" | "keying.remove" | "roto.upsert" | "roto.tracking.detach" | "roto.remove", state: ReturnType<typeof keyingState>) {
  return {
    packageRoot, package: packageIdentity(), layerId: "plate", changedPaths: ["/layers/0"], state,
    receipt: { schema: "shellx-motion/receipt@1" as const, id: `receipt-${operation}`, packageId: "pkg_sdk", operation, status: "passed" as const, sha256: SHA_C },
    receiptPath: `${packageRoot}/receipts/${operation}.json`, warnings: [],
  };
}

function compositingGraph() {
  return {
    schema: "shellx-motion/compositing-graph@1" as const,
    id: "hero",
    nodes: [
      { id: "source", type: "source" as const, layerId: "plate" },
      { id: "blur", type: "blur" as const, radius: 4 },
      { id: "output", type: "output" as const },
    ],
    edges: [
      { id: "source_blur", from: { nodeId: "source", port: "output" as const }, to: { nodeId: "blur", port: "input" as const } },
      { id: "blur_output", from: { nodeId: "blur", port: "output" as const }, to: { nodeId: "output", port: "input" as const } },
    ],
  };
}

function compositingState(compiled: boolean) {
  if (!compiled) {
    return { graph: null, compiled: false, metadata: null, validation: null, fingerprint: null };
  }
  const graph = compositingGraph();
  const fingerprint = compositingGraphFingerprint(graph);
  const estimate = {
    nodeCount: 3,
    edgeCount: 2,
    sourceCount: 1,
    maxDepth: 3,
    maxFanOut: 1,
    pixelOperations: 1.5,
    workingBytes: 16,
  };
  return {
    graph,
    compiled: true,
    metadata: {
      schema: "shellx-motion/compositing-compile@1" as const,
      graphId: "hero",
      fingerprint,
      nodeOrder: ["source", "blur", "output"],
      sourceLayerIds: ["plate"],
      outputLayerIds: ["cg.hero.blur"],
      estimate,
    },
    validation: { ok: true, issues: [], order: ["source", "blur", "output"], estimate },
    fingerprint,
  };
}

function compositingMutation(
  packageRoot: string,
  operation: "compositing.graph.set" | "compositing.graph.remove",
  state: ReturnType<typeof compositingState>,
) {
  return {
    packageRoot,
    package: packageIdentity(),
    changedPaths: ["/compositing", "/layers", "/x-compositing-compile"],
    state,
    receipt: {
      schema: "shellx-motion/receipt@1" as const,
      id: `receipt-${operation}`,
      packageId: "pkg_sdk",
      operation,
      status: "passed" as const,
      path: `${packageRoot}/receipts/${operation}.json`,
      sha256: SHA_C,
    },
    receiptPath: `${packageRoot}/receipts/${operation}.json`,
    warnings: [],
  };
}

function playerSource(): MotionPlayerSource {
  return { schema: "shellx-motion/player-source@1", uri: "http://127.0.0.1:5757/motion-artifact/artifact-sdk-1", durationMs: 2_000, artifact: artifactIdentity() };
}
