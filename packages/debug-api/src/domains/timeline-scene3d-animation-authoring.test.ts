import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as Core from "@shellx-motion/core";
import type { MotionDocument, MotionPackage, OperationReceipt } from "@shellx-motion/core";
import { hasAtomicCOWAuthority } from "@shellx-motion/core/test-support";
import { debugCommandDefinition } from "../command-registry.js";
import {
  applyTimelineScene3DAnimationIntent,
  dispatchTimelineScene3DAnimationAuthoringCommand,
  scene3dAnimationFacts,
  type TimelineScene3DAnimationAuthoringServices,
} from "./timeline-scene3d-animation-authoring.js";
import {
  isTimelineScene3DAnimationCommand,
  readTimelineScene3DAnimationIntent,
  TIMELINE_SCENE3D_ANIMATION_COMMANDS,
} from "./timeline-scene3d-animation.js";
import { dispatchTimelineStructuralCommand } from "./timeline-structural-dispatch.js";

const atomicCOW = hasAtomicCOWAuthority(tmpdir()) ? it : it.skip;
const topologyRefusal = hasAtomicCOWAuthority(tmpdir()) ? it.skip : it;

describe("timeline scene3d animation Debug boundary", () => {
  it("registers exactly the closed six-command family and parses no generic property route", () => {
    expect(readTimelineScene3DAnimationIntent(TIMELINE_SCENE3D_ANIMATION_COMMANDS.inspect, { packageRoot: "/package" }))
      .toEqual({ ok: true, intent: { kind: "inspect", packageRoot: "/package" } });
    expect(readTimelineScene3DAnimationIntent(TIMELINE_SCENE3D_ANIMATION_COMMANDS.trackUpsert, common({ track: fovTrack() })))
      .toMatchObject({ ok: true, intent: { kind: "track.upsert", track: { id: "fov", locator: camera("fovDeg"), keyframes: [{ atUs: 100, value: 50 }] } } });
    expect(readTimelineScene3DAnimationIntent(TIMELINE_SCENE3D_ANIMATION_COMMANDS.keyframeUpsert, common({ trackId: "fov", keyframe: key(200, 55, "ease-in") })))
      .toEqual({ ok: true, intent: { kind: "keyframe.upsert", edit: edit(), trackId: "fov", keyframe: key(200, 55, "ease-in") } });
    expect(readTimelineScene3DAnimationIntent(TIMELINE_SCENE3D_ANIMATION_COMMANDS.keyframeMove, common({ trackId: "fov", fromAtUs: 100, toAtUs: 200 })))
      .toEqual({ ok: true, intent: { kind: "keyframe.move", edit: edit(), trackId: "fov", fromAtUs: 100, toAtUs: 200 } });
    expect(readTimelineScene3DAnimationIntent(TIMELINE_SCENE3D_ANIMATION_COMMANDS.keyframeMove, common({ trackId: "fov", fromAtUs: 100, toAtUs: 100 })))
      .toEqual({ ok: false, problem: "fromAtUs and toAtUs must differ for an exact scene3d keyframe move." });
    expect(isTimelineScene3DAnimationCommand("motion.timeline.keyframe.upsert")).toBe(false);
    for (const command of Object.values(TIMELINE_SCENE3D_ANIMATION_COMMANDS)) expect(debugCommandDefinition(command)).not.toBeNull();
  });

  it("refuses hostile, malformed, caller receipt-root, and generic input before package loading", async () => {
    let loads = 0;
    const services = unavailableServices(() => { loads += 1; });
    const invalid = await dispatchTimelineScene3DAnimationAuthoringCommand(
      TIMELINE_SCENE3D_ANIMATION_COMMANDS.trackUpsert, common({ track: { ...fovTrack(), unsupported: true } }), services,
    );
    expect(invalid).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    const callerReceipt = await dispatchTimelineScene3DAnimationAuthoringCommand(
      TIMELINE_SCENE3D_ANIMATION_COMMANDS.trackRemove, common({ trackId: "fov", receiptsRoot: "/caller-must-not-choose" }), services,
    );
    expect(callerReceipt).toMatchObject({ ok: false, error: { code: "invalid_args", message: "Unknown argument: receiptsRoot." } });
    const missingHostReceipt = await dispatchTimelineScene3DAnimationAuthoringCommand(
      TIMELINE_SCENE3D_ANIMATION_COMMANDS.trackUpsert, common({ track: fovTrack() }), services,
    );
    expect(missingHostReceipt).toMatchObject({ ok: false, error: { code: "capability_unavailable", message: "Scene3d animation mutations require a host-configured receiptsRoot." } });
    const hostile = new Proxy(common({ track: fovTrack() }), { ownKeys() { throw new Error("must not reach package loading"); } });
    expect(await dispatchTimelineScene3DAnimationAuthoringCommand(TIMELINE_SCENE3D_ANIMATION_COMMANDS.trackUpsert, hostile, services))
      .toMatchObject({ ok: false, error: { code: "invalid_args" } });
    const overCapKeyframe = await dispatchTimelineScene3DAnimationAuthoringCommand(
      TIMELINE_SCENE3D_ANIMATION_COMMANDS.keyframeUpsert,
      common({ trackId: "fov", keyframe: key(200, `#${"a".repeat(300_000)}`) }), services,
    );
    expect(overCapKeyframe).toMatchObject({ ok: false, error: { code: "invalid_args", message: expect.stringContaining("transport limit") } });
    expect(await dispatchTimelineScene3DAnimationAuthoringCommand("motion.timeline.keyframe.upsert", common({ trackId: "fov", keyframe: key(200, 55) }), services)).toBeNull();
    expect(loads).toBe(0);
  });

  it("keeps inspect receipt-free and applies exact Core operations through the structural router", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-debug-scene3d-animation-inspect-"));
    try {
      const inspected = await dispatchTimelineStructuralCommand(
        TIMELINE_SCENE3D_ANIMATION_COMMANDS.inspect, { packageRoot: root },
        { authoringInputRoots: [tmpdir()], packageLoader: async () => packageFor(root) },
      );
      expect(inspected).toMatchObject({ ok: true, result: { inspection: { store: null, storeSha256: null }, render: { unrenderablePackageRefusal: null } } });

      const first = applyTimelineScene3DAnimationIntent(motion(), { kind: "track.upsert", edit: edit(), track: Core.readMotionScene3DAnimationTrackForAuthoring(fovTrack()) }, {});
      const second = applyTimelineScene3DAnimationIntent(first.motion, { kind: "keyframe.upsert", edit: edit(), trackId: "fov", keyframe: key(200, 55, "ease-in") }, {});
      const moved = applyTimelineScene3DAnimationIntent(second.motion, { kind: "keyframe.move", edit: edit(), trackId: "fov", fromAtUs: 200, toAtUs: 150 }, {});
      const deleted = applyTimelineScene3DAnimationIntent(moved.motion, { kind: "keyframe.delete", edit: edit(), trackId: "fov", atUs: 150 }, {});
      expect([first.action, second.action, moved.action, deleted.action]).toEqual(["track_inserted", "keyframe_inserted", "keyframe_moved", "keyframe_deleted"]);
      expect(deleted.motion.scene3dAnimation!.tracks[0]!.keyframes).toEqual([{ atUs: 100, value: 50 }]);
      expect(deleted.outputMotionSha256).toBe(Core.canonicalJsonSha256(deleted.motion));
      expect(scene3dAnimationFacts(deleted)).toMatchObject({
        motionIdentity: { outputCanonicalSha256: deleted.outputMotionSha256, outputPersistedPrettyJsonSha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
        cow: { compositingIdempotent: true, canonicalReopen: "staged-package" },
      });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  atomicCOW("publishes one host-receipted COW revision with source/output, store/track/keyframe, direct-route, and generic-Debug-refusal facts", async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), "shellx-motion-debug-scene3d-animation-cow-"));
    const source = await writePackage(join(evidenceRoot, "source"));
    const outDir = join(evidenceRoot, "output");
    const sourceBytes = await readFile(join(source, "motion.json"));
    try {
      const result = await dispatchTimelineStructuralCommand(
        TIMELINE_SCENE3D_ANIMATION_COMMANDS.trackUpsert,
        common({ packageRoot: source, outDir, track: fovTrack(), createdBy: "test" }),
        cowServices(evidenceRoot),
      );
      expect(result).toMatchObject({ ok: true, result: {
        action: "track_inserted", sourceMotionSha256: expect.stringMatching(/^[a-f0-9]{64}$/), outputMotionSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        persistedMotionSha256: expect.stringMatching(/^[a-f0-9]{64}$/), scene3dAnimation: { action: "track_inserted", store: { beforeSha256: null, afterSha256: expect.stringMatching(/^[a-f0-9]{64}$/) } },
        render: {
          renderLanesFor: ["gpu"],
          unrenderablePackageRefusal: null,
          genericDebugGpuPreviewRefusal: expect.objectContaining({ code: "motion_scene3d_animation_unavailable", lane: "gpu-static" }),
        },
      } });
      if (!result || !result.ok) throw new Error("expected successful scene3d animation COW result");
      const receipt = JSON.parse(await readFile(join(outDir, "receipts", "timeline-scene3d-animation-track-upsert.receipt.json"), "utf8"));
      const reopened = await Core.loadMotionPackage(outDir);
      const persistedBytes = await readFile(join(outDir, "motion.json"));
      expect(receipt).toMatchObject({
        operation: "timeline.scene3d-animation.track.upsert", status: "warning",
        inputHashes: { "manifest.json": expect.stringMatching(/^[a-f0-9]{64}$/), "motion.json": expect.stringMatching(/^[a-f0-9]{64}$/) },
        output: {
          motionIdentity: {
            outputCanonicalSha256: Core.canonicalJsonSha256(reopened.motion),
            outputPersistedPrettyJsonSha256: Core.hashBuffer(persistedBytes),
          },
          scene3dAnimation: { request: { kind: "track.upsert", track: { id: "fov" } }, track: { beforeSha256: null, afterSha256: expect.stringMatching(/^[a-f0-9]{64}$/) } },
          render: {
            renderLanesFor: ["gpu"],
            unrenderablePackageRefusal: null,
            genericDebugGpuPreviewRefusal: expect.objectContaining({ code: "motion_scene3d_animation_unavailable", lane: "gpu-static" }),
          },
        },
        warnings: ["Debug GPU preview does not admit document scene3dAnimation@1; the strict O6 lowerer is available only through the direct @shellx-motion/renderer-browser renderMotionGpuPreview API."],
      });
      expect(result.warnings).toEqual(["Debug GPU preview does not admit document scene3dAnimation@1; the strict O6 lowerer is available only through the direct @shellx-motion/renderer-browser renderMotionGpuPreview API."]);
      expect(result.result).toHaveProperty("hostReceiptPath");
      expect(await readFile(join(source, "motion.json"))).toEqual(sourceBytes);
    } finally { await rm(evidenceRoot, { recursive: true, force: true }); }
  });

  topologyRefusal("retains the managed-topology COW evidence gap without source/output mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-debug-scene3d-animation-topology-"));
    const source = await writePackage(join(root, "source"));
    const outDir = join(root, "output-refused");
    const before = await readFile(join(source, "motion.json"));
    try {
      const result = await dispatchTimelineStructuralCommand(TIMELINE_SCENE3D_ANIMATION_COMMANDS.trackUpsert, common({ packageRoot: source, outDir, track: fovTrack() }), cowServices(root));
      expect(result).toMatchObject({ ok: false, error: { code: "timeline_scene3d_animation_failed", message: expect.stringContaining("Output parent is owned by an unrelated POSIX principal.") } });
      expect(existsSync(outDir)).toBe(false);
      expect(await readFile(join(source, "motion.json"))).toEqual(before);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

function common(values: Record<string, unknown> = {}): Record<string, unknown> { return { packageRoot: "/package", outDir: "/out", ...values }; }
function edit() { return { packageRoot: "/package", outDir: "/out" }; }
function motion(): MotionDocument {
  return {
    schema: "shellx-motion/motion@1", id: "debug-scene3d-animation", name: "Debug scene3d animation", durationMs: 1_000, fps: 30, width: 100, height: 50,
    assets: [], provenance: { sourceApp: "test", createdBy: "test" }, layers: [{
      id: "world", type: "scene3d", startMs: 0, durationMs: 1_000,
      scene3d: {
        schema: "shellx-motion/scene3d@1",
        camera: { position: [0, 2, 6], target: [0, 0, 0], fovDeg: 45, near: 0.1, far: 100 },
        lighting: { ambient: 0.25, direction: [0, -1, -1], intensity: 1, color: "#ffffff" },
        backgroundColor: "#101820",
        objects: [{ id: "beacon", primitive: "box", position: [0, 0, 0], rotationDeg: [0, 0, 0], scale: 1, color: "#00aaff", emissive: 0.1 }],
      },
    }],
  };
}
function packageFor(root: string): MotionPackage {
  return { root, manifest: { schema: "shellx-motion/package-manifest@1", id: "pkg-debug-scene3d-animation", name: "Debug scene3d animation", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["browser"], hosts: ["motion"] } }, motion: motion() };
}
function fovTrack() { return { id: "fov", locator: camera("fovDeg"), keyframes: [key(100, 50)] }; }
function key(atUs: number, value: unknown, easing?: unknown) { return { atUs, value, ...(easing === undefined ? {} : { easing }) }; }
function camera(property: "position" | "target" | "fovDeg") { return { layerId: "world", scope: "camera", property }; }
function unavailableServices(onLoad: () => void): TimelineScene3DAnimationAuthoringServices {
  return { packageLoader: async () => { onLoad(); throw new Error("invalid input must not load package"); }, isUnsafePackageOutputDirectory: async () => false, isEmptyOrAbsentDirectory: async () => true };
}
function cowServices(receiptsRoot: string): TimelineScene3DAnimationAuthoringServices {
  return {
    authoringInputRoots: [tmpdir()], authoringOutputRoots: [tmpdir()], receiptsRoot,
    packageLoader: Core.loadMotionPackage, isUnsafePackageOutputDirectory: async () => false,
    isEmptyOrAbsentDirectory: async (path) => !existsSync(path) || (await readdir(path)).length === 0,
    writeReceipt: async (root, receipt: OperationReceipt) => { const path = join(root, `${receipt.id}.json`); await writeFile(path, `${JSON.stringify(receipt)}\n`); return path; },
  };
}
async function writePackage(root: string): Promise<string> {
  await mkdir(root, { recursive: true });
  const pkg = packageFor(root);
  await writeFile(join(root, "manifest.json"), `${JSON.stringify(pkg.manifest, null, 2)}\n`);
  await writeFile(join(root, "motion.json"), `${JSON.stringify(pkg.motion, null, 2)}\n`);
  return root;
}
