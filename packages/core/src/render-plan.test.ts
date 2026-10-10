import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createMotionRenderPlan,
  motionRenderPlanFingerprint,
  parseMotionRenderPlan,
  serializeMotionRenderPlan,
  type MotionRenderPlanInput
} from "./render-plan";
import { canonicalJsonSha256 } from "./canonical-json";
import { validateAgainstPublishedSchema, type JsonSchemaDocument } from "./published-schema-check";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const HASH_E = "e".repeat(64);
const HASH_F = "f".repeat(64);
const RENDER_PLAN_SCHEMA = JSON.parse(readFileSync(new URL("../../../schemas/render-plan.schema.json", import.meta.url), "utf8")) as JsonSchemaDocument;

export function renderPlanInput(overrides: Partial<MotionRenderPlanInput> = {}): MotionRenderPlanInput {
  return {
    package: { id: "pkg_demo", manifestSha256: HASH_A },
    motion: { id: "motion_demo", documentSha256: HASH_B },
    lineage: { schema: "shellx-motion/package-render-lineage@1", manifestSha256: HASH_A, motionSha256: HASH_B },
    output: { preset: "mp4-h264", mediaRole: "final-video", intentSha256: HASH_C },
    quality: { mode: "none" },
    requested: { lane: "ffmpeg", frameLane: "gpu", delivery: "streamed", segmented: null, fallback: "none" },
    runtime: { engine: "ffmpeg@7.1", routeFingerprint: HASH_D, presetFingerprint: HASH_E, capabilityFingerprint: HASH_F },
    compatibility: { version: 1, state: "current" },
    ...overrides
  };
}

function historicalV2(overrides: { capability?: Record<string, unknown> } = {}): Record<string, unknown> {
  const v1 = createMotionRenderPlan(renderPlanInput());
  const { capabilityFingerprint: _opaqueCapabilityFingerprint, ...runtime } = v1.runtime;
  const { fingerprint: _v1Fingerprint, ...v1Content } = v1;
  const capability = overrides.capability ?? {
      schema: "shellx-motion/render-capability-snapshot@1",
      tools: {
        ffmpeg: { source: "shellx-family", executableSha256: HASH_A, versionSha256: HASH_B, configurationSha256: HASH_C, filtersSha256: HASH_D, encodersSha256: HASH_E },
        ffprobe: { source: "shellx-family", executableSha256: HASH_F, versionSha256: HASH_A, configurationSha256: HASH_B }
      },
      filterGraph: { schema: "shellx-motion/ffmpeg-filter-graph-contract@1", sha256: HASH_C, requiredFilters: [] },
      encoder: { attempts: [{ source: "hardware", encoder: "h264_nvenc" }, { source: "software", encoder: "libx264" }], fallback: "hardware-to-software" },
      implementation: { frameLane: "gpu", renderer: "renderer-browser-gpu-streamed-final@1", launch: "precontained-direct-chromium", adapterFingerprint: HASH_D, containment: "precontained-direct-chromium@1" }
  };
  const content = {
    ...v1Content,
    schema: "shellx-motion/render-plan@2",
    runtime,
    capability,
    compatibility: { version: 2, state: "current" }
  };
  return { ...content, fingerprint: canonicalJsonSha256(content) };
}

describe("MotionRenderPlan", () => {
  it("uses the same fingerprint for semantically identical data built in a different key order", () => {
    const ordinary = renderPlanInput();
    const reordered: MotionRenderPlanInput = {
      compatibility: { state: "current", version: 1 },
      runtime: { capabilityFingerprint: HASH_F, presetFingerprint: HASH_E, routeFingerprint: HASH_D, engine: "ffmpeg@7.1" },
      requested: { fallback: "none", segmented: null, delivery: "streamed", frameLane: "gpu", lane: "ffmpeg" },
      output: { intentSha256: HASH_C, mediaRole: "final-video", preset: "mp4-h264" },
      quality: { mode: "none" },
      lineage: { motionSha256: HASH_B, manifestSha256: HASH_A, schema: "shellx-motion/package-render-lineage@1" },
      motion: { documentSha256: HASH_B, id: "motion_demo" },
      package: { manifestSha256: HASH_A, id: "pkg_demo" }
    };
    const first = createMotionRenderPlan(ordinary);
    const second = createMotionRenderPlan(reordered);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(motionRenderPlanFingerprint(first)).toBe(first.fingerprint);
    expect(serializeMotionRenderPlan(second)).toBe(serializeMotionRenderPlan(first));
  });

  it("changes its fingerprint for every mutable bound identity and route choice", () => {
    const baseline = createMotionRenderPlan(renderPlanInput());
    const variants: MotionRenderPlanInput[] = [
      renderPlanInput({ package: { id: "pkg_other", manifestSha256: HASH_A } }),
      renderPlanInput({ package: { id: "pkg_demo", manifestSha256: HASH_C }, lineage: { schema: "shellx-motion/package-render-lineage@1", manifestSha256: HASH_C, motionSha256: HASH_B } }),
      renderPlanInput({ motion: { id: "motion_other", documentSha256: HASH_B } }),
      renderPlanInput({ motion: { id: "motion_demo", documentSha256: HASH_C }, lineage: { schema: "shellx-motion/package-render-lineage@1", manifestSha256: HASH_A, motionSha256: HASH_C } }),
      renderPlanInput({ lineage: { schema: "shellx-motion/package-render-lineage@1", manifestSha256: HASH_A, motionSha256: HASH_B, adapterId: "adapter.gltf", sourceSha256: HASH_C, normalizedSourceSha256: HASH_D, loweringReceiptSha256: HASH_E } }),
      renderPlanInput({ output: { preset: "webm-vp9-alpha", mediaRole: "final-video", intentSha256: HASH_C } }),
      renderPlanInput({ output: { preset: "mp4-h264", mediaRole: "final-video", intentSha256: HASH_D } }),
      renderPlanInput({ requested: { lane: "ffmpeg", frameLane: "browser", delivery: "streamed", segmented: null, fallback: "none" } }),
      renderPlanInput({ requested: { lane: "ffmpeg", frameLane: "gpu", delivery: "segmented", segmented: { segmentFrames: 120, resume: true }, fallback: "none" } }),
      renderPlanInput({ runtime: { engine: "ffmpeg@7.2", routeFingerprint: HASH_D, presetFingerprint: HASH_E, capabilityFingerprint: HASH_F } }),
      renderPlanInput({ runtime: { engine: "ffmpeg@7.1", routeFingerprint: HASH_C, presetFingerprint: HASH_E, capabilityFingerprint: HASH_F } }),
      renderPlanInput({ runtime: { engine: "ffmpeg@7.1", routeFingerprint: HASH_D, presetFingerprint: HASH_C, capabilityFingerprint: HASH_F } }),
      renderPlanInput({ runtime: { engine: "ffmpeg@7.1", routeFingerprint: HASH_D, presetFingerprint: HASH_E, capabilityFingerprint: HASH_C } })
    ];
    for (const variant of variants) expect(createMotionRenderPlan(variant).fingerprint).not.toBe(baseline.fingerprint);
  });

  it("refuses unknown, inherited, path-like, secret-bearing, and tampered values", () => {
    const plan = createMotionRenderPlan(renderPlanInput());
    expect(() => parseMotionRenderPlan({ ...plan, executor: "never" })).toThrow(/unknown field/i);
    expect(() => createMotionRenderPlan(renderPlanInput({ package: { id: "/tmp/package", manifestSha256: HASH_A } }))).toThrow(/path/i);
    expect(() => createMotionRenderPlan(renderPlanInput({ runtime: { engine: "secret-token", routeFingerprint: HASH_D, presetFingerprint: HASH_E, capabilityFingerprint: HASH_F } }))).toThrow(/secret/i);
    const inherited = Object.assign(Object.create({ inherited: true }), plan);
    expect(() => parseMotionRenderPlan(inherited)).toThrow(/plain object/i);
    expect(() => parseMotionRenderPlan({ ...plan, fingerprint: HASH_B })).toThrow(/fingerprint/i);
    expect(() => createMotionRenderPlan(renderPlanInput({ quality: { mode: "manifest" } as never }))).toThrow(/quality mode/i);
    expect(() => createMotionRenderPlan(renderPlanInput({ requested: { lane: "ffmpeg", frameLane: "gpu", delivery: "streamed", segmented: { segmentFrames: 10, resume: false }, fallback: "none" } }))).toThrow(/segmented intent/i);
  });

  it("keeps the published schema aligned with path-free opaque runtime fields", () => {
    const plan = createMotionRenderPlan(renderPlanInput());
    expect(validateAgainstPublishedSchema(RENDER_PLAN_SCHEMA, plan)).toEqual([]);
    expect(validateAgainstPublishedSchema(RENDER_PLAN_SCHEMA, { ...plan, runtime: { ...plan.runtime, engine: "secret-token" } })).not.toEqual([]);
    expect(validateAgainstPublishedSchema(RENDER_PLAN_SCHEMA, { ...plan, package: { ...plan.package, id: "Secret-Package" } })).not.toEqual([]);
  });

  it("returns a deeply frozen plan with an explicit path-free output intent", () => {
    const plan = createMotionRenderPlan(renderPlanInput());
    expect(plan.output.intentSha256).toBe(HASH_C);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.package)).toBe(true);
    expect(Object.isFrozen(plan.requested)).toBe(true);
    expect(Object.isFrozen(plan.quality)).toBe(true);
    expect(Object.isFrozen(plan.runtime)).toBe(true);
  });

  it("keeps historical V1 readable while V2 serializes a closed capability snapshot", () => {
    const historical = createMotionRenderPlan(renderPlanInput());
    const current = historicalV2();
    expect(parseMotionRenderPlan(JSON.parse(serializeMotionRenderPlan(historical)))).toMatchObject({ schema: "shellx-motion/render-plan@1", fingerprint: historical.fingerprint });
    expect(parseMotionRenderPlan(JSON.parse(serializeMotionRenderPlan(current as never)))).toMatchObject({
      schema: "shellx-motion/render-plan@2",
      capability: {
        tools: { ffmpeg: { executableSha256: HASH_A }, ffprobe: { executableSha256: HASH_F } },
        encoder: { attempts: [{ source: "hardware", encoder: "h264_nvenc" }, { source: "software", encoder: "libx264" }], fallback: "hardware-to-software" },
        implementation: { frameLane: "gpu", adapterFingerprint: HASH_D }
      }
    });
    const parsed = parseMotionRenderPlan(current);
    if (parsed.schema !== "shellx-motion/render-plan@2") throw new Error("Expected V2 plan.");
    expect(Object.isFrozen(parsed.capability)).toBe(true);
    expect(parsed.runtime).not.toHaveProperty("capabilityFingerprint");
  });

  it("refuses capability drift, inconsistent lanes, and unordered fallback claims in historical V2", () => {
    const plan = historicalV2();
    const capability = plan.capability as { tools: { ffmpeg: Record<string, unknown>; ffprobe: Record<string, unknown> }; implementation: Record<string, unknown> } & Record<string, unknown>;
    expect(() => parseMotionRenderPlan({ ...plan, capability: { ...capability, tools: { ...capability.tools, ffmpeg: { ...capability.tools.ffmpeg, executableSha256: HASH_F } } } })).toThrow(/fingerprint/i);
    const laneMismatch = historicalV2({ capability: { ...capability, implementation: { ...capability.implementation, frameLane: "native" } } });
    expect(() => parseMotionRenderPlan(laneMismatch)).toThrow(/frame lane/i);
    const unordered = historicalV2({ capability: { ...capability, encoder: { attempts: [{ source: "software", encoder: "libx264" }, { source: "hardware", encoder: "h264_nvenc" }], fallback: "hardware-to-software" } } });
    expect(() => parseMotionRenderPlan(unordered)).toThrow(/fallback/i);
  });
});
