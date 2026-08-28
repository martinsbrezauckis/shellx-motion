import {
  BINGO_BALL_COLORS,
  BINGO_BALL_IDS,
  COLLISION_SHOWCASE_FRAME_COUNT,
  COLLISION_SHOWCASE_SAMPLE_EVERY_TICKS,
  COLLISION_SHOWCASE_TICKS_PER_SECOND,
  type BingoCollisionShowcaseRecipe,
} from "./collision-showcase-types";
import { solveBingoContacts, integrateBody } from "./collision-showcase-physics";
import {
  ContactLedger,
  XorShift32,
  collisionFrame,
  normalize,
  quantize,
  quantizeBody,
  type SimBody,
  type SimulationResult,
} from "./collision-showcase-simulation";

const INITIAL_POINTS = Object.freeze([
  [-0.82, -0.58, -0.48], [0, -0.76, 0.34], [0.82, -0.52, -0.3],
  [-0.72, 0.02, 0.54], [0.08, -0.02, -0.72], [0.76, 0.1, 0.48],
  [-0.58, 0.68, -0.34], [0.04, 0.74, 0.5], [0.68, 0.62, -0.54],
  [0.02, 0.28, 0.76],
] as const);

export function simulateBingoCollisionShowcase(recipe: BingoCollisionShowcaseRecipe): SimulationResult {
  const random = new XorShift32(recipe.seed), scale = recipe.cageRadius / 2.35;
  const bodies = BINGO_BALL_IDS.map((id, index): SimBody => {
    const direction = normalize([random.signed(), random.signed(), random.signed()]);
    const speed = recipe.speed * (0.72 + random.unit() * 0.56);
    return {
      id,
      shape: "sphere",
      color: BINGO_BALL_COLORS[index]!,
      dynamic: true,
      position: INITIAL_POINTS[index]!.map((value) => quantize(value * scale)) as [number, number, number],
      velocity: direction.map((value) => quantize(value * speed)) as [number, number, number],
      rotationDeg: [0, 0, 0],
      angularVelocity: [0, 0, 0],
      radius: recipe.ballRadius,
    };
  });
  const selected = bodies.find((body) => body.id === recipe.selectedBallId)!;
  const mixingTick = recipe.mixingFrame * COLLISION_SHOWCASE_SAMPLE_EVERY_TICKS;
  const selectedTick = recipe.selectedFrame * COLLISION_SHOWCASE_SAMPLE_EVERY_TICKS;
  const finalTick = (COLLISION_SHOWCASE_FRAME_COUNT - 1) * COLLISION_SHOWCASE_SAMPLE_EVERY_TICKS;
  const ledger = new ContactLedger(), frames = [collisionFrame(0, "idle", bodies)];
  let selectionStart: [number, number, number] | undefined, maximumPairCandidates = 0;

  for (let tick = 1; tick <= finalTick; tick += 1) {
    ledger.startTick(tick);
    if (tick >= mixingTick) {
      const active = tick >= selectedTick ? bodies.filter((body) => body !== selected) : bodies;
      for (const body of active) integrateBody(body, recipe.gravity);
      maximumPairCandidates = Math.max(maximumPairCandidates, solveBingoContacts(active, recipe.cageRadius, recipe.restitution, ledger));
      if (tick >= selectedTick) {
        selectionStart ??= [...selected.position];
        const progress = (tick - selectedTick) / Math.max(1, finalTick - selectedTick);
        const eased = progress * progress * (3 - 2 * progress);
        const target: [number, number, number] = [0, recipe.cageRadius * 0.18, recipe.cageRadius + recipe.ballRadius * 1.8];
        selected.position = selectionStart.map((value, axis) => quantize(value + (target[axis]! - value) * eased)) as [number, number, number];
        selected.velocity = [0, 0, 0];
        quantizeBody(selected);
      }
    }
    ledger.finishTick();
    if (tick % COLLISION_SHOWCASE_SAMPLE_EVERY_TICKS === 0) {
      const frameIndex = tick / COLLISION_SHOWCASE_SAMPLE_EVERY_TICKS;
      frames.push(collisionFrame(frameIndex, bingoPhase(frameIndex, recipe), bodies));
    }
  }
  if (!ledger.evidence().first.some((entry) => entry.kind === "sphere-sphere") || !ledger.evidence().first.some((entry) => entry.kind === "sphere-volume")) {
    throw new Error(`Bingo collision showcase seed ${recipe.seed} did not produce the required sphere-sphere and sphere-volume contacts.`);
  }
  return {
    bodies,
    frames,
    checkpoints: [
      { id: "idle", frameIndex: 0 },
      { id: "mixing", frameIndex: recipe.mixingFrame },
      { id: "selected", frameIndex: recipe.selectedFrame },
      { id: "reveal", frameIndex: COLLISION_SHOWCASE_FRAME_COUNT - 1 },
    ],
    contacts: ledger,
    maximumPairCandidates,
    projectedTrackCount: 11,
    projectedKeyframeCount: 10 * COLLISION_SHOWCASE_FRAME_COUNT + 2,
    axisAlignedBoxCollisionWithVisualRotation: false,
  };
}

function bingoPhase(frameIndex: number, recipe: BingoCollisionShowcaseRecipe): string {
  if (frameIndex < recipe.mixingFrame) return "idle";
  if (frameIndex < recipe.selectedFrame) return "mixing";
  if (frameIndex < COLLISION_SHOWCASE_FRAME_COUNT - 1) return "selected";
  return "reveal";
}
