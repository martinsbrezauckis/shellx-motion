import { describe, expect, it } from "vitest";
import { effectiveLayerAtUs, evaluateMotionBehaviorFrame } from "./motion-behavior-evaluate";
import { compileMotionBehaviorFramePlan, compileMotionBehaviorStaticPlan } from "./motion-behavior-plan";
import { resolveMotionBehaviorTiming } from "./unadopted/behavior-timing/motion-behavior-timing";
import { validateMotionBehaviors } from "./motion-behavior-validate";
import { buildMotionPublicSchema } from "./motion-public-schema";
import {
  MOTION_BEHAVIOR_MAX_COORDINATE,
  MOTION_BEHAVIOR_MAX_GRAVITY,
  MOTION_BEHAVIOR_MAX_RESTITUTION,
  MOTION_BEHAVIOR_MAX_SQUASH_AMOUNT,
  MOTION_BEHAVIOR_MAX_VELOCITY,
  MOTION_BEHAVIOR_MIN_BOUNCE_GRAVITY,
  MOTION_BEHAVIOR_MIN_COORDINATE,
  MOTION_BEHAVIOR_MIN_GRAVITY,
  MOTION_BEHAVIOR_MIN_RESTITUTION,
  MOTION_BEHAVIOR_MIN_SQUASH_AMOUNT,
  MOTION_BEHAVIOR_MIN_VELOCITY,
} from "./motion-behavior-types";
import { effectiveLayerAtMs } from "./timeline";
import { loadSchemaSync, validateDocumentSync } from "./validate";
import type { MotionDocument } from "./types";

describe("document-root behaviors@1", () => {
  it("evaluates closed path-follow and transform intent on the exact microsecond rail", () => {
    const document = motion({
      bindings: [
        pathBinding("orbit"),
        transformBinding("subject"),
      ],
    });
    expect(validateDocumentSync(loadSchemaSync("motion"), document)).toEqual({ ok: true });
    const path = effectiveLayerAtUs(document, layer(document, "orbit"), 0);
    expect(path.transform).toMatchObject({ x: 0, y: 0, rotation: 0 });
    const transform = effectiveLayerAtUs(document, layer(document, "subject"), 500_000);
    expect(transform.transform).toMatchObject({ x: 55, y: expect.closeTo(47.272727, 5), width: 110, height: expect.closeTo(45.454545, 5) });
    const frame = evaluateMotionBehaviorFrame(document, 500_000);
    expect(frame.samples.map((sample) => sample.targetLayerId)).toEqual(["orbit", "subject"]);
    expect(frame.frameWorkUnits).toBeGreaterThan(0);
  });

  it("leaves disabled and no-behavior paths as exact no-ops", () => {
    const noBehavior = motion();
    const baseline = effectiveLayerAtMs(layer(noBehavior, "subject"), 500);
    expect(effectiveLayerAtUs(noBehavior, layer(noBehavior, "subject"), 500_000)).toEqual(baseline);
    const disabled = motion({ bindings: [{ ...transformBinding("subject"), enabled: false }] });
    expect(effectiveLayerAtUs(disabled, layer(disabled, "subject"), 500_000)).toEqual(baseline);
    expect(evaluateMotionBehaviorFrame(disabled, 500_000).samples).toEqual([]);
  });

  it("binds static and frame identities separately from existing renderer plans", () => {
    const document = motion({ bindings: [transformBinding("subject")] });
    const first = compileMotionBehaviorStaticPlan(document), replay = compileMotionBehaviorStaticPlan(structuredClone(document));
    expect(first).toMatchObject({ ok: true }); expect(replay).toMatchObject({ ok: true });
    if (!first.ok || !replay.ok) return;
    expect(replay.plan).toEqual(first.plan);
    const frame = compileMotionBehaviorFramePlan(document, 500_000);
    expect(frame).toMatchObject({ ok: true, plan: { staticFingerprint: first.plan.fingerprint, budget: { activeBindingCount: 1 } } });
    const changed = structuredClone(document); (changed.behaviors!.bindings[0] as { motion: { velocityX: number } }).motion.velocityX = 101;
    expect(compileMotionBehaviorStaticPlan(changed)).toMatchObject({ ok: true });
    const changedPlan = compileMotionBehaviorStaticPlan(changed); if (changedPlan.ok) expect(changedPlan.plan.fingerprint).not.toBe(first.plan.fingerprint);
  });

  it("resolves optional beat input once and returns only persisted physical microseconds", () => {
    const timing = resolveMotionBehaviorTiming({ beat: { startTick: 960, durationTicks: 960, ticksPerBeat: 960, tempoSegments: [{ startTick: 0, microsecondsPerBeat: { numerator: 500_000, denominator: 1 } }] } });
    expect(timing).toMatchObject({ startUs: 500_000, durationUs: 500_000 });
    expect(timing).not.toHaveProperty("beat");
    expect(() => resolveMotionBehaviorTiming({ startUs: 0, durationUs: 1, beat: {} })).toThrow("exactly physical");
  });

  it("places only the exact store in the source schema builder", () => {
    const schema = buildMotionPublicSchema() as { properties: Record<string, unknown>; $defs: Record<string, unknown> };
    expect(schema.properties.behaviors).toEqual({ $ref: "#/$defs/motionBehaviors" });
    expect(schema.$defs.motionBehaviors).toMatchObject({ type: "object", required: ["schema", "bindings"] });
    expect(JSON.stringify(schema.$defs.motionBehaviors)).not.toContain("tempoSegments");
  });

  it("keeps duration and offset bounded while allowing safe-integer startUs positions", () => {
    const schema = buildMotionPublicSchema() as { $defs: { motionBehavior: { oneOf: Array<{ properties: Record<string, unknown> }> } } };
    const [path, transform] = schema.$defs.motionBehavior.oneOf;
    expect(path?.properties.startUs).toEqual({ type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
    expect(transform?.properties.startUs).toEqual({ type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
    expect(path?.properties.durationUs).toEqual({ type: "integer", minimum: 1, maximum: 3_600_000_000 });
    expect(path?.properties.offsetUs).toEqual({ type: "integer", minimum: 0, maximum: 3_600_000_000 });
  });

  it("publishes the exact shared transform behavior numeric ABI", () => {
    const schema = buildMotionPublicSchema() as { $defs: Record<string, { properties: Record<string, unknown> }> };
    expect(schema.$defs.motionBehaviorGravity?.properties).toMatchObject({
      velocityX: { minimum: MOTION_BEHAVIOR_MIN_VELOCITY, maximum: MOTION_BEHAVIOR_MAX_VELOCITY },
      velocityY: { minimum: MOTION_BEHAVIOR_MIN_VELOCITY, maximum: MOTION_BEHAVIOR_MAX_VELOCITY },
      gravityY: { minimum: MOTION_BEHAVIOR_MIN_GRAVITY, maximum: MOTION_BEHAVIOR_MAX_GRAVITY },
    });
    expect(schema.$defs.motionBehaviorBounce?.properties).toMatchObject({
      floorY: { minimum: MOTION_BEHAVIOR_MIN_COORDINATE, maximum: MOTION_BEHAVIOR_MAX_COORDINATE },
      velocityY: { minimum: MOTION_BEHAVIOR_MIN_VELOCITY, maximum: MOTION_BEHAVIOR_MAX_VELOCITY },
      gravityY: { minimum: MOTION_BEHAVIOR_MIN_BOUNCE_GRAVITY, maximum: MOTION_BEHAVIOR_MAX_GRAVITY },
      restitution: { minimum: MOTION_BEHAVIOR_MIN_RESTITUTION, maximum: MOTION_BEHAVIOR_MAX_RESTITUTION },
    });
    expect(schema.$defs.motionBehaviorSquash?.properties).toMatchObject({
      amount: { minimum: MOTION_BEHAVIOR_MIN_SQUASH_AMOUNT, maximum: MOTION_BEHAVIOR_MAX_SQUASH_AMOUNT },
    });
  });

  it("refuses target ownership, ordering, timing, and all competing transform authorities", () => {
    const unordered = motion({ bindings: [transformBinding("subject"), pathBinding("orbit")] });
    expect(validateMotionBehaviors(unordered.behaviors, unordered)).toMatchObject({ ok: false, issues: [expect.objectContaining({ message: expect.stringContaining("ascending") })] });
    const keyed = motion({ bindings: [transformBinding("subject")] });
    keyed.layers[1]!.keyframes = { "transform.x": [{ atMs: 0, value: 1 }] };
    expect(validateMotionBehaviors(keyed.behaviors, keyed)).toMatchObject({ ok: false, issues: [expect.objectContaining({ message: expect.stringContaining("keyframes") })] });
    const procedural = motion({ bindings: [transformBinding("subject")] });
    procedural.relationships = { schema: "shellx-motion/procedural-relationships@1", relationships: [{ id: "drive", enabled: false, target: { layerId: "subject", property: "transform.x" }, nodes: [], outputNodeId: "none" }] };
    expect(validateMotionBehaviors(procedural.behaviors, procedural)).toMatchObject({ ok: false, issues: [expect.objectContaining({ message: expect.stringContaining("procedural") })] });
    const child = motion({ bindings: [transformBinding("subject")] });
    child.layers.push({ id: "group", type: "group", startMs: 0, durationMs: 1_000, childLayerIds: ["subject"] });
    expect(validateMotionBehaviors(child.behaviors, child)).toMatchObject({ ok: false, issues: [expect.objectContaining({ message: expect.stringContaining("root-owned") })] });
    const late = motion({ bindings: [{ ...transformBinding("subject"), startUs: 900_000, durationUs: 200_000 }] });
    expect(validateMotionBehaviors(late.behaviors, late)).toMatchObject({ ok: false, issues: [expect.objectContaining({ message: expect.stringContaining("document duration") })] });
  });
});

function motion(behaviors?: { bindings: NonNullable<MotionDocument["behaviors"]>["bindings"] }): MotionDocument {
  return {
    schema: "shellx-motion/motion@1", id: "behaviors", name: "Behaviors", durationMs: 1_000, fps: 30, width: 160, height: 90, assets: [], provenance: { sourceApp: "test", createdBy: "test" },
    layers: [
      { id: "orbit", type: "shape", shape: "rect", startMs: 0, durationMs: 1_000, transform: { x: 10, y: 10, width: 20, height: 20 } },
      { id: "subject", type: "shape", shape: "rect", startMs: 0, durationMs: 1_000, transform: { x: 10, y: 20, width: 100, height: 50 } },
    ],
    ...(behaviors ? { behaviors: { schema: "shellx-motion/behaviors@1", bindings: behaviors.bindings } } : {}),
  };
}

function pathBinding(targetLayerId: string) {
  return { targetLayerId, enabled: true, kind: "path-follow" as const, startUs: 0, durationUs: 1_000_000, orientToPath: true, geometry: { schema: "shellx-motion/shape-geometry@1" as const, kind: "path" as const, viewBox: { x: 0, y: 0, width: 100, height: 100 }, data: "M 0 0 L 100 0 L 100 100 Z" } };
}
function transformBinding(targetLayerId: string) {
  return { targetLayerId, enabled: true, kind: "transform" as const, startUs: 0, durationUs: 1_000_000, motion: { kind: "gravity" as const, velocityX: 100, velocityY: 50, gravityY: 0 }, squash: { kind: "squash" as const, axis: "vertical" as const, amount: 0.1 } };
}
function layer(document: MotionDocument, id: string) { const result = document.layers.find((item) => item.id === id); if (!result) throw new Error(`Missing ${id}`); return result; }
