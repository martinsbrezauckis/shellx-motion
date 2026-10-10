/** Read-only historical render-plan@2 parsing. No active plan constructor lives here. */
import { canonicalJsonSha256 } from "./canonical-json";
import { boundedInteger, closedRecord, closedRecordWithOptional, opaqueText, sha256 } from "./lifecycle-envelope-validation";
import { validatePackageRenderLineage, type PackageRenderLineage } from "./package-render-lineage";
import type { MotionRenderFrameLane, MotionRenderPlanSegmentedIntent, MotionRenderPlanV1 } from "./render-plan";

export const MOTION_RENDER_PLAN_V2_SCHEMA = "shellx-motion/render-plan@2" as const;

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const PRESET_ID = /^[a-z][a-z0-9-]{0,63}$/u;
const ENGINE_ID = /^[A-Za-z0-9][A-Za-z0-9._+@-]{0,127}$/u;

export interface MotionRenderCapabilitySnapshot {
  readonly schema: "shellx-motion/render-capability-snapshot@1";
  readonly tools: Readonly<{
    ffmpeg: Readonly<{ source: "path" | "override" | "shellx-family"; executableSha256: string; versionSha256: string; configurationSha256: string; filtersSha256: string; encodersSha256: string }>;
    ffprobe: Readonly<{ source: "path" | "override" | "shellx-family"; executableSha256: string; versionSha256: string; configurationSha256: string }>;
  }>;
  readonly filterGraph: Readonly<{ schema: "shellx-motion/ffmpeg-filter-graph-contract@1"; sha256: string; requiredFilters: readonly string[] }>;
  readonly encoder: Readonly<{ attempts: readonly Readonly<{ source: "hardware" | "software"; encoder: string }>[]; fallback: "hardware-to-software" | "none" }>;
  readonly implementation: Readonly<{ frameLane: MotionRenderFrameLane; renderer: string; launch: string; adapterFingerprint: string | null; containment: string }>;
}

/** V2 is readable history only until every executor has a live private authority. */
export interface MotionRenderPlanV2 extends Omit<MotionRenderPlanV1, "schema" | "runtime" | "compatibility" | "fingerprint"> {
  readonly schema: typeof MOTION_RENDER_PLAN_V2_SCHEMA;
  /** The closed snapshot replaces V1's opaque runtime capability fingerprint. */
  readonly runtime: Readonly<{ engine: string; routeFingerprint: string; presetFingerprint: string }>;
  readonly capability: MotionRenderCapabilitySnapshot;
  readonly compatibility: Readonly<{ version: 2; state: "current" }>;
  readonly fingerprint: string;
}

type MotionRenderPlanV2Content = Omit<MotionRenderPlanV2, "fingerprint">;

export function parseMotionRenderPlanV2(value: unknown): MotionRenderPlanV2 {
  const record = closedRecord(value, [
    "schema", "operation", "package", "motion", "lineage", "output", "quality", "requested", "runtime", "capability", "compatibility", "fingerprint"
  ], "Render plan V2");
  if (record.schema !== MOTION_RENDER_PLAN_V2_SCHEMA) throw new Error("Unsupported render plan schema.");
  if (record.operation !== "render.final") throw new Error("Render plan operation must be render.final.");
  const packageIdentity = parsePackage(record.package);
  const motionIdentity = parseMotion(record.motion);
  const lineage = parseLineage(record.lineage);
  if (packageIdentity.manifestSha256 !== lineage.manifestSha256) throw new Error("Render plan package manifestSha256 must match its lineage.");
  if (motionIdentity.documentSha256 !== lineage.motionSha256) throw new Error("Render plan documentSha256 must match its lineage motionSha256.");
  const requested = parseRequested(record.requested);
  const capability = parseCapability(record.capability);
  if (capability.implementation.frameLane !== requested.frameLane) throw new Error("Render capability implementation frame lane must match the requested render lane.");
  const content: MotionRenderPlanV2Content = {
    schema: MOTION_RENDER_PLAN_V2_SCHEMA,
    operation: "render.final",
    package: packageIdentity,
    motion: motionIdentity,
    lineage,
    output: parseOutput(record.output),
    quality: parseQuality(record.quality),
    requested,
    runtime: parseRuntime(record.runtime),
    capability,
    compatibility: parseCompatibility(record.compatibility)
  };
  const fingerprint = sha256(record.fingerprint, "Render plan V2 fingerprint");
  if (fingerprint !== canonicalJsonSha256(content)) throw new Error("Render plan V2 fingerprint does not match its canonical content.");
  return freezePlan({ ...content, fingerprint });
}

function parseCapability(value: unknown): MotionRenderCapabilitySnapshot {
  const record = closedRecord(value, ["schema", "tools", "filterGraph", "encoder", "implementation"], "Render capability snapshot");
  if (record.schema !== "shellx-motion/render-capability-snapshot@1") throw new Error("Unsupported render capability snapshot schema.");
  const tools = closedRecord(record.tools, ["ffmpeg", "ffprobe"], "Render capability tools");
  const filterGraph = closedRecord(record.filterGraph, ["schema", "sha256", "requiredFilters"], "Render capability filter graph");
  if (filterGraph.schema !== "shellx-motion/ffmpeg-filter-graph-contract@1" || !Array.isArray(filterGraph.requiredFilters) || filterGraph.requiredFilters.length > 32) throw new Error("Render capability filter graph is invalid.");
  const requiredFilters = filterGraph.requiredFilters.map((item) => opaqueText(item, "Render capability filter", 1, 64, PRESET_ID));
  if (new Set(requiredFilters).size !== requiredFilters.length) throw new Error("Render capability filters must be unique.");
  const encoder = parseEncoder(record.encoder);
  const implementation = parseImplementation(record.implementation);
  return Object.freeze({
    schema: "shellx-motion/render-capability-snapshot@1",
    tools: Object.freeze({ ffmpeg: parseFfmpegTool(tools.ffmpeg), ffprobe: parseFfprobeTool(tools.ffprobe) }),
    filterGraph: Object.freeze({ schema: "shellx-motion/ffmpeg-filter-graph-contract@1", sha256: sha256(filterGraph.sha256, "Render capability filter graph sha256"), requiredFilters: Object.freeze(requiredFilters) }),
    encoder,
    implementation
  });
}

function parseFfmpegTool(value: unknown): MotionRenderCapabilitySnapshot["tools"]["ffmpeg"] {
  const record = closedRecord(value, ["source", "executableSha256", "versionSha256", "configurationSha256", "filtersSha256", "encodersSha256"], "FFmpeg capability identity");
  const base = parseToolBase(record);
  return Object.freeze({ ...base, filtersSha256: sha256(record.filtersSha256, "Render capability filters sha256"), encodersSha256: sha256(record.encodersSha256, "Render capability encoders sha256") });
}

function parseFfprobeTool(value: unknown): MotionRenderCapabilitySnapshot["tools"]["ffprobe"] {
  const record = closedRecord(value, ["source", "executableSha256", "versionSha256", "configurationSha256"], "FFprobe capability identity");
  return Object.freeze(parseToolBase(record));
}

function parseToolBase(record: Record<string, unknown>) {
  if (record.source !== "path" && record.source !== "override" && record.source !== "shellx-family") throw new Error("Render capability tool source is invalid.");
  return {
    source: record.source,
    executableSha256: sha256(record.executableSha256, "Render capability executable sha256"),
    versionSha256: sha256(record.versionSha256, "Render capability version sha256"),
    configurationSha256: sha256(record.configurationSha256, "Render capability configuration sha256")
  } as const;
}

function parseEncoder(value: unknown): MotionRenderCapabilitySnapshot["encoder"] {
  const record = closedRecord(value, ["attempts", "fallback"], "Render capability encoder");
  if (!Array.isArray(record.attempts) || record.attempts.length < 1 || record.attempts.length > 8) throw new Error("Render capability encoder attempts are invalid.");
  const attempts = record.attempts.map((attempt) => {
    const parsed = closedRecord(attempt, ["source", "encoder"], "Render capability encoder attempt");
    if (parsed.source !== "hardware" && parsed.source !== "software") throw new Error("Render capability encoder source is invalid.");
    return Object.freeze({ source: parsed.source, encoder: opaqueText(parsed.encoder, "Render capability encoder", 1, 128, ENGINE_ID) });
  });
  if (record.fallback !== "hardware-to-software" && record.fallback !== "none") throw new Error("Render capability fallback is invalid.");
  if ((record.fallback === "hardware-to-software") !== (attempts.length === 2 && attempts[0]!.source === "hardware" && attempts[1]!.source === "software")) throw new Error("Render capability fallback does not match ordered encoder attempts.");
  return Object.freeze({ attempts: Object.freeze(attempts), fallback: record.fallback });
}

function parseImplementation(value: unknown): MotionRenderCapabilitySnapshot["implementation"] {
  const record = closedRecord(value, ["frameLane", "renderer", "launch", "adapterFingerprint", "containment"], "Render capability implementation");
  if (record.frameLane !== "browser" && record.frameLane !== "native" && record.frameLane !== "gpu") throw new Error("Render capability implementation frame lane is invalid.");
  if (record.adapterFingerprint !== null && typeof record.adapterFingerprint !== "string") throw new Error("Render capability adapter identity is invalid.");
  return Object.freeze({
    frameLane: record.frameLane,
    renderer: opaqueText(record.renderer, "Render capability renderer", 1, 128, ENGINE_ID),
    launch: opaqueText(record.launch, "Render capability launch", 1, 128, ENGINE_ID),
    adapterFingerprint: record.adapterFingerprint === null ? null : sha256(record.adapterFingerprint, "Render capability adapter fingerprint"),
    containment: opaqueText(record.containment, "Render capability containment", 1, 128, ENGINE_ID)
  });
}

function parsePackage(value: unknown) {
  const record = closedRecord(value, ["id", "manifestSha256"], "Render plan package");
  return { id: opaqueText(record.id, "Render plan package id", 1, 128, OPAQUE_ID), manifestSha256: sha256(record.manifestSha256, "Render plan package manifestSha256") };
}

function parseMotion(value: unknown) {
  const record = closedRecord(value, ["id", "documentSha256"], "Render plan motion");
  return { id: opaqueText(record.id, "Render plan motion id", 1, 128, OPAQUE_ID), documentSha256: sha256(record.documentSha256, "Render plan documentSha256") };
}

function parseLineage(value: unknown): PackageRenderLineage {
  const record = closedRecordWithOptional(value, ["schema", "manifestSha256", "motionSha256"], ["adapterId", "sourceSha256", "normalizedSourceSha256", "loweringReceiptSha256"], "Render plan lineage");
  validatePackageRenderLineage(record);
  if (record.adapterId === undefined) {
    if (record.sourceSha256 !== undefined || record.normalizedSourceSha256 !== undefined || record.loweringReceiptSha256 !== undefined) throw new Error("Render plan lineage source hashes require adapter.gltf.");
    return Object.freeze({ schema: "shellx-motion/package-render-lineage@1", manifestSha256: sha256(record.manifestSha256, "Render plan lineage manifestSha256"), motionSha256: sha256(record.motionSha256, "Render plan lineage motionSha256") });
  }
  if (record.adapterId !== "adapter.gltf") throw new Error("Render plan lineage adapterId is unsupported.");
  return Object.freeze({
    schema: "shellx-motion/package-render-lineage@1",
    manifestSha256: sha256(record.manifestSha256, "Render plan lineage manifestSha256"),
    motionSha256: sha256(record.motionSha256, "Render plan lineage motionSha256"),
    adapterId: record.adapterId,
    sourceSha256: sha256(record.sourceSha256, "Render plan lineage sourceSha256"),
    normalizedSourceSha256: sha256(record.normalizedSourceSha256, "Render plan lineage normalizedSourceSha256"),
    loweringReceiptSha256: sha256(record.loweringReceiptSha256, "Render plan lineage loweringReceiptSha256")
  });
}

function parseOutput(value: unknown) {
  const record = closedRecord(value, ["preset", "mediaRole", "intentSha256"], "Render plan output");
  if (record.mediaRole !== "final-video") throw new Error("Render plan mediaRole must be final-video.");
  return { preset: opaqueText(record.preset, "Render plan preset", 1, 64, PRESET_ID), mediaRole: "final-video" as const, intentSha256: sha256(record.intentSha256, "Render plan output intentSha256") };
}

function parseQuality(value: unknown) {
  const record = closedRecord(value, ["mode"], "Render plan quality");
  if (record.mode !== "none") throw new Error("Render plan quality mode must be none for V1 coordinated final-video jobs.");
  return Object.freeze({ mode: "none" as const });
}

function parseRequested(value: unknown): MotionRenderPlanV1["requested"] {
  const record = closedRecord(value, ["lane", "frameLane", "delivery", "segmented", "fallback"], "Render plan requested route");
  if (record.lane !== "ffmpeg") throw new Error("Render plan lane must be ffmpeg.");
  if (record.frameLane !== "browser" && record.frameLane !== "native" && record.frameLane !== "gpu") throw new Error("Render plan frameLane is unsupported.");
  if (record.delivery !== "streamed" && record.delivery !== "segmented") throw new Error("Render plan delivery is unsupported.");
  if (record.fallback !== "none") throw new Error("Render plan fallback must be none.");
  const segmented = parseSegmented(record.segmented);
  if ((record.delivery === "streamed" && segmented !== null) || (record.delivery === "segmented" && segmented === null)) throw new Error("Render plan segmented intent must match its delivery.");
  return Object.freeze({ lane: "ffmpeg", frameLane: record.frameLane, delivery: record.delivery, segmented, fallback: "none" });
}

function parseSegmented(value: unknown): MotionRenderPlanSegmentedIntent | null {
  if (value === null) return null;
  const record = closedRecord(value, ["segmentFrames", "resume"], "Render plan segmented intent");
  if (typeof record.resume !== "boolean") throw new Error("Render plan segmented resume must be boolean.");
  return Object.freeze({ segmentFrames: boundedInteger(record.segmentFrames, "Render plan segmentFrames", 1, 1_000_000), resume: record.resume });
}

function parseRuntime(value: unknown): MotionRenderPlanV2["runtime"] {
  const record = closedRecord(value, ["engine", "routeFingerprint", "presetFingerprint"], "Render plan V2 runtime");
  return Object.freeze({ engine: opaqueText(record.engine, "Render plan engine", 1, 128, ENGINE_ID), routeFingerprint: sha256(record.routeFingerprint, "Render plan routeFingerprint"), presetFingerprint: sha256(record.presetFingerprint, "Render plan presetFingerprint") });
}

function parseCompatibility(value: unknown): MotionRenderPlanV2["compatibility"] {
  const record = closedRecord(value, ["version", "state"], "Render plan V2 compatibility");
  if (record.version !== 2 || record.state !== "current") throw new Error("Render plan V2 compatibility must be version 2 in current state.");
  return Object.freeze({ version: 2, state: "current" });
}

function freezePlan(value: MotionRenderPlanV2): MotionRenderPlanV2 {
  return Object.freeze({
    ...value,
    package: Object.freeze({ ...value.package }), motion: Object.freeze({ ...value.motion }), lineage: Object.freeze({ ...value.lineage }), output: Object.freeze({ ...value.output }), quality: Object.freeze({ ...value.quality }),
    requested: Object.freeze({ ...value.requested, segmented: value.requested.segmented === null ? null : Object.freeze({ ...value.requested.segmented }) }),
    runtime: Object.freeze({ ...value.runtime }),
    capability: Object.freeze({
      ...value.capability,
      tools: Object.freeze({ ffmpeg: Object.freeze({ ...value.capability.tools.ffmpeg }), ffprobe: Object.freeze({ ...value.capability.tools.ffprobe }) }),
      filterGraph: Object.freeze({ ...value.capability.filterGraph, requiredFilters: Object.freeze([...value.capability.filterGraph.requiredFilters]) }),
      encoder: Object.freeze({ attempts: Object.freeze(value.capability.encoder.attempts.map((attempt) => Object.freeze({ ...attempt }))), fallback: value.capability.encoder.fallback }),
      implementation: Object.freeze({ ...value.capability.implementation })
    }),
    compatibility: Object.freeze({ version: 2, state: "current" })
  });
}
