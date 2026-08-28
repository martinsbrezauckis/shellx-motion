import {
  type MotionColumnLayout,
  type MotionGridLayout,
  type MotionLayout,
  type MotionLayoutAlignment,
  type MotionLayoutChild,
  type MotionLayoutCompiledInstance,
  type MotionLayoutCompiledTransform,
  type MotionLayoutDistribution,
  type MotionLayoutFillSize,
  type MotionLayoutRepeater,
  type MotionLayoutSize,
  type MotionRadialLayout,
  type MotionRowLayout,
  type MotionStackLayout,
} from "./motion-layout-types";
import { quantize } from "./motion-layout-safety";
import { deterministicRadialUnitCircle, fixedRadialDegrees, fixedRadialFraction } from "./motion-layout-radial";

interface LayoutSlot { source: MotionLayoutChild; instanceIndex: number; repeater?: MotionLayoutRepeater }
interface LayoutBox { x: number; y: number; width: number; height: number }

export function expandMotionLayoutSlots(children: MotionLayoutChild[], repeaters: MotionLayoutRepeater[]): LayoutSlot[] {
  const bySource = new Map(repeaters.map((repeater) => [repeater.sourceId, repeater]));
  const slots: LayoutSlot[] = [];
  for (const source of children) {
    const repeater = bySource.get(source.id);
    const count = repeater?.count ?? 1;
    for (let instanceIndex = 0; instanceIndex < count; instanceIndex += 1) slots.push({ source, instanceIndex, ...(repeater ? { repeater } : {}) });
  }
  return slots;
}

export function solveMotionLayout(layout: MotionLayout, slots: LayoutSlot[]): LayoutBox[] {
  if (layout.kind === "row") return solveRow(layout, slots);
  if (layout.kind === "column") return solveColumn(layout, slots);
  if (layout.kind === "stack") return solveStack(layout, slots);
  if (layout.kind === "grid") return solveGrid(layout, slots);
  return solveRadial(layout, slots);
}

export function compileMotionLayoutInstance(layout: MotionLayout, box: LayoutBox, slot: LayoutSlot): MotionLayoutCompiledInstance {
  const { source, instanceIndex, repeater } = slot;
  const delta = repeater?.transformDelta;
  const transform: MotionLayoutCompiledTransform = {
    x: quantize(box.x + source.transform.x + (delta?.x ?? 0) * instanceIndex),
    y: quantize(box.y + source.transform.y + (delta?.y ?? 0) * instanceIndex),
    width: quantize(box.width), height: quantize(box.height),
    scale: quantize(source.transform.scale + (delta?.scale ?? 0) * instanceIndex),
    rotation: quantize(source.transform.rotation + (delta?.rotation ?? 0) * instanceIndex),
    opacity: quantize(source.transform.opacity + (repeater?.opacityDelta ?? 0) * instanceIndex),
  };
  const timing = { startMs: source.timing.startMs + (repeater?.indexTimeStaggerMs ?? 0) * instanceIndex, durationMs: source.timing.durationMs };
  const content = contentBox(layout);
  const outsideBounds = isOutsideUnscaledLayoutBox(transform, content);
  return { sourceId: source.id, instanceIndex, transform, timing, outsideBounds, overflow: layout.overflow === "clip" && outsideBounds ? "clipped" : "visible" };
}

function solveRow(layout: MotionRowLayout, slots: LayoutSlot[]): LayoutBox[] {
  const content = contentBox(layout);
  const widths = resolveMainSizes(slots.map((slot) => slot.source.sizing.width), content.width, layout.gap);
  const heights = slots.map((slot) => resolveCrossSize(slot.source.sizing.height, content.height, layout.align.y));
  const used = widths.reduce((sum, width) => sum + width, 0) + layout.gap * Math.max(0, slots.length - 1);
  const distribution = distribute(content.width, used, slots.length, layout.distribution);
  let x = content.x + distribution.offset;
  return slots.map((slot, index) => {
    const box = { x, y: content.y + alignOffset(content.height, heights[index], layout.align.y), width: widths[index], height: heights[index] };
    x += widths[index] + layout.gap + distribution.extraGap;
    return box;
  });
}

function solveColumn(layout: MotionColumnLayout, slots: LayoutSlot[]): LayoutBox[] {
  const content = contentBox(layout);
  const heights = resolveMainSizes(slots.map((slot) => slot.source.sizing.height), content.height, layout.gap);
  const widths = slots.map((slot) => resolveCrossSize(slot.source.sizing.width, content.width, layout.align.x));
  const used = heights.reduce((sum, height) => sum + height, 0) + layout.gap * Math.max(0, slots.length - 1);
  const distribution = distribute(content.height, used, slots.length, layout.distribution);
  let y = content.y + distribution.offset;
  return slots.map((slot, index) => {
    const box = { x: content.x + alignOffset(content.width, widths[index], layout.align.x), y, width: widths[index], height: heights[index] };
    y += heights[index] + layout.gap + distribution.extraGap;
    return box;
  });
}

function solveStack(layout: MotionStackLayout, slots: LayoutSlot[]): LayoutBox[] {
  const content = contentBox(layout);
  return slots.map((slot) => {
    const width = resolveCrossSize(slot.source.sizing.width, content.width, layout.align.x);
    const height = resolveCrossSize(slot.source.sizing.height, content.height, layout.align.y);
    return { x: content.x + alignOffset(content.width, width, layout.align.x), y: content.y + alignOffset(content.height, height, layout.align.y), width, height };
  });
}

function solveGrid(layout: MotionGridLayout, slots: LayoutSlot[]): LayoutBox[] {
  const content = contentBox(layout);
  const rows = Math.ceil(slots.length / layout.columns);
  const cellWidth = Math.max(0, (content.width - layout.gap * (layout.columns - 1)) / layout.columns);
  const cellHeight = Math.max(0, (content.height - layout.gap * Math.max(0, rows - 1)) / rows);
  return slots.map((slot, index) => {
    const column = index % layout.columns;
    const row = Math.floor(index / layout.columns);
    const width = resolveCrossSize(slot.source.sizing.width, cellWidth, layout.align.x);
    const height = resolveCrossSize(slot.source.sizing.height, cellHeight, layout.align.y);
    const cellX = content.x + column * (cellWidth + layout.gap);
    const cellY = content.y + row * (cellHeight + layout.gap);
    return { x: cellX + alignOffset(cellWidth, width, layout.align.x), y: cellY + alignOffset(cellHeight, height, layout.align.y), width, height };
  });
}

function solveRadial(layout: MotionRadialLayout, slots: LayoutSlot[]): LayoutBox[] {
  const content = contentBox(layout);
  return slots.map((slot, index) => {
    const width = resolveCrossSize(slot.source.sizing.width, content.width, layout.align.x);
    const height = resolveCrossSize(slot.source.sizing.height, content.height, layout.align.y);
    const unit = deterministicRadialUnitCircle(radialAngle(layout, slots.length, index));
    const anchorX = content.x + content.width / 2 + unit.cos * layout.radius;
    const anchorY = content.y + content.height / 2 + unit.sin * layout.radius;
    return { x: anchorX - radialAlignOffset(width, layout.align.x), y: anchorY - radialAlignOffset(height, layout.align.y), width, height };
  });
}

function contentBox(layout: MotionLayout): LayoutBox {
  return { x: layout.padding.left, y: layout.padding.top, width: layout.width - layout.padding.left - layout.padding.right, height: layout.height - layout.padding.top - layout.padding.bottom };
}

function radialAngle(layout: MotionRadialLayout, count: number, index: number): bigint {
  const start = fixedRadialDegrees(layout.startAngleDeg);
  const sweep = fixedRadialDegrees(layout.sweepAngleDeg);
  const gap = fixedRadialDegrees(layout.gap);
  if (layout.distribution === "space-between") return start + (count <= 1 ? 0n : fixedRadialFraction(sweep, index, count - 1));
  if (layout.distribution === "space-around") return start + fixedRadialFraction(sweep, index * 2 + 1, count * 2);
  if (layout.distribution === "space-evenly") return start + fixedRadialFraction(sweep, index + 1, count + 1);
  const span = gap * BigInt(Math.max(0, count - 1));
  if (layout.distribution === "center") return start + (sweep - span) / 2n + gap * BigInt(index);
  if (layout.distribution === "end") return start + sweep - span + gap * BigInt(index);
  return start + gap * BigInt(index);
}

function resolveMainSizes(sizes: MotionLayoutSize[], available: number, gap: number): number[] {
  const values = sizes.map((size) => size.mode === "fixed" ? size.value : size.min);
  let remaining = Math.max(0, available - gap * Math.max(0, sizes.length - 1) - values.reduce((sum, value) => sum + value, 0));
  let active = sizes.map((size, index) => size.mode === "fill" && values[index] < size.max ? index : -1).filter((index) => index >= 0);
  while (remaining > 0.0000001 && active.length) {
    const share = remaining / active.length;
    let consumed = 0;
    const next: number[] = [];
    for (const index of active) {
      const size = sizes[index] as MotionLayoutFillSize;
      const addition = Math.min(share, size.max - values[index]);
      values[index] += addition;
      consumed += addition;
      if (values[index] < size.max - 0.0000001) next.push(index);
    }
    if (consumed <= 0) break;
    remaining -= consumed;
    active = next;
  }
  return values.map(quantize);
}

function resolveCrossSize(size: MotionLayoutSize, available: number, alignment: MotionLayoutAlignment): number {
  if (alignment === "stretch") return quantize(available);
  return quantize(size.mode === "fixed" ? size.value : Math.min(size.max, Math.max(size.min, available)));
}

function distribute(available: number, used: number, count: number, distribution: MotionLayoutDistribution): { offset: number; extraGap: number } {
  const free = Math.max(0, available - used);
  if (distribution === "center") return { offset: free / 2, extraGap: 0 };
  if (distribution === "end") return { offset: free, extraGap: 0 };
  if (distribution === "space-between" && count > 1) return { offset: 0, extraGap: free / (count - 1) };
  if (distribution === "space-around" && count > 0) return { offset: free / count / 2, extraGap: free / count };
  if (distribution === "space-evenly" && count > 0) return { offset: free / (count + 1), extraGap: free / (count + 1) };
  return { offset: 0, extraGap: 0 };
}

function alignOffset(available: number, size: number, alignment: MotionLayoutAlignment): number {
  if (alignment === "center") return (available - size) / 2;
  if (alignment === "end") return available - size;
  return 0;
}

function radialAlignOffset(size: number, alignment: MotionLayoutAlignment): number {
  if (alignment === "start") return 0;
  if (alignment === "end") return size;
  return size / 2;
}

/**
 * Layout containment is intentionally not a painted-pixel test. It uses the resolved, unscaled,
 * unrotated top-left box after x/y intent. Scale and rotation require an owner origin and renderer
 * geometry contract, which this pure compiler deliberately does not invent.
 */
function isOutsideUnscaledLayoutBox(transform: MotionLayoutCompiledTransform, content: LayoutBox): boolean {
  return transform.x < content.x || transform.y < content.y
    || transform.x + transform.width > content.x + content.width || transform.y + transform.height > content.y + content.height;
}
