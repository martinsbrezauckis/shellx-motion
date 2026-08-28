import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadMotionPackage, type MotionDocument, type MotionPackage } from "@shellx-motion/core";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { debugCommandDefinition } from "../command-registry.js";
import { TIMELINE_PARTICLE_STRUCTURAL_COMMAND_METADATA } from "../command-metadata-timeline-particle-structural.js";
import {
  applyTimelineParticleStructuralIntent,
  dispatchTimelineParticleStructuralAuthoringCommand,
  type TimelineParticleStructuralAuthoringServices,
  type TimelineParticleStructuralCore,
} from "./timeline-particle-structural-authoring.js";
import {
  readTimelineParticleStructuralIntent,
  TIMELINE_PARTICLE_STRUCTURAL_COMMANDS,
  type TimelineParticleStructuralCommand,
  type TimelineParticleStructuralIntent,
} from "./timeline-particle-structural.js";
import { dispatchTimelineStructuralCommand } from "./timeline-structural-dispatch.js";

const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../fixtures/packages/gpu-g9-particle-cathedral");

describe("timeline particle structural Debug leaf", () => {
  it("parses the complete closed structural command set and keeps scalar routes absent", () => {
    for (const entry of mutationCases()) {
      expect(readTimelineParticleStructuralIntent(entry.command, common(entry.args))).toEqual({ ok: true, intent: entry.intent });
    }
    expect(readTimelineParticleStructuralIntent(TIMELINE_PARTICLE_STRUCTURAL_COMMANDS.inspect, { packageRoot: "/package", layerId: "field" }))
      .toEqual({ ok: true, intent: { kind: "inspect", layerId: "field" } });
    expect(readTimelineParticleStructuralIntent("motion.timeline.particles.emitter.count.set", common({ count: 1 }))).toBeNull();
    expect(readTimelineParticleStructuralIntent(TIMELINE_PARTICLE_STRUCTURAL_COMMANDS.sourceInsert, common({ index: 0, source: { kind: "flow", angleDeg: 0, strength: 1, ignored: true } })))
      .toEqual({ ok: false, problem: "source has unknown field ignored." });
    expect(readTimelineParticleStructuralIntent(TIMELINE_PARTICLE_STRUCTURAL_COMMANDS.sourceMove, common({ fromIndex: 1, toIndex: 1 })))
      .toEqual({ ok: false, problem: "fromIndex and toIndex must differ for an ordered structural move." });
    expect(Object.values(TIMELINE_PARTICLE_STRUCTURAL_COMMANDS).map((command) => debugCommandDefinition(command))).toEqual([
      expect.objectContaining({ permission: "read_motion", mutates: false }),
      ...Array.from({ length: 15 }, () => expect.objectContaining({ permission: "edit_motion", mutates: true })),
    ]);
  });

  it("refuses hostile exact-key input before package loading or output preparation", async () => {
    let loads = 0;
    const hostile = common({ index: 0, source: { kind: "flow", angleDeg: 0, strength: 1 } });
    Object.defineProperty(hostile.source as object, "strength", { enumerable: true, get: () => 1 });
    const result = await dispatchTimelineParticleStructuralAuthoringCommand(
      TIMELINE_PARTICLE_STRUCTURAL_COMMANDS.sourceInsert,
      hostile,
      unavailableServices(() => { loads += 1; }),
    );
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_args", message: "Arguments.source.strength must be a data property." } });
    const proxy = new Proxy(common({ index: 0, source: { kind: "flow", angleDeg: 0, strength: 1 } }), { ownKeys: () => { throw new Error("untrusted proxy trap"); } });
    expect(readTimelineParticleStructuralIntent(TIMELINE_PARTICLE_STRUCTURAL_COMMANDS.sourceInsert, proxy))
      .toEqual({ ok: false, problem: "Arguments must be plain JSON data." });
    const proxied = await dispatchTimelineParticleStructuralAuthoringCommand(TIMELINE_PARTICLE_STRUCTURAL_COMMANDS.sourceInsert, proxy, unavailableServices(() => { loads += 1; }));
    expect(proxied).toMatchObject({ ok: false, error: { code: "invalid_args", message: "Arguments must be plain JSON data." } });
    expect(loads).toBe(0);
  });

  it("maps each parsed structural intent to exactly one Core operation", () => {
    const calls: Array<{ method: string; input: unknown }> = [];
    const core = recordingCore(calls);
    const motion = minimalMotion();
    for (const entry of mutationCases()) {
      const parsed = readTimelineParticleStructuralIntent(entry.command, common(entry.args));
      if (!parsed || !parsed.ok) throw new Error("expected a parsed mutation intent");
      const result = applyTimelineParticleStructuralIntent(motion, parsed.intent as Exclude<TimelineParticleStructuralIntent, { kind: "inspect" }>, { particleStructural: core });
      expect(result.action).toBe(entry.action);
    }
    expect(calls.map((call) => call.method)).toEqual(mutationCases().map((entry) => entry.method));
    expect(calls.map((call) => Object.hasOwn(call.input as object, "kind"))).toEqual(Array.from({ length: 15 }, () => false));
    expect(calls[0]?.input).toMatchObject({ layerId: "field", index: 0, source: { kind: "flow", angleDeg: 0, strength: 1 } });
    expect(calls[4]?.input).toMatchObject({ layerId: "field", index: 0, origin: { x: 0.25, y: 0.75, weight: 1 } });
  });

  it("keeps inspect read-only and receipt-free", async () => {
    const result = await dispatchTimelineParticleStructuralAuthoringCommand(
      TIMELINE_PARTICLE_STRUCTURAL_COMMANDS.inspect,
      { packageRoot: fixtureRoot, layerId: "field" },
      {
        authoringInputRoots: [fixtureRoot],
        packageLoader: async () => fixturePackage(),
        particleStructural: {
          ...recordingCore([]),
          inspectMotionParticleStructure: () => ({ layerId: "field", field: null, origins: null, trail: null, shading: null, limits: { maxSources: null, maxOrigins: null } }),
        },
      },
    );
    if (!result || !result.ok) throw new Error(result && !result.ok ? result.error.message : "expected particle structural inspection result");
    expect(result).toMatchObject({ ok: true, result: { inspection: { layerId: "field", limits: { maxOrigins: null } } } });
    expect(result && "receiptId" in result).toBe(false);
  });

  it("routes Core-backed inspection through the production structural dispatcher without a receipt", async () => {
    const result = await dispatchTimelineStructuralCommand(
      TIMELINE_PARTICLE_STRUCTURAL_COMMANDS.inspect,
      { packageRoot: fixtureRoot, layerId: "field" },
      { authoringInputRoots: [fixtureRoot], packageLoader: async () => fixturePackage() },
    );
    if (!result || !result.ok) throw new Error(result && !result.ok ? result.error.message : "expected particle structural inspection dispatch");
    expect(result).toMatchObject({ ok: true, result: { inspection: { layerId: "field", field: { schema: "shellx-motion/particle-field@2", sources: [{ kind: "flow", angleDeg: 0, strength: 0.2 }] }, origins: null, trail: null, shading: null, limits: { maxSources: 4, maxOrigins: 4 } } } });
    expect("receiptId" in result).toBe(false);
  });

  it("validates the complete post-mutation Motion document before creating any output", async () => {
    const outDir = resolve(tmpdir(), `shellx-motion-particle-invalid-root-${process.pid}-${Date.now()}`);
    expect(existsSync(outDir)).toBe(false);
    const result = await dispatchTimelineParticleStructuralAuthoringCommand(
      TIMELINE_PARTICLE_STRUCTURAL_COMMANDS.sourceReplace,
      common({ packageRoot: fixtureRoot, outDir, index: 0, source: { kind: "flow", angleDeg: 0, strength: 1 } }),
      {
        authoringInputRoots: [fixtureRoot],
        authoringOutputRoots: [tmpdir()],
        packageLoader: async () => fixturePackage(fixtureRoot, { ...minimalMotion(), width: -1 }),
        isUnsafePackageOutputDirectory: async () => false,
        isEmptyOrAbsentDirectory: async () => true,
        particleStructural: invalidRootCore(),
      },
    );
    if (!result || result.ok) throw new Error("expected invalid-root mutation to refuse before output");
    expect(result).toMatchObject({ ok: false, error: { code: "timeline_particle_structural_invalid", message: "Patched Motion document failed validation." } });
    expect(existsSync(outDir)).toBe(false);
  });

  it.skipIf(process.platform === "win32")("refuses an actually group-writable parent before Particle COW publication while retaining exact evidence", async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), "shellx-motion-m2605-particle-cow-evidence-"));
    try {
      const anchor = await createTrustedWorkspaceAnchor(evidenceRoot);
      const source = await writeParticlePackage(join(evidenceRoot, "source"), minimalMotion());
      const sourceManifest = await readFile(join(source, "manifest.json"), "utf8");
      const sourceMotion = await readFile(join(source, "motion.json"), "utf8");
      const outputRoot = join(evidenceRoot, "output-root");
      const unsafeParent = join(outputRoot, "group-writable");
      await mkdir(outputRoot, { mode: 0o700 });
      await mkdir(unsafeParent, { mode: 0o700 });
      await chmod(unsafeParent, 0o777);
      const services = evidenceServices(evidenceRoot, async () => fixturePackage(source, minimalMotion()), outputRoot);
      const outDir = join(unsafeParent, "output");
      const result = await withTrustedWorkspaceAnchor(anchor, async () => await dispatchTimelineStructuralCommand(TIMELINE_PARTICLE_STRUCTURAL_COMMANDS.sourceInsert, {
        packageRoot: source, outDir, layerId: "field", index: 1, source: { kind: "flow", angleDeg: 15, strength: 0.3 },
      }, services));
      expect(result).toMatchObject({ ok: false, error: { code: "timeline_particle_structural_failed", message: expect.stringMatching(/group- or world-writable/i) } });
      expect(existsSync(outDir)).toBe(false);
      expect(await readFile(join(source, "manifest.json"), "utf8")).toBe(sourceManifest);
      expect(await readFile(join(source, "motion.json"), "utf8")).toBe(sourceMotion);

      const hostileOut = join(evidenceRoot, "hostile-refusal-no-output");
      const hostile = new Proxy({
        packageRoot: source, outDir: hostileOut, layerId: "field", index: 1,
        source: { kind: "flow", angleDeg: 0, strength: 1 },
      }, { ownKeys: () => { throw new Error("hostile reflection must not reach package copy"); } });
      const refusal = await dispatchTimelineStructuralCommand(TIMELINE_PARTICLE_STRUCTURAL_COMMANDS.sourceInsert, hostile, services);
      expect(refusal).toMatchObject({ ok: false, error: { code: "invalid_args", message: "Arguments must be plain JSON data." } });
      expect(existsSync(hostileOut)).toBe(false);
    } finally {
      await rm(evidenceRoot, { recursive: true, force: true });
    }
  });

  it("keeps dormant metadata in one-to-one parity with exact parser commands", () => {
    const commands = Object.values(TIMELINE_PARTICLE_STRUCTURAL_COMMANDS);
    expect(Object.keys(TIMELINE_PARTICLE_STRUCTURAL_COMMAND_METADATA).sort()).toEqual([...commands].sort());
    expect(TIMELINE_PARTICLE_STRUCTURAL_COMMAND_METADATA[TIMELINE_PARTICLE_STRUCTURAL_COMMANDS.inspect]).not.toHaveProperty("expectedReceipts");
    for (const command of commands.filter((command) => command !== TIMELINE_PARTICLE_STRUCTURAL_COMMANDS.inspect)) {
      expect(TIMELINE_PARTICLE_STRUCTURAL_COMMAND_METADATA[command]).toHaveProperty("expectedReceipts");
    }
  });
});

function common(values: Record<string, unknown> = {}): Record<string, unknown> {
  return { packageRoot: "/package", outDir: "/out", layerId: "field", ...values };
}

function unavailableServices(onLoad: () => void): TimelineParticleStructuralAuthoringServices {
  return { packageLoader: async () => { onLoad(); throw new Error("hostile input must not load a package"); } };
}

function minimalMotion(): MotionDocument {
  return {
    schema: "shellx-motion/motion@1", id: "motion_particle_structural_debug", name: "Particle structural Debug", durationMs: 1_000, fps: 25, width: 100, height: 100,
    layers: [{ id: "field", type: "particles", startMs: 0, durationMs: 1_000, emitter: { seed: 1, count: 100_000, lifetimeMs: 500, shape: "circle", color: "#ffffff", field: { schema: "shellx-motion/particle-field@2", sources: [{ kind: "flow", angleDeg: 0, strength: 0.2 }] } } }], assets: [], provenance: { sourceApp: "test", createdBy: "test" },
  } as MotionDocument;
}

function fixturePackage(root = fixtureRoot, motion: MotionDocument = minimalMotion()): MotionPackage {
  return {
    root,
    manifest: {
      schema: "shellx-motion/package-manifest@1", id: "pkg_gpu_g9_particle_cathedral", name: "Particle Cathedral — G9 GPU Film", motion: "motion.json", assets: [], sourceApp: "shellx-motion", compatibility: { lanes: ["gpu", "ffmpeg"], hosts: ["motion"] },
    },
    motion,
  } as MotionPackage;
}

function mutationCases(): Array<{ command: TimelineParticleStructuralCommand; args: Record<string, unknown>; intent: Exclude<TimelineParticleStructuralIntent, { kind: "inspect" }>; method: string; action: string }> {
  const source = { kind: "flow", angleDeg: 0, strength: 1 } as const;
  const origin = { x: 0.25, y: 0.75, weight: 1 } as const;
  const trail = { durationMs: 100, samples: 2, opacity: 0.5 } as const;
  const shading = { mode: "soft", sizeJitter: 0.1, opacityJitter: 0.2, glow: 0.3 } as const;
  return [
    { command: TIMELINE_PARTICLE_STRUCTURAL_COMMANDS.sourceInsert, args: { index: 0, source }, intent: { kind: "source-insert", layerId: "field", index: 0, source }, method: "insertMotionParticleFieldSource", action: "source-inserted" },
    { command: TIMELINE_PARTICLE_STRUCTURAL_COMMANDS.sourceReplace, args: { index: 0, source }, intent: { kind: "source-replace", layerId: "field", index: 0, source }, method: "replaceMotionParticleFieldSource", action: "source-replaced" },
    { command: TIMELINE_PARTICLE_STRUCTURAL_COMMANDS.sourceMove, args: { fromIndex: 0, toIndex: 1 }, intent: { kind: "source-move", layerId: "field", fromIndex: 0, toIndex: 1 }, method: "moveMotionParticleFieldSource", action: "source-moved" },
    { command: TIMELINE_PARTICLE_STRUCTURAL_COMMANDS.sourceDelete, args: { index: 0 }, intent: { kind: "source-delete", layerId: "field", index: 0 }, method: "deleteMotionParticleFieldSource", action: "source-deleted" },
    { command: TIMELINE_PARTICLE_STRUCTURAL_COMMANDS.originInsert, args: { index: 0, origin }, intent: { kind: "origin-insert", layerId: "field", index: 0, origin }, method: "insertMotionParticleOrigin", action: "origin-inserted" },
    { command: TIMELINE_PARTICLE_STRUCTURAL_COMMANDS.originReplace, args: { index: 0, origin }, intent: { kind: "origin-replace", layerId: "field", index: 0, origin }, method: "replaceMotionParticleOrigin", action: "origin-replaced" },
    { command: TIMELINE_PARTICLE_STRUCTURAL_COMMANDS.originMove, args: { fromIndex: 0, toIndex: 1 }, intent: { kind: "origin-move", layerId: "field", fromIndex: 0, toIndex: 1 }, method: "moveMotionParticleOrigin", action: "origin-moved" },
    { command: TIMELINE_PARTICLE_STRUCTURAL_COMMANDS.originDelete, args: { index: 0 }, intent: { kind: "origin-delete", layerId: "field", index: 0 }, method: "deleteMotionParticleOrigin", action: "origin-deleted" },
    { command: TIMELINE_PARTICLE_STRUCTURAL_COMMANDS.collisionAxisUpdate, args: { index: 0, axis: "y" }, intent: { kind: "collision-axis-update", layerId: "field", index: 0, axis: "y" }, method: "updateMotionParticleCollisionAxis", action: "collision-axis-updated" },
    { command: TIMELINE_PARTICLE_STRUCTURAL_COMMANDS.trailAdd, args: { trail }, intent: { kind: "trail-add", layerId: "field", trail }, method: "addMotionParticleAnalyticTrail", action: "trail-added" },
    { command: TIMELINE_PARTICLE_STRUCTURAL_COMMANDS.trailReplace, args: { trail }, intent: { kind: "trail-replace", layerId: "field", trail }, method: "replaceMotionParticleAnalyticTrail", action: "trail-replaced" },
    { command: TIMELINE_PARTICLE_STRUCTURAL_COMMANDS.trailRemove, args: {}, intent: { kind: "trail-remove", layerId: "field" }, method: "removeMotionParticleAnalyticTrail", action: "trail-removed" },
    { command: TIMELINE_PARTICLE_STRUCTURAL_COMMANDS.shadingAdd, args: { shading }, intent: { kind: "shading-add", layerId: "field", shading }, method: "addMotionParticleShading", action: "shading-added" },
    { command: TIMELINE_PARTICLE_STRUCTURAL_COMMANDS.shadingReplace, args: { shading }, intent: { kind: "shading-replace", layerId: "field", shading }, method: "replaceMotionParticleShading", action: "shading-replaced" },
    { command: TIMELINE_PARTICLE_STRUCTURAL_COMMANDS.shadingRemove, args: {}, intent: { kind: "shading-remove", layerId: "field" }, method: "removeMotionParticleShading", action: "shading-removed" },
  ];
}

async function writeParticlePackage(root: string, motion: MotionDocument): Promise<string> {
  await mkdir(root, { mode: 0o700 });
  await writeFile(join(root, "manifest.json"), `${JSON.stringify({ schema: "shellx-motion/package-manifest@1", id: "pkg_particle_structural_debug", name: "Particle structural Debug", motion: "motion.json", assets: [], sourceApp: "shellx-motion", compatibility: { lanes: ["gpu", "ffmpeg"], hosts: ["motion"] } }, null, 2)}\n`);
  await writeFile(join(root, "motion.json"), `${JSON.stringify(motion, null, 2)}\n`);
  return root;
}

function evidenceServices(root: string, packageLoader = loadMotionPackage, outputRoot = root) {
  return {
    authoringInputRoots: [root], authoringOutputRoots: [outputRoot], packageLoader,
    isUnsafePackageOutputDirectory: async () => false,
    isEmptyOrAbsentDirectory: async (path: string) => (await readdir(path).catch((error: unknown) => {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return [];
      throw error;
    })).length === 0,
  };
}

function recordingCore(calls: Array<{ method: string; input: unknown }>): TimelineParticleStructuralCore {
  const mutation = (method: string, action: string) => (motion: MotionDocument, input: unknown) => {
    calls.push({ method, input });
    return { motion, layerId: "field", layer: motion.layers[0]!, action, changedPaths: ["/layers/field"] };
  };
  return {
    inspectMotionParticleStructure: () => ({ layerId: "field", field: null, origins: null, trail: null, shading: null, limits: { maxSources: null, maxOrigins: null } }),
    insertMotionParticleFieldSource: mutation("insertMotionParticleFieldSource", "source-inserted"),
    replaceMotionParticleFieldSource: mutation("replaceMotionParticleFieldSource", "source-replaced"),
    moveMotionParticleFieldSource: mutation("moveMotionParticleFieldSource", "source-moved"),
    deleteMotionParticleFieldSource: mutation("deleteMotionParticleFieldSource", "source-deleted"),
    insertMotionParticleOrigin: mutation("insertMotionParticleOrigin", "origin-inserted"),
    replaceMotionParticleOrigin: mutation("replaceMotionParticleOrigin", "origin-replaced"),
    moveMotionParticleOrigin: mutation("moveMotionParticleOrigin", "origin-moved"),
    deleteMotionParticleOrigin: mutation("deleteMotionParticleOrigin", "origin-deleted"),
    updateMotionParticleCollisionAxis: mutation("updateMotionParticleCollisionAxis", "collision-axis-updated"),
    addMotionParticleAnalyticTrail: mutation("addMotionParticleAnalyticTrail", "trail-added"),
    replaceMotionParticleAnalyticTrail: mutation("replaceMotionParticleAnalyticTrail", "trail-replaced"),
    removeMotionParticleAnalyticTrail: mutation("removeMotionParticleAnalyticTrail", "trail-removed"),
    addMotionParticleShading: mutation("addMotionParticleShading", "shading-added"),
    replaceMotionParticleShading: mutation("replaceMotionParticleShading", "shading-replaced"),
    removeMotionParticleShading: mutation("removeMotionParticleShading", "shading-removed"),
  } as unknown as TimelineParticleStructuralCore;
}

function invalidRootCore(): TimelineParticleStructuralCore {
  const core = recordingCore([]);
  return {
    ...core,
    replaceMotionParticleFieldSource: (motion) => ({ ...core.replaceMotionParticleFieldSource(motion, { layerId: "field", index: 0, source: { kind: "flow", angleDeg: 0, strength: 1 } }), motion: { ...motion, width: -1 } }),
  };
}
