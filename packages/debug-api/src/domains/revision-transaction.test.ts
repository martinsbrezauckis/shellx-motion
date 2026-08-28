import { hashPackageFile, loadMotionPackage } from "@shellx-motion/core";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withTestAuthoringRoots } from "../authoring-test-context.test-support.js";
import { dispatchRevisionTransactionCommand } from "./revision-transaction.js";

const roots: string[] = [];

describe("motion.revision.transaction", () => {
  afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

  it("replays typed steps in one hidden copy and publishes one aggregate receipt", async () => {
    const root = await fixtureRoot();
    const source = join(root, "source"); const output = join(root, "revision");
    await writePackage(source);
    const base = await identity(source);
    const original = await readFile(join(source, "motion.json"), "utf8");
    const result = await dispatchRevisionTransactionCommand("motion.revision.transaction", {
      packageRoot: source,
      outDir: output,
      base,
      steps: [
        { command: "motion.timeline.layer.text.set", layerId: "title", text: "After" },
        { command: "motion.timeline.layer.visibility.set", layerId: "title", visible: false },
        { command: "motion.timeline.keyframe.upsert", layerId: "title", target: "opacity", atMs: 200, value: 0.5, easing: "linear" }
      ]
    }, services(root));

    expect(result).toMatchObject({ ok: true, result: { transactionSha256: expect.stringMatching(/^[a-f0-9]{64}$/), steps: [{ index: 0 }, { index: 1 }, { index: 2 }] } });
    expect(await readFile(join(source, "motion.json"), "utf8")).toBe(original);
    const revised = await loadMotionPackage(output);
    expect(revised.motion.layers[0]).toMatchObject({ text: "After", visible: false, keyframes: { opacity: [{ atMs: 200, value: 0.5 }] } });
    expect(await readdir(join(output, "receipts"))).toEqual(["revision-transaction.receipt.json"]);
    const receipt = JSON.parse(await readFile(join(output, "receipts", "revision-transaction.receipt.json"), "utf8")) as Record<string, unknown>;
    expect(receipt).toMatchObject({ operation: "revision.transaction", packageId: base.packageId });
    expect(receipt).not.toHaveProperty("packageSha256");
    expect((receipt.output as Record<string, unknown>).final).toMatchObject({ manifestSha256: base.manifestSha256, motionSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });

  it("rejects later invalid steps without publishing a revision or a receipt", async () => {
    const root = await fixtureRoot(); const source = join(root, "source"); const output = join(root, "revision");
    await writePackage(source);
    const result = await dispatchRevisionTransactionCommand("motion.revision.transaction", {
      packageRoot: source, outDir: output, base: await identity(source),
      steps: [
        { command: "motion.timeline.layer.text.set", layerId: "title", text: "After" },
        { command: "motion.timeline.keyframe.delete", layerId: "title", target: "opacity", atMs: 777 }
      ]
    }, services(root));
    expect(result).toMatchObject({ ok: false, error: { code: "revision_step_invalid", detail: { index: 1 } } });
    expect(await stat(output).catch(() => null)).toBeNull();
  });

  it("does not invoke getters or accept inherited, unknown, or unbounded direct-JS arguments", async () => {
    const root = await fixtureRoot(); const source = join(root, "source"); const output = join(root, "revision");
    await writePackage(source);
    const base = await identity(source);
    let invoked = false;
    const getterStep = Object.defineProperty({}, "command", { enumerable: true, get: () => { invoked = true; return "motion.timeline.layer.text.set"; } });
    const getterResult = await dispatchRevisionTransactionCommand("motion.revision.transaction", {
      packageRoot: source, outDir: output, base, steps: [getterStep]
    }, services(root));
    expect(getterResult).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    expect(invoked).toBe(false);

    let rootGetterInvoked = false;
    const getterRoot = Object.defineProperty({ outDir: output, base, steps: [] }, "packageRoot", { enumerable: true, get: () => { rootGetterInvoked = true; return source; } });
    const getterRootResult = await dispatchRevisionTransactionCommand("motion.revision.transaction", getterRoot, services(root));
    expect(getterRootResult).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    expect(rootGetterInvoked).toBe(false);

    for (const packageRoot of ["x".repeat(4097), `${source}\0hidden`]) {
      const boundedResult = await dispatchRevisionTransactionCommand("motion.revision.transaction", { packageRoot, outDir: output, base, steps: [] }, services(root));
      expect(boundedResult).toMatchObject({ ok: false, error: { code: "invalid_args", message: "motion.revision.transaction requires packageRoot and outDir as strings up to 4096 UTF-8 bytes without NUL bytes." } });
    }

    const inherited = Object.create({ packageRoot: source, outDir: output, base, steps: [] });
    const inheritedResult = await dispatchRevisionTransactionCommand("motion.revision.transaction", inherited, services(root));
    expect(inheritedResult).toMatchObject({ ok: false, error: { code: "invalid_args" } });

    const unknownResult = await dispatchRevisionTransactionCommand("motion.revision.transaction", {
      packageRoot: source, outDir: output, base, steps: [], receiptsRoot: join(root, "attacker")
    }, services(root));
    expect(unknownResult).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    expect(await stat(output).catch(() => null)).toBeNull();
  });

  it("refuses configured root-policy escapes before package loading or hidden staging", async () => {
    const root = await fixtureRoot(); const sourceRoot = join(root, "approved-input"); const outputRoot = join(root, "approved-output");
    const source = join(sourceRoot, "source"); const rejected = join(root, "outside-output", "revision");
    await mkdir(outputRoot, { recursive: true, mode: 0o700 });
    await writePackage(source);
    let loads = 0;
    const result = await dispatchRevisionTransactionCommand("motion.revision.transaction", {
      packageRoot: source,
      outDir: rejected,
      base: await identity(source),
      steps: [{ command: "motion.timeline.layer.text.set", layerId: "title", text: "After" }]
    }, {
      ...services(),
      packageLoader: async (path) => { loads += 1; return loadMotionPackage(path); },
      authoringInputRoots: [sourceRoot],
      authoringOutputRoots: [outputRoot]
    });
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_args", message: "motion.revision.transaction outDir is outside the configured authoring output roots." } });
    expect(loads).toBe(0);
    expect(await stat(rejected).catch(() => null)).toBeNull();
  });

  it("does not expose internal absolute paths from loader or staging failures", async () => {
    const root = await fixtureRoot(); const source = join(root, "source"); const output = join(root, "revision");
    await writePackage(source);
    const hiddenStage = join(root, ".hidden-stage", "copy-tmp");
    const result = await dispatchRevisionTransactionCommand("motion.revision.transaction", {
      packageRoot: source, outDir: output, base: await identity(source),
      steps: [{ command: "motion.timeline.layer.text.set", layerId: "title", text: "After" }]
    }, {
      ...services(root),
      isUnsafePackageOutputDirectory: async () => { throw new Error(`copy failed at ${hiddenStage}`); }
    });
    expect(result).toMatchObject({ ok: false, error: { code: "revision_transaction_failed", message: "motion.revision.transaction could not complete." } });
    expect(JSON.stringify(result)).not.toContain(hiddenStage);
    expect(await stat(output).catch(() => null)).toBeNull();
  });
});

function services(root?: string) {
  return withTestAuthoringRoots({
    packageLoader: loadMotionPackage,
    isUnsafePackageOutputDirectory: async () => false,
    isEmptyOrAbsentDirectory: async (path: string) => (await stat(path).catch(() => null)) === null
  }, root ? { inputRoots: [root], outputRoots: [root] } : {});
}

async function identity(root: string) {
  const pkg = await loadMotionPackage(root);
  return {
    packageId: pkg.manifest.id,
    motionId: pkg.motion.id,
    manifestSha256: await hashPackageFile(join(root, "manifest.json")),
    motionSha256: await hashPackageFile(join(root, "motion.json"))
  };
}

async function fixtureRoot(): Promise<string> { const root = await mkdtemp(join(tmpdir(), "shellx-motion-revision-transaction-")); roots.push(root); return root; }
async function writePackage(root: string): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeFile(join(root, "manifest.json"), `${JSON.stringify({ schema: "shellx-motion/package-manifest@1", id: "revision-fixture", name: "Revision fixture", motion: "motion.json", assets: [], sourceApp: "shellx-motion-test", compatibility: { lanes: ["browser"], hosts: ["shellx-motion"] } }, null, 2)}\n`);
  await writeFile(join(root, "motion.json"), `${JSON.stringify({ schema: "shellx-motion/motion@1", id: "revision-motion", name: "Revision fixture", durationMs: 1_000, fps: 30, width: 320, height: 180, layers: [{ id: "title", type: "text", text: "Before", startMs: 0, durationMs: 1_000, width: 320, height: 80, style: { color: "#ffffff" } }], assets: [], provenance: { sourceApp: "shellx-motion", createdBy: "test" } }, null, 2)}\n`);
}
