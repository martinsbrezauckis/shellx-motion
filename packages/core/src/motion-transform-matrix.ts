/**
 * Small affine-transform authority shared by static import lowering and bounded authoring bakes.
 *
 * Motion layer transforms are document-pixel transforms of a layer's local top-left box:
 * `translate(x,y) * translate(origin) * rotate(rotation) * scale * translate(-origin)`.
 * Keeping that equation here prevents authoring tools from recreating a subtly different matrix
 * convention from either renderer's presentation code.
 */
export type MotionAffineMatrix = [number, number, number, number, number, number];

export interface MotionAffineComponents {
  x: number;
  y: number;
  originX: number;
  originY: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
}

export interface MotionSimilarityTransform {
  x: number;
  y: number;
  scale: number;
  rotation: number;
}

export function motionAffineMatrix(input: MotionAffineComponents): MotionAffineMatrix {
  const radians = (input.rotation * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const a = cosine * input.scaleX;
  const b = sine * input.scaleX;
  const c = -sine * input.scaleY;
  const d = cosine * input.scaleY;
  return [
    a,
    b,
    c,
    d,
    input.x - (a * input.originX) - (c * input.originY) + input.originX,
    input.y - (b * input.originX) - (d * input.originY) + input.originY
  ];
}

export function multiplyMotionAffineMatrices(left: MotionAffineMatrix, right: MotionAffineMatrix): MotionAffineMatrix {
  return [
    (left[0] * right[0]) + (left[2] * right[1]),
    (left[1] * right[0]) + (left[3] * right[1]),
    (left[0] * right[2]) + (left[2] * right[3]),
    (left[1] * right[2]) + (left[3] * right[3]),
    (left[0] * right[4]) + (left[2] * right[5]) + left[4],
    (left[1] * right[4]) + (left[3] * right[5]) + left[5]
  ];
}

export function transformMotionAffinePoint(matrix: MotionAffineMatrix, point: readonly [number, number]): [number, number] {
  return [
    (matrix[0] * point[0]) + (matrix[2] * point[1]) + matrix[4],
    (matrix[1] * point[0]) + (matrix[3] * point[1]) + matrix[5]
  ];
}

export function transformMotionAffineVector(matrix: MotionAffineMatrix, vector: readonly [number, number]): [number, number] {
  return [
    (matrix[0] * vector[0]) + (matrix[2] * vector[1]),
    (matrix[1] * vector[0]) + (matrix[3] * vector[1])
  ];
}

/**
 * Recover the exact Motion transform only for an orientation-preserving uniform-scale matrix.
 * Skew, non-uniform scale, reflection, non-finite values, and singular matrices return null.
 */
export function decomposeMotionSimilarityMatrix(
  matrix: MotionAffineMatrix,
  origin: { x: number; y: number },
  tolerance = 1e-8
): MotionSimilarityTransform | null {
  if (!matrix.every(Number.isFinite) || !Number.isFinite(origin.x) || !Number.isFinite(origin.y)) return null;
  const [a, b, c, d, tx, ty] = matrix;
  const scaleX = Math.hypot(a, b);
  const scaleY = Math.hypot(c, d);
  const determinant = (a * d) - (b * c);
  const magnitude = Math.max(1, scaleX, scaleY);
  if (scaleX <= tolerance || scaleY <= tolerance || determinant <= tolerance) return null;
  if (Math.abs(scaleX - scaleY) > tolerance * magnitude) return null;
  if (Math.abs((a * c) + (b * d)) > tolerance * magnitude * magnitude) return null;
  const scale = (scaleX + scaleY) / 2;
  const rotation = (Math.atan2(b, a) * 180) / Math.PI;
  return {
    x: tx - origin.x + (a * origin.x) + (c * origin.y),
    y: ty - origin.y + (b * origin.x) + (d * origin.y),
    scale,
    rotation
  };
}
