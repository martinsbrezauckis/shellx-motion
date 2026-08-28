import {
  COLLISION_SHOWCASE_SOLVER_ITERATIONS,
  COLLISION_SHOWCASE_TICKS_PER_SECOND,
} from "./collision-showcase-types";
import {
  ContactLedger,
  add,
  clamp,
  dot,
  length,
  normalize,
  quantize,
  quantizeBody,
  scale,
  subtract,
  type SimBody,
} from "./collision-showcase-simulation";

const DT = 1 / COLLISION_SHOWCASE_TICKS_PER_SECOND;

export function integrateBody(body: SimBody, gravity: number): void {
  if (!body.dynamic) return;
  body.velocity[1] = quantize(body.velocity[1] + gravity * DT);
  body.position = add(body.position, scale(body.velocity, DT)).map(quantize) as [number, number, number];
  body.rotationDeg = add(body.rotationDeg, scale(body.angularVelocity, DT)).map(quantize) as [number, number, number];
  body.angularVelocity = scale(body.angularVelocity, 0.998).map(quantize) as [number, number, number];
  quantizeBody(body);
}

export function solveBingoContacts(bodies: readonly SimBody[], cageRadius: number, restitution: number, ledger: ContactLedger): number {
  let candidates = 0;
  for (let iteration = 0; iteration < COLLISION_SHOWCASE_SOLVER_ITERATIONS; iteration += 1) {
    for (let leftIndex = 0; leftIndex < bodies.length; leftIndex += 1) {
      const left = bodies[leftIndex]!;
      if (left.dynamic) resolveSphereVolume(left, cageRadius, restitution, ledger);
      for (let rightIndex = leftIndex + 1; rightIndex < bodies.length; rightIndex += 1) {
        if (iteration === 0) candidates += 1;
        resolveSphereSphere(left, bodies[rightIndex]!, restitution, ledger);
      }
    }
  }
  return candidates;
}

export function solveWreckingContacts(ball: SimBody, bricks: readonly SimBody[], restitution: number, ledger: ContactLedger): number {
  let candidates = 0;
  for (let iteration = 0; iteration < COLLISION_SHOWCASE_SOLVER_ITERATIONS; iteration += 1) {
    for (const brick of bricks) {
      if (iteration === 0) candidates += 1;
      resolveSphereBox(ball, brick, restitution, ledger);
      resolveBoxGround(brick, restitution, ledger);
    }
    for (let leftIndex = 0; leftIndex < bricks.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < bricks.length; rightIndex += 1) {
        if (iteration === 0) candidates += 1;
        resolveBoxBox(bricks[leftIndex]!, bricks[rightIndex]!, restitution, ledger);
      }
    }
  }
  return candidates;
}

function resolveSphereSphere(left: SimBody, right: SimBody, restitution: number, ledger: ContactLedger): void {
  const radius = (left.radius ?? 0) + (right.radius ?? 0), delta = subtract(right.position, left.position), distance = length(delta);
  if (distance >= radius) return;
  const normal = normalize(delta, stableNormal(left.id, right.id)), penetration = radius - distance;
  ledger.add("sphere-sphere", left.id, right.id);
  positionalCorrection(left, right, normal, penetration);
  impulse(left, right, normal, restitution);
}

function resolveSphereVolume(body: SimBody, cageRadius: number, restitution: number, ledger: ContactLedger): void {
  const distance = length(body.position), allowed = cageRadius - (body.radius ?? 0);
  if (distance <= allowed) return;
  const outward = normalize(body.position), penetration = distance - allowed;
  body.position = subtract(body.position, scale(outward, penetration)).map(quantize) as [number, number, number];
  const outwardSpeed = dot(body.velocity, outward);
  if (outwardSpeed > 0) body.velocity = subtract(body.velocity, scale(outward, (1 + restitution) * outwardSpeed)).map(quantize) as [number, number, number];
  quantizeBody(body); ledger.add("sphere-volume", body.id, "bingo-cage");
}

function resolveSphereBox(sphere: SimBody, box: SimBody, restitution: number, ledger: ContactLedger): void {
  const half = box.halfExtents;
  if (!half || sphere.radius === undefined) return;
  const closest: [number, number, number] = [0, 1, 2].map((axis) => clamp(sphere.position[axis]!, box.position[axis]! - half[axis]!, box.position[axis]! + half[axis]!)) as [number, number, number];
  const fromSphere = subtract(closest, sphere.position), distance = length(fromSphere);
  if (distance >= sphere.radius) return;
  const normal = normalize(fromSphere, normalize(subtract(box.position, sphere.position))), penetration = sphere.radius - distance;
  ledger.add("sphere-box", sphere.id, box.id);
  positionalCorrection(sphere, box, normal, penetration);
  impulse(sphere, box, normal, restitution);
}

function resolveBoxBox(left: SimBody, right: SimBody, restitution: number, ledger: ContactLedger): void {
  const a = left.halfExtents, b = right.halfExtents;
  if (!a || !b) return;
  const overlaps = [0, 1, 2].map((axis) => a[axis]! + b[axis]! - Math.abs(right.position[axis]! - left.position[axis]!));
  if (overlaps.some((overlap) => overlap <= 0)) return;
  let axis = 0; if (overlaps[1]! < overlaps[axis]!) axis = 1; if (overlaps[2]! < overlaps[axis]!) axis = 2;
  const normal: [number, number, number] = [0, 0, 0]; normal[axis] = right.position[axis]! >= left.position[axis]! ? 1 : -1;
  ledger.add("box-box", left.id, right.id);
  positionalCorrection(left, right, normal, overlaps[axis]!);
  impulse(left, right, normal, restitution);
}

function resolveBoxGround(body: SimBody, restitution: number, ledger: ContactLedger): void {
  const half = body.halfExtents; if (!half) return;
  const penetration = half[1] - body.position[1]; if (penetration <= 0) return;
  body.position[1] = quantize(body.position[1] + penetration);
  if (body.velocity[1] < 0) body.velocity[1] = quantize(-body.velocity[1] * restitution);
  body.velocity[0] = quantize(body.velocity[0] * 0.94); body.velocity[2] = quantize(body.velocity[2] * 0.94);
  quantizeBody(body); ledger.add("box-ground", body.id, "ground");
}

function positionalCorrection(left: SimBody, right: SimBody, normal: readonly [number, number, number], penetration: number): void {
  const leftMass = left.dynamic ? 1 : 0, rightMass = right.dynamic ? 1 : 0, total = leftMass + rightMass;
  if (total === 0) return;
  if (leftMass) left.position = subtract(left.position, scale(normal, penetration * leftMass / total)).map(quantize) as [number, number, number];
  if (rightMass) right.position = add(right.position, scale(normal, penetration * rightMass / total)).map(quantize) as [number, number, number];
  quantizeBody(left); quantizeBody(right);
}

function impulse(left: SimBody, right: SimBody, normal: readonly [number, number, number], restitution: number): void {
  const leftMass = left.dynamic ? 1 : 0, rightMass = right.dynamic ? 1 : 0, total = leftMass + rightMass;
  if (total === 0) return;
  const closing = dot(subtract(right.velocity, left.velocity), normal); if (closing >= 0) return;
  const magnitude = -(1 + restitution) * closing / total;
  if (leftMass) left.velocity = subtract(left.velocity, scale(normal, magnitude * leftMass)).map(quantize) as [number, number, number];
  if (rightMass) right.velocity = add(right.velocity, scale(normal, magnitude * rightMass)).map(quantize) as [number, number, number];
}

function stableNormal(left: string, right: string): [number, number, number] { const value = [...`${left}\u0000${right}`].reduce((sum, character) => (sum + character.codePointAt(0)!) % 3, 0); return value === 0 ? [1, 0, 0] : value === 1 ? [0, 1, 0] : [0, 0, 1]; }
