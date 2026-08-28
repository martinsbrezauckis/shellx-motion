/** Behavioral proof for atomic debug keying and roto package edits. */
import {
  CHROMA_KEY_SCHEMA,
  ROTO_MASK_SCHEMA,
  ROTO_TRACKING_ATTACHMENT_SCHEMA,
  loadMotionPackage,
  type OperationReceipt,
} from "@shellx-motion/core";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withTestAuthoringRoots } from "../authoring-test-context.test-support.js";
import { dispatchKeyingAuthoringCommand } from "./authoring-keying.js";

const roots: string[] = [];

describe("keying and roto authoring commands", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("applies and inspects a chroma key through an atomic package copy", async () => {
    const root = await fixtureRoot();
    const sourceRoot = join(root, "source");
    const outputRoot = join(root, "keyed");
    const hostReceipts = join(root, "host-receipts");
    await writePackage(sourceRoot);
    const originalMotion = await readFile(join(sourceRoot, "motion.json"), "utf8");
    const result = await dispatchKeyingAuthoringCommand("motion.keying.apply", {
      packageRoot: sourceRoot,
      outDir: outputRoot,
      layerId: "subject",
      keying: { schema: CHROMA_KEY_SCHEMA, keyColor: "#00ff00", similarity: 0.2, spillSuppression: 0.8 },
      receiptsRoot: hostReceipts,
    }, withTestAuthoringRoots({
      packageLoader: loadMotionPackage,
      writeReceipt: async (receiptsRoot: string, receipt: OperationReceipt) => {
        await mkdir(receiptsRoot, { recursive: true, mode: 0o700 });
        const path = join(receiptsRoot, `${receipt.id}.json`);
        await writeFile(path, JSON.stringify(receipt), "utf8");
        return path;
      },
    }, { inputRoots: [root], outputRoots: [root] }));
    expect(result).toMatchObject({
      ok: true,
      result: { state: { keying: { keyColor: "#00ff00" }, trackingAttached: false } },
      visibleState: { panel: "keyingInspector", operation: "keying.apply", layerId: "subject" },
    });
    expect(await readFile(join(sourceRoot, "motion.json"), "utf8")).toBe(originalMotion);
    expect((await loadMotionPackage(outputRoot)).motion.layers[0].keying?.keyColor).toBe("#00ff00");
    expect(JSON.parse(await readFile(join(outputRoot, "receipts/keying-apply-subject.receipt.json"), "utf8"))).toMatchObject({
      operation: "keying.apply",
      artifacts: [{ role: "motion_package" }, { role: "keying_receipt" }],
    });
    const inspected = await dispatchKeyingAuthoringCommand("motion.keying.inspect", { packageRoot: outputRoot, layerId: "subject" }, authoringServices(root));
    expect(inspected).toMatchObject({ ok: true, result: { state: { keying: { spillSuppression: 0.8 } } } });
  });

  it("upserts tracked roto, detaches tracking only, and removes the mask", async () => {
    const root = await fixtureRoot();
    const sourceRoot = join(root, "source");
    const rotoRoot = join(root, "roto");
    const detachedRoot = join(root, "detached");
    const removedRoot = join(root, "removed");
    await writePackage(sourceRoot);
    const mask = {
      type: "roto",
      schema: ROTO_MASK_SCHEMA,
      closed: true,
      frames: [{
        atMs: 0,
        vertices: [
          { id: "a", x: 0.1, y: 0.1 },
          { id: "b", x: 0.9, y: 0.1 },
          { id: "c", x: 0.5, y: 0.9 },
        ],
      }],
      tracking: {
        schema: ROTO_TRACKING_ATTACHMENT_SCHEMA,
        analysisId: "subject-track",
        sourceSha256: "a".repeat(64),
        segmentIndex: 0,
        model: "similarity",
      },
    };
    const services = authoringServices(root);
    const upserted = await dispatchKeyingAuthoringCommand("motion.roto.upsert", { packageRoot: sourceRoot, outDir: rotoRoot, layerId: "subject", mask }, services);
    expect(upserted).toMatchObject({ ok: true, result: { state: { trackingAttached: true } } });

    const detached = await dispatchKeyingAuthoringCommand("motion.roto.tracking.detach", { packageRoot: rotoRoot, outDir: detachedRoot, layerId: "subject" }, services);
    expect(detached).toMatchObject({ ok: true, result: { state: { trackingAttached: false, roto: { frames: mask.frames } } } });
    expect((await loadMotionPackage(rotoRoot)).motion.layers[0].mask?.tracking).toBeDefined();

    const removed = await dispatchKeyingAuthoringCommand("motion.roto.remove", { packageRoot: detachedRoot, outDir: removedRoot, layerId: "subject" }, services);
    expect(removed).toMatchObject({ ok: true, result: { state: { roto: null } } });
    expect((await loadMotionPackage(removedRoot)).motion.layers[0].mask).toBeUndefined();
  });

  it("rejects malformed controls and unsafe or occupied output destinations", async () => {
    const root = await fixtureRoot();
    const sourceRoot = join(root, "source");
    const malformedRoot = join(root, "malformed");
    const occupiedRoot = join(root, "occupied");
    await writePackage(sourceRoot);
    const services = authoringServices(root);
    const baseArgs = { packageRoot: sourceRoot, layerId: "subject", keying: { schema: CHROMA_KEY_SCHEMA, keyColor: "#00ff00" } };

    const malformed = await dispatchKeyingAuthoringCommand("motion.keying.apply", {
      ...baseArgs,
      outDir: malformedRoot,
      keying: { ...baseArgs.keying, injected: true },
    }, services);
    expect(malformed).toMatchObject({ ok: false, error: { code: "keying_apply_failed", message: expect.stringMatching(/not supported/) } });
    expect(await stat(malformedRoot).catch(() => null)).toBeNull();

    const inPlace = await dispatchKeyingAuthoringCommand("motion.keying.apply", { ...baseArgs, outDir: sourceRoot }, services);
    expect(inPlace).toMatchObject({ ok: false, error: { code: "unsafe_output" } });

    await mkdir(occupiedRoot, { mode: 0o700 });
    await writeFile(join(occupiedRoot, "keep.txt"), "user-owned", "utf8");
    const occupied = await dispatchKeyingAuthoringCommand("motion.keying.apply", { ...baseArgs, outDir: occupiedRoot }, services);
    expect(occupied).toMatchObject({ ok: false, error: { code: "output_not_empty" } });
    expect(await readFile(join(occupiedRoot, "keep.txt"), "utf8")).toBe("user-owned");
  });
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-keying-authoring-"));
  roots.push(root);
  return root;
}

function authoringServices(root: string) {
  return withTestAuthoringRoots({ packageLoader: loadMotionPackage }, {
    inputRoots: [root],
    outputRoots: [root],
  });
}

async function writePackage(root: string): Promise<void> {
  await mkdir(join(root, "assets"), { recursive: true, mode: 0o700 });
  await writeFile(join(root, "assets/subject.mp4"), "fixture-video", "utf8");
  await writeJson(join(root, "manifest.json"), {
    schema: "shellx-motion/package-manifest@1",
    id: "keying-fixture",
    name: "Keying fixture",
    motion: "motion.json",
    assets: ["assets/subject.mp4"],
    sourceApp: "shellx-motion-test",
    compatibility: { lanes: ["browser", "ffmpeg"], hosts: ["shellx-motion"] },
  });
  await writeJson(join(root, "motion.json"), {
    schema: "shellx-motion/motion@1",
    id: "keying-fixture-motion",
    name: "Keying fixture",
    durationMs: 1_000,
    fps: 30,
    width: 320,
    height: 180,
    layers: [{ id: "subject", type: "video", assetId: "subject-video", startMs: 0, durationMs: 1_000 }],
    assets: [{ schema: "shellx-motion/asset@1", id: "subject-video", kind: "video", source: { path: "assets/subject.mp4", mimeType: "video/mp4" }, hash: { sha256: "fixture" } }],
    provenance: { sourceApp: "shellx-motion", createdBy: "test" },
  });
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
