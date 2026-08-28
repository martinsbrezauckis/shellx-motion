import type {
  SceneRecipeEntity,
  SceneRecipeEntityState,
  SceneRecipeGeneratedState,
  SceneRecipeGeometryResource,
  SceneRecipeWallGenerator,
} from "./scene-recipe-types";
import { freeze } from "./scene-recipe-data";

export interface ExpandedWallEntity {
  readonly entity: SceneRecipeEntity;
  readonly baseState: SceneRecipeEntityState;
}

export function wallEntityId(generatorId: string, row: number, column: number): string {
  return `${generatorId}.r${String(row).padStart(2, "0")}.c${String(column).padStart(2, "0")}`;
}

export function expandWallGenerator(generator: SceneRecipeWallGenerator, geometry: SceneRecipeGeometryResource): readonly ExpandedWallEntity[] {
  if (geometry.kind !== "box") throw new Error(`Wall generator '${generator.id}' requires box geometry.`);
  const pitchX = sceneFloat(geometry.size[0] + generator.gap[0]);
  const pitchY = sceneFloat(geometry.size[1] + generator.gap[1]);
  const result: ExpandedWallEntity[] = [];
  for (let row = 0; row < generator.rows; row += 1) {
    const bondOffset = generator.bond === "running" && row % 2 === 1 ? 0.5 : 0;
    for (let column = 0; column < generator.columns; column += 1) {
      const id = wallEntityId(generator.id, row, column);
      const materialIndex = generator.materialPattern.kind === "row-cycle"
        ? row % generator.materialPattern.materialRefs.length
        : (row * generator.columns + column) % generator.materialPattern.materialRefs.length;
      result.push(freeze({
        entity: freeze({ id, geometryRef: generator.geometryRef, materialRef: generator.materialPattern.materialRefs[materialIndex]! }),
        baseState: freeze({
          entityId: id,
          position: freeze([
            generatedPosition(generator.origin[0] + (column - (generator.columns - 1) / 2 + bondOffset) * pitchX, id),
            generatedPosition(generator.origin[1] + row * pitchY, id),
            generatedPosition(generator.origin[2], id),
          ]),
          rotationDeg: freeze([0, 0, 0]),
          scale: 1,
        }),
      }));
    }
  }
  return freeze(result);
}

export function transformGeneratedState(base: SceneRecipeEntityState, group: SceneRecipeGeneratedState): SceneRecipeEntityState {
  const scaled: readonly [number, number, number] = [base.position[0] * group.scale, base.position[1] * group.scale, base.position[2] * group.scale];
  const rotated = rotateXyz(scaled, group.rotationDeg);
  return freeze({
    entityId: base.entityId,
    position: freeze([
      generatedPosition(rotated[0] + group.translation[0], base.entityId),
      generatedPosition(rotated[1] + group.translation[1], base.entityId),
      generatedPosition(rotated[2] + group.translation[2], base.entityId),
    ]),
    rotationDeg: freeze(group.rotationDeg.map(sceneFloat)) as unknown as readonly [number, number, number],
    scale: sceneFloat(group.scale),
  });
}

function rotateXyz(value: readonly [number, number, number], rotationDeg: readonly [number, number, number]): readonly [number, number, number] {
  const radians = rotationDeg.map((component) => component * Math.PI / 180);
  const [sinX, sinY, sinZ] = radians.map(Math.sin), [cosX, cosY, cosZ] = radians.map(Math.cos);
  const x1 = value[0], y1 = value[1] * cosX! - value[2] * sinX!, z1 = value[1] * sinX! + value[2] * cosX!;
  const x2 = x1 * cosY! + z1 * sinY!, y2 = y1, z2 = -x1 * sinY! + z1 * cosY!;
  return [sceneFloat(x2 * cosZ! - y2 * sinZ!), sceneFloat(x2 * sinZ! + y2 * cosZ!), sceneFloat(z2)];
}

function sceneFloat(value: number): number {
  const normalized = Math.abs(value) < 1e-7 ? 0 : Math.fround(value);
  return Object.is(normalized, -0) ? 0 : normalized;
}

function generatedPosition(value: number, entityId: string): number {
  const normalized = sceneFloat(value);
  if (normalized < -1_000 || normalized > 1_000) throw new Error(`Generated entity '${entityId}' position exceeds the -1000..1000 scene bound.`);
  return normalized;
}
