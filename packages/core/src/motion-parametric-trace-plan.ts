import { canonicalJson, canonicalJsonSha256 } from "./canonical-json";
import { evaluateMotionParametricTraceDrawer, type MotionParametricTraceAuthority } from "./motion-parametric-trace-evaluate";
import { readMotionParametricTraceDescriptor } from "./motion-parametric-trace-read";
import { MAX_MOTION_PARAMETRIC_TRACE_AGGREGATE_SAMPLES, MOTION_PARAMETRIC_TRACE_PLAN_SCHEMA, type MotionParametricTraceDescriptor, type MotionParametricTraceDrawer, type MotionParametricTracePlan, type MotionParametricTraceRetention, type MotionParametricTraceRetentionWindow, type MotionParametricTraceSample, type MotionParametricTraceTrigonometry } from "./motion-parametric-trace-types";

export type MotionParametricTracePlanResult = { ok: true; plan: MotionParametricTracePlan } | { ok: false; message: string };

/** Compiles immutable C4C geometry evidence only. It invokes no renderer, document write, or package I/O. */
export function compileMotionParametricTracePlan(value: unknown, authority: MotionParametricTraceAuthority = {}): MotionParametricTracePlanResult {
  try {
    const source = readMotionParametricTraceDescriptor(value), schedule = buildSchedule(source);
    const scheduledSampleCount = aggregateSamplePreflight(schedule.length, source.drawers.length, source.caps.aggregate.maxSamples);
    const compiledDrawers = source.drawers.map((drawer, index) => compileDrawer(drawer, index, source, schedule, authority));
    const drawers = compiledDrawers.map(({ trigonometry: _ignored, ...drawer }) => drawer);
    const sampleCount = drawers.reduce((total, drawer) => total + drawer.samples.length, 0);
    if (sampleCount !== scheduledSampleCount) throw new Error("Parametric trace driver did not preserve the admitted schedule.");
    const aggregate = aggregateBudget(compiledDrawers, source);
    let storageBytes = 0;
    let payload = null as unknown as Omit<MotionParametricTracePlan, "fingerprint">;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      payload = {
      schema: MOTION_PARAMETRIC_TRACE_PLAN_SCHEMA,
      sourceSha256: canonicalJsonSha256(source),
      schedule,
      drawers,
      budget: { samples: sampleCount, ...aggregate, storageBytes, peakBytes: storageBytes + aggregate.maxFrameBytes, limits: source.caps },
      evidence: { scheduleSha256: canonicalJsonSha256(schedule), trigonometry: combineTrigonometry(compiledDrawers.map((drawer) => drawer.trigonometry)), noRenderer: true as const, noPixelClaim: true as const },
      };
      const next = Buffer.byteLength(canonicalJson({ ...payload, fingerprint: "0".repeat(64) }), "utf8");
      if (next === storageBytes) break;
      storageBytes = next;
    }
    if (Buffer.byteLength(canonicalJson({ ...payload, fingerprint: "0".repeat(64) }), "utf8") !== storageBytes) throw new Error("Parametric trace storage accounting did not stabilize.");
    if (storageBytes + aggregate.maxFrameBytes > source.caps.aggregate.maxBytes) throw new Error(`Parametric trace aggregate peak bytes exceed ${source.caps.aggregate.maxBytes}.`);
    const fingerprint = canonicalJsonSha256(payload);
    return { ok: true, plan: freeze({ ...payload, fingerprint }) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Parametric trace planning refused." };
  }
}

function compileDrawer(drawer: MotionParametricTraceDrawer, index: number, source: MotionParametricTraceDescriptor, schedule: readonly number[], authority: MotionParametricTraceAuthority) {
  if (schedule.length > source.caps.perDrawer.maxSamples) throw new Error(`Parametric trace drawer ${drawer.id} samples exceed ${source.caps.perDrawer.maxSamples}.`);
  if (drawer.retention.kind === "full-clip" && schedule.length > drawer.retention.maxSamples) throw new Error(`Parametric trace drawer ${drawer.id} full-clip retention exceeds its explicit ${drawer.retention.maxSamples}-sample bound.`);
  const evaluated = evaluateMotionParametricTraceDrawer(drawer, schedule, authority);
  const windowPlan = compileWindows(drawer, evaluated.samples, evaluated.sampleWorkUnits);
  const windows = windowPlan.windows;
  const maxVertices = Math.max(...windows.map((item) => item.vertexCount)), maxWorkUnits = Math.max(...windows.map((item) => item.workUnits)), dynamicBytes = Math.max(...windows.map((item) => item.bytes));
  const dataBytes = Buffer.byteLength(canonicalJson({ id: drawer.id, driver: drawer.driver, output: drawer.output, retention: drawer.retention, samples: evaluated.samples, windows }), "utf8"), peakBytes = dynamicBytes + dataBytes, compileWorkUnits = windows.reduce((total, item) => total + item.workUnits, 0) + windowPlan.retentionWork;
  if (maxVertices > source.caps.perDrawer.maxVertices) throw new Error(`Parametric trace drawer ${drawer.id} vertices exceed ${source.caps.perDrawer.maxVertices}.`);
  if (maxWorkUnits > source.caps.perDrawer.maxWorkUnits) throw new Error(`Parametric trace drawer ${drawer.id} work exceeds ${source.caps.perDrawer.maxWorkUnits}.`);
  if (compileWorkUnits > source.caps.perDrawer.maxWorkUnits) throw new Error(`Parametric trace drawer ${drawer.id} total compile work exceeds ${source.caps.perDrawer.maxWorkUnits}.`);
  if (peakBytes > source.caps.perDrawer.maxBytes) throw new Error(`Parametric trace drawer ${drawer.id} peak bytes exceed ${source.caps.perDrawer.maxBytes}.`);
  return {
    id: drawer.id,
    driver: { kind: drawer.driver.kind, sourceSha256: evaluated.sourceSha256, ...(evaluated.authorityFingerprint ? { authorityFingerprint: evaluated.authorityFingerprint } : {}) },
    output: drawer.output,
    retention: drawer.retention,
    signalDomain: { age: [0, 1] as [0, 1], speed: [0, 1] as [0, 1], drawer: source.drawers.length === 1 ? 0 : index / (source.drawers.length - 1) },
    samples: evaluated.samples,
    windows,
    budget: { samples: evaluated.samples.length, maxVertices, maxWorkUnits, compileWorkUnits, maxFrameBytes: dynamicBytes, dataBytes, peakBytes },
    trigonometry: evaluated.trigonometry,
  };
}

function combineTrigonometry(values: readonly MotionParametricTraceTrigonometry[]): MotionParametricTraceTrigonometry {
  const radians = values.some((value) => value === "quantized-radians@1" || value === "mixed-quantized-radians-and-exact-modular-turns@1");
  const modularTurns = values.some((value) => value === "exact-modular-turns@1" || value === "mixed-quantized-radians-and-exact-modular-turns@1");
  if (radians && modularTurns) return "mixed-quantized-radians-and-exact-modular-turns@1";
  if (radians) return "quantized-radians@1";
  return modularTurns ? "exact-modular-turns@1" : "none";
}

function aggregateBudget(drawers: ReturnType<typeof compileDrawer>[], source: MotionParametricTraceDescriptor): { maxVertices: number; maxWorkUnits: number; compileWorkUnits: number; maxFrameBytes: number } {
  let maxVertices = 0, maxWorkUnits = 0, maxFrameBytes = 0;
  for (let index = 0; index < drawers[0]!.windows.length; index += 1) {
    const frame = drawers.reduce((total, drawer) => ({ vertices: total.vertices + drawer.windows[index]!.vertexCount, work: total.work + drawer.windows[index]!.workUnits, bytes: total.bytes + drawer.windows[index]!.bytes }), { vertices: 0, work: 0, bytes: 0 });
    maxVertices = Math.max(maxVertices, frame.vertices); maxWorkUnits = Math.max(maxWorkUnits, frame.work); maxFrameBytes = Math.max(maxFrameBytes, frame.bytes);
  }
  if (maxVertices > source.caps.aggregate.maxVertices) throw new Error(`Parametric trace aggregate vertices exceed ${source.caps.aggregate.maxVertices}.`);
  if (maxWorkUnits > source.caps.aggregate.maxWorkUnits) throw new Error(`Parametric trace aggregate work exceeds ${source.caps.aggregate.maxWorkUnits}.`);
  const compileWorkUnits = drawers.reduce((total, drawer) => total + drawer.budget.compileWorkUnits, 0);
  if (compileWorkUnits > source.caps.aggregate.maxWorkUnits) throw new Error(`Parametric trace aggregate total compile work exceeds ${source.caps.aggregate.maxWorkUnits}.`);
  return { maxVertices, maxWorkUnits, compileWorkUnits, maxFrameBytes };
}

function buildSchedule(source: MotionParametricTraceDescriptor): number[] {
  const schedule = [0];
  for (let atUs = source.clip.sampleIntervalUs; atUs < source.clip.durationUs; atUs += source.clip.sampleIntervalUs) schedule.push(atUs);
  if (schedule.at(-1) !== source.clip.durationUs) schedule.push(source.clip.durationUs);
  return schedule;
}

function aggregateSamplePreflight(scheduleLength: number, drawerCount: number, configuredMaximum: number): number {
  if (!Number.isSafeInteger(scheduleLength) || !Number.isSafeInteger(drawerCount) || drawerCount === 0 || scheduleLength > Math.floor(Number.MAX_SAFE_INTEGER / drawerCount)) throw new Error("Parametric trace aggregate sample preflight overflowed.");
  const samples = scheduleLength * drawerCount;
  if (samples > MAX_MOTION_PARAMETRIC_TRACE_AGGREGATE_SAMPLES || samples > configuredMaximum) throw new Error(`Parametric trace aggregate samples exceed ${Math.min(MAX_MOTION_PARAMETRIC_TRACE_AGGREGATE_SAMPLES, configuredMaximum)} before driver evaluation.`);
  return samples;
}

function compileWindows(drawer: MotionParametricTraceDrawer, samples: readonly MotionParametricTraceSample[], evaluationWork: readonly number[]): { windows: MotionParametricTraceRetentionWindow[]; retentionWork: number } {
  const windows: MotionParametricTraceRetentionWindow[] = [], retention = drawer.retention; let first = 0, distance = 0, retentionWork = 0;
  for (let index = 0; index < samples.length; index += 1) {
    if (retention.kind === "last-samples") first = Math.max(0, index - retention.samples + 1);
    else if (retention.kind === "last-us" || retention.kind === "age-fade") { const minimum = samples[index]!.atUs - retention.durationUs; while (first < index && samples[first]!.atUs < minimum) { first += 1; retentionWork += 1; } }
    else if (retention.kind === "distance") { if (index > 0) distance += pointDistance(samples[index - 1]!, samples[index]!); while (first < index && distance > retention.distance) { distance -= pointDistance(samples[first]!, samples[first + 1]!); first += 1; retentionWork += 1; } }
    const sampleCount = index - first + 1, vertexCount = sampleCount * vertexMultiplier(drawer.output.mode), workUnits = evaluationWork[index]! + geometryWork(drawer.output.mode, sampleCount), bytes = sampleCount * 40 + vertexCount * 16;
    windows.push({ atUs: samples[index]!.atUs, firstSampleIndex: first, sampleCount, vertexCount, workUnits, bytes }); retentionWork += 1;
  }
  return { windows, retentionWork };
}

function vertexMultiplier(mode: MotionParametricTraceDrawer["output"]["mode"]): number { return mode === "ribbon" ? 2 : mode === "tube" ? 8 : 1; }
function geometryWork(mode: MotionParametricTraceDrawer["output"]["mode"], sampleCount: number): number { const segments = Math.max(0, sampleCount - 1); return mode === "tube" ? sampleCount * 8 + segments * 6 : mode === "ribbon" ? sampleCount * 2 + segments * 2 : sampleCount + segments; }
function pointDistance(left: MotionParametricTraceSample, right: MotionParametricTraceSample): number { return Math.hypot(right.position.x - left.position.x, right.position.y - left.position.y, right.position.z - left.position.z); }
function freeze<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value as Record<string, unknown>)) freeze(child); Object.freeze(value); } return value; }
