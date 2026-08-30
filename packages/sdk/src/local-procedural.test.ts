import { loadMotionPackage } from "@shellx-motion/core";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalMotionSdk } from "./local.js";
import { withTestAuthoringRoots } from "./local-test-authoring-context.test-support.js";

const roots: string[] = [];

describe("local procedural relationship SDK", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("exposes readable relationship state and receipt-backed enable, bake, and detach revisions", async () => {
    const root = await fixtureRoot();
    const sourceRoot = join(root, "source");
    const setRoot = join(root, "set");
    const disabledRoot = join(root, "disabled");
    const rejectedBakeRoot = join(root, "rejected-bake");
    const enabledRoot = join(root, "enabled");
    const bakedRoot = join(root, "baked");
    const detachedRoot = join(root, "detached");
    await writePackage(sourceRoot);
    const sourceText = await readFile(join(sourceRoot, "motion.json"), "utf8");
    const sdk = createLocalMotionSdk(withTestAuthoringRoots({}, {
      inputRoots: [root],
      outputRoots: [root],
    }));

    const set = await sdk.proceduralSet({
      packageRoot: sourceRoot,
      outDir: setRoot,
      relationship: relationship(),
      createdBy: "sdk-test",
    });
    expect(set).toMatchObject({
      ok: true,
      output: {
        packageRoot: setRoot,
        operation: "procedural.relationship.set",
        state: {
          relationships: [{
            id: "drift",
            enabled: true,
            target: { layerId: "target", property: "transform.x" },
            sources: [{ layerId: "driver", property: "opacity" }],
          }],
          validation: { ok: true },
        },
        receipt: {
          operation: "procedural.relationship.set",
          path: expect.stringContaining("procedural-relationship-set.receipt.json"),
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      },
    });
    expect(await readFile(join(sourceRoot, "motion.json"), "utf8")).toBe(sourceText);

    const inspect = await sdk.proceduralInspect({ packageRoot: setRoot, atMs: 500 });
    expect(inspect).toMatchObject({
      ok: true,
      output: { state: { evaluation: { atMs: 500, values: { drift: 50 } } } },
    });

    const disabled = await sdk.proceduralSetEnabled({
      packageRoot: setRoot,
      outDir: disabledRoot,
      relationshipId: "drift",
      enabled: false,
    });
    expect(disabled).toMatchObject({
      ok: true,
      output: {
        operation: "procedural.relationship.enabled.set",
        state: { relationships: [{ id: "drift", enabled: false }] },
      },
    });

    const rejectedBake = await sdk.proceduralBake({
      packageRoot: disabledRoot,
      outDir: rejectedBakeRoot,
      relationshipIds: ["drift"],
    });
    expect(rejectedBake).toMatchObject({
      ok: false,
      error: {
        code: "procedural_relationship_bake_failed",
        message: expect.stringMatching(/must be enabled/i),
      },
    });
    expect(await stat(rejectedBakeRoot).catch(() => null)).toBeNull();

    const enabled = await sdk.proceduralSetEnabled({
      packageRoot: disabledRoot,
      outDir: enabledRoot,
      relationshipId: "drift",
      enabled: true,
    });
    expect(enabled).toMatchObject({ ok: true });

    const baked = await sdk.proceduralBake({
      packageRoot: enabledRoot,
      outDir: bakedRoot,
      relationshipIds: ["drift"],
      startMs: 0,
      endMs: 1_000,
      sampleEveryFrames: 15,
    });
    expect(baked).toMatchObject({
      ok: true,
      output: {
        operation: "procedural.relationship.bake",
        state: { graph: null, relationships: [] },
        bake: {
          relationshipIds: ["drift"],
          sampleCount: 3,
          keyframeCount: 3,
          fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      },
    });
    const bakedMotion = (await loadMotionPackage(bakedRoot)).motion;
    expect(bakedMotion.relationships).toBeUndefined();
    expect(bakedMotion.layers.find((layer) => layer.id === "target")?.keyframes?.["transform.x"])
      .toMatchObject([{ atMs: 0 }, { atMs: 500 }, { atMs: 1_000 }]);

    const detached = await sdk.proceduralDetach({
      packageRoot: setRoot,
      outDir: detachedRoot,
      relationshipId: "drift",
    });
    expect(detached).toMatchObject({
      ok: true,
      output: {
        operation: "procedural.relationship.detach",
        state: { graph: null, relationships: [] },
      },
    });
  });

  it("rejects executable relationship fields in the SDK request guard before package access", async () => {
    const root = await fixtureRoot();
    const unsafe = { ...relationship(), expression: "time * 20" };
    const result = await createLocalMotionSdk().proceduralSet({
      packageRoot: join(root, "missing-source"),
      outDir: join(root, "output"),
      relationship: unsafe as never,
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "invalid_request", message: expect.stringMatching(/unsupported field/i) },
    });
  });

  it("rejects hostile procedural properties before package access or placeholder writes", async () => {
    const root = await fixtureRoot();
    const result = await createLocalMotionSdk().proceduralSet({
      packageRoot: join(root, "missing-source"),
      outDir: join(root, "output"),
      relationship: {
        ...relationship(),
        target: { layerId: "target", property: "__proto__.sdk_placeholder_polluted" },
      } as never,
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "invalid_request",
        message: expect.stringMatching(/target\/property.*allow-listed numeric property/i),
      },
    });
    expect(await stat(join(root, "output")).catch(() => null)).toBeNull();
    expect((Object.prototype as { sdk_placeholder_polluted?: unknown }).sdk_placeholder_polluted).toBeUndefined();
  });

  it("forwards configured authoring roots to procedural inspect and mutations", async () => {
    const root = await fixtureRoot();
    const inputRoot = join(root, "input");
    const outputRoot = join(root, "output");
    const outsideRoot = join(root, "outside");
    const sourceRoot = join(inputRoot, "source");
    await Promise.all([mkdir(outputRoot, { mode: 0o700 }), mkdir(outsideRoot)]);
    await writePackage(sourceRoot);
    const sdk = createLocalMotionSdk({
      authoringInputRoots: [inputRoot],
      authoringOutputRoots: [outputRoot],
    });

    expect(await sdk.proceduralInspect({ packageRoot: sourceRoot })).toMatchObject({ ok: true });
    expect(await sdk.proceduralSet({
      packageRoot: sourceRoot,
      outDir: join(outputRoot, "allowed"),
      relationship: relationship(),
    })).toMatchObject({ ok: true });

    const rejectedInspect = await sdk.proceduralInspect({ packageRoot: outsideRoot });
    expect(rejectedInspect).toMatchObject({ ok: false, error: { code: "authoring_path_not_approved" } });
    if (!rejectedInspect.ok) expect(rejectedInspect.error.message).not.toContain(outsideRoot);

    const rejectedMutation = await sdk.proceduralSet({
      packageRoot: sourceRoot,
      outDir: join(outsideRoot, "escaped"),
      relationship: relationship(),
    });
    expect(rejectedMutation).toMatchObject({ ok: false, error: { code: "authoring_path_not_approved" } });
    if (!rejectedMutation.ok) expect(rejectedMutation.error.message).not.toContain(outsideRoot);
    expect(await stat(join(outsideRoot, "escaped")).catch(() => null)).toBeNull();
  });
});

function relationship() {
  return {
    id: "drift",
    enabled: true,
    target: { layerId: "target", property: "transform.x" as const },
    nodes: [
      { id: "source", type: "property" as const, ref: { layerId: "driver", property: "opacity" as const } },
      { id: "time", type: "time" as const, unit: "seconds" as const },
      { id: "speed", type: "constant" as const, value: 20 },
      { id: "motion", type: "multiply" as const, left: "time", right: "speed" },
      { id: "output", type: "add" as const, left: "source", right: "motion" },
    ],
    outputNodeId: "output",
  };
}

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-sdk-procedural-"));
  roots.push(root);
  return root;
}

async function writePackage(root: string): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeJson(join(root, "manifest.json"), {
    schema: "shellx-motion/package-manifest@1",
    id: "sdk-procedural",
    name: "SDK procedural",
    motion: "motion.json",
    assets: [],
    sourceApp: "shellx-motion-test",
    compatibility: { lanes: ["browser"], hosts: ["shellx-motion"] },
  });
  await writeJson(join(root, "motion.json"), {
    schema: "shellx-motion/motion@1",
    id: "sdk-procedural-motion",
    name: "SDK procedural",
    durationMs: 1_000,
    fps: 30,
    width: 320,
    height: 180,
    layers: [
      {
        id: "driver",
        type: "shape",
        shape: "rectangle",
        startMs: 0,
        durationMs: 1_000,
        width: 10,
        height: 10,
        fill: "#ffffff",
        opacity: 40,
      },
      {
        id: "target",
        type: "shape",
        shape: "rectangle",
        startMs: 0,
        durationMs: 1_000,
        width: 20,
        height: 20,
        fill: "#336699",
        transform: { x: 0, y: 0 },
      },
    ],
    assets: [],
    provenance: { sourceApp: "shellx-motion-test", createdBy: "test" },
  });
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
