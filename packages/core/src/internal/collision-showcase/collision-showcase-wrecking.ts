import {
  COLLISION_SHOWCASE_FRAME_COUNT,
  COLLISION_SHOWCASE_SAMPLE_EVERY_TICKS,
  WRECKING_BRICK_IDS,
  type WreckingCollisionShowcaseRecipe,
} from "./collision-showcase-types";
import { integrateBody, solveWreckingContacts } from "./collision-showcase-physics";
import {
  ContactLedger,
  XorShift32,
  collisionFrame,
  normalize,
  quantize,
  quantizeBody,
  scale,
  subtract,
  type SimBody,
  type SimulationResult,
} from "./collision-showcase-simulation";

const BALL_RADIUS = 0.6;
const BRICK_HALF_EXTENTS = [0.24, 0.22, 0.32] as const;
const BRICK_ROW_PITCH = 0.46;
const BRICK_COLUMN_PITCH = 0.68;
const WALL_X = 1.2;
const HORIZONTAL_AIR_DRAG = 0.985;
const ANCHOR = [-1.2, 2.6, 0] as const;
// Stop the kinematic ball at a shallow wall contact instead of driving its centre through
// the bricks. The incoming velocity still transfers the authored impact impulse.
const TARGET_ANGLE_DEG = 38;

export function simulateWreckingCollisionShowcase(recipe: WreckingCollisionShowcaseRecipe): SimulationResult {
  const random = new XorShift32(recipe.seed);
  const bricks = WRECKING_BRICK_IDS.map((id, index): SimBody => ({
    id,
    shape: "box",
    color: index % 2 === 0 ? "#c96f45" : "#e08a57",
    dynamic: true,
    position: [WALL_X, quantize(BRICK_HALF_EXTENTS[1] + Math.floor(index / 5) * BRICK_ROW_PITCH), quantize((index % 5 - 2) * BRICK_COLUMN_PITCH)],
    velocity: [0, 0, 0],
    rotationDeg: [0, 0, 0],
    angularVelocity: [0, 0, 0],
    halfExtents: [...BRICK_HALF_EXTENTS],
  }));
  const ball: SimBody = {
    id: "wrecking-ball",
    shape: "sphere",
    color: "#d6dee9",
    dynamic: false,
    position: swingPosition(recipe.releaseAngleDeg, recipe.tetherLength),
    velocity: [0, 0, 0],
    rotationDeg: [0, 0, 0],
    angularVelocity: [0, 0, 0],
    radius: BALL_RADIUS,
  };
  const bodies = [ball, ...bricks], ledger = new ContactLedger();
  const impactTick = recipe.impactFrame * COLLISION_SHOWCASE_SAMPLE_EVERY_TICKS;
  const finalTick = (COLLISION_SHOWCASE_FRAME_COUNT - 1) * COLLISION_SHOWCASE_SAMPLE_EVERY_TICKS;
  const frames = [collisionFrame(0, "intact", bodies)];
  let maximumPairCandidates = 0, activated = false;

  for (let tick = 1; tick <= finalTick; tick += 1) {
    ledger.startTick(tick);
    const previousBall = [...ball.position] as [number, number, number];
    const targetProgress = Math.min(1, tick / impactTick);
    const eased = 0.5 - 0.5 * Math.cos(Math.PI * targetProgress);
    const angle = recipe.releaseAngleDeg + (TARGET_ANGLE_DEG - recipe.releaseAngleDeg) * eased;
    ball.position = swingPosition(angle, recipe.tetherLength);
    const direction = normalize(subtract(ball.position, previousBall));
    ball.velocity = scale(direction, recipe.swingSpeed).map(quantize) as [number, number, number];
    quantizeBody(ball);

    if (tick >= impactTick && !activated) {
      activated = true;
      for (const brick of bricks) {
        brick.velocity = [quantize(random.signed() * 0.025), 0, quantize(random.signed() * 0.025)];
        // The bounded solver resolves axis-aligned boxes. Keep their rendered orientation aligned
        // with that collision shape and let the independent translated bodies carry the collapse.
        brick.angularVelocity = [0, 0, 0];
      }
    }
    if (activated) {
      for (const brick of bricks) {
        integrateBody(brick, recipe.gravity);
        brick.velocity[0] = quantize(brick.velocity[0] * HORIZONTAL_AIR_DRAG);
        brick.velocity[2] = quantize(brick.velocity[2] * HORIZONTAL_AIR_DRAG);
      }
      maximumPairCandidates = Math.max(maximumPairCandidates, solveWreckingContacts(ball, bricks, recipe.restitution, ledger));
    }
    ledger.finishTick();
    if (tick % COLLISION_SHOWCASE_SAMPLE_EVERY_TICKS === 0) {
      const frameIndex = tick / COLLISION_SHOWCASE_SAMPLE_EVERY_TICKS;
      frames.push(collisionFrame(frameIndex, wreckingPhase(frameIndex, recipe), bodies));
    }
  }
  const contactEvidence = ledger.evidence();
  for (const kind of ["sphere-box", "box-box", "box-ground"] as const) {
    if (!contactEvidence.first.some((entry) => entry.kind === kind)) throw new Error(`Wrecking collision showcase seed ${recipe.seed} did not produce the required ${kind} contact.`);
  }
  return {
    bodies,
    frames,
    checkpoints: [
      { id: "intact", frameIndex: 0 },
      { id: "impact", frameIndex: recipe.impactFrame },
      { id: "falling", frameIndex: recipe.fallingFrame },
      { id: "end", frameIndex: COLLISION_SHOWCASE_FRAME_COUNT - 1 },
    ],
    contacts: ledger,
    maximumPairCandidates,
    projectedTrackCount: 17,
    projectedKeyframeCount: 1_005,
    axisAlignedBoxCollisionWithVisualRotation: false,
  };
}

export function assertWreckingCollisionGeometry(recipe: WreckingCollisionShowcaseRecipe): void {
  const target = swingPosition(TARGET_ANGLE_DEG, recipe.tetherLength);
  const wallMinimum: [number, number, number] = [WALL_X - BRICK_HALF_EXTENTS[0], 0, -2 * BRICK_COLUMN_PITCH - BRICK_HALF_EXTENTS[2]];
  const wallMaximum: [number, number, number] = [WALL_X + BRICK_HALF_EXTENTS[0], BRICK_HALF_EXTENTS[1] * 2 + BRICK_ROW_PITCH * 2, 2 * BRICK_COLUMN_PITCH + BRICK_HALF_EXTENTS[2]];
  const closest = target.map((value, axis) => Math.min(wallMaximum[axis]!, Math.max(wallMinimum[axis]!, value))) as [number, number, number];
  if (Math.hypot(...target.map((value, axis) => value - closest[axis]!) as [number, number, number]) >= BALL_RADIUS) {
    throw new Error("Wrecking tetherLength cannot intersect the fixed wall at the bounded impact checkpoint.");
  }
}

function swingPosition(angleDeg: number, tetherLength: number): [number, number, number] {
  const radians = angleDeg * Math.PI / 180;
  return [quantize(ANCHOR[0] + Math.sin(radians) * tetherLength), quantize(ANCHOR[1] - Math.cos(radians) * tetherLength), 0];
}

function wreckingPhase(frameIndex: number, recipe: WreckingCollisionShowcaseRecipe): string {
  if (frameIndex < recipe.impactFrame) return "intact";
  if (frameIndex < recipe.fallingFrame) return "impact";
  if (frameIndex < COLLISION_SHOWCASE_FRAME_COUNT - 1) return "falling";
  return "end";
}
