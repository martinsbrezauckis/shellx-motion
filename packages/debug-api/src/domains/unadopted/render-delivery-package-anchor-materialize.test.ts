import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, canonicalJsonSha256, loadMotionPackage } from "@shellx-motion/core";
import {
  admitMotionRenderDeliverySources,
  renderDeliveryAnchorDeliveryBindingSha256,
  type MotionRenderDeliverySourceManifest,
} from "@shellx-motion/core/internal/render-delivery-source";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { inspectImportedRenderDeliveryAnchors } from "./render-delivery-package-anchor-inspect.js";
import { materializeImportedRenderDeliveryAnchorKeyframes } from "./render-delivery-package-anchor-materialize.js";
import { assertRenderDeliveryAnchorKeyframeMaterializationReceipt } from "./render-delivery-package-anchor-materialize-receipt.js";
import { importAdmittedRenderDeliveryToPackage } from "./render-delivery-package-import.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64");
const REQUEST_SCHEMA = "shellx-motion/render-delivery-anchor-keyframe-materialization-request/v1";
const INTENT_SCHEMA = "shellx-motion/render-delivery-anchor-keyframe-intent-request/v1";
const RECEIPT_PATH = "receipts/render-delivery-anchor-keyframe-materialization.v1.json";
const roots: string[] = [];
afterEach(async () => await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))));

describe("private provider-anchor C5B3 materialization", () => {
  it("rederives the exact plan and atomically persists only its linear x/y keyframes and receipt", async () => {
    const fixture = await makeImported(), sourceBefore = await packageBytes(fixture.imported), output = join(fixture.workspace, "materialized");
    const request = await materializationRequest(fixture);
    const result = await materializeImportedRenderDeliveryAnchorKeyframes(host(fixture, output), request);
    const outputPackage = await withTrustedWorkspaceAnchor(fixture.packageAuthority, async () => await loadMotionPackage(output));
    expect(await packageBytes(fixture.imported)).toEqual(sourceBefore);
    expect(result).toMatchObject({ packageRoot: output, workspaceCleanup: "completed", receipt: { cow: { outcome: "installed", cleanup: "transaction-owned", receipt: "exclusive-absent" } } });
    expect(Object.isFrozen(result.receipt)).toBe(true);
    expect(outputPackage.motion.layers[0]!.keyframes).toEqual({
      "transform.x": [{ atMs: 0, value: 0.5, easing: "linear" }, { atMs: 1000 / 30, value: 2.5, easing: "linear" }],
      "transform.y": [{ atMs: 0, value: 1, easing: "linear" }, { atMs: 1000 / 30, value: 3, easing: "linear" }],
    });
    const receipt: unknown = JSON.parse(await readFile(join(output, RECEIPT_PATH), "utf8"));
    assertRenderDeliveryAnchorKeyframeMaterializationReceipt(receipt);
    expect(receipt).toMatchObject({ output: { package: { motionSha256: expect.stringMatching(/^[a-f0-9]{64}$/) }, persistedMotionSha256: expect.any(String), canonicalMotionFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    expect(JSON.stringify(receipt)).not.toContain(fixture.workspace);
  });

  it("refuses hostile/oversize descriptors before package reopening or output work", async () => {
    const hostValue = { sourcePackageRoot: "/missing/imported", packageWorkspaceRoot: "/missing", outputPackageRoot: "/missing/out" };
    const accessor = Object.defineProperty({}, "request", { enumerable: true, get: () => { throw new Error("must not invoke accessor"); } });
    await expect(materializeImportedRenderDeliveryAnchorKeyframes(hostValue, accessor)).rejects.toThrow(/data field/i);
    for (const length of [17, 100_000]) {
      let traversal = 0;
      const mappings = new Proxy(new Array(length), {
        ownKeys(target) { traversal += 1; return Reflect.ownKeys(target); },
        getOwnPropertyDescriptor(target, key) { if (key !== "length") traversal += 1; return Reflect.getOwnPropertyDescriptor(target, key); },
      });
      await expect(materializeImportedRenderDeliveryAnchorKeyframes(hostValue, materializationShape(mappings))).rejects.toThrow(/1\.\.16/i);
      expect(traversal).toBe(0);
    }
  });

  it("refuses stale bases and caller plan/receipt-path aliases before output", async () => {
    const fixture = await makeImported(), output = join(fixture.workspace, "materialized"), request = await materializationRequest(fixture);
    await expect(materializeImportedRenderDeliveryAnchorKeyframes(host(fixture, output), { ...request, expected: { ...request.expected, motionSha256: "f".repeat(64) } })).rejects.toThrow(/bases/i);
    await expect(materializeImportedRenderDeliveryAnchorKeyframes(host(fixture, output), { ...request, plan: {} })).rejects.toThrow(/unsupported field/i);
    await expect(materializeImportedRenderDeliveryAnchorKeyframes(host(fixture, output), { ...request, receiptPath: RECEIPT_PATH })).rejects.toThrow(/unsupported field/i);
    await expect(readFile(join(output, "manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses receipt collisions, overlap, and workspace authority mismatch without changing source", async () => {
    const fixture = await makeImported(), before = await packageBytes(fixture.imported), request = await materializationRequest(fixture);
    await mkdir(join(fixture.imported, "receipts"), { recursive: true });
    await writeFile(join(fixture.imported, RECEIPT_PATH), "old");
    await expect(materializeImportedRenderDeliveryAnchorKeyframes(host(fixture, join(fixture.workspace, "regular")), request)).rejects.toThrow();
    await rm(join(fixture.imported, RECEIPT_PATH));
    await symlink(join(fixture.root, "outside-receipt"), join(fixture.imported, RECEIPT_PATH));
    await expect(materializeImportedRenderDeliveryAnchorKeyframes(host(fixture, join(fixture.workspace, "symlink")), request)).rejects.toThrow();
    await rm(join(fixture.imported, RECEIPT_PATH));
    await expect(materializeImportedRenderDeliveryAnchorKeyframes(host(fixture, fixture.imported), request)).rejects.toThrow(/outside|overlap|output/i);
    await expect(materializeImportedRenderDeliveryAnchorKeyframes({ ...host(fixture, join(fixture.workspace, "bad")), packageWorkspaceRoot: fixture.imported }, request)).rejects.toThrow(/strict descendant|authority/i);
    expect(await packageBytes(fixture.imported)).toEqual(before);
  });

  it("requires an absent, not merely empty, output directory", async () => {
    const fixture = await makeImported(), output = join(fixture.workspace, "empty-output");
    await mkdir(output);
    await expect(materializeImportedRenderDeliveryAnchorKeyframes(host(fixture, output), await materializationRequest(fixture))).rejects.toThrow(/must be absent/i);
  });

  it("observes cancellation before plan, after plan, and at the last beforeCommit checkpoint", async () => {
    const fixture = await makeImported(), request = await materializationRequest(fixture);
    const before = new AbortController(); before.abort();
    await expect(materializeImportedRenderDeliveryAnchorKeyframes(host(fixture, join(fixture.workspace, "pre")), request, { signal: before.signal })).rejects.toThrow(/cancelled/i);
    const afterPlan = new AbortController();
    await expect(materializeImportedRenderDeliveryAnchorKeyframes(host(fixture, join(fixture.workspace, "after")), request, { signal: afterPlan.signal, afterPlan: async () => afterPlan.abort() })).rejects.toThrow(/cancelled/i);
    const beforeCommit = new AbortController();
    await expect(materializeImportedRenderDeliveryAnchorKeyframes(host(fixture, join(fixture.workspace, "claim")), request, { signal: beforeCommit.signal, beforeCommit: async () => beforeCommit.abort() })).rejects.toThrow(/cancelled/i);
    for (const output of ["pre", "after", "claim"]) await expect(readFile(join(fixture.workspace, output, "manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("refuses B2 source/authority failures through fresh rederivation and leaves no output", async () => {
    const cases: ReadonlyArray<readonly [FixtureOptions, RegExp]> = [
      [{ durationMs: 100 }, /cover the full Motion clip/i],
      [{ mutateMotion: (motion) => { motion.layers[0].locked = true; } }, /locked/i],
      [{ mutateMotion: (motion) => { motion.behaviors = { schema: "shellx-motion/behaviors@1", bindings: [{ targetLayerId: "shape", enabled: false, kind: "transform", startUs: 0, durationUs: motion.durationMs * 1000, motion: { kind: "gravity", velocityX: 1, velocityY: 0, gravityY: 0 } }] }; } }, /authority/i],
      [{ mutateMotion: (motion) => { motion.relationships = { schema: "shellx-motion/procedural-relationships@1", relationships: [{ id: "p", enabled: false, target: { layerId: "shape", property: "transform.x" }, nodes: [{ id: "n", type: "constant", value: 1 }], outputNodeId: "n" }] }; } }, /transform authority/i],
    ];
    for (const [options, message] of cases) {
      const fixture = await makeImported(options), output = join(fixture.workspace, `out-${roots.length}`), request = await materializationRequest(fixture);
      await expect(materializeImportedRenderDeliveryAnchorKeyframes(host(fixture, output), request)).rejects.toThrow(message);
      await expect(readFile(join(output, "manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });
    }
  }, 30_000);

  it("rejects a plan/source race and treats output receipts as evidence rather than future authority", async () => {
    const fixture = await makeImported(), output = join(fixture.workspace, "race"), request = await materializationRequest(fixture);
    await expect(materializeImportedRenderDeliveryAnchorKeyframes(host(fixture, output), request, {
      afterPlan: async () => await writeFile(join(fixture.imported, "receipts", "render-delivery-import.v1.json"), "{}\n"),
    })).rejects.toThrow();
    await expect(readFile(join(output, "manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });

    const clean = await makeImported(), done = join(clean.workspace, "done"), cleanRequest = await materializationRequest(clean);
    await materializeImportedRenderDeliveryAnchorKeyframes(host(clean, done), cleanRequest);
    const forged = JSON.parse(await readFile(join(done, RECEIPT_PATH), "utf8"));
    forged.output.persistedMotionSha256 = "0".repeat(64);
    expect(() => assertRenderDeliveryAnchorKeyframeMaterializationReceipt(forged)).toThrow(/invalid/i);
    await writeFile(join(done, RECEIPT_PATH), JSON.stringify(forged));
    await expect(materializeImportedRenderDeliveryAnchorKeyframes({ ...host(clean, join(clean.workspace, "again")), sourcePackageRoot: done }, cleanRequest)).rejects.toThrow(/keyframes|base|receipt/i);
  }, 30_000);

  it("keeps the exact 3,600-sample/7,200-write receipt below the one-megabyte package cap", async () => {
    const fixture = await makeImported({ frameCount: 225, anchorIds: Array.from({ length: 16 }, (_, index) => index + 1), shapeCount: 16 });
    const output = join(fixture.workspace, "at-cap");
    await materializeImportedRenderDeliveryAnchorKeyframes(host(fixture, output), await materializationRequest(fixture));
    expect((await readFile(join(output, RECEIPT_PATH))).byteLength).toBeLessThanOrEqual(1024 * 1024);
  }, 60_000);
});

type AnchorSample = { xQ1024: number; yQ1024: number } | null;
interface Fixture { root: string; workspace: string; imported: string; packageAuthority: Awaited<ReturnType<typeof createTrustedWorkspaceAnchor>>; anchorIds: readonly number[]; }
interface FixtureOptions { durationMs?: number; frameCount?: number; anchorIds?: readonly number[]; shapeCount?: number; mutateMotion?: (motion: any) => void; }
function host(fixture: Fixture, outputPackageRoot: string) { return { sourcePackageRoot: fixture.imported, packageWorkspaceRoot: fixture.workspace, packageWorkspaceAuthority: fixture.packageAuthority, outputPackageRoot }; }
function targetId(index: number) { return index === 0 ? "shape" : `shape-${index}`; }
function mapping(anchorId = 7, index = 0) { return { anchorId, targetLayerId: targetId(index), localTargetAnchorOffsetQ1024: { xQ1024: 512, yQ1024: 1024 } }; }
function intentShape(mappings: unknown) { return { schema: INTENT_SCHEMA, inspectionFingerprint: "a".repeat(64), receiptFingerprint: "b".repeat(64), mappings }; }
function materializationShape(mappings: unknown) { return { schema: REQUEST_SCHEMA, expected: { packageId: "fixture_package", manifestSha256: "c".repeat(64), motionSha256: "d".repeat(64) }, request: intentShape(mappings) }; }
async function materializationRequest(fixture: Fixture) {
  const inspection = await inspectImportedRenderDeliveryAnchors(host(fixture, join(fixture.workspace, "unused")));
  const intent = { schema: INTENT_SCHEMA, inspectionFingerprint: inspection.fingerprint, receiptFingerprint: inspection.receiptFingerprint, mappings: fixture.anchorIds.map((anchorId, index) => mapping(anchorId, index)) };
  return { schema: REQUEST_SCHEMA, expected: { packageId: inspection.package.packageId, manifestSha256: inspection.package.manifestSha256, motionSha256: inspection.package.motionSha256 }, request: intent };
}

async function makeImported(options: FixtureOptions = {}): Promise<Fixture> {
  const root = await scratch(), workspace = join(root, "workspace"), source = join(workspace, "source"), imported = join(workspace, "imported"), provider = join(root, "provider"), frameCount = options.frameCount ?? 2, anchorIds = options.anchorIds ?? [7], durationMs = options.durationMs ?? frameCount * 1000 / 30;
  await Promise.all([mkdir(workspace, { recursive: true, mode: 0o700 }), mkdir(provider, { recursive: true, mode: 0o700 })]);
  await writePackage(source, durationMs, options.shapeCount ?? anchorIds.length, options.mutateMotion);
  const paths = await Promise.all(Array.from({ length: frameCount }, async (_item, index) => { const path = join(provider, `${index}.png`); await writeFile(path, PNG); return path; }));
  const delivery: any = createDelivery(frameCount);
  delivery.anchors = { schema: "motion.render-provider-anchor-payload/v1", sha256: "0".repeat(64), frameCount, convention: "screen-pixel-top-left-q1024" };
  const anchorPayload = { schema: "motion.render-provider-anchor-payload/v1", deliveryBindingSha256: renderDeliveryAnchorDeliveryBindingSha256(delivery), coordinateConvention: "screen-pixel-top-left-q1024", anchors: anchorIds.map((id, trackIndex) => ({ id, samples: Array.from({ length: frameCount }, (_item, index) => ({ frameIndex: index, state: "visible", xQ1024: 1024 + index * 2048 + trackIndex, yQ1024: 2048 + index * 2048 + trackIndex })) })) };
  const anchorBytes = Buffer.from(canonicalJson(anchorPayload), "utf8"), anchor = join(provider, "anchors.json");
  delivery.anchors.sha256 = sha(anchorBytes); await writeFile(anchor, anchorBytes);
  const providerAuthority = await createTrustedWorkspaceAnchor(provider), packageAuthority = await createTrustedWorkspaceAnchor(workspace);
  const admitted = await admitMotionRenderDeliverySources({ delivery, sources: { beauty: paths.map((providerLocalPath, index) => ({ index, providerLocalPath })), anchors: { providerLocalPath: anchor } } }, { providerInputRoot: provider, providerInputRootAuthority: providerAuthority });
  await importAdmittedRenderDeliveryToPackage(admitted as MotionRenderDeliverySourceManifest, { sourcePackageRoot: source, outputPackageRoot: imported, packageWorkspaceRoot: workspace, packageWorkspaceAuthority: packageAuthority });
  return { root, workspace, imported, packageAuthority, anchorIds };
}

function createDelivery(frameCount: number) {
  const rate = { numerator: 30, denominator: 1 }, schedule = Array.from({ length: frameCount }, (_item, index) => ({ index, presentationTime: reduce(index, 30) })), frames = Array.from({ length: frameCount }, (_item, index) => ({ index, sha256: sha(PNG) }));
  return { schema: "motion.render-delivery/v1", provider: { id: "fixture-provider", version: "v1", capabilitySnapshotSha256: "a".repeat(64) }, terminal: { jobId: "fixture-job", outcome: "passed", revalidation: "passed", cleanup: { state: "closed", succeeded: true } }, identity: { sceneSha256: "b".repeat(64), shotSha256: "c".repeat(64), assetManifestSha256: "d".repeat(64), scheduleSha256: canonicalJsonSha256({ rate, schedule }), providerReceiptSha256: "e".repeat(64) }, conventions: { timing: "frame-index-rational-seconds", coordinates: "screen-pixel-top-left", alpha: "straight", depth: "not-provided" }, rate, schedule, passes: [{ kind: "beauty", id: "beauty", format: "png", alphaMode: "straight", width: 1, height: 1, frames, frameSequenceSha256: canonicalJsonSha256({ frames }) }] };
}
async function writePackage(root: string, durationMs: number, shapeCount: number, mutateMotion: FixtureOptions["mutateMotion"]): Promise<void> {
  const layers = Array.from({ length: shapeCount }, (_item, index) => ({ id: targetId(index), type: "shape", shape: "rect", startMs: 0, durationMs, transform: { x: 0, y: 0 } }));
  const motion: any = { schema: "shellx-motion/motion@1", id: "fixture_motion", name: "Fixture", durationMs, fps: 30, width: 1, height: 1, layers, assets: [], provenance: { sourceApp: "test", createdBy: "test" } };
  mutateMotion?.(motion); await mkdir(root, { recursive: true });
  await writeFile(join(root, "manifest.json"), JSON.stringify({ schema: "shellx-motion/package-manifest@1", id: "fixture_package", name: "Fixture", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["browser"], hosts: ["motion"] } }, null, 2) + "\n");
  await writeFile(join(root, "motion.json"), JSON.stringify(motion, null, 2) + "\n");
}
async function packageBytes(root: string): Promise<readonly Buffer[]> { return await Promise.all(["manifest.json", "motion.json", "receipts/render-delivery-import.v1.json"].map(async (file) => await readFile(join(root, file)))); }
function sha(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function reduce(numerator: number, denominator: number) { let a = numerator, b = denominator; while (b) [a, b] = [b, a % b]; return { numerator: numerator / (a || 1), denominator: denominator / (a || 1) }; }
async function scratch(): Promise<string> { const base = resolve(".scratch"); await mkdir(base, { recursive: true, mode: 0o700 }); const root = await mkdtemp(join(base, "provider-anchor-materialize-")); roots.push(root); return root; }
