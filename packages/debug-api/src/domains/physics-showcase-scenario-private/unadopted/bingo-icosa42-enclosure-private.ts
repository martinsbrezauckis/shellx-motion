/** Private C7B6C deterministic icosa42 enclosure math. No host, provider, or renderer authority. */
export type BingoIco42Vec3 = readonly [number, number, number];
export type BingoIco42Quaternion = readonly [number, number, number, number];
export type BingoIco42Record = Readonly<{ center: BingoIco42Vec3; visibleRadius: number; panelThickness: number; surfaceMargin: number; proxy: "icosa42-slabs" }>;

/** Certified f64 bound for `max ||x||` where all 42 canonical `n dot x <= 1`. */
export const BINGO_ICO42_HULL_K = 1.07046626931927;
export const BINGO_ICO42_SAFETY_POLICY = Object.freeze({
  schema: "shellx-motion/private-bingo-icosa42-safety@1",
  reserveRule: "equal-surface-margin" as const,
  f32NormalHullReserve: 0.000001,
  f32PanelPlaneInset: 0.000001,
});

export interface BingoIco42Panel {
  readonly id: string;
  readonly source: Readonly<{ kind: "icosa-vertex" | "icosa-edge-midpoint"; vertexIndices: readonly number[] }>;
  readonly normal: BingoIco42Vec3;
  readonly position: BingoIco42Vec3;
  readonly rotation: BingoIco42Quaternion;
  readonly size: BingoIco42Vec3;
}
export interface BingoIco42Enclosure {
  readonly record: BingoIco42Record;
  readonly policy: Readonly<typeof BINGO_ICO42_SAFETY_POLICY & { solverAndF32Reserve: number; certifiedHullK: number }>;
  readonly panelInnerPlaneDistance: number;
  readonly certifiedBallCenterHalfspaceDistance: number;
  readonly certifiedBallCenterRadius: number;
  readonly certifiedBallSurfaceRadius: number;
  readonly tangentHalfExtent: number;
  readonly floorPanelId: string;
  readonly panels: readonly BingoIco42Panel[];
}

/** Generates the fixed 12-vertex then 30-edge-midpoint order and its bounded static slabs. */
export function deriveBingoIco42Enclosure(record: BingoIco42Record, ballRadius: number): BingoIco42Enclosure {
  const { visibleRadius, surfaceMargin } = record, reserve = surfaceMargin;
  if (record.proxy !== "icosa42-slabs") throw new Error("Bingo enclosure.proxy must equal icosa42-slabs.");
  if (visibleRadius <= ballRadius + surfaceMargin + reserve) throw new Error("Bingo enclosure visibleRadius must leave a positive ball-center hull after visible and solver/f32 reserves.");
  const certifiedHullK = BINGO_ICO42_HULL_K + BINGO_ICO42_SAFETY_POLICY.f32NormalHullReserve;
  const certifiedBallCenterHalfspaceDistance = (visibleRadius - ballRadius - surfaceMargin - reserve) / certifiedHullK;
  // The equal reserve is consumed once in `a`: the emitted inner plane is
  // `a + ballRadius`, so the collider centre halfspace remains exactly `a`.
  const panelInnerPlaneDistance = f32Down(certifiedBallCenterHalfspaceDistance + ballRadius);
  if (panelInnerPlaneDistance <= 0) throw new Error("Bingo enclosure reserves leave no positive panel inner-plane distance.");
  const tangentHalfExtent = visibleRadius, panelCenterDistance = panelInnerPlaneDistance + record.panelThickness / 2;
  const panels = Object.freeze(ICO42_NORMALS.map((source, index) => {
    const rotation = quaternionFromPositiveZ(source.normal);
    return Object.freeze({
      id: `wall-panel-${String(index).padStart(2, "0")}`,
      source: source.source,
      normal: source.normal,
      position: f32SafePanelPosition(record.center, source.normal, rotation, panelCenterDistance, record.panelThickness, panelInnerPlaneDistance),
      rotation,
      size: tuple3([f32(2 * tangentHalfExtent), f32(2 * tangentHalfExtent), record.panelThickness]),
    });
  }));
  const floorPanelId = panels.reduce((best, panel) => panel.normal[1] < best.normal[1] || (panel.normal[1] === best.normal[1] && panel.id < best.id) ? panel : best).id;
  const certifiedBallCenterRadius = certifiedHullK * certifiedBallCenterHalfspaceDistance, certifiedBallSurfaceRadius = certifiedBallCenterRadius + ballRadius;
  if (certifiedBallSurfaceRadius > visibleRadius - surfaceMargin + 1e-12) throw new Error("Bingo enclosure certificate does not retain the visible surface margin.");
  if (tangentHalfExtent + 1e-12 < certifiedBallSurfaceRadius) throw new Error("Bingo panel tangent extents do not cover the certified ball-center hull plus ball radius.");
  return Object.freeze({ record: Object.freeze({ ...record }), policy: Object.freeze({ ...BINGO_ICO42_SAFETY_POLICY, solverAndF32Reserve: reserve, certifiedHullK }), panelInnerPlaneDistance, certifiedBallCenterHalfspaceDistance, certifiedBallCenterRadius, certifiedBallSurfaceRadius, tangentHalfExtent, floorPanelId, panels });
}

/** Canonical local +Z-to-normal quaternion, including the antiparallel local-axis case. */
export function quaternionFromPositiveZ(normal: BingoIco42Vec3): BingoIco42Quaternion {
  const unit = normalize(normal, "Bingo icosa42 panel normal"), z = unit[2];
  if (z < -1 + 1e-12) return Object.freeze([0, 1, 0, 0]);
  return canonicalQuaternion(normalizeQuaternion([-unit[1], unit[0], 0, 1 + z]));
}

/** Uses the emitted f32 quaternion rather than the ideal derivation normal. */
export function bingoIco42PanelNormal(rotation: BingoIco42Quaternion): BingoIco42Vec3 { return normalize(rotatedPositiveZ(rotation), "Bingo f32 panel quaternion normal"); }
export function bingoIco42PanelInnerPlane(center: BingoIco42Vec3, panel: Pick<BingoIco42Panel, "position" | "rotation" | "size">): number {
  return dot(bingoIco42PanelNormal(panel.rotation), panel.position.map((value, axis) => value - center[axis]!)) - panel.size[2] / 2;
}

const GOLDEN_RATIO = (1 + Math.sqrt(5)) / 2;
const ICO12_RAW_VERTICES: readonly BingoIco42Vec3[] = Object.freeze([
  [0, -1, -GOLDEN_RATIO], [0, -1, GOLDEN_RATIO], [0, 1, -GOLDEN_RATIO], [0, 1, GOLDEN_RATIO],
  [-1, -GOLDEN_RATIO, 0], [-1, GOLDEN_RATIO, 0], [1, -GOLDEN_RATIO, 0], [1, GOLDEN_RATIO, 0],
  [-GOLDEN_RATIO, 0, -1], [-GOLDEN_RATIO, 0, 1], [GOLDEN_RATIO, 0, -1], [GOLDEN_RATIO, 0, 1],
].map((vertex) => Object.freeze(vertex) as BingoIco42Vec3));
const ICO12_UNIT_VERTICES = Object.freeze(ICO12_RAW_VERTICES.map((vertex) => normalize(vertex, "Bingo icosahedron vertex")));
const ICO30_EDGE_VERTEX_PAIRS: readonly (readonly [number, number])[] = Object.freeze((() => {
  const pairs: [number, number][] = [];
  for (let left = 0; left < ICO12_RAW_VERTICES.length; left += 1) for (let right = left + 1; right < ICO12_RAW_VERTICES.length; right += 1) {
    const squaredDistance = ICO12_RAW_VERTICES[left]!.reduce((sum, value, axis) => sum + (value - ICO12_RAW_VERTICES[right]![axis]!) ** 2, 0);
    if (Math.abs(squaredDistance - 4) <= 1e-12) pairs.push([left, right]);
  }
  if (pairs.length !== 30) throw new Error("Canonical icosahedron must contain exactly 30 edges.");
  return pairs.map((pair) => Object.freeze(pair) as readonly [number, number]);
})());
const ICO42_NORMALS = Object.freeze([
  ...ICO12_UNIT_VERTICES.map((normal, index) => Object.freeze({ normal: f32Normalize(normal, "Bingo icosahedron vertex normal"), source: Object.freeze({ kind: "icosa-vertex" as const, vertexIndices: Object.freeze([index]) }) })),
  ...ICO30_EDGE_VERTEX_PAIRS.map(([left, right]) => Object.freeze({ normal: f32Normalize(tuple3(ICO12_UNIT_VERTICES[left]!.map((value, axis) => value + ICO12_UNIT_VERTICES[right]![axis]!) as [number, number, number]), "Bingo icosahedron edge-midpoint normal"), source: Object.freeze({ kind: "icosa-edge-midpoint" as const, vertexIndices: Object.freeze([left, right]) }) })),
]);

function f32SafePanelPosition(center: BingoIco42Vec3, intendedNormal: BingoIco42Vec3, rotation: BingoIco42Quaternion, centerDistance: number, thickness: number, innerPlaneDistance: number): BingoIco42Vec3 {
  const actualNormal = bingoIco42PanelNormal(rotation);
  let position = tuple3(intendedNormal.map((component, axis) => f32(center[axis]! + component * centerDistance)));
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (bingoIco42PanelInnerPlane(center, { position, rotation, size: [0, 0, thickness] }) <= innerPlaneDistance) return position;
    const inward = bingoIco42PanelInnerPlane(center, { position, rotation, size: [0, 0, thickness] }) - innerPlaneDistance + BINGO_ICO42_SAFETY_POLICY.f32PanelPlaneInset;
    position = tuple3(position.map((component, axis) => f32(component - actualNormal[axis]! * inward)));
  }
  throw new Error("Bingo enclosure could not place an f32 panel inside its shared inner-plane certificate.");
}
function normalize(value: readonly number[], label: string): BingoIco42Vec3 { const length = Math.hypot(...value); if (!Number.isFinite(length) || length <= 1e-12) throw new Error(`${label} must be non-zero.`); return tuple3(value.map((component) => component / length)); }
function f32Normalize(value: BingoIco42Vec3, label: string): BingoIco42Vec3 { return tuple3(normalize(value, label).map(f32)); }
function normalizeQuaternion(value: readonly number[]): BingoIco42Quaternion { const length = Math.hypot(...value); if (!Number.isFinite(length) || length <= 1e-12) throw new Error("Bingo icosa42 panel quaternion cannot normalize a zero axis."); return Object.freeze(value.map((component) => f32(component / length)) as unknown as [number, number, number, number]); }
function canonicalQuaternion(value: BingoIco42Quaternion): BingoIco42Quaternion { const sign = value[3] < 0 || (value[3] === 0 && (value[0] < 0 || (value[0] === 0 && (value[1] < 0 || (value[1] === 0 && value[2] < 0))))) ? -1 : 1; return sign === 1 ? value : Object.freeze(value.map((component) => f32(sign * component)) as unknown as [number, number, number, number]); }
function rotatedPositiveZ([x, y, z, w]: BingoIco42Quaternion): BingoIco42Vec3 { return tuple3([2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y)]); }
function f32Down(value: number): number { const rounded = f32(value); if (rounded <= value) return rounded; const bits = new Uint32Array(new Float32Array([rounded]).buffer)[0]!; return f32(new Float32Array(new Uint32Array([bits - 1]).buffer)[0]!); }
function f32(value: number): number { const result = Math.fround(value); if (!Number.isFinite(result)) throw new Error("Bingo icosa42 derivation produced a non-finite f32 value."); return Object.is(result, -0) ? 0 : result; }
function tuple3(value: readonly number[]): BingoIco42Vec3 { return Object.freeze([value[0]!, value[1]!, value[2]!]); }
function dot(left: readonly number[], right: readonly number[]): number { return left.reduce((sum, value, index) => sum + value * right[index]!, 0); }
