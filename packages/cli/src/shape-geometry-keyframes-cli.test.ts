import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  packagePatchWorkspacePaths,
} from "./debug-context-cli.js";
import { cliAuthoringRoots } from "./debug-authoring-roots.js";
import { createCliShapeGeometryKeyframeHostReceiptStore } from "./shape-geometry-keyframes-host-receipt.js";
import {
  isShapeGeometryKeyframeDebugCommand,
  shapeGeometryKeyframeDebugArgs,
} from "./shape-geometry-keyframes-cli.js";

const UPSERT = "motion.timeline.shape.geometry-keyframes.upsert" as const;
const DELETE = "motion.timeline.shape.geometry-keyframes.delete" as const;
const MOVE = "motion.timeline.shape.geometry-keyframes.move" as const;
const INSPECT = "motion.timeline.shape.geometry-keyframes.inspect" as const;
const option = (argv: string[], name: string) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const snapshot = { atUs: 500_000, geometry: { schema: "shellx-motion/shape-geometry@1", kind: "line", viewBox: { x: 0, y: 0, width: 100, height: 100 }, points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] } };

describe("shape geometry keyframe CLI projection", () => {
  it("maps the exact inspect, upsert, delete, and move argv forms without a caller receipt root", () => {
    expect(shapeGeometryKeyframeDebugArgs(INSPECT, ["--layer", "shape"], "/source", option))
      .toEqual({ packageRoot: "/source", layerId: "shape" });
    expect(shapeGeometryKeyframeDebugArgs(UPSERT, ["--out", "/out", "--layer-id", "shape", "--created-by", "cli-test", "--snapshot-json", JSON.stringify(snapshot)], "/source", option))
      .toEqual({ packageRoot: "/source", outDir: "/out", layerId: "shape", createdBy: "cli-test", snapshot });
    expect(shapeGeometryKeyframeDebugArgs(DELETE, ["--package-dir", "/out", "--layer", "shape", "--at-us", "500000"], "/source", option))
      .toEqual({ packageRoot: "/source", outDir: "/out", layerId: "shape", atUs: 500_000 });
    expect(shapeGeometryKeyframeDebugArgs(MOVE, ["--out", "/out", "--layer", "shape", "--from-at-us", "0", "--to-at-us", "750000"], "/source", option))
      .toEqual({ packageRoot: "/source", outDir: "/out", layerId: "shape", fromAtUs: 0, toAtUs: 750_000 });
  });

  it("refuses a caller receipt root and keeps generic property keyframes outside this adapter", () => {
    expect(() => shapeGeometryKeyframeDebugArgs(UPSERT, ["--receipts-root", "/caller", "--snapshot-json", JSON.stringify(snapshot)], "/source", option))
      .toThrow("does not accept caller-selected receipts roots");
    expect(shapeGeometryKeyframeDebugArgs("motion.timeline.keyframe.upsert", [], "/source", option)).toBeNull();
    expect(isShapeGeometryKeyframeDebugCommand("motion.timeline.keyframe.upsert")).toBe(false);
  });

  it("derives workspace-anchor paths from typed authoring roots and includes a host-minted receipt scope", () => {
    const inspectArgs = { packageRoot: "/workspace/source", layerId: "shape" };
    const upsertArgs = { packageRoot: "/workspace/source", outDir: "/workspace/out/revision", layerId: "shape", snapshot };
    expect(packagePatchWorkspacePaths(inspectArgs, cliAuthoringRoots(INSPECT, inspectArgs))).toEqual(["/workspace"]);
    expect(packagePatchWorkspacePaths(upsertArgs, cliAuthoringRoots(UPSERT, upsertArgs))).toEqual(["/workspace", "/workspace/out"]);
    const store = createCliShapeGeometryKeyframeHostReceiptStore(UPSERT, { workspaceRoot: "/workspace" });
    expect(store?.receiptsRoot.startsWith(`${join(resolve("/workspace"), ".scratch", "cli-host-receipts", "timeline-shape-geometry-keyframes")}/`)).toBe(true);
    expect(packagePatchWorkspacePaths(upsertArgs, cliAuthoringRoots(UPSERT, upsertArgs), store?.receiptsRoot))
      .toEqual(["/workspace", "/workspace/out", store?.receiptsRoot]);
    const genericArgs = { packageRoot: "/workspace/source", outDir: "/workspace/out/revision" };
    expect(packagePatchWorkspacePaths(genericArgs, cliAuthoringRoots("motion.timeline.keyframe.upsert", genericArgs)))
      .toEqual(["/workspace", "/workspace/out"]);
    expect(createCliShapeGeometryKeyframeHostReceiptStore(INSPECT)).toBeUndefined();
  });
});
