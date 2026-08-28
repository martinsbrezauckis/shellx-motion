import { describe, expect, it } from "vitest";
import {
  compileMotionLayout,
  MAX_MOTION_LAYOUT_COMPILED_INSTANCES,
  MAX_MOTION_LAYOUT_COMPILED_MEMORY_BYTES,
  MAX_MOTION_LAYOUT_COMPILED_WORK,
  MAX_MOTION_LAYOUT_PLAN_BYTES,
  type MotionLayoutChild,
  type MotionLayoutCompileRequest,
  type MotionLayoutCompiledPlan,
  type MotionLayoutRepeater,
} from "./motion-layout";
import { deterministicRadialUnitCircle, fixedRadialDegrees } from "./motion-layout-radial";

describe("Motion layout Core compiler", () => {
  it("solves row, column, and stack intent with fixed and fill sizing", () => {
    const row = baseRequest();
    row.layout = { ...row.layout, distribution: "space-between" };
    const rowPlan = plan(row);
    expect(rowPlan.instances.map((instance) => instance.transform)).toEqual([
      expect.objectContaining({ x: 10, y: 140, width: 30, height: 20 }),
      expect.objectContaining({ x: 260, y: 140, width: 30, height: 20 }),
    ]);

    const column = baseRequest();
    column.layout = { ...column.layout, kind: "column", distribution: "end", align: { x: "end", y: "start" } };
    const columnPlan = plan(column);
    expect(columnPlan.instances.map((instance) => instance.transform)).toEqual([
      expect.objectContaining({ x: 260, y: 240 }),
      expect.objectContaining({ x: 260, y: 270 }),
    ]);

    const stack = baseRequest();
    stack.layout = { ...stack.layout, kind: "stack", gap: 0, align: { x: "center", y: "end" } };
    const stackPlan = plan(stack);
    expect(stackPlan.instances.map((instance) => instance.transform)).toEqual([
      expect.objectContaining({ x: 135, y: 270 }),
      expect.objectContaining({ x: 135, y: 270 }),
    ]);

    const filled = baseRequest();
    filled.layout = { ...filled.layout, width: 120, height: 60, align: { x: "start", y: "start" } };
    filled.children = [fillChild("a"), fillChild("b")];
    filled.ownership = { ...filled.ownership, childIds: ["a", "b"] };
    expect(plan(filled).instances.map((instance) => instance.transform.width)).toEqual([45, 45]);

    const stretched = baseRequest();
    stretched.layout = { ...stretched.layout, align: { x: "start", y: "stretch" } };
    expect(plan(stretched).instances.map((instance) => instance.transform)).toEqual([
      expect.objectContaining({ y: 10, height: 280 }),
      expect.objectContaining({ y: 10, height: 280 }),
    ]);
  });

  it("solves grid and radial placements and reflows deterministically on resize", () => {
    const grid = baseRequest();
    grid.layout = { ...grid.layout, kind: "grid", width: 100, height: 100, columns: 2, align: { x: "center", y: "center" } };
    grid.children = [fillChild("a"), fillChild("b")];
    const small = plan(grid);
    expect(small.instances.map((instance) => instance.transform)).toEqual([
      expect.objectContaining({ x: 10, y: 10, width: 35, height: 80 }),
      expect.objectContaining({ x: 55, y: 10, width: 35, height: 80 }),
    ]);
    grid.layout = { ...grid.layout, width: 200 };
    expect(plan(grid).instances.map((instance) => instance.transform.width)).toEqual([85, 85]);

    const radial = baseRequest();
    radial.layout = {
      ...radial.layout,
      kind: "radial",
      width: 100,
      height: 100,
      padding: { top: 0, right: 0, bottom: 0, left: 0 },
      gap: 0,
      radius: 20,
      startAngleDeg: 0,
      sweepAngleDeg: 180,
      distribution: "space-between",
      align: { x: "center", y: "center" },
    };
    expect(plan(radial).instances.map((instance) => instance.transform)).toEqual([
      expect.objectContaining({ x: 55, y: 40, width: 30, height: 20 }),
      expect.objectContaining({ x: 15, y: 40, width: 30, height: 20 }),
    ]);

    // The radial path is integer CORDIC, not host libm; these cardinal values are exact ABI cases.
    expect(deterministicRadialUnitCircle(fixedRadialDegrees(0))).toEqual({ cos: 1, sin: 0 });
    expect(deterministicRadialUnitCircle(fixedRadialDegrees(90))).toEqual({ cos: 0, sin: 1 });
    expect(deterministicRadialUnitCircle(fixedRadialDegrees(-90))).toEqual({ cos: 0, sin: -1 });
    expect(deterministicRadialUnitCircle(fixedRadialDegrees(360.25))).toEqual(deterministicRadialUnitCircle(fixedRadialDegrees(0.25)));
    const nonCardinal = deterministicRadialUnitCircle(fixedRadialDegrees(12.345678901234567));
    expect(nonCardinal).toEqual({ cos: 0.9768754260623056, sin: 0.2138092653642234 });
  });

  it("expands a bounded repeater into ordinary transforms, opacity, and staggered timing", () => {
    const source = fixedChild("ornament");
    const request: MotionLayoutCompileRequest = {
      ...baseRequest(),
      ownership: { schema: "shellx-motion/layout-ownership-input@1", ownerId: "external-owner", childIds: ["ornament"] },
      layout: { ...baseRequest().layout, kind: "stack", width: 100, height: 100, gap: 0, padding: { top: 0, right: 0, bottom: 0, left: 0 } },
      children: [source],
      repeaters: [{
        schema: "shellx-motion/repeater@1",
        sourceId: "ornament",
        count: 3,
        transformDelta: { x: 10, y: -5, scale: 0.25, rotation: 15 },
        opacityDelta: -0.2,
        indexTimeStaggerMs: 40,
      }],
    };
    const compiled = plan(request);
    expect(compiled.ownershipJoin).toBe("external-adapter-required");
    expect(compiled.instances).toEqual([
      expect.objectContaining({ sourceId: "ornament", instanceIndex: 0, transform: expect.objectContaining({ x: 0, y: 40, scale: 1, rotation: 0, opacity: 1 }), timing: { startMs: 0, durationMs: 100 } }),
      expect.objectContaining({ sourceId: "ornament", instanceIndex: 1, transform: expect.objectContaining({ x: 10, y: 35, scale: 1.25, rotation: 15, opacity: 0.8 }), timing: { startMs: 40, durationMs: 100 } }),
      expect.objectContaining({ sourceId: "ornament", instanceIndex: 2, transform: expect.objectContaining({ x: 20, y: 30, scale: 1.5, rotation: 30, opacity: 0.6 }), timing: { startMs: 80, durationMs: 100 } }),
    ]);
  });

  it("has locale-independent canonical fingerprint input and code-unit ordered repeater records", () => {
    const input = baseRequest();
    const reordered = Object.fromEntries(Object.entries(input).reverse());
    const first = plan(input);
    const second = plan(reordered);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.fingerprintInput).toBe(first.fingerprintInput);
    expect(first.fingerprintInput).toContain("\"children\"");

    const structuralOrder = baseRequest();
    structuralOrder.children = [fixedChild("a"), fixedChild("Z")];
    structuralOrder.ownership = { ...structuralOrder.ownership, childIds: ["a", "Z"] };
    expect(plan(structuralOrder).instances.map((instance) => instance.sourceId)).toEqual(["a", "Z"]);
    structuralOrder.repeaters = [repeater("Z"), repeater("a")];
    expect(compileMotionLayout(structuralOrder).status).toBe("ok");
    structuralOrder.repeaters = [repeater("a"), repeater("Z")];
    expect(refusalCodes(structuralOrder)).toContain("identifier.order");
  });

  it("keeps overflow deterministic without dropping a child intent", () => {
    const clipped = baseRequest();
    clipped.children = [{ ...clipped.children[0], transform: { ...clipped.children[0].transform, x: 500 } }];
    clipped.ownership = { ...clipped.ownership, childIds: ["a"] };
    expect(plan(clipped).instances).toEqual([expect.objectContaining({ outsideBounds: true, overflow: "clipped" })]);
    clipped.layout = { ...clipped.layout, overflow: "allow" };
    expect(plan(clipped).instances).toEqual([expect.objectContaining({ outsideBounds: true, overflow: "visible" })]);

    const physicalTransform = baseRequest();
    physicalTransform.children = [{ ...physicalTransform.children[0], transform: { ...physicalTransform.children[0].transform, x: 250, scale: 2, rotation: 45 } }];
    physicalTransform.ownership = { ...physicalTransform.ownership, childIds: ["a"] };
    expect(plan(physicalTransform).instances[0]).toMatchObject({ outsideBounds: false, overflow: "visible" });
  });

  it("fails closed for hostile keys, non-finite numbers, ownership mismatch, and invalid repeater output", () => {
    const unknownField = baseRequest();
    const layoutWithUnknown = { ...unknownField.layout, execute: "not-data" };
    expect(refusalCodes({ ...unknownField, layout: layoutWithUnknown })).toContain("field.unknown");

    const nonFinite = baseRequest();
    nonFinite.children = [{ ...nonFinite.children[0], transform: { ...nonFinite.children[0].transform, x: Number.NaN } }, nonFinite.children[1]];
    expect(refusalCodes(nonFinite)).toContain("number.range");

    const ownershipMismatch = baseRequest();
    ownershipMismatch.ownership = { ...ownershipMismatch.ownership, childIds: ["a", "different"] };
    expect(refusalCodes(ownershipMismatch)).toContain("ownership.children");

    const ownershipSelf = baseRequest();
    ownershipSelf.ownership = { ...ownershipSelf.ownership, ownerId: "a" };
    expect(refusalCodes(ownershipSelf)).toContain("ownership.self");

    const opacityOverflow = baseRequest();
    opacityOverflow.repeaters = [{
      schema: "shellx-motion/repeater@1", sourceId: "a", count: 2,
      transformDelta: { x: 0, y: 0, scale: 0, rotation: 0 }, opacityDelta: 0.1, indexTimeStaggerMs: 0,
    }];
    expect(refusalCodes(opacityOverflow)).toContain("repeater.derived_opacity");

    const positionOverflow = baseRequest();
    positionOverflow.children = [{ ...positionOverflow.children[0], transform: { ...positionOverflow.children[0].transform, x: 1_000_000 } }, positionOverflow.children[1]];
    positionOverflow.repeaters = [{ ...repeater("a"), count: 2, transformDelta: { x: 1, y: 0, scale: 0, rotation: 0 } }];
    expect(refusalCodes(positionOverflow)).toContain("repeater.derived_position");

    const rotationOverflow = baseRequest();
    rotationOverflow.children = [{ ...rotationOverflow.children[0], transform: { ...rotationOverflow.children[0].transform, rotation: 360_000 } }, rotationOverflow.children[1]];
    rotationOverflow.repeaters = [{ ...repeater("a"), count: 2, transformDelta: { x: 0, y: 0, scale: 0, rotation: 1 } }];
    expect(refusalCodes(rotationOverflow)).toContain("repeater.derived_rotation");

    const layoutPositionOverflow = baseRequest();
    layoutPositionOverflow.layout = { ...layoutPositionOverflow.layout, width: 1_000_000, height: 1_000_000 };
    layoutPositionOverflow.children = [{ ...layoutPositionOverflow.children[0], transform: { ...layoutPositionOverflow.children[0].transform, x: 1_000_000 } }, layoutPositionOverflow.children[1]];
    expect(refusalCodes(layoutPositionOverflow)).toContain("compiled.position");

    const ignoredStackGap = baseRequest();
    ignoredStackGap.layout = { ...ignoredStackGap.layout, kind: "stack" };
    expect(refusalCodes(ignoredStackGap)).toContain("layout.gap_unsupported");

    const radialStretch = baseRequest();
    radialStretch.layout = { ...radialStretch.layout, kind: "radial", radius: 20, startAngleDeg: 0, sweepAngleDeg: 180, align: { x: "stretch", y: "center" } };
    expect(refusalCodes(radialStretch)).toContain("layout.stretch_unsupported");

    const rowMainAxisStretch = baseRequest();
    rowMainAxisStretch.layout = { ...rowMainAxisStretch.layout, align: { x: "stretch", y: "start" } };
    expect(refusalCodes(rowMainAxisStretch)).toContain("layout.main_axis_align_unsupported");
  });

  it("refuses instance, work, memory, and canonical plan ceilings before compiling", () => {
    const tooManyInstances = repeatedRequest(5, 128, "row");
    expect(refusalCodes(tooManyInstances)).toContain("budget.instances");

    const tooMuchWork = repeatedRequest(4, 128, "radial");
    expect(refusalCodes(tooMuchWork)).toContain("budget.work");

    const longSourceIds = repeatedRequest(4, 128, "row", true);
    const codes = refusalCodes(longSourceIds);
    expect(codes).toContain("budget.plan_bytes");
    expect(refusalCodes(memoryBoundRequest())).toContain("budget.memory");
    expect(MAX_MOTION_LAYOUT_COMPILED_INSTANCES).toBe(512);
    expect(MAX_MOTION_LAYOUT_COMPILED_WORK).toBe(7_000);
    expect(MAX_MOTION_LAYOUT_COMPILED_MEMORY_BYTES).toBe(192 * 1024);
    expect(MAX_MOTION_LAYOUT_PLAN_BYTES).toBe(128 * 1024);
  });
});

function baseRequest(): MotionLayoutCompileRequest {
  return {
    schema: "shellx-motion/layout-compile@1",
    ownership: { schema: "shellx-motion/layout-ownership-input@1", ownerId: "external-owner", childIds: ["a", "b"] },
    layout: {
      schema: "shellx-motion/layout@1", kind: "row", width: 300, height: 300,
      padding: { top: 10, right: 10, bottom: 10, left: 10 }, gap: 10,
      align: { x: "start", y: "center" }, distribution: "start", overflow: "clip",
    },
    children: [fixedChild("a"), fixedChild("b")],
    repeaters: [],
  };
}

function fixedChild(id: string): MotionLayoutChild {
  return {
    id,
    sizing: { width: { mode: "fixed", value: 30 }, height: { mode: "fixed", value: 20 } },
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    timing: { startMs: 0, durationMs: 100 },
  };
}

function fillChild(id: string): MotionLayoutChild {
  return {
    ...fixedChild(id),
    sizing: { width: { mode: "fill", min: 10, max: 100 }, height: { mode: "fill", min: 10, max: 100 } },
  };
}

function repeater(sourceId: string): MotionLayoutRepeater {
  return {
    schema: "shellx-motion/repeater@1", sourceId, count: 1,
    transformDelta: { x: 0, y: 0, scale: 0, rotation: 0 }, opacityDelta: 0, indexTimeStaggerMs: 0,
  };
}

function repeatedRequest(sourceCount: number, count: number, kind: "row" | "radial", longIds = false): MotionLayoutCompileRequest {
  const children = Array.from({ length: sourceCount }, (_value, index) => fixedChild(longIds
    ? `${String(index).padStart(3, "0")}-${"x".repeat(124)}`
    : `source-${String(index).padStart(3, "0")}`));
  const repeaters: MotionLayoutRepeater[] = children.map((child) => ({
    schema: "shellx-motion/repeater@1", sourceId: child.id, count,
    transformDelta: { x: 0, y: 0, scale: 0, rotation: 0 }, opacityDelta: 0, indexTimeStaggerMs: 0,
  }));
  const base = baseRequest().layout;
  const layout = kind === "radial"
    ? { ...base, kind: "radial" as const, radius: 20, startAngleDeg: 0, sweepAngleDeg: 360 }
    : { ...base, kind: "row" as const };
  return {
    schema: "shellx-motion/layout-compile@1",
    ownership: { schema: "shellx-motion/layout-ownership-input@1", ownerId: "external-owner", childIds: children.map((child) => child.id) },
    layout,
    children,
    repeaters,
  };
}

function memoryBoundRequest(): MotionLayoutCompileRequest {
  const children = Array.from({ length: 256 }, (_value, index) => fixedChild(`${String(index).padStart(3, "0")}-${"m".repeat(124)}`));
  return {
    schema: "shellx-motion/layout-compile@1",
    ownership: { schema: "shellx-motion/layout-ownership-input@1", ownerId: "external-owner", childIds: children.map((child) => child.id) },
    layout: baseRequest().layout,
    children,
    repeaters: children.slice(0, 2).map((child) => ({
      schema: "shellx-motion/repeater@1", sourceId: child.id, count: 128,
      transformDelta: { x: 0, y: 0, scale: 0, rotation: 0 }, opacityDelta: 0, indexTimeStaggerMs: 0,
    })),
  };
}

function plan(value: unknown): MotionLayoutCompiledPlan {
  const result = compileMotionLayout(value);
  if (result.status !== "ok") throw new Error(result.issues.map((issue) => `${issue.code}: ${issue.message}`).join("\n"));
  return result.plan;
}

function refusalCodes(value: unknown): string[] {
  const result = compileMotionLayout(value);
  if (result.status === "ok") throw new Error("expected a refusal");
  return result.issues.map((issue) => issue.code);
}
