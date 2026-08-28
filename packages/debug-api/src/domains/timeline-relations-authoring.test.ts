import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as Core from "@shellx-motion/core";
import type { MotionDocument, MotionPackage } from "@shellx-motion/core";
import { hasAtomicCOWAuthority } from "@shellx-motion/core/test-support";
import { TIMELINE_RELATION_COMMAND_METADATA } from "../command-metadata-timeline-relations.js";
import { debugCommandDefinition } from "../command-registry.js";
import { dispatchDebugCommand } from "../index.js";
import { withTestAuthoringRoots } from "../authoring-test-context.test-support.js";
import {
  applyTimelineRelationIntent,
  dispatchTimelineRelationAuthoringCommand,
  relationMutationFacts,
} from "./timeline-relations-authoring.js";
import { TIMELINE_RELATION_COMMANDS, readTimelineRelationIntent } from "./timeline-relations.js";
import { dispatchTimelineStructuralCommand } from "./timeline-structural-dispatch.js";

const atomicCOW = hasAtomicCOWAuthority(tmpdir()) ? it : it.skip;

describe("timeline relations Debug authoring", () => {
  it("parses the closed inspect and lifecycle vocabulary before route selection", () => {
    expect(readTimelineRelationIntent(TIMELINE_RELATION_COMMANDS.inspect, { packageRoot: "/pkg", atUs: 2_000 }))
      .toEqual({ ok: true, intent: { kind: "inspect", packageRoot: "/pkg", atUs: 2_000 } });
    expect(readTimelineRelationIntent(TIMELINE_RELATION_COMMANDS.upsert, edit({ binding: relation("next", "new-follower") })))
      .toEqual({ ok: true, intent: { kind: "upsert", edit: editTransport(), binding: relation("next", "new-follower") } });
    expect(readTimelineRelationIntent(TIMELINE_RELATION_COMMANDS.upsert, edit({ binding: aim("look", "new-follower") })))
      .toEqual({ ok: true, intent: { kind: "upsert", edit: editTransport(), binding: aim("look", "new-follower") } });
    expect(readTimelineRelationIntent(TIMELINE_RELATION_COMMANDS.enabled, edit({ id: "follow", enabled: false })))
      .toEqual({ ok: true, intent: { kind: "enabled", edit: editTransport(), id: "follow", enabled: false } });
    for (const [command, kind] of [[TIMELINE_RELATION_COMMANDS.remove, "remove"], [TIMELINE_RELATION_COMMANDS.detach, "detach"]] as const) {
      expect(readTimelineRelationIntent(command, edit({ id: "follow" }))).toEqual({ ok: true, intent: { kind, edit: editTransport(), id: "follow" } });
    }
    expect(readTimelineRelationIntent(TIMELINE_RELATION_COMMANDS.bake, edit({ id: "follow", sampleEveryUs: 2_000 })))
      .toEqual({ ok: true, intent: { kind: "bake", edit: editTransport(), id: "follow", sampleEveryUs: 2_000 } });
    expect(readTimelineRelationIntent(TIMELINE_RELATION_COMMANDS.inspect, { packageRoot: "/pkg", atUs: 1 }))
      .toMatchObject({ ok: false, problem: expect.stringContaining("whole-millisecond") });
    expect(readTimelineRelationIntent(TIMELINE_RELATION_COMMANDS.bake, edit({ id: "follow", sampleEveryUs: 1 })))
      .toMatchObject({ ok: false, problem: expect.stringContaining("whole-millisecond") });
    expect(readTimelineRelationIntent(TIMELINE_RELATION_COMMANDS.upsert, edit({ binding: { ...relation("next", "new-follower"), unknown: true } })))
      .toMatchObject({ ok: false, problem: expect.stringContaining("unknown field") });
    expect(readTimelineRelationIntent(TIMELINE_RELATION_COMMANDS.upsert, edit({ binding: relation("next", "new-follower"), receiptsRoot: "/caller" })))
      .toEqual({ ok: false, problem: "Unknown argument: receiptsRoot." });
    expect(Object.values(TIMELINE_RELATION_COMMANDS).map((command) => debugCommandDefinition(command))).toEqual([
      expect.objectContaining({ permission: "read_motion", mutates: false }),
      ...Array.from({ length: 5 }, () => expect.objectContaining({ permission: "edit_motion", mutates: true })),
    ]);
  });

  it("refuses hostile or malformed data without loading a package or probing an output", async () => {
    for (const command of Object.values(TIMELINE_RELATION_COMMANDS)) {
      let descriptors = 0, valueGets = 0, loads = 0, outputs = 0;
      const hostile = new Proxy({}, {
        ownKeys: () => Array.from({ length: 10_000 }, (_, index) => `unexpected${index}`),
        getOwnPropertyDescriptor: () => { descriptors += 1; return undefined; },
        get: () => { valueGets += 1; return undefined; },
      });
      expect(readTimelineRelationIntent(command, hostile)).toMatchObject({ ok: false, problem: expect.stringContaining("allowance") });
      expect({ descriptors, valueGets }).toEqual({ descriptors: 0, valueGets: 0 });
      const result = await dispatchTimelineRelationAuthoringCommand(command, hostile, refusingServices(() => { loads += 1; }, () => { outputs += 1; }));
      expect(result).toMatchObject({ ok: false, error: { code: "invalid_args" } });
      expect({ loads, outputs }).toEqual({ loads: 0, outputs: 0 });
    }

    for (const command of Object.values(TIMELINE_RELATION_COMMANDS)) {
      let reads = 0, loads = 0;
      const input = commandArgs(command);
      const key = command === TIMELINE_RELATION_COMMANDS.upsert ? "binding"
        : command === TIMELINE_RELATION_COMMANDS.enabled || command === TIMELINE_RELATION_COMMANDS.remove || command === TIMELINE_RELATION_COMMANDS.detach || command === TIMELINE_RELATION_COMMANDS.bake ? "id"
          : "packageRoot";
      const accessor = { ...input };
      delete accessor[key];
      Object.defineProperty(accessor, key, { enumerable: true, get() { reads += 1; return "must not read"; } });
      const result = await dispatchTimelineRelationAuthoringCommand(command, Object.freeze(accessor), refusingServices(() => { loads += 1; }));
      expect(result).toMatchObject({ ok: false, error: { code: "invalid_args" } });
      expect({ reads, loads }).toEqual({ reads: 0, loads: 0 });
    }
  });

  it("uses exact Core lifecycle operations and records static identities plus renderer refusal truth", () => {
    const upsert = parsed(TIMELINE_RELATION_COMMANDS.upsert, edit({ binding: relation("next", "new-follower") }));
    const upserted = applyTimelineRelationIntent(motion(), upsert, {});
    expect(relationMutationFacts(upserted)).toMatchObject({
      outputMotionSha256: Core.canonicalJsonSha256(upserted.motion),
      relations: {
        action: "upserted", relationId: "next", changedPaths: ["/relations/bindings/1"],
        beforeSourceSha256: expect.any(String), afterSourceSha256: expect.any(String),
        beforeStaticPlan: { fingerprint: expect.any(String), relationSourceSha256: expect.any(String), budget: expect.any(Object) },
        afterStaticPlan: { fingerprint: expect.any(String), relationSourceSha256: expect.any(String), budget: expect.any(Object) },
        laneTruth: { state: "relation_store_refused", refusal: { code: "package_unrenderable" } },
      },
    });

    const enabled = applyTimelineRelationIntent(motion(), parsed(TIMELINE_RELATION_COMMANDS.enabled, edit({ id: "follow", enabled: false })), {});
    expect(enabled).toMatchObject({ action: "enabled", relationId: "follow", changedPaths: ["/relations/bindings/0/enabled"] });
    const removed = applyTimelineRelationIntent(motion(), parsed(TIMELINE_RELATION_COMMANDS.remove, edit({ id: "follow" })), {});
    expect(removed).toMatchObject({ action: "removed", changedPaths: ["/relations"] });
    expect(removed.motion).not.toHaveProperty("relations");
    const detached = applyTimelineRelationIntent(motion(), parsed(TIMELINE_RELATION_COMMANDS.detach, edit({ id: "follow" })), {});
    expect(detached).toMatchObject({ action: "detached", changedPaths: ["/relations"] });
    expect(detached.motion).not.toHaveProperty("relations");
  });

  it("binds relation output identity to the exact compositing-compiled Motion object", () => {
    const source = rawCompositingMotion();
    const rawMutation = Core.setMotionRelationEnabled(source, { id: "follow", enabled: false });
    const mutation = applyTimelineRelationIntent(source, parsed(TIMELINE_RELATION_COMMANDS.enabled, edit({ id: "follow", enabled: false })), {});
    expect(Core.canonicalJsonSha256(rawMutation.motion)).not.toBe(Core.canonicalJsonSha256(mutation.motion));
    expect(mutation.motion).toEqual(Core.compileMotionDocumentCompositing(rawMutation.motion));
    expect(mutation.outputMotionSha256).toBe(Core.canonicalJsonSha256(mutation.motion));
    expect(Core.compileMotionDocumentCompositing(mutation.motion)).toEqual(mutation.motion);
    expect(relationMutationFacts(mutation)).toMatchObject({ outputMotionSha256: mutation.outputMotionSha256 });
  });

  it("bakes a millisecond-inclusive grid atomically and labels it sampled rather than equivalent", () => {
    const baked = applyTimelineRelationIntent(motion(), parsed(TIMELINE_RELATION_COMMANDS.bake, edit({ id: "follow", sampleEveryUs: 2_000 })), {});
    expect(relationMutationFacts(baked)).toMatchObject({
      relations: {
        action: "baked", relationId: "follow", changedPaths: ["/layers/1/keyframes/transform.x", "/layers/1/keyframes/transform.y", "/relations"],
        afterSourceSha256: null,
        bake: { sampleEveryUs: 2_000, sampleCount: 6, keyframeCount: 12, bakeSemantics: "sampled_not_equivalent_between_samples" },
        laneTruth: { state: "relation_store_absent" },
      },
    });
    const follower = baked.motion.layers.find((layer) => layer.id === "follower")!;
    expect(follower.keyframes?.["transform.x"]).toEqual([
      { atMs: 0, value: 10, easing: "linear" }, { atMs: 2, value: 20, easing: "linear" }, { atMs: 4, value: 30, easing: "linear" },
      { atMs: 6, value: 40, easing: "linear" }, { atMs: 8, value: 50, easing: "linear" }, { atMs: 10, value: 60, easing: "linear" },
    ]);
  });

  it("forwards partial-bake refusal before COW mutation and leaves the source unchanged", () => {
    const source = motion(4_000);
    const before = Core.canonicalJson(source);
    let bakes = 0;
    expect(() => applyTimelineRelationIntent(source, parsed(TIMELINE_RELATION_COMMANDS.bake, edit({ id: "follow", sampleEveryUs: 2_000 })), {
      relations: { ...Core, bakeMotionRelation: () => { bakes += 1; throw new Error("Motion relation bake requires full document coverage exactly (startUs=0 and endUs=10000); partial intervals change ordinary-keyframe motion before or after the relation."); } },
    })).toThrow("full document coverage exactly (startUs=0 and endUs=10000)");
    expect(bakes).toBe(1);
    expect(Core.canonicalJson(source)).toBe(before);
  });

  it("routes inspection through the production structural dispatcher without an edit receipt", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-debug-relations-inspect-"));
    try {
      const pkg = packageFor(root);
      const result = await dispatchTimelineStructuralCommand(
        TIMELINE_RELATION_COMMANDS.inspect,
        { packageRoot: pkg.root, atUs: 2_000 },
        withTestAuthoringRoots({ packageLoader: async () => pkg }, { inputRoots: [pkg.root] }),
      );
      expect(result).toMatchObject({
        ok: true,
        result: {
          inspection: { store: { schema: "shellx-motion/relations@1", bindings: [expect.objectContaining({ id: "follow" })] } },
          frame: { schema: "shellx-motion/relation-frame-plan@1" },
          laneTruth: { state: "relation_store_refused", refusal: { code: "package_unrenderable" } },
        },
        warnings: [expect.stringContaining("relations@1")],
      });
      expect(result).not.toHaveProperty("receiptId");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  atomicCOW("atomically COW-upserts, reopens, and receipts relations through the production Debug adapter", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-debug-relations-cow-"));
    const source = await writePackage(join(root, "source"));
    const outDir = join(root, "output");
    const receiptsRoot = join(root, "host-receipts");
    const [sourceManifestBytes, sourceMotionBytes] = await Promise.all([
      readFile(join(source, "manifest.json")),
      readFile(join(source, "motion.json")),
    ]);
    try {
      const result = await dispatchDebugCommand(
        TIMELINE_RELATION_COMMANDS.upsert,
        edit({ packageRoot: source, outDir, binding: relation("next", "new-follower"), createdBy: "test" }),
        {
          tier: "edit_motion",
          authoringInputRoots: [root],
          authoringOutputRoots: [root],
          receiptsRoot,
        },
      );
      expect(result).toMatchObject({
        ok: true,
        result: {
          outputMotionSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          relations: {
            action: "upserted",
            relationId: "next",
            beforeSourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            afterSourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          },
        },
      });
      if (!result.ok) throw new Error(result.error.message);

      const reopened = await Core.loadMotionPackage(outDir);
      expect(reopened.motion.relations).toMatchObject({
        schema: "shellx-motion/relations@1",
        bindings: [
          expect.objectContaining({ id: "follow", target: expect.objectContaining({ layerId: "follower", anchor: { x: 0, y: 0 } }) }),
          expect.objectContaining({ id: "next", target: expect.objectContaining({ layerId: "new-follower", anchor: { x: 0, y: 0 } }) }),
        ],
      });
      expect(await dispatchDebugCommand(
        TIMELINE_RELATION_COMMANDS.inspect,
        { packageRoot: outDir, atUs: 5_000 },
        { tier: "read_motion", authoringInputRoots: [root] },
      )).toMatchObject({
        ok: true,
        result: { inspection: { store: { bindings: [expect.objectContaining({ id: "follow" }), expect.objectContaining({ id: "next" })] } } },
      });

      const receiptPath = join(outDir, "receipts", "timeline-relations-upsert.receipt.json");
      const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
      expect(receipt).toMatchObject({
        operation: "timeline.relations.upsert",
        lane: "debug-api",
        inputHashes: {
          "manifest.json": expect.stringMatching(/^[a-f0-9]{64}$/),
          "motion.json": expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        output: {
          outputMotionSha256: Core.canonicalJsonSha256(reopened.motion),
          relations: {
            action: "upserted",
            relationId: "next",
            afterStaticPlan: { relationSourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
          },
        },
      });
      expect(await readdir(join(outDir, "receipts"))).toEqual(["timeline-relations-upsert.receipt.json"]);
      expect(result.result).toHaveProperty("hostReceiptPath");
      expect(JSON.parse(await readFile(join(receiptsRoot, `${result.receiptId}.receipt.json`), "utf8"))).toEqual(receipt);
      await expect(Promise.all([
        readFile(join(source, "manifest.json")),
        readFile(join(source, "motion.json")),
      ])).resolves.toEqual([sourceManifestBytes, sourceMotionBytes]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps metadata one-to-one, COW-only, and receipt-bearing", () => {
    expect(Object.keys(TIMELINE_RELATION_COMMAND_METADATA).sort()).toEqual(Object.values(TIMELINE_RELATION_COMMANDS).sort());
    expect(TIMELINE_RELATION_COMMAND_METADATA[TIMELINE_RELATION_COMMANDS.inspect]).not.toHaveProperty("expectedReceipts");
    for (const command of Object.values(TIMELINE_RELATION_COMMANDS).slice(1)) {
      const metadata = TIMELINE_RELATION_COMMAND_METADATA[command];
      expect("expectedReceipts" in metadata ? metadata.expectedReceipts : undefined).toEqual([
        expect.objectContaining({ operation: command.replace("motion.", ""), mode: "emits", required: true, artifactRoles: expect.arrayContaining(["timeline_receipt"]) }),
      ]);
      expect(metadata.argsSchema.properties).not.toHaveProperty("receiptsRoot");
    }
  });
});

function parsed(command: string, value: Record<string, unknown>) {
  const result = readTimelineRelationIntent(command, value);
  if (!result || !result.ok || result.intent.kind === "inspect") throw new Error("Expected relation mutation intent.");
  return result.intent;
}
function relation(id = "follow", targetLayerId = "follower", durationUs = 10_000) {
  return {
    id, enabled: true, kind: "attach" as const, mode: "follow" as const, startUs: 0, durationUs,
    source: { layerId: "leader", anchor: { x: 0, y: 0 } }, target: { layerId: targetLayerId, anchor: { x: 0, y: 0 } },
    offset: { space: "world" as const, x: 0, y: 0, rotationDeg: 0, scale: 1 },
  };
}
function aim(id = "look", targetLayerId = "follower") {
  return {
    id, enabled: true, kind: "aim" as const, startUs: 0, durationUs: 4_000,
    source: { layerId: "leader", anchor: { x: 0, y: 0 } }, target: { layerId: targetLayerId, anchor: { x: 0, y: 0 } },
    rotationOffsetDeg: 0,
  };
}
function motion(relationDurationUs = 10_000): MotionDocument {
  return {
    schema: "shellx-motion/motion@1", id: "relation-debug", name: "Relation Debug", durationMs: 10, fps: 30, width: 320, height: 180, assets: [], provenance: { sourceApp: "test", createdBy: "test" },
    layers: [
      { id: "leader", type: "shape", shape: "rect", startMs: 0, durationMs: 10, transform: { x: 10, y: 5, width: 10, height: 10 }, keyframes: { "transform.x": [{ atMs: 0, value: 10 }, { atMs: 10, value: 60 }] } },
      { id: "follower", type: "shape", shape: "rect", startMs: 0, durationMs: 10, transform: { x: 0, y: 0, width: 10, height: 10 } },
      { id: "new-follower", type: "shape", shape: "rect", startMs: 0, durationMs: 10, transform: { x: 0, y: 20, width: 10, height: 10 } },
    ],
    relations: { schema: "shellx-motion/relations@1", bindings: [relation("follow", "follower", relationDurationUs)] },
  } as MotionDocument;
}
function rawCompositingMotion(): MotionDocument {
  const document = motion();
  document.compositing = {
    schema: "shellx-motion/compositing-graph@1",
    id: "relation-output-identity",
    nodes: [
      { id: "source", type: "source", layerId: "follower" },
      { id: "output", type: "output" },
    ],
    edges: [{ id: "source-output", from: { nodeId: "source", port: "output" }, to: { nodeId: "output", port: "input" } }],
  } as never;
  return document;
}
function edit(values: Record<string, unknown>): Record<string, unknown> { return { packageRoot: "/pkg", outDir: "/out", ...values }; }
function editTransport() { return { packageRoot: "/pkg", outDir: "/out" }; }
function commandArgs(command: typeof TIMELINE_RELATION_COMMANDS[keyof typeof TIMELINE_RELATION_COMMANDS]): Record<string, unknown> {
  if (command === TIMELINE_RELATION_COMMANDS.inspect) return { packageRoot: "/pkg" };
  if (command === TIMELINE_RELATION_COMMANDS.upsert) return edit({ binding: relation("next", "new-follower") });
  if (command === TIMELINE_RELATION_COMMANDS.enabled) return edit({ id: "follow", enabled: false });
  if (command === TIMELINE_RELATION_COMMANDS.bake) return edit({ id: "follow", sampleEveryUs: 2_000 });
  return edit({ id: "follow" });
}
function refusingServices(onLoad: () => void, onOutput = () => {}): Parameters<typeof dispatchTimelineRelationAuthoringCommand>[2] {
  return {
    packageLoader: async () => { onLoad(); throw new Error("must not load"); },
    isUnsafePackageOutputDirectory: async () => { onOutput(); return false; },
    isEmptyOrAbsentDirectory: async () => { onOutput(); return true; },
  };
}
function packageFor(root: string, document = motion()): MotionPackage {
  return {
    root,
    manifest: { schema: "shellx-motion/package-manifest@1", id: "relation-debug-package", name: "Relation Debug", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["browser"], hosts: ["motion"] } },
    motion: document,
  };
}

async function writePackage(root: string, document = motion()): Promise<string> {
  await mkdir(root, { recursive: true });
  const pkg = packageFor(root, document);
  await Promise.all([
    writeFile(join(root, "manifest.json"), `${JSON.stringify(pkg.manifest, null, 2)}\n`),
    writeFile(join(root, "motion.json"), `${JSON.stringify(pkg.motion, null, 2)}\n`),
  ]);
  return root;
}
