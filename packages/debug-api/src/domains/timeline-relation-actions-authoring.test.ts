import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as Core from "@shellx-motion/core";
import type { MotionDocument, MotionPackage, MotionRelationActionDefinition, OperationReceipt } from "@shellx-motion/core";
import { hasAtomicCOWAuthority } from "@shellx-motion/core/test-support";
import { TIMELINE_RELATION_ACTION_COMMAND_METADATA } from "../command-metadata-timeline-relation-actions.js";
import { debugCommandDefinition } from "../command-registry.js";
import { withTestAuthoringRoots } from "../authoring-test-context.test-support.js";
import {
  applyTimelineRelationActionIntent,
  dispatchTimelineRelationActionAuthoringCommand,
  relationActionMutationFacts,
  type TimelineRelationActionAuthoringServices,
} from "./timeline-relation-actions-authoring.js";
import { TIMELINE_RELATION_ACTION_COMMANDS, readTimelineRelationActionIntent } from "./timeline-relation-actions.js";
import { dispatchTimelineStructuralCommand } from "./timeline-structural-dispatch.js";

const atomicCOW = hasAtomicCOWAuthority(tmpdir()) ? it : it.skip;
const topologyRefusal = hasAtomicCOWAuthority(tmpdir()) ? it.skip : it;

describe("timeline relation-actions Debug authoring", () => {
  it("parses only the closed inspect/upsert/remove/apply ABI through Core readers", () => {
    expect(readTimelineRelationActionIntent(TIMELINE_RELATION_ACTION_COMMANDS.inspect, { packageRoot: "/pkg" }))
      .toEqual({ ok: true, intent: { kind: "inspect", packageRoot: "/pkg" } });
    expect(readTimelineRelationActionIntent(TIMELINE_RELATION_ACTION_COMMANDS.upsert, edit({ definition: definition() })))
      .toMatchObject({ ok: true, intent: { kind: "upsert", edit: editTransport(), definition: { id: "accent-action" } } });
    expect(readTimelineRelationActionIntent(TIMELINE_RELATION_ACTION_COMMANDS.remove, edit({ id: "accent-action" })))
      .toEqual({ ok: true, intent: { kind: "remove", edit: editTransport(), definitionId: "accent-action" } });
    expect(readTimelineRelationActionIntent(TIMELINE_RELATION_ACTION_COMMANDS.apply, edit({ expectedPackageId: "pkg", expectedPackageManifestSha256: "a".repeat(64), request: syntacticRequest() })))
      .toMatchObject({ ok: true, intent: { kind: "apply", expectedPackageId: "pkg", request: { definitionId: "accent-action", startAtUs: 1_000_000 } } });
    for (const alias of ["receiptsRoot", "receiptRoot", "receipts", "receiptDirectory"]) {
      expect(readTimelineRelationActionIntent(TIMELINE_RELATION_ACTION_COMMANDS.upsert, { ...edit({ definition: definition() }), [alias]: "/caller" }))
        .toEqual({ ok: false, problem: `Unknown argument: ${alias}.` });
    }
    expect(Object.values(TIMELINE_RELATION_ACTION_COMMANDS).map((command) => debugCommandDefinition(command))).toEqual([
      expect.objectContaining({ permission: "read_motion", mutates: false }),
      ...Array.from({ length: 3 }, () => expect.objectContaining({ permission: "edit_motion", mutates: true })),
    ]);
  });

  it("refuses hostile and Core-capped semantic input before package load or output preflight", async () => {
    for (const command of Object.values(TIMELINE_RELATION_ACTION_COMMANDS)) {
      let descriptors = 0, gets = 0, loads = 0, outputs = 0;
      const hostile = new Proxy({}, {
        ownKeys: () => Array.from({ length: 10_000 }, (_, index) => `unexpected${index}`),
        getOwnPropertyDescriptor: () => { descriptors += 1; return undefined; }, get: () => { gets += 1; return undefined; },
      });
      expect(readTimelineRelationActionIntent(command, hostile)).toMatchObject({ ok: false, problem: expect.stringContaining("allowance") });
      expect({ descriptors, gets }).toEqual({ descriptors: 0, gets: 0 });
      const result = await dispatchTimelineRelationActionAuthoringCommand(command, hostile, refusingServices(() => { loads += 1; }, () => { outputs += 1; }));
      expect(result).toMatchObject({ ok: false, error: { code: "invalid_args" } }); expect({ loads, outputs }).toEqual({ loads: 0, outputs: 0 });
    }
    let templateOwnKeys = 0, templateDescriptors = 0, loads = 0;
    const templates = new Proxy(new Array(33), { ownKeys(target) { templateOwnKeys += 1; return Reflect.ownKeys(target); }, getOwnPropertyDescriptor(target, key) { templateDescriptors += 1; return Reflect.getOwnPropertyDescriptor(target, key); } });
    const capped = definition(); capped.templateLayers = templates as unknown as typeof capped.templateLayers;
    const refusal = await dispatchTimelineRelationActionAuthoringCommand(TIMELINE_RELATION_ACTION_COMMANDS.upsert, edit({ definition: capped }), refusingServices(() => { loads += 1; }));
    expect(refusal).toMatchObject({ ok: false, error: { code: "invalid_args", message: expect.stringContaining("at most 32") } });
    expect({ templateOwnKeys, templateDescriptors, loads }).toEqual({ templateOwnKeys: 0, templateDescriptors: 1, loads: 0 });

    // `id` must cross the Debug envelope untouched: Core's exact one-field remove reader is
    // the first semantic reader, so no generic clone traverses hostile or oversized id values.
    const accessor = edit({}); let accessorReads = 0;
    Object.defineProperty(accessor, "id", { enumerable: true, get() { accessorReads += 1; return "accent-action"; } });
    let outputs = 0;
    const accessorResult = await dispatchTimelineRelationActionAuthoringCommand(TIMELINE_RELATION_ACTION_COMMANDS.remove, accessor, refusingServices(() => { loads += 1; }, () => { outputs += 1; }));
    expect(accessorResult).toMatchObject({ ok: false, error: { code: "invalid_args", message: expect.stringContaining("enumerable data field") } });
    expect({ accessorReads, loads, outputs }).toEqual({ accessorReads: 0, loads: 0, outputs: 0 });

    let idOwnKeys = 0, idDescriptors = 0, idGets = 0;
    const hostileId = new Proxy({}, {
      ownKeys: () => { idOwnKeys += 1; return []; },
      getOwnPropertyDescriptor: () => { idDescriptors += 1; return undefined; },
      get: () => { idGets += 1; return undefined; },
    });
    const hostileResult = await dispatchTimelineRelationActionAuthoringCommand(TIMELINE_RELATION_ACTION_COMMANDS.remove, edit({ id: hostileId }), refusingServices(() => { loads += 1; }, () => { outputs += 1; }));
    expect(hostileResult).toMatchObject({ ok: false, error: { code: "invalid_args", message: expect.stringContaining("JSON scalar") } });
    expect({ idOwnKeys, idDescriptors, idGets, loads, outputs }).toEqual({ idOwnKeys: 0, idDescriptors: 0, idGets: 0, loads: 0, outputs: 0 });

    const oversizedResult = await dispatchTimelineRelationActionAuthoringCommand(TIMELINE_RELATION_ACTION_COMMANDS.remove, edit({ id: "a".repeat(65) }), refusingServices(() => { loads += 1; }, () => { outputs += 1; }));
    expect(oversizedResult).toMatchObject({ ok: false, error: { code: "invalid_args", message: expect.stringContaining("safe stable id") } });
    expect({ loads, outputs }).toEqual({ loads: 0, outputs: 0 });
  });

  it("uses Core lifecycle output and reports exact plan/lane facts", () => {
    const upserted = applyTimelineRelationActionIntent(motion(), { kind: "upsert", edit: editTransport(), definition: definition() }, {});
    expect(upserted).toMatchObject({ action: "upserted", definitionId: "accent-action", outputMotionSha256: Core.canonicalJsonSha256(upserted.motion) });
    const request = applyRequest(upserted.motion);
    const applied = applyTimelineRelationActionIntent(upserted.motion, { kind: "apply", edit: editTransport(), expectedPackageId: "pkg", expectedPackageManifestSha256: "a".repeat(64), request }, {});
    expect(relationActionMutationFacts(applied)).toMatchObject({
      outputMotionSha256: Core.canonicalJsonSha256(applied.motion),
      relationActions: { action: "applied", beforeStoreSha256: expect.stringMatching(/^[a-f0-9]{64}$/), afterStoreSha256: expect.stringMatching(/^[a-f0-9]{64}$/), beforeDefinitionSha256: expect.stringMatching(/^[a-f0-9]{64}$/), afterDefinitionSha256: expect.stringMatching(/^[a-f0-9]{64}$/), requestSha256: requestSha256(request), planFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/), counts: { objects: 1, relations: 0, keyframeWrites: 0 }, createdLayerIds: [expect.stringMatching(/^ra_layer_/)], render: { renderLanesFor: expect.any(Array), unrenderablePackageRefusal: null } },
    });
    const removed = applyTimelineRelationActionIntent(upserted.motion, { kind: "remove", edit: editTransport(), definitionId: "accent-action" }, {});
    expect(removed).toMatchObject({ action: "removed", definitionId: "accent-action" }); expect(removed.motion).not.toHaveProperty("relationActions");
  });

  it("routes inspect read-only through the structural dispatcher without a receipt", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-debug-relation-actions-inspect-"));
    try {
      const pkg = packageFor(root, Core.upsertMotionRelationActionDefinition(motion(), { definition: definition() }).motion);
      const result = await dispatchTimelineStructuralCommand(
        TIMELINE_RELATION_ACTION_COMMANDS.inspect,
        { packageRoot: pkg.root },
        withTestAuthoringRoots({ packageLoader: async () => pkg }, { inputRoots: [pkg.root] }),
      );
      expect(result).toMatchObject({ ok: true, result: { inspection: { store: { schema: "shellx-motion/relation-actions@2", definitions: [expect.objectContaining({ id: "accent-action" })] } }, render: { renderLanesFor: expect.any(Array), unrenderablePackageRefusal: null } } });
      expect(result).not.toHaveProperty("receiptId");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  atomicCOW("atomically COW-applies exact-base materialization, reopens it, and mirrors one receipt", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-debug-relation-actions-cow-"));
    const stored = Core.upsertMotionRelationActionDefinition(motion(), { definition: definition() }).motion;
    const source = await writePackage(join(root, "source"), stored); const outDir = join(root, "output"); const sourceBytes = await readFile(join(source, "motion.json"));
    try {
      const pkg = await Core.loadMotionPackage(source);
      const result = await dispatchTimelineStructuralCommand(TIMELINE_RELATION_ACTION_COMMANDS.apply, edit({
        packageRoot: source, outDir, expectedPackageId: pkg.manifest.id,
        expectedPackageManifestSha256: await Core.hashPackageFile(Core.resolvePackageAsset(pkg, "manifest.json")), request: applyRequest(pkg.motion), createdBy: "test",
      }), cowServices(root));
      expect(result).toMatchObject({ ok: true, result: { action: "applied", outputMotionSha256: expect.stringMatching(/^[a-f0-9]{64}$/), relationActions: { requestSha256: expect.stringMatching(/^[a-f0-9]{64}$/), planFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/), createdLayerIds: [expect.stringMatching(/^ra_layer_/)] } } });
      if (!result || !result.ok) throw new Error("expected COW apply");
      const reopened = await Core.loadMotionPackage(outDir);
      const receipt = JSON.parse(await readFile(join(outDir, "receipts", "timeline-relation-actions-apply.receipt.json"), "utf8"));
      expect(receipt).toMatchObject({ operation: "timeline.relation-actions.apply", status: "passed", inputHashes: { "manifest.json": expect.stringMatching(/^[a-f0-9]{64}$/), "motion.json": expect.stringMatching(/^[a-f0-9]{64}$/) }, output: { outputMotionSha256: Core.canonicalJsonSha256(reopened.motion), relationActions: { expectedPackage: { id: pkg.manifest.id }, beforeStoreSha256: expect.stringMatching(/^[a-f0-9]{64}$/), afterStoreSha256: expect.stringMatching(/^[a-f0-9]{64}$/), beforeDefinitionSha256: expect.stringMatching(/^[a-f0-9]{64}$/), afterDefinitionSha256: expect.stringMatching(/^[a-f0-9]{64}$/), render: { renderLanesFor: expect.any(Array), unrenderablePackageRefusal: null } } } });
      expect(result.result).toHaveProperty("hostReceiptPath"); expect(await readFile(join(source, "motion.json"))).toEqual(sourceBytes);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("refuses stale outer package identity before COW output while preserving the source", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-debug-relation-actions-stale-"));
    const stored = Core.upsertMotionRelationActionDefinition(motion(), { definition: definition() }).motion;
    const source = await writePackage(join(root, "source"), stored);
    const outDir = join(root, "output"); const before = await readFile(join(source, "motion.json"));
    try {
      let loads = 0, outputChecks = 0;
      const result = await dispatchTimelineStructuralCommand(TIMELINE_RELATION_ACTION_COMMANDS.apply, edit({ packageRoot: source, outDir, expectedPackageId: "stale-package", expectedPackageManifestSha256: "0".repeat(64), request: applyRequest(stored) }), {
        ...cowServices(root),
        // This focused base-binding test intentionally bypasses the managed package loader.
        // It still uses actual manifest/motion files for the generic receipt input hashes, but
        // proves the stale outer identity stops before the COW transaction creates output.
        packageLoader: async () => { loads += 1; return packageFor(source, stored); },
        isUnsafePackageOutputDirectory: async () => { outputChecks += 1; return false; },
        isEmptyOrAbsentDirectory: async () => { outputChecks += 1; return true; },
      });
      expect(result).toMatchObject({ ok: false, error: { code: "timeline_relation_action_failed", message: expect.stringContaining("stale expectedPackageId") } });
      expect({ loads, outputChecks }).toEqual({ loads: 1, outputChecks: 2 });
      expect(existsSync(outDir)).toBe(false); expect(await readFile(join(source, "motion.json"))).toEqual(before);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  topologyRefusal("keeps the managed topology refusal source/output-clean", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-debug-relation-actions-topology-")); const source = await writePackage(join(root, "source")); const outDir = join(root, "output"); const before = await readFile(join(source, "motion.json"));
    try {
      const result = await dispatchTimelineStructuralCommand(TIMELINE_RELATION_ACTION_COMMANDS.upsert, edit({ packageRoot: source, outDir, definition: definition() }), cowServices(root));
      expect(result).toMatchObject({ ok: false }); expect(existsSync(outDir)).toBe(false); expect(await readFile(join(source, "motion.json"))).toEqual(before);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("keeps metadata one-to-one, COW-only, and receipt-bearing", () => {
    expect(Object.keys(TIMELINE_RELATION_ACTION_COMMAND_METADATA).sort()).toEqual(Object.values(TIMELINE_RELATION_ACTION_COMMANDS).sort());
    expect(TIMELINE_RELATION_ACTION_COMMAND_METADATA[TIMELINE_RELATION_ACTION_COMMANDS.inspect]).not.toHaveProperty("expectedReceipts");
    for (const command of Object.values(TIMELINE_RELATION_ACTION_COMMANDS).slice(1)) {
      const metadata = TIMELINE_RELATION_ACTION_COMMAND_METADATA[command];
      expect("expectedReceipts" in metadata ? metadata.expectedReceipts : undefined).toEqual([expect.objectContaining({ operation: command.replace("motion.", ""), mode: "emits", required: true })]);
      expect(metadata.argsSchema.properties).not.toHaveProperty("receiptsRoot");
    }
    const request = TIMELINE_RELATION_ACTION_COMMAND_METADATA[TIMELINE_RELATION_ACTION_COMMANDS.apply].argsSchema.properties.request!;
    expect(request.properties?.roleBindings).toMatchObject({ type: "object", maxProperties: 16 });
    expect(request.properties?.parameterValues).toMatchObject({ type: "object", maxProperties: 16 });
  });
});

function definition(): MotionRelationActionDefinition { return { id: "accent-action", roles: [{ id: "anchor", kind: "layer", layerTypes: ["shape"] }], parameters: [], templateLayers: [{ id: "accent", layer: { schema: "shellx-motion/relation-action-layer-prototype@1", type: "shape", startUs: 0, durationUs: 1_000_000, shape: "rect", fill: "#abcdef", transform: { x: 1, y: 1, width: 10, height: 10 } } }], relationTemplates: [], sequence: [] }; }
function motion(): MotionDocument { return { schema: "shellx-motion/motion@1", id: "action-debug", name: "Action Debug", durationMs: 2_000, fps: 30, width: 100, height: 60, assets: [], provenance: { sourceApp: "test", createdBy: "test" }, layers: [{ id: "anchor", type: "shape", shape: "rect", fill: "#ffffff", startMs: 0, durationMs: 2_000, transform: { x: 10, y: 5, width: 10, height: 10 } }] }; }
function syntacticRequest() { return { definitionId: "accent-action", expectedMotionSha256: "a".repeat(64), expectedStoreSha256: "b".repeat(64), expectedDefinitionSha256: "c".repeat(64), instanceId: "accent-01", startAtUs: 1_000_000, roleBindings: { anchor: "anchor" }, parameterValues: {} }; }
function applyRequest(source: MotionDocument) { const inspection = Core.inspectMotionRelationActions(source), definition = inspection.store!.definitions[0]!; return { definitionId: definition.id, expectedMotionSha256: Core.canonicalJsonSha256(source), expectedStoreSha256: inspection.storeSha256!, expectedDefinitionSha256: Core.canonicalJsonSha256(definition), instanceId: "accent-01", startAtUs: 1_000_000, roleBindings: { anchor: "anchor" }, parameterValues: {} }; }
function requestSha256(request: ReturnType<typeof applyRequest>) { return Core.canonicalJsonSha256(request); }
function edit(values: Record<string, unknown>) { return { packageRoot: "/pkg", outDir: "/out", ...values }; }
function editTransport() { return { packageRoot: "/pkg", outDir: "/out" }; }
function refusingServices(onLoad: () => void, onOutput = () => {}): TimelineRelationActionAuthoringServices { return { packageLoader: async () => { onLoad(); throw new Error("must not load"); }, isUnsafePackageOutputDirectory: async () => { onOutput(); return false; }, isEmptyOrAbsentDirectory: async () => { onOutput(); return true; } }; }
function packageFor(root: string, document = motion()): MotionPackage { return { root, manifest: { schema: "shellx-motion/package-manifest@1", id: "pkg", name: "Action Debug", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["browser"], hosts: ["motion"] } }, motion: document }; }
function cowServices(root: string): TimelineRelationActionAuthoringServices { return { authoringInputRoots: [root], authoringOutputRoots: [root], receiptsRoot: root, packageLoader: Core.loadMotionPackage, isUnsafePackageOutputDirectory: async () => false, isEmptyOrAbsentDirectory: async (path) => !existsSync(path) || (await readdir(path)).length === 0, writeReceipt: async (root, receipt: OperationReceipt) => { const path = join(root, `${receipt.id}.json`); await writeFile(path, `${JSON.stringify(receipt)}\n`); return path; } }; }
async function writePackage(root: string, document = motion()): Promise<string> { await mkdir(root, { recursive: true }); const pkg = packageFor(root, document); await writeFile(join(root, "manifest.json"), `${JSON.stringify(pkg.manifest, null, 2)}\n`); await writeFile(join(root, "motion.json"), `${JSON.stringify(pkg.motion, null, 2)}\n`); return root; }
