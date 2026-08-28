import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, canonicalJsonSha256 } from "@shellx-motion/core";
import {
  admitMotionRenderDeliverySources,
  renderDeliveryAnchorDeliveryBindingSha256,
  type MotionRenderDeliverySourceManifest,
} from "@shellx-motion/core/internal/render-delivery-source";
import { createTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { planImportedRenderDeliveryAnchorKeyframes } from "./render-delivery-package-anchor-bake-plan.js";
import { inspectImportedRenderDeliveryAnchors } from "./render-delivery-package-anchor-inspect.js";
import { importAdmittedRenderDeliveryToPackage } from "./render-delivery-package-import.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64");
const roots: string[] = [];
afterEach(async () => await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))));

describe("private provider-anchor inspection and immutable keyframe planning", () => {
  it("reopens receipt-bound bytes and compiles frozen exact linear x/y intents", async () => {
    const fixture = await makeImported(), before = await packageBytes(fixture.imported);
    const inspection = await inspect(fixture), plan = await planFor(fixture, inspection);
    expect(inspection).toMatchObject({
      receiptFingerprint: fixture.receiptFingerprint,
      delivery: { width: 1, height: 1, rate: { numerator: 30, denominator: 1 } },
      anchorAsset: { coordinateConvention: "screen-pixel-top-left-q1024" },
      anchors: [{ id: 7, visibility: { visibleSamples: 2, notVisibleSamples: 0 } }],
    });
    expect(JSON.stringify(inspection)).not.toContain(fixture.root);
    expect(Object.isFrozen(inspection)).toBe(true);
    expect(Object.isFrozen(inspection.anchors[0]!.samples)).toBe(true);
    expect(plan.counts).toEqual({ mappings: 1, samples: 2, keyframeWrites: 4 });
    expect(plan.timing).toEqual({
      scheduleFingerprint: inspection.delivery.scheduleFingerprint,
      derivedAtMs: [0, 1000 / 30],
      derivedAtMsFingerprint: canonicalJsonSha256([0, 1000 / 30]),
      coverage: { policy: "final-frame-interval-at-most", endMs: 2000 / 30 },
    });
    expect(plan.mappings[0]!.keyframes).toEqual({
      x: [{ atMs: 0, value: 0.5, easing: "linear" }, { atMs: 1000 / 30, value: 2.5, easing: "linear" }],
      y: [{ atMs: 0, value: 1, easing: "linear" }, { atMs: 1000 / 30, value: 3, easing: "linear" }],
    });
    expect(plan.changedPathIntents).toEqual(["/layers/0/keyframes/transform.x", "/layers/0/keyframes/transform.y"]);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.mappings[0]!.keyframes.x)).toBe(true);
    expect(await packageBytes(fixture.imported)).toEqual(before);
  });

  it("rejects hostile, sparse, and oversize requests before package reopening", async () => {
    const badHost = { sourcePackageRoot: "/missing/provider-anchor-package", packageWorkspaceRoot: "/missing" };
    const accessor = Object.defineProperty({}, "schema", { enumerable: true, get: () => MOTION_REQUEST });
    await expect(planImportedRenderDeliveryAnchorKeyframes(badHost, accessor)).rejects.toThrow(/data/i);
    const sparse: any[] = []; sparse.length = 1;
    await expect(planImportedRenderDeliveryAnchorKeyframes(badHost, requestShape(sparse))).rejects.toThrow(/dense/i);
    for (const length of [17, 100_000]) {
      let traversal = 0;
      const mappings = new Proxy(new Array(length), {
        ownKeys(target) { traversal += 1; return Reflect.ownKeys(target); },
        getOwnPropertyDescriptor(target, key) {
          if (key !== "length") traversal += 1;
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      });
      await expect(planImportedRenderDeliveryAnchorKeyframes(badHost, requestShape(mappings))).rejects.toThrow(/1\.\.16/i);
      expect(traversal).toBe(0);
    }
  });

  it("refuses visibility/no-op/rate/coverage/dimensions and publishes B2 caps at the exact boundary", async () => {
    const hidden = await makeImported({ samples: [{ xQ1024: 0, yQ1024: 0 }, null] });
    await expect(planFor(hidden, await inspect(hidden))).rejects.toThrow(/not-visible/i);
    const noOp = await makeImported({
      anchorTracks: [
        { id: 7, samples: [{ xQ1024: 0, yQ1024: 0 }, { xQ1024: 0, yQ1024: 0 }] },
        { id: 8, samples: [{ xQ1024: 1024, yQ1024: 2048 }, { xQ1024: 3072, yQ1024: 4096 }] },
      ], shapeCount: 2,
    });
    await expect(planFor(noOp, await inspect(noOp), [
      { anchorId: 7, targetLayerId: "shape", localTargetAnchorOffsetQ1024: { xQ1024: 0, yQ1024: 0 } }, mapping(8, "other"),
    ])).rejects.toThrow(/mapping 7 is a no-op/i);
    for (const [options, message] of [
      [{ fps: 24 }, /integer delivery rate/i],
      [{ rate: { numerator: 30_000, denominator: 1_001 } }, /integer delivery rate/i],
      [{ durationMs: 100 }, /cover the full Motion clip/i],
      [{ motionWidth: 2 }, /dimensions/i],
    ] as const) {
      const fixture = await makeImported(options);
      await expect(planFor(fixture, await inspect(fixture))).rejects.toThrow(message);
    }
    const oneFrame = await makeImported({ frameCount: 1, durationMs: 20 });
    await expect(planFor(oneFrame, await inspect(oneFrame))).resolves.toMatchObject({ timing: { derivedAtMs: [0], coverage: { endMs: 1000 / 30 } } });

    const atCap = await makeImported({ frameCount: 225, anchorIds: Array.from({ length: 16 }, (_, index) => index + 1), shapeCount: 16 });
    const inspection = await inspect(atCap);
    const plan = await planFor(atCap, inspection, Array.from({ length: 16 }, (_, index) => mapping(index + 1, targetId(index))));
    expect(plan.counts).toEqual({ mappings: 16, samples: 3600, keyframeWrites: 7200 });
    expect(plan.limits).toEqual({ maxMappings: 16, maxSamples: 3600, maxKeyframeWrites: 7200 });
    const overCap = await makeImported({ frameCount: 226 });
    await expect(planFor(overCap, await inspect(overCap), Array.from({ length: 16 }, (_, index) => mapping(index + 1, targetId(index))))).rejects.toThrow(/3600 samples/i);
  }, 60_000);

  it("refuses duplicate, hidden, non-root/non-shape, locked, and competing transform authority", async () => {
    const duplicate = await makeImported();
    await expect(planFor(duplicate, await inspect(duplicate), [mapping(7, "shape"), mapping(8, "shape")])).rejects.toThrow(/reuse a target/i);
    const cases: ReadonlyArray<readonly [FixtureOptions["mutateMotion"], RegExp]> = [
      [(motion) => { motion.layers[0].visible = false; }, /visible root-owned/i],
      [(motion) => { motion.layers[0] = { ...motion.layers[0], type: "group", childLayerIds: [] }; }, /visible root-owned/i],
      [(motion) => { motion.layers.push({ id: "group", type: "group", startMs: 0, durationMs: motion.durationMs, childLayerIds: ["shape"] }); }, /visible root-owned/i],
      [(motion) => { motion.layers[0].durationMs = 20; }, /not active/i],
      [(motion) => { motion.layers[0].durationMs = 1000 / 30; }, /not active/i],
      [(motion) => { motion.layers[0].keyframes = { "transform.x": [{ atMs: 0, value: 0 }] }; }, /already has transform\.x/i],
      [(motion) => { motion.layers[0].locked = true; }, /locked layer/i],
      [(motion) => { motion.tracks = [{ id: "referencing-track", type: "overlay", locked: true, layerIds: ["shape"] }]; }, /locked track/i],
      [(motion) => { motion.behaviors = { schema: "shellx-motion/behaviors@1", bindings: [{ targetLayerId: "shape", enabled: false, kind: "transform", startUs: 0, durationUs: motion.durationMs * 1000, motion: { kind: "gravity", velocityX: 1, velocityY: 0, gravityY: 0 } }] }; }, /transform authority/i],
      [(motion) => { motion.relationships = { schema: "shellx-motion/procedural-relationships@1", relationships: [{ id: "p", enabled: false, target: { layerId: "shape", property: "transform.x" }, nodes: [{ id: "n", type: "constant", value: 1 }], outputNodeId: "n" }] }; }, /transform authority/i],
      [(motion) => {
        motion.layers.push({ id: "other", type: "shape", shape: "rect", startMs: 0, durationMs: motion.durationMs, transform: { x: 0, y: 0 } });
        motion.relations = { schema: "shellx-motion/relations@1", bindings: [{ id: "r", enabled: false, kind: "attach", source: { layerId: "other", anchor: { x: 0, y: 0 } }, target: { layerId: "shape", anchor: { x: 0, y: 0 } }, startUs: 0, durationUs: motion.durationMs * 1000, mode: "follow", offset: { space: "world", x: 0, y: 0, rotationDeg: 0, scale: 1 } }] };
      }, /transform authority/i],
    ];
    for (const [mutateMotion, message] of cases) {
      const fixture = await makeImported({ mutateMotion });
      await expect(planFor(fixture, await inspect(fixture))).rejects.toThrow(message);
    }
  }, 30_000);

  it("refuses forged receipt/package identity and tampered, symlinked, or hardlinked anchors", async () => {
    const receipt = await makeImported();
    await writeFile(join(receipt.imported, "receipts", "render-delivery-import.v1.json"), "{}\n");
    await expect(inspect(receipt)).rejects.toThrow();
    const identity = await makeImported(), manifest = JSON.parse(await readFile(join(identity.imported, "manifest.json"), "utf8"));
    manifest.id = "forged"; await writeFile(join(identity.imported, "manifest.json"), JSON.stringify(manifest));
    await expect(inspect(identity)).rejects.toThrow(/identity/i);
    const linked = await makeImported(), linkedAnchor = await anchorPathFor(linked), outside = join(linked.root, "outside.json");
    await writeFile(outside, await readFile(linkedAnchor)); await rm(linkedAnchor); await symlink(outside, linkedAnchor);
    await expect(inspect(linked)).rejects.toThrow();
    const hardlinked = await makeImported(), hardAnchor = await anchorPathFor(hardlinked);
    await link(hardAnchor, join(hardlinked.root, "second-anchor.json"));
    await expect(inspect(hardlinked)).rejects.toThrow();
  });

  it("re-reads receipt, anchor, manifest, and Motion evidence without creating output", async () => {
    const receipt = await makeImported(), receiptPath = join(receipt.imported, "receipts", "render-delivery-import.v1.json");
    await expect(inspectImportedRenderDeliveryAnchors(host(receipt), {
      afterInitialAnchorSnapshot: async () => await writeFile(receiptPath, "{}\n"),
    })).rejects.toThrow(/receipt/i);
    await expect(readFile(join(receipt.workspace, "unexpected-output", "manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });
    const anchor = await makeImported();
    await expect(inspectImportedRenderDeliveryAnchors(host(anchor), {
      afterInitialAnchorSnapshot: async () => await writeFile(await anchorPathFor(anchor), "tampered"),
    })).rejects.toThrow(/anchor/i);
    for (const file of ["manifest.json", "motion.json", "receipts/render-delivery-import.v1.json", "anchor"] as const) {
      const fixture = await makeImported();
      await expect(inspectImportedRenderDeliveryAnchors(host(fixture), {
        afterFinalAnchorSnapshot: async () => {
          if (file === "anchor") {
            await writeFile(await anchorPathFor(fixture), "tampered");
            return;
          }
          const path = join(fixture.imported, file);
          if (file === "receipts/render-delivery-import.v1.json") {
            await writeFile(path, "{}\n");
            return;
          }
          const json = JSON.parse(await readFile(path, "utf8"));
          json.name = "mutated-" + file;
          await writeFile(path, JSON.stringify(json));
        },
      })).rejects.toThrow(/receipt|anchor|changed/i);
    }
  });
});

const MOTION_REQUEST = "shellx-motion/render-delivery-anchor-keyframe-intent-request/v1";
type AnchorSample = { xQ1024: number; yQ1024: number } | null;
interface Fixture { root: string; workspace: string; imported: string; packageAuthority: Awaited<ReturnType<typeof createTrustedWorkspaceAnchor>>; receiptFingerprint: string; }
interface FixtureOptions {
  samples?: readonly AnchorSample[]; anchorTracks?: readonly { readonly id: number; readonly samples: readonly AnchorSample[] }[]; anchorIds?: readonly number[];
  frameCount?: number; fps?: number; rate?: { readonly numerator: number; readonly denominator: number }; shapeCount?: number; durationMs?: number; motionWidth?: number;
  mutateMotion?: (motion: any) => void;
}
function mapping(anchorId: number, targetLayerId: string) { return { anchorId, targetLayerId, localTargetAnchorOffsetQ1024: { xQ1024: 512, yQ1024: 1024 } }; }
function targetId(index: number): string { return index === 0 ? "shape" : index === 1 ? "other" : "shape-" + index; }
function request(inspection: any, mappings = [mapping(7, "shape")]) { return { schema: MOTION_REQUEST, inspectionFingerprint: inspection.fingerprint, receiptFingerprint: inspection.receiptFingerprint, mappings }; }
function requestShape(mappings: unknown) { return { schema: MOTION_REQUEST, inspectionFingerprint: "a".repeat(64), receiptFingerprint: "b".repeat(64), mappings }; }
function host(fixture: Fixture) { return { sourcePackageRoot: fixture.imported, packageWorkspaceRoot: fixture.workspace, packageWorkspaceAuthority: fixture.packageAuthority }; }
async function inspect(fixture: Fixture) { return await inspectImportedRenderDeliveryAnchors(host(fixture)); }
async function planFor(fixture: Fixture, inspection: any, mappings = [mapping(7, "shape")]) { return await planImportedRenderDeliveryAnchorKeyframes(host(fixture), request(inspection, mappings)); }

async function makeImported(options: FixtureOptions = {}): Promise<Fixture> {
  const root = await scratch(), workspace = join(root, "workspace"), source = join(workspace, "source"), imported = join(workspace, "imported"), provider = join(root, "provider");
  await Promise.all([mkdir(workspace, { recursive: true, mode: 0o700 }), mkdir(provider, { recursive: true, mode: 0o700 })]);
  const fps = options.fps ?? 30, frameCount = options.frameCount ?? options.samples?.length ?? options.anchorTracks?.[0]?.samples.length ?? 2;
  const samples = options.samples ?? Array.from({ length: frameCount }, (_, index) => ({ xQ1024: 1024 + (index * 2048), yQ1024: 2048 + (index * 2048) }));
  const anchorTracks = options.anchorTracks ?? (options.anchorIds ?? [7]).map((id) => ({ id, samples }));
  if (!Number.isSafeInteger(frameCount) || frameCount < 1 || anchorTracks.some((track) => track.samples.length !== frameCount)) throw new Error("Fixture anchor samples must use one positive shared frame count.");
  const durationMs = options.durationMs ?? (Number.isInteger(frameCount * 1000 / fps) ? frameCount * 1000 / fps : 50);
  await writePackage(source, fps, options.shapeCount ?? 1, durationMs, options.motionWidth ?? 1, options.mutateMotion);
  const paths = await Promise.all(Array.from({ length: frameCount }, async (_, index) => {
    const path = join(provider, String(index) + ".png"); await writeFile(path, PNG); return path;
  }));
  const delivery: any = createDelivery(frameCount, options.rate);
  delivery.anchors = { schema: "motion.render-provider-anchor-payload/v1", sha256: "0".repeat(64), frameCount, convention: "screen-pixel-top-left-q1024" };
  const anchorPayload = {
    schema: "motion.render-provider-anchor-payload/v1", deliveryBindingSha256: renderDeliveryAnchorDeliveryBindingSha256(delivery), coordinateConvention: "screen-pixel-top-left-q1024",
    anchors: anchorTracks.map((track) => ({ id: track.id, samples: track.samples.map((sample, index) => sample ? { frameIndex: index, state: "visible", ...sample } : { frameIndex: index, state: "not-visible" }) })),
  };
  const anchorBytes = Buffer.from(canonicalJson(anchorPayload), "utf8"), anchor = join(provider, "anchors.json");
  delivery.anchors.sha256 = sha(anchorBytes); await writeFile(anchor, anchorBytes);
  const providerAuthority = await createTrustedWorkspaceAnchor(provider), packageAuthority = await createTrustedWorkspaceAnchor(workspace);
  const admitted = await admitMotionRenderDeliverySources({
    delivery, sources: { beauty: paths.map((providerLocalPath, index) => ({ index, providerLocalPath })), anchors: { providerLocalPath: anchor } },
  }, { providerInputRoot: provider, providerInputRootAuthority: providerAuthority });
  const result = await importAdmittedRenderDeliveryToPackage(admitted as MotionRenderDeliverySourceManifest, {
    sourcePackageRoot: source, outputPackageRoot: imported, packageWorkspaceRoot: workspace, packageWorkspaceAuthority: packageAuthority,
  });
  return { root, workspace, imported, packageAuthority, receiptFingerprint: result.receipt.fingerprint };
}
function createDelivery(count: number, override: FixtureOptions["rate"]) {
  const rate = override ?? { numerator: 30, denominator: 1 };
  const schedule = Array.from({ length: count }, (_, index) => ({ index, presentationTime: reduce(index * rate.denominator, rate.numerator) }));
  const frames = Array.from({ length: count }, (_, index) => ({ index, sha256: sha(PNG) }));
  return {
    schema: "motion.render-delivery/v1", provider: { id: "fixture-provider", version: "v1", capabilitySnapshotSha256: "a".repeat(64) },
    terminal: { jobId: "fixture-job", outcome: "passed", revalidation: "passed", cleanup: { state: "closed", succeeded: true } },
    identity: { sceneSha256: "b".repeat(64), shotSha256: "c".repeat(64), assetManifestSha256: "d".repeat(64), scheduleSha256: canonicalJsonSha256({ rate, schedule }), providerReceiptSha256: "e".repeat(64) },
    conventions: { timing: "frame-index-rational-seconds", coordinates: "screen-pixel-top-left", alpha: "straight", depth: "not-provided" }, rate, schedule,
    passes: [{ kind: "beauty", id: "beauty", format: "png", alphaMode: "straight", width: 1, height: 1, frames, frameSequenceSha256: canonicalJsonSha256({ frames }) }],
  };
}
async function writePackage(root: string, fps: number, shapeCount: number, durationMs: number, width: number, mutateMotion: FixtureOptions["mutateMotion"]): Promise<void> {
  const layers = Array.from({ length: shapeCount }, (_, index) => ({ id: targetId(index), type: "shape", shape: "rect", startMs: 0, durationMs, transform: { x: 0, y: 0 } }));
  const motion: any = { schema: "shellx-motion/motion@1", id: "fixture_motion", name: "Fixture", durationMs, fps, width, height: 1, layers, assets: [], provenance: { sourceApp: "test", createdBy: "test" } };
  mutateMotion?.(motion); await mkdir(root, { recursive: true });
  await writeFile(join(root, "manifest.json"), JSON.stringify({ schema: "shellx-motion/package-manifest@1", id: "fixture_package", name: "Fixture", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["browser"], hosts: ["motion"] } }, null, 2) + "\n");
  await writeFile(join(root, "motion.json"), JSON.stringify(motion, null, 2) + "\n");
}
async function anchorPathFor(fixture: Fixture): Promise<string> {
  const receipt: any = JSON.parse(await readFile(join(fixture.imported, "receipts", "render-delivery-import.v1.json"), "utf8"));
  return join(fixture.imported, receipt.sourceManifest.anchors.packagePath);
}
async function packageBytes(root: string): Promise<readonly Buffer[]> {
  const baseline = await Promise.all(["manifest.json", "motion.json", "receipts/render-delivery-import.v1.json"].map(async (file) => await readFile(join(root, file))));
  const receipt: any = JSON.parse(baseline[2]!.toString("utf8"));
  return [...baseline, await readFile(join(root, receipt.sourceManifest.anchors.packagePath))];
}
function reduce(numerator: number, denominator: number) { let a = numerator, b = denominator; while (b) [a, b] = [b, a % b]; return { numerator: numerator / (a || 1), denominator: denominator / (a || 1) }; }
function sha(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }
async function scratch(): Promise<string> {
  const base = resolve("../../.scratch"); await mkdir(base, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(base, "provider-anchor-plan-")); roots.push(root); return root;
}
