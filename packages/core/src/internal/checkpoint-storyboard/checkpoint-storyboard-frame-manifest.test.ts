import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalJson, canonicalJsonSha256 } from "../../canonical-json";
import { appendFrameCheckpointOutputHashes, createFrameCheckpointManifest, readFrameCheckpointManifest } from "./checkpoint-storyboard-frame-manifest-compile";
import { readFrameCheckpointManifestRequest, readFrameCheckpointOutputAppend } from "./checkpoint-storyboard-frame-manifest-read";
import {
  FRAME_CHECKPOINT_EVALUATOR_VERSION,
  FRAME_CHECKPOINT_MANIFEST_LIMITS,
  FRAME_CHECKPOINT_MANIFEST_REQUEST_SCHEMA,
  FRAME_CHECKPOINT_MANIFEST_SCHEMA,
  FRAME_CHECKPOINT_OUTPUT_APPEND_SCHEMA,
} from "./checkpoint-storyboard-frame-manifest-types";

const H = (digit: string) => digit.repeat(64);
function request(): any {
  return {
    schema: FRAME_CHECKPOINT_MANIFEST_REQUEST_SCHEMA,
    evaluatorVersion: FRAME_CHECKPOINT_EVALUATOR_VERSION,
    seed: 17,
    rate: { numerator: 30_000, denominator: 1_001 },
    totalFrameCount: 6,
    frameRange: { startFrameIndex: 1, frameCount: 4 },
    inputs: [{ inputId: "package", sha256: H("a") }, { inputId: "storyboard", sha256: H("b") }],
    checkpoints: [
      { checkpointId: "start", atUs: 0, sha256: H("c") },
      { checkpointId: "beat-a", atUs: 33_370, sha256: H("d") },
      { checkpointId: "beat-b", atUs: 100_100, sha256: H("e") },
    ],
  };
}
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

describe("private deterministic frame/checkpoint manifest", () => {
  it("derives rational frame times, exact checkpoint offsets, input identity, and one bounded window", () => {
    const input = request(), before = canonicalJson(input);
    const first = createFrameCheckpointManifest(input);
    expect(canonicalJson(input)).toBe(before);
    expect(readFrameCheckpointManifestRequest(clone(input))).toEqual(input);
    expect(createFrameCheckpointManifest(clone(input))).toEqual(first);
    expect(first).toMatchObject({
      schema: FRAME_CHECKPOINT_MANIFEST_SCHEMA,
      evaluatorVersion: FRAME_CHECKPOINT_EVALUATOR_VERSION,
      seed: 17,
      rate: { numerator: 30_000, denominator: 1_001 },
      totalFrameCount: 6,
      frameRange: { startFrameIndex: 1, frameCount: 4 },
      outputHashRange: { startFrameIndex: 1, entries: [] },
      resume: { completedFrameCount: 0, nextFrameIndex: 1, windowComplete: false },
      revision: 1,
      evidence: { timeMapping: "floor-rational-frame-time-to-microseconds", reducedRationalRate: true, exactInputHashes: true, contiguousOutputHashRange: true, noIO: true, noStore: true, noRenderer: true, noFinalMedia: true, noPublicCoreRoot: true },
    });
    expect(first.parentFingerprint).toBeUndefined();
    expect(first.frames).toEqual([
      { frameIndex: 1, atUs: 33_366, checkpointIds: ["beat-a"] },
      { frameIndex: 2, atUs: 66_733, checkpointIds: [] },
      { frameIndex: 3, atUs: 100_100, checkpointIds: ["beat-b"] },
      { frameIndex: 4, atUs: 133_466, checkpointIds: [] },
    ]);
    expect(first.checkpoints).toEqual([
      { checkpointId: "start", atUs: 0, sha256: H("c"), frameIndex: 0, frameAtUs: 0, offsetUs: 0 },
      { checkpointId: "beat-a", atUs: 33_370, sha256: H("d"), frameIndex: 1, frameAtUs: 33_366, offsetUs: 4 },
      { checkpointId: "beat-b", atUs: 100_100, sha256: H("e"), frameIndex: 3, frameAtUs: 100_100, offsetUs: 0 },
    ]);
    expect(first.inputsSha256).toBe(canonicalJsonSha256({ inputs: input.inputs }));
    expect(first.requestSha256).toBe(canonicalJsonSha256(input));
    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(readFrameCheckpointManifest(clone(first))).toEqual(first);
    expect(Object.isFrozen(first.frames[0]!.checkpointIds)).toBe(true);
  });

  it("appends only the exact contiguous output prefix and produces immutable resumable revisions", () => {
    const first = createFrameCheckpointManifest(request());
    const second = appendFrameCheckpointOutputHashes(first, { schema: FRAME_CHECKPOINT_OUTPUT_APPEND_SCHEMA, entries: [{ frameIndex: 1, sha256: H("1") }, { frameIndex: 2, sha256: H("2") }] });
    expect(first.outputHashRange.entries).toEqual([]);
    expect(second).toMatchObject({ revision: 2, parentFingerprint: first.fingerprint, outputHashRange: { startFrameIndex: 1, entries: [{ frameIndex: 1, sha256: H("1") }, { frameIndex: 2, sha256: H("2") }] }, resume: { completedFrameCount: 2, nextFrameIndex: 3, windowComplete: false } });
    const complete = appendFrameCheckpointOutputHashes(second, { schema: FRAME_CHECKPOINT_OUTPUT_APPEND_SCHEMA, entries: [{ frameIndex: 3, sha256: H("3") }, { frameIndex: 4, sha256: H("4") }] });
    expect(complete).toMatchObject({ revision: 3, parentFingerprint: second.fingerprint, resume: { completedFrameCount: 4, nextFrameIndex: null, windowComplete: true } });
    expect(complete.outputHashRange.entries.map((entry) => entry.frameIndex)).toEqual([1, 2, 3, 4]);
    expect(readFrameCheckpointManifest(clone(complete))).toEqual(complete);
    expect(() => appendFrameCheckpointOutputHashes(complete, { schema: FRAME_CHECKPOINT_OUTPUT_APPEND_SCHEMA, entries: [{ frameIndex: 5, sha256: H("5") }] })).toThrow("already complete");
  });

  it("refuses skipped, repeated, out-of-window, stale, and tampered output lineage", () => {
    const first = createFrameCheckpointManifest(request());
    for (const append of [
      { schema: FRAME_CHECKPOINT_OUTPUT_APPEND_SCHEMA, entries: [{ frameIndex: 2, sha256: H("1") }] },
      { schema: FRAME_CHECKPOINT_OUTPUT_APPEND_SCHEMA, entries: [{ frameIndex: 1, sha256: H("1") }, { frameIndex: 3, sha256: H("2") }] },
      { schema: FRAME_CHECKPOINT_OUTPUT_APPEND_SCHEMA, entries: Array.from({ length: 5 }, (_entry, index) => ({ frameIndex: index + 1, sha256: H(String((index + 1) % 10)) })) },
    ]) expect(() => appendFrameCheckpointOutputHashes(first, append)).toThrow();

    const second = appendFrameCheckpointOutputHashes(first, { schema: FRAME_CHECKPOINT_OUTPUT_APPEND_SCHEMA, entries: [{ frameIndex: 1, sha256: H("1") }] });
    for (const mutate of [
      (draft: any) => { draft.frames[0].atUs += 1; },
      (draft: any) => { draft.checkpoints[1].offsetUs += 1; },
      (draft: any) => { draft.inputsSha256 = H("f"); },
      (draft: any) => { draft.outputHashRange.entries[0].frameIndex = 2; },
      (draft: any) => { draft.resume.nextFrameIndex = 4; },
      (draft: any) => { draft.parentFingerprint = H("f"); },
      (draft: any) => { draft.revision = 3; },
      (draft: any) => { draft.fingerprint = H("f"); },
    ]) {
      const draft = clone(second); mutate(draft);
      expect(() => readFrameCheckpointManifest(draft)).toThrow();
    }
    const parentOnFirst: any = clone(first); parentOnFirst.parentFingerprint = H("f");
    expect(() => readFrameCheckpointManifest(parentOnFirst)).toThrow("parentFingerprint");
    const noParent: any = clone(second); delete noParent.parentFingerprint;
    expect(() => readFrameCheckpointManifest(noParent)).toThrow("parentFingerprint");
  });

  it("enforces literal evaluator, reduced bounded rate, window, ordered hashes, and checkpoint time grammar", () => {
    for (const [label, mutate] of [
      ["schema", (draft: any) => { draft.schema = "frame-manifest@2"; }],
      ["evaluator", (draft: any) => { draft.evaluatorVersion = "caller-evaluator@1"; }],
      ["seed", (draft: any) => { draft.seed = 0x1_0000_0000; }],
      ["numerator", (draft: any) => { draft.rate.numerator = 240_241; }],
      ["denominator", (draft: any) => { draft.rate.denominator = 1_002; }],
      ["unreduced", (draft: any) => { draft.rate = { numerator: 60, denominator: 2 }; }],
      ["low fps", (draft: any) => { draft.rate = { numerator: 1, denominator: 2 }; }],
      ["high fps", (draft: any) => { draft.rate = { numerator: 241, denominator: 1 }; }],
      ["total frames", (draft: any) => { draft.totalFrameCount = 3_601; }],
      ["window start", (draft: any) => { draft.frameRange.startFrameIndex = 6; }],
      ["window count", (draft: any) => { draft.frameRange.frameCount = 65; }],
      ["window extent", (draft: any) => { draft.frameRange = { startFrameIndex: 5, frameCount: 2 }; }],
      ["inputs empty", (draft: any) => { draft.inputs = []; }],
      ["input order", (draft: any) => { draft.inputs.reverse(); }],
      ["input hash", (draft: any) => { draft.inputs[0].sha256 = "A".repeat(64); }],
      ["checkpoints empty", (draft: any) => { draft.checkpoints = []; }],
      ["checkpoint start", (draft: any) => { draft.checkpoints[0].atUs = 1; }],
      ["checkpoint order", (draft: any) => { draft.checkpoints[2].atUs = 30_000; }],
      ["checkpoint duplicate", (draft: any) => { draft.checkpoints[1].checkpointId = "start"; }],
      ["checkpoint duration", (draft: any) => { draft.checkpoints[2].atUs = 200_000; }],
      ["checkpoint hash", (draft: any) => { draft.checkpoints[0].sha256 = "no"; }],
      ["unknown script", (draft: any) => { draft.script = "return globalThis"; }],
    ] as const) {
      const draft = request(); mutate(draft);
      expect(() => readFrameCheckpointManifestRequest(draft), label).toThrow();
    }
    const signedZero = request(); signedZero.seed = -0; signedZero.frameRange.startFrameIndex = -0; signedZero.checkpoints[0].atUs = -0;
    const normalized = readFrameCheckpointManifestRequest(signedZero);
    expect(Object.is(normalized.seed, -0)).toBe(false);
    expect(Object.is(normalized.frameRange.startFrameIndex, -0)).toBe(false);
    expect(Object.is(normalized.checkpoints[0]!.atUs, -0)).toBe(false);

    expect(readFrameCheckpointOutputAppend({ schema: FRAME_CHECKPOINT_OUTPUT_APPEND_SCHEMA, entries: [{ frameIndex: 0, sha256: H("0") }] })).toEqual({ schema: FRAME_CHECKPOINT_OUTPUT_APPEND_SCHEMA, entries: [{ frameIndex: 0, sha256: H("0") }] });
    for (const append of [
      { schema: "wrong", entries: [{ frameIndex: 0, sha256: H("0") }] },
      { schema: FRAME_CHECKPOINT_OUTPUT_APPEND_SCHEMA, entries: [] },
      { schema: FRAME_CHECKPOINT_OUTPUT_APPEND_SCHEMA, entries: [{ frameIndex: 0.5, sha256: H("0") }] },
      { schema: FRAME_CHECKPOINT_OUTPUT_APPEND_SCHEMA, entries: [{ frameIndex: 0, sha256: "A".repeat(64) }] },
      { schema: FRAME_CHECKPOINT_OUTPUT_APPEND_SCHEMA, entries: [{ frameIndex: 0, sha256: H("0"), path: "/tmp/out" }] },
    ]) expect(() => readFrameCheckpointOutputAppend(append)).toThrow();
  });

  it("admits the exact frame, window, input, checkpoint, and output-hash ceilings", () => {
    const maximum = request();
    maximum.rate = { numerator: 1, denominator: 1 };
    maximum.totalFrameCount = FRAME_CHECKPOINT_MANIFEST_LIMITS.maxTotalFrames;
    maximum.frameRange = { startFrameIndex: 3_536, frameCount: FRAME_CHECKPOINT_MANIFEST_LIMITS.maxWindowFrames };
    maximum.inputs = Array.from({ length: FRAME_CHECKPOINT_MANIFEST_LIMITS.maxInputs }, (_entry, index) => ({ inputId: `input-${String(index).padStart(2, "0")}`, sha256: H((index % 10).toString()) }));
    maximum.checkpoints = Array.from({ length: FRAME_CHECKPOINT_MANIFEST_LIMITS.maxCheckpoints }, (_entry, index) => ({ checkpointId: `checkpoint-${String(index).padStart(2, "0")}`, atUs: index * 50_000_000, sha256: H((index % 10).toString()) }));
    const first = createFrameCheckpointManifest(maximum);
    expect(first.frames).toHaveLength(64);
    expect(first.checkpoints).toHaveLength(64);
    const complete = appendFrameCheckpointOutputHashes(first, {
      schema: FRAME_CHECKPOINT_OUTPUT_APPEND_SCHEMA,
      entries: Array.from({ length: 64 }, (_entry, index) => ({ frameIndex: 3_536 + index, sha256: H((index % 10).toString()) })),
    });
    expect(complete).toMatchObject({ revision: 2, resume: { completedFrameCount: 64, nextFrameIndex: null, windowComplete: true } });
    expect(readFrameCheckpointManifest(clone(complete))).toEqual(complete);
  });

  it("snapshots hostile data once and exposes only a no-I/O private Core subpath", () => {
    let reads = 0;
    const hostile = request();
    Object.defineProperty(hostile, "seed", { enumerable: true, get() { reads += 1; return 1; } });
    expect(() => createFrameCheckpointManifest(hostile)).toThrow("data field");
    expect(reads).toBe(0);
    const source = [
      readFileSync(new URL("./checkpoint-storyboard-frame-manifest.ts", import.meta.url), "utf8"),
      readFileSync(new URL("./checkpoint-storyboard-frame-manifest-types.ts", import.meta.url), "utf8"),
      readFileSync(new URL("./checkpoint-storyboard-frame-manifest-read.ts", import.meta.url), "utf8"),
      readFileSync(new URL("./checkpoint-storyboard-frame-manifest-compile.ts", import.meta.url), "utf8"),
    ].join("\n");
    expect(source).not.toMatch(/node:(?:fs|path)|\b(?:readFile|writeFile|mkdir|rename)\b/i);
    expect(source).not.toMatch(/from\s+["'][^"']*(?:debug-server|\/cli|connectors?|renderer-)/i);
    const root = readFileSync(new URL("../../index.ts", import.meta.url), "utf8");
    expect(root).not.toContain("checkpoint-storyboard-frame-manifest");
    const manifest = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { exports: Record<string, unknown>; publishConfig: { exports: Record<string, unknown> } };
    expect(manifest.exports["./internal/checkpoint-storyboard-frame-manifest"]).toBe("./src/internal/checkpoint-storyboard/checkpoint-storyboard-frame-manifest.ts");
    expect(manifest.publishConfig.exports).not.toHaveProperty("./internal/checkpoint-storyboard-frame-manifest");
    expect(FRAME_CHECKPOINT_MANIFEST_LIMITS).toEqual({ maxTotalFrames: 3_600, maxWindowFrames: 64, maxInputs: 16, maxCheckpoints: 64, maxOutputHashes: 64, maxRateNumerator: 240_240, maxRateDenominator: 1_001, maxFramesPerSecond: 240 });
  });
});
