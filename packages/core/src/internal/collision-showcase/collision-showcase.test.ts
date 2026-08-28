import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compileCollisionShowcaseRecipe } from "./collision-showcase-compile";
import { readCollisionShowcaseRecipe } from "./collision-showcase-read";
import {
  BINGO_BALL_IDS,
  COLLISION_SHOWCASE_FRAME_COUNT,
  COLLISION_SHOWCASE_RECIPE_SCHEMA,
  WRECKING_BRICK_IDS,
  type BingoCollisionShowcaseRecipe,
  type CollisionShowcasePlan,
  type WreckingCollisionShowcaseRecipe,
} from "./collision-showcase-types";

const bingo = (): BingoCollisionShowcaseRecipe => ({
  schema: COLLISION_SHOWCASE_RECIPE_SCHEMA,
  kind: "bingo-sphere-3d@1",
  seed: 2_975_908_062,
  speed: 3.4,
  gravity: -1.1,
  restitution: 0.92,
  cageRadius: 2.2,
  ballRadius: 0.28,
  selectedBallId: "bingo-ball-07",
  mixingFrame: 6,
  selectedFrame: 46,
});

const wrecking = (): WreckingCollisionShowcaseRecipe => ({
  schema: COLLISION_SHOWCASE_RECIPE_SCHEMA,
  kind: "wrecking-wall-3d@1",
  seed: 487_201,
  gravity: -8,
  restitution: 0.18,
  swingSpeed: 6.5,
  tetherLength: 2.8,
  releaseAngleDeg: -70,
  impactFrame: 24,
  fallingFrame: 32,
});

describe("private C6G-A collision showcase bake plans", () => {
  it("bakes repeatable ten-ball sphere contacts, exact checkpoints, and a selected reveal", () => {
    const first = compileCollisionShowcaseRecipe(bingo());
    const repeated = compileCollisionShowcaseRecipe(bingo());
    expect(repeated).toEqual(first);
    expect(first.fingerprint).toBe("0fa6d5a9a1c17150c950a1514fb7e06078b1becb19beb81e310babf25b66de83");
    expect(first.contacts.ledgerSha256).toBe("f8192f6d8533abc26ef0d62f46b637d897880982d59218e419ecaa914b982cf1");
    expect(first.frames).toHaveLength(COLLISION_SHOWCASE_FRAME_COUNT);
    expect(first.frames.slice(0, 5).map((frame) => frame.atUs)).toEqual([0, 83_333, 166_666, 250_000, 333_333]);
    expect(first.frames.at(-1)).toMatchObject({ frameIndex: 60, atUs: 5_000_000, phase: "reveal" });
    expect(first.checkpoints.map((entry) => [entry.id, entry.frameIndex])).toEqual([["idle", 0], ["mixing", 6], ["selected", 46], ["reveal", 60]]);
    expect(first.bodyCatalog.map((entry) => entry.id)).toEqual(BINGO_BALL_IDS);
    expect(first.bodyCatalog).toHaveLength(10);
    expect(first.contacts.first.some((entry) => entry.kind === "sphere-sphere")).toBe(true);
    expect(first.contacts.first.some((entry) => entry.kind === "sphere-volume")).toBe(true);
    expect(first.budget).toMatchObject({ durationUs: 5_000_000, frameRate: 12, ticksPerSecond: 120, sampleEveryTicks: 10, dynamicBodyCount: 10, maximumPairCandidates: 45, projectedScene3dTrackCount: 11, projectedScene3dKeyframeCount: 612 });
    const selectedAtEnd = state(first, 60, "bingo-ball-07");
    expect(Math.hypot(...selectedAtEnd.position)).toBeGreaterThan(bingo().cageRadius);
    for (const frame of first.frames.slice(0, bingo().selectedFrame)) {
      for (const body of frame.bodies) expect(Math.hypot(...body.position)).toBeLessThanOrEqual(bingo().cageRadius - bingo().ballRadius + 0.000002);
    }
    expect(maximumBingoResidualPenetration(first, bingo().selectedFrame)).toBeLessThanOrEqual(bingo().ballRadius / 4);
    expect(first.evidence).toEqual({ authorTimeBake: true, persistentRuntimePhysics: false, rendererInvoked: false, axisAlignedBoxCollisionWithVisualRotation: false });
  });

  it("bakes a tethered sphere impact plus box-box and ground contacts within Scene3D budgets", () => {
    const plan = compileCollisionShowcaseRecipe(wrecking());
    expect(plan.fingerprint).toBe("fa229b15e25fc22f07bd8402559459108c2cfbbc58cc25d2c6a616ddaa944c70");
    expect(plan.contacts.ledgerSha256).toBe("d9854b94c5057c00a94d4b6dd26604615f051aa73ff2e898fea1ecf7c7106e44");
    expect(plan.frames).toHaveLength(61);
    expect(plan.checkpoints.map((entry) => [entry.id, entry.frameIndex])).toEqual([["intact", 0], ["impact", 24], ["falling", 32], ["end", 60]]);
    expect(plan.bodyCatalog.map((entry) => entry.id)).toEqual([...WRECKING_BRICK_IDS, "wrecking-ball"].sort());
    expect(plan.bodyCatalog).toHaveLength(16);
    expect(plan.bodyCatalog.find((entry) => entry.id === "wrecking-ball")?.radius).toBe(0.6);
    expect(plan.contacts.first.map((entry) => entry.kind)).toEqual(expect.arrayContaining(["sphere-box", "box-box", "box-ground"]));
    expect(plan.budget).toMatchObject({ dynamicBodyCount: 15, maximumPairCandidates: 120, projectedScene3dTrackCount: 17, projectedScene3dKeyframeCount: 1_005 });
    expect(plan.evidence.axisAlignedBoxCollisionWithVisualRotation).toBe(false);
    for (const frame of plan.frames) {
      const ball = state(plan, frame.frameIndex, "wrecking-ball");
      expect(Math.hypot(ball.position[0] + 1.2, ball.position[1] - 2.6, ball.position[2])).toBeCloseTo(wrecking().tetherLength, 5);
      for (const body of frame.bodies) {
        for (const component of [...body.position, ...body.rotationDeg]) expect(Number.isFinite(component)).toBe(true);
        if (body.id.startsWith("brick-")) expect(body.rotationDeg).toEqual([0, 0, 0]);
      }
    }
    const initialBrickStates = plan.frames[0]!.bodies.filter((body) => body.id.startsWith("brick-"));
    const finalBrickStates = plan.frames.at(-1)!.bodies.filter((body) => body.id.startsWith("brick-"));
    expect(finalBrickStates).not.toEqual(initialBrickStates);
    expect(finalBrickStates.filter((body, index) => body.position[1] < initialBrickStates[index]!.position[1] - 0.1).length).toBeGreaterThanOrEqual(5);
    const residual = maximumWreckingResidualPenetration(plan);
    expect(residual.brickAndGround).toBeLessThanOrEqual(0.02);
    expect(residual.sphereBox).toBeLessThanOrEqual(0.2);
  });

  it("changes trajectory hashes with the seed while retaining closed topology and schedule", () => {
    for (const source of [bingo(), wrecking()]) {
      const first = compileCollisionShowcaseRecipe(source);
      const changed = compileCollisionShowcaseRecipe({ ...source, seed: source.seed + 1 });
      expect(changed.fingerprint).not.toBe(first.fingerprint);
      expect(changed.bodyCatalog).toEqual(first.bodyCatalog);
      expect(changed.frames.map((frame) => frame.atUs)).toEqual(first.frames.map((frame) => frame.atUs));
      expect(changed.frames.map((frame) => frame.stateSha256)).not.toEqual(first.frames.map((frame) => frame.stateSha256));
    }
  });

  it("refuses hostile, expanded, mistimed, and physically incompatible recipes before simulation", () => {
    expect(readCollisionShowcaseRecipe(bingo())).toEqual(bingo());
    expect(() => readCollisionShowcaseRecipe({ ...bingo(), callback: "run" })).toThrow("unknown field");
    expect(() => readCollisionShowcaseRecipe({ ...bingo(), seed: 0 })).toThrow("uint32");
    expect(() => readCollisionShowcaseRecipe({ ...bingo(), ballRadius: 0.5 })).toThrow();
    expect(() => readCollisionShowcaseRecipe({ ...bingo(), selectedBallId: "ball-99" })).toThrow("ten stable balls");
    expect(() => readCollisionShowcaseRecipe({ ...bingo(), mixingFrame: 20, selectedFrame: 19 })).toThrow();
    expect(() => readCollisionShowcaseRecipe({ ...wrecking(), impactFrame: 36, fallingFrame: 24 })).toThrow("precede");
    expect(() => compileCollisionShowcaseRecipe({ ...wrecking(), tetherLength: 2 })).toThrow("cannot intersect");
    let reads = 0;
    const accessor = { ...bingo() };
    Object.defineProperty(accessor, "speed", { enumerable: true, get() { reads += 1; return 3.4; } });
    expect(() => readCollisionShowcaseRecipe(accessor)).toThrow("enumerable data field");
    expect(reads).toBe(0);
    expect(() => readCollisionShowcaseRecipe(new Proxy(bingo(), { ownKeys() { throw new Error("blocked"); } }))).toThrow("reflection failed");
  });

  it("keeps C6G-A source-only and free of renderer, connector, process, path, and I/O authority", () => {
    const publicRoot = readFileSync(new URL("../../index.ts", import.meta.url), "utf8");
    const manifest = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { exports: Record<string, unknown>; publishConfig: { exports: Record<string, unknown> } };
    const sources = ["collision-showcase-types.ts", "collision-showcase-read.ts", "collision-showcase-simulation.ts", "collision-showcase-physics.ts", "collision-showcase-bingo.ts", "collision-showcase-wrecking.ts", "collision-showcase-compile.ts", "collision-showcase-lowering-types.ts", "collision-showcase-geometry.ts", "collision-showcase-lower.ts", "collision-showcase.ts"]
      .map((name) => readFileSync(new URL(name, import.meta.url), "utf8")).join("\n");
    expect(publicRoot).not.toContain("collision-showcase");
    expect(manifest.exports["./internal/collision-showcase"]).toBe("./src/internal/collision-showcase/collision-showcase.ts");
    expect(manifest.publishConfig.exports).not.toHaveProperty("./internal/collision-showcase");
    expect(sources).not.toMatch(/(?:node:fs|node:child_process|packages\/(?:connectors|renderer)|outputPath|sourcePackageRoot|fetch\(|process\.)/u);
  });
});

function state(plan: CollisionShowcasePlan, frameIndex: number, bodyId: string) {
  const result = plan.frames[frameIndex]?.bodies.find((body) => body.id === bodyId);
  if (!result) throw new Error(`Missing ${bodyId} at frame ${frameIndex}.`);
  return result;
}

function maximumBingoResidualPenetration(plan: CollisionShowcasePlan, selectedFrame: number): number {
  const radius = plan.bodyCatalog[0]?.radius ?? 0;
  let maximum = 0;
  for (const frame of plan.frames.slice(0, selectedFrame)) {
    for (let leftIndex = 0; leftIndex < frame.bodies.length; leftIndex += 1) {
      const left = frame.bodies[leftIndex]!;
      for (let rightIndex = leftIndex + 1; rightIndex < frame.bodies.length; rightIndex += 1) {
        const right = frame.bodies[rightIndex]!;
        maximum = Math.max(maximum, radius * 2 - Math.hypot(...left.position.map((value, axis) => value - right.position[axis]!) as [number, number, number]));
      }
    }
  }
  return maximum;
}

function maximumWreckingResidualPenetration(plan: CollisionShowcasePlan): { brickAndGround: number; sphereBox: number } {
  const half = plan.bodyCatalog.find((body) => body.shape === "box")?.halfExtents;
  if (!half) throw new Error("Missing wrecking brick dimensions.");
  let brickAndGround = 0, sphereBox = 0;
  for (const frame of plan.frames) {
    const bricks = frame.bodies.filter((body) => body.id.startsWith("brick-"));
    const ball = frame.bodies.find((body) => body.id === "wrecking-ball");
    const ballRadius = plan.bodyCatalog.find((body) => body.id === "wrecking-ball")?.radius;
    if (!ball || ballRadius === undefined) throw new Error("Missing wrecking ball state.");
    for (let leftIndex = 0; leftIndex < bricks.length; leftIndex += 1) {
      const left = bricks[leftIndex]!;
      brickAndGround = Math.max(brickAndGround, half[1] - left.position[1]);
      const closest = ball.position.map((value, axis) => Math.min(left.position[axis]! + half[axis]!, Math.max(left.position[axis]! - half[axis]!, value))) as [number, number, number];
      sphereBox = Math.max(sphereBox, ballRadius - Math.hypot(...ball.position.map((value, axis) => value - closest[axis]!) as [number, number, number]));
      for (let rightIndex = leftIndex + 1; rightIndex < bricks.length; rightIndex += 1) {
        const right = bricks[rightIndex]!;
        const overlaps = left.position.map((value, axis) => half[axis]! * 2 - Math.abs(right.position[axis]! - value));
        if (overlaps.every((overlap) => overlap > 0)) brickAndGround = Math.max(brickAndGround, Math.min(...overlaps));
      }
    }
  }
  return { brickAndGround, sphereBox };
}
