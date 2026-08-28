import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  evaluateMotionGradientColorKeyframes,
  loadSchema,
  readMotionDocument,
  validateDocument,
  type MotionDocument,
  type MotionGradientColorKeyframesMutation,
  type MotionPackage,
} from "@shellx-motion/core";
import { hasAtomicCOWAuthority } from "@shellx-motion/core/test-support";
import {
  applyTimelineGradientColorKeyframeIntent,
  dispatchTimelineGradientColorKeyframeAuthoringCommand,
  type TimelineGradientColorKeyframeAuthoringServices,
  type TimelineGradientColorKeyframeCore,
} from "./timeline-gradient-color-keyframes-authoring.js";
import {
  isTimelineGradientColorKeyframeCommand,
  readTimelineGradientColorKeyframeIntent,
  TIMELINE_GRADIENT_COLOR_KEYFRAME_COMMANDS,
} from "./timeline-gradient-color-keyframes.js";

const SNAPSHOT = { atUs: 500_000, colors: ["#0000ff", "#ffffff"], easing: "linear" } as const;
const atomicCOW = hasAtomicCOWAuthority(tmpdir()) ? it : it.skip;

describe("timeline gradient color keyframe Debug boundary", () => {
  it("parses the exact four-command vocabulary without dropping color snapshots or easing", () => {
    expect(readTimelineGradientColorKeyframeIntent(TIMELINE_GRADIENT_COLOR_KEYFRAME_COMMANDS.inspect, { packageRoot: "/package", layerId: "shape" }))
      .toEqual({ ok: true, intent: { kind: "inspect", layerId: "shape" } });
    expect(readTimelineGradientColorKeyframeIntent(TIMELINE_GRADIENT_COLOR_KEYFRAME_COMMANDS.upsert, common({ snapshot: SNAPSHOT })))
      .toEqual({ ok: true, intent: { kind: "upsert", layerId: "shape", snapshot: SNAPSHOT } });
    expect(readTimelineGradientColorKeyframeIntent(TIMELINE_GRADIENT_COLOR_KEYFRAME_COMMANDS.delete, common({ atUs: 500_000 })))
      .toEqual({ ok: true, intent: { kind: "delete", layerId: "shape", atUs: 500_000 } });
    expect(readTimelineGradientColorKeyframeIntent(TIMELINE_GRADIENT_COLOR_KEYFRAME_COMMANDS.move, common({ fromAtUs: 0, toAtUs: 750_000 })))
      .toEqual({ ok: true, intent: { kind: "move", layerId: "shape", fromAtUs: 0, toAtUs: 750_000 } });
    expect(isTimelineGradientColorKeyframeCommand("motion.timeline.gradient.color-keyframes.unknown")).toBe(false);
  });

  it("refuses unknown, no-op, and accessor-bearing input before package loading", async () => {
    let packageLoads = 0;
    const services = unavailableServices(() => { packageLoads += 1; });
    const unknown = await dispatchTimelineGradientColorKeyframeAuthoringCommand(
      TIMELINE_GRADIENT_COLOR_KEYFRAME_COMMANDS.upsert,
      common({ snapshot: { ...SNAPSHOT, accidental: true } }),
      services,
    );
    expect(unknown).toMatchObject({ ok: false, error: { code: "invalid_args", message: "snapshot has unknown field accidental." } });
    expect(readTimelineGradientColorKeyframeIntent(TIMELINE_GRADIENT_COLOR_KEYFRAME_COMMANDS.move, common({ fromAtUs: 5, toAtUs: 5 })))
      .toEqual({ ok: false, problem: "fromAtUs and toAtUs must differ for an ordered snapshot move." });
    const accessor = common({ snapshot: SNAPSHOT });
    Object.defineProperty(accessor, "snapshot", { enumerable: true, get: () => SNAPSHOT });
    expect(readTimelineGradientColorKeyframeIntent(TIMELINE_GRADIENT_COLOR_KEYFRAME_COMMANDS.upsert, accessor))
      .toEqual({ ok: false, problem: "Arguments.snapshot must be a data property." });
    expect(packageLoads).toBe(0);
  });

  it("uses the Core inspection export read-only and routes every mutation to exactly one Core operation", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-debug-gradient-keyframe-inspect-"));
    try {
      const inspected = await dispatchTimelineGradientColorKeyframeAuthoringCommand(
        TIMELINE_GRADIENT_COLOR_KEYFRAME_COMMANDS.inspect,
        { packageRoot: root, layerId: "shape" },
        { authoringInputRoots: [tmpdir()], packageLoader: async () => inMemoryPackage(root) },
      );
      expect(inspected).toMatchObject({
        ok: true,
        result: { inspection: { layerId: "shape", colorKeyframes: { keyframes: [{ atUs: 0, colors: ["#ff0000", "#000000"], easing: "linear" }, { atUs: 1_000_000, colors: ["#0000ff", "#ffffff"] }] } } },
      });

      const calls: string[] = [];
      const services: TimelineGradientColorKeyframeAuthoringServices = { gradientColorKeyframes: fakeCore(calls) };
      for (const intent of [
        { kind: "upsert", layerId: "shape", snapshot: SNAPSHOT },
        { kind: "delete", layerId: "shape", atUs: 500_000 },
        { kind: "move", layerId: "shape", fromAtUs: 0, toAtUs: 750_000 },
      ] as const) {
        expect(applyTimelineGradientColorKeyframeIntent(inMemoryPackage(root).motion, intent, services).layerId).toBe("shape");
      }
      expect(calls).toEqual(["upsert", "delete", "move"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("revalidates the complete document before output and leaves source bytes untouched", async () => {
    const root = await writePackage();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-gradient-keyframe-invalid-out-"));
    const before = await readFile(join(root, "motion.json"));
    try {
      const result = await dispatchTimelineGradientColorKeyframeAuthoringCommand(
        TIMELINE_GRADIENT_COLOR_KEYFRAME_COMMANDS.upsert,
        common({ packageRoot: root, outDir, snapshot: SNAPSHOT }),
        {
          authoringInputRoots: [tmpdir()],
          authoringOutputRoots: [tmpdir()],
          packageLoader: async () => inMemoryPackage(root),
          gradientColorKeyframes: invalidOutputCore(),
          isUnsafePackageOutputDirectory: async () => false,
          isEmptyOrAbsentDirectory: async () => true,
        },
      );
      expect(result).toMatchObject({ ok: false, error: { code: "timeline_gradient_color_keyframes_invalid", message: "Patched Motion document failed validation." } });
      expect(await readFile(join(root, "motion.json"))).toEqual(before);
    } finally {
      await Promise.all([rm(root, { recursive: true, force: true }), rm(outDir, { recursive: true, force: true })]);
    }
  });

  it("keeps omitted package fields JSON-clean across Core mutation revalidation", async () => {
    const parsed = readMotionDocument(JSON.parse(JSON.stringify(motion())));
    expect(Object.hasOwn(parsed, "background")).toBe(false);

    const mutation = applyTimelineGradientColorKeyframeIntent(parsed, {
      kind: "upsert", layerId: "shape", snapshot: SNAPSHOT,
    }, {});
    expect(await validateDocument(await loadSchema("motion"), mutation.motion)).toEqual({ ok: true });
  });

  atomicCOW("publishes the one COW receipt with canonical color-keyframe identity and ordering facts", async () => {
    const root = await writePackage();
    const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-debug-gradient-keyframe-cow-out-"));
    try {
      const result = await dispatchTimelineGradientColorKeyframeAuthoringCommand(
        TIMELINE_GRADIENT_COLOR_KEYFRAME_COMMANDS.upsert,
        common({ packageRoot: root, outDir, snapshot: SNAPSHOT, createdBy: "test" }),
        {
          authoringInputRoots: [tmpdir()], authoringOutputRoots: [tmpdir()],
          packageLoader: async (path) => (await import("@shellx-motion/core")).loadMotionPackage(path),
          isUnsafePackageOutputDirectory: async () => false,
          isEmptyOrAbsentDirectory: async (path) => (await readdir(path)).length === 0,
        },
      );
      expect(result).toMatchObject({ ok: true, result: { action: "inserted", index: 1, gradientColorKeyframes: { schema: "shellx-motion/gradient-color-keyframes@1", atUs: 500_000, fingerprint: expect.any(String), budget: { snapshotCount: 3, stopCount: 2 } } } });
      const receipt = JSON.parse(await readFile(join(outDir, "receipts", "timeline-gradient-color-keyframes-upsert.receipt.json"), "utf8"));
      expect(receipt).toMatchObject({ operation: "timeline.gradient.color-keyframes.upsert", status: "passed", output: { action: "inserted", gradientColorKeyframes: { fingerprint: expect.any(String), sourceSequenceSha256: expect.any(String), topologySha256: expect.any(String) } } });
    } finally {
      await Promise.all([rm(root, { recursive: true, force: true }), rm(outDir, { recursive: true, force: true })]);
    }
  });
});

function common(values: Record<string, unknown> = {}): Record<string, unknown> {
  return { packageRoot: "/package", outDir: "/out", layerId: "shape", ...values };
}

function inMemoryPackage(root: string): MotionPackage {
  return {
    root,
    manifest: {
      schema: "shellx-motion/package-manifest@1", id: "pkg_debug_gradient_keyframes", name: "Gradient keyframes",
      motion: "motion.json", assets: [], sourceApp: "shellx-motion", compatibility: { lanes: ["browser"], hosts: ["motion"] },
    },
    motion: motion(),
  } as unknown as MotionPackage;
}

function motion(): MotionDocument {
  return {
    schema: "shellx-motion/motion@1", id: "motion_debug_gradient_keyframes", name: "Gradient keyframes",
    durationMs: 1000, fps: 30, width: 100, height: 100, assets: [],
    layers: [{
      id: "shape", type: "shape", shape: "rect", startMs: 0, durationMs: 1000,
      transform: { x: 0, y: 0, width: 100, height: 100 },
      gradient: {
        type: "linear", angle: 0,
        stops: [{ offset: 0, color: "#ff0000" }, { offset: 1, color: "#000000" }],
        colorKeyframes: {
          schema: "shellx-motion/gradient-color-keyframes@1",
          keyframes: [{ atUs: 0, colors: ["#ff0000", "#000000"], easing: "linear" }, { atUs: 1_000_000, colors: ["#0000ff", "#ffffff"] }],
        },
      },
    }],
    provenance: { sourceApp: "test", createdBy: "test" },
  } as unknown as MotionDocument;
}

function evaluation() {
  const layer = motion().layers[0] as { gradient: unknown };
  const value = evaluateMotionGradientColorKeyframes({ gradient: layer.gradient, atUs: 0 });
  if (!value.ok) throw new Error(value.message);
  return value.evaluation;
}

function fakeCore(calls: string[]): TimelineGradientColorKeyframeCore {
  const mutate = (operation: string, action: MotionGradientColorKeyframesMutation["action"]) => (value: MotionDocument) => {
    calls.push(operation);
    const layer = value.layers[0]!;
    return { motion: value, layerId: "shape", layer, action, changedPaths: ["/layers/shape/gradient/colorKeyframes/keyframes"], index: 0, evaluation: evaluation() } as MotionGradientColorKeyframesMutation;
  };
  return {
    inspectMotionGradientColorKeyframes: () => { calls.push("inspect"); return { layerId: "shape", topology: { type: "linear", stopCount: 2, offsets: [0, 1] }, colorKeyframes: null, evaluation: null }; },
    upsertMotionGradientColorKeyframe: mutate("upsert", "inserted"),
    deleteMotionGradientColorKeyframe: mutate("delete", "deleted"),
    moveMotionGradientColorKeyframe: mutate("move", "moved"),
  };
}

function invalidOutputCore(): TimelineGradientColorKeyframeCore {
  const invalid = () => ({ ...motion(), width: -1 });
  const mutate = (action: MotionGradientColorKeyframesMutation["action"]) => () => ({
    motion: invalid(), layerId: "shape", layer: invalid().layers[0]!, action, changedPaths: ["/layers/shape/gradient/colorKeyframes/keyframes"], index: 0, evaluation: evaluation(),
  } as MotionGradientColorKeyframesMutation);
  return {
    inspectMotionGradientColorKeyframes: () => { throw new Error("not used"); },
    upsertMotionGradientColorKeyframe: mutate("inserted"),
    deleteMotionGradientColorKeyframe: mutate("deleted"),
    moveMotionGradientColorKeyframe: mutate("moved"),
  };
}

function unavailableServices(onLoad: () => void): TimelineGradientColorKeyframeAuthoringServices {
  return {
    packageLoader: async () => { onLoad(); throw new Error("invalid input must not load a package"); },
    isUnsafePackageOutputDirectory: async () => false,
    isEmptyOrAbsentDirectory: async () => true,
  };
}

async function writePackage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-debug-gradient-keyframe-source-"));
  const pkg = inMemoryPackage(root);
  await writeFile(join(root, "manifest.json"), `${JSON.stringify(pkg.manifest, null, 2)}\n`);
  await writeFile(join(root, "motion.json"), `${JSON.stringify(pkg.motion, null, 2)}\n`);
  return root;
}
