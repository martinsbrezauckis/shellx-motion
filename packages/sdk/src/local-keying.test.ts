/** End-to-end local SDK proof for keying and roto package revisions. */
import { CHROMA_KEY_SCHEMA, ROTO_MASK_SCHEMA, ROTO_TRACKING_ATTACHMENT_SCHEMA, loadMotionPackage } from "@shellx-motion/core";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalMotionSdk } from "./local.js";

const roots: string[] = [];

describe("local keying SDK", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("inspects, applies, and removes a chroma key through verified package revisions", async () => {
    const root = await fixtureRoot();
    const sourceRoot = join(root, "source");
    const keyedRoot = join(root, "keyed");
    const unkeyedRoot = join(root, "unkeyed");
    await writePackage(sourceRoot);
    const sourceMotion = await readFile(join(sourceRoot, "motion.json"), "utf8");
    const sdk = createLocalMotionSdk();

    const inspected = await sdk.keyingInspect({ packageRoot: sourceRoot, layerId: "subject" });
    expect(inspected).toMatchObject({ ok: true, output: { state: { keying: null, roto: null } } });

    const applied = await sdk.keyingApply({
      packageRoot: sourceRoot,
      outDir: keyedRoot,
      layerId: "subject",
      keying: { schema: CHROMA_KEY_SCHEMA, keyColor: "#00ff00", similarity: 0.2, spillSuppression: 0.8 },
    });
    expect(applied).toMatchObject({
      ok: true,
      output: {
        packageRoot: keyedRoot,
        state: { keying: { keyColor: "#00ff00", spillSuppression: 0.8 } },
        receipt: { operation: "keying.apply", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      },
    });
    expect(await readFile(join(sourceRoot, "motion.json"), "utf8")).toBe(sourceMotion);
    expect((await loadMotionPackage(keyedRoot)).motion.layers[0].keying?.keyColor).toBe("#00ff00");

    const removed = await sdk.keyingRemove({ packageRoot: keyedRoot, outDir: unkeyedRoot, layerId: "subject" });
    expect(removed).toMatchObject({ ok: true, output: { state: { keying: null }, receipt: { operation: "keying.remove" } } });
  });

  it("preserves animated roto vertices when detaching tracking, then removes only the mask", async () => {
    const root = await fixtureRoot();
    const sourceRoot = join(root, "source");
    const rotoRoot = join(root, "roto");
    const detachedRoot = join(root, "detached");
    const removedRoot = join(root, "removed");
    await writePackage(sourceRoot);
    const sdk = createLocalMotionSdk();
    const mask = {
      type: "roto",
      schema: ROTO_MASK_SCHEMA,
      closed: true,
      frames: [{ atMs: 0, vertices: [
        { id: "a", x: 0.1, y: 0.1 }, { id: "b", x: 0.9, y: 0.1 }, { id: "c", x: 0.5, y: 0.9 },
      ] }],
      tracking: { schema: ROTO_TRACKING_ATTACHMENT_SCHEMA, analysisId: "track-1", sourceSha256: "a".repeat(64), segmentIndex: 0, model: "similarity" as const },
    };

    const upserted = await sdk.rotoUpsert({ packageRoot: sourceRoot, outDir: rotoRoot, layerId: "subject", mask });
    expect(upserted).toMatchObject({ ok: true, output: { state: { trackingAttached: true }, receipt: { operation: "roto.upsert" } } });

    const detached = await sdk.rotoTrackingDetach({ packageRoot: rotoRoot, outDir: detachedRoot, layerId: "subject" });
    expect(detached).toMatchObject({ ok: true, output: { state: { trackingAttached: false, roto: { frames: mask.frames } } } });
    expect((await loadMotionPackage(rotoRoot)).motion.layers[0].mask?.tracking).toBeDefined();

    const removed = await sdk.rotoRemove({ packageRoot: detachedRoot, outDir: removedRoot, layerId: "subject" });
    expect(removed).toMatchObject({ ok: true, output: { state: { roto: null }, receipt: { operation: "roto.remove" } } });
  });
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-sdk-keying-"));
  roots.push(root);
  return root;
}

async function writePackage(root: string): Promise<void> {
  await mkdir(join(root, "assets"), { recursive: true });
  await writeFile(join(root, "assets/subject.mp4"), "fixture-video", "utf8");
  await writeJson(join(root, "manifest.json"), {
    schema: "shellx-motion/package-manifest@1", id: "sdk-keying", name: "SDK keying", motion: "motion.json",
    assets: ["assets/subject.mp4"], sourceApp: "shellx-motion-test", compatibility: { lanes: ["browser"], hosts: ["shellx-motion"] },
  });
  await writeJson(join(root, "motion.json"), {
    schema: "shellx-motion/motion@1", id: "sdk-keying-motion", name: "SDK keying", durationMs: 1_000, fps: 30, width: 320, height: 180,
    layers: [{ id: "subject", type: "video", assetId: "subject-video", startMs: 0, durationMs: 1_000 }],
    assets: [{ schema: "shellx-motion/asset@1", id: "subject-video", kind: "video", source: { path: "assets/subject.mp4", mimeType: "video/mp4" }, hash: { sha256: "fixture" } }],
    provenance: { sourceApp: "shellx-motion-test", createdBy: "test" },
  });
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
