/** Read-only contract coverage for the deterministic atomic-revision preflight. */
import { hashPackageFile, loadMotionPackage } from "@shellx-motion/core";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dispatchRevisionTransactionCommand } from "./revision-transaction.js";
import { dispatchRevisionTransactionPlanCommand } from "./revision-transaction-plan.js";

const roots: string[] = [];

describe("motion.revision.transaction.plan", () => {
  afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

  it("replays bounded typed steps deterministically without writing a package or receipt", async () => {
    const root = await fixtureRoot(); const source = join(root, "source");
    await writePackage(source);
    const base = await identity(source);
    const original = await readFile(join(source, "motion.json"), "utf8");
    const args = { packageRoot: source, base, steps: [
      { command: "motion.timeline.layer.text.set", layerId: "title", text: "Planned" },
      { command: "motion.timeline.layer.visibility.set", layerId: "title", visible: false }
    ] };
    const first = await dispatchRevisionTransactionPlanCommand("motion.revision.transaction.plan", args, services(root));
    const second = await dispatchRevisionTransactionPlanCommand("motion.revision.transaction.plan", args, services(root));

    expect(first).toEqual(second);
    expect(first).toMatchObject({ ok: true, result: {
      packageId: base.packageId, motionId: base.motionId, base,
      transactionSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      steps: [{ index: 0, command: "motion.timeline.layer.text.set", changedPaths: expect.any(Array) }, { index: 1, command: "motion.timeline.layer.visibility.set" }],
      final: { manifestSha256: base.manifestSha256, motionSha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      validation: { ok: true, errorCount: 0 }, warnings: []
    } });
    expect(JSON.stringify(first)).not.toMatch(/receipt|outDir|packageRoot|createdAt|timestamp/i);
    expect(Buffer.byteLength(JSON.stringify(first), "utf8")).toBeLessThanOrEqual(256 * 1024);
    expect(await readFile(join(source, "motion.json"), "utf8")).toBe(original);
    expect(await stat(join(source, "receipts")).catch(() => null)).toBeNull();
  });

  it("never invokes getters or accepts inherited, oversized, NUL, or commit-only fields", async () => {
    const root = await fixtureRoot(); const source = join(root, "source");
    await writePackage(source);
    const base = await identity(source);
    let invoked = false;
    const getterRoot = Object.defineProperty({ base, steps: [] }, "packageRoot", { enumerable: true, get: () => { invoked = true; return source; } });
    const getterResult = await dispatchRevisionTransactionPlanCommand("motion.revision.transaction.plan", getterRoot, services(root));
    expect(getterResult).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    expect(invoked).toBe(false);
    let stepGetterInvoked = false;
    const getterStep = Object.defineProperty({}, "command", { enumerable: true, get: () => { stepGetterInvoked = true; return "motion.timeline.layer.text.set"; } });
    expect(await dispatchRevisionTransactionPlanCommand("motion.revision.transaction.plan", { packageRoot: source, base, steps: [getterStep] }, services(root))).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    expect(stepGetterInvoked).toBe(false);
    for (const packageRoot of ["x".repeat(4097), `${source}\0hidden`]) {
      const result = await dispatchRevisionTransactionPlanCommand("motion.revision.transaction.plan", { packageRoot, base, steps: [] }, services(root));
      expect(result).toMatchObject({ ok: false, error: { code: "invalid_args", message: "motion.revision.transaction.plan requires packageRoot as a string up to 4096 UTF-8 bytes without NUL bytes." } });
    }
    const inherited = Object.create({ packageRoot: source, base, steps: [] });
    expect(await dispatchRevisionTransactionPlanCommand("motion.revision.transaction.plan", inherited, services(root))).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    expect(await dispatchRevisionTransactionPlanCommand("motion.revision.transaction.plan", { packageRoot: source, base, steps: [], outDir: join(root, "forbidden") }, services(root))).toMatchObject({ ok: false, error: { code: "invalid_args" } });
  });

  it("refuses an input-root escape before package loading and redacts loader failures", async () => {
    const root = await fixtureRoot(); const approved = join(root, "approved"); const source = join(root, "outside", "source");
    await writePackage(source);
    const base = await identity(source);
    let loads = 0;
    const refused = await dispatchRevisionTransactionPlanCommand("motion.revision.transaction.plan", { packageRoot: source, base, steps: [{ command: "motion.timeline.layer.text.set", layerId: "title", text: "Plan" }] }, {
      packageLoader: async (path) => { loads += 1; return await loadMotionPackage(path); }, authoringInputRoots: [approved]
    });
    expect(refused).toMatchObject({ ok: false, error: { code: "invalid_args", message: "motion.revision.transaction.plan packageRoot is outside the configured authoring input roots." } });
    expect(loads).toBe(0);

    const hidden = join(root, "hidden-host-path");
    const redacted = await dispatchRevisionTransactionPlanCommand("motion.revision.transaction.plan", { packageRoot: source, base, steps: [{ command: "motion.timeline.layer.text.set", layerId: "title", text: "Plan" }] }, {
      packageLoader: async () => { throw new Error(`loader failed at ${hidden}`); }, authoringInputRoots: [root]
    });
    expect(redacted).toMatchObject({ ok: false, error: { code: "revision_transaction_failed", message: "motion.revision.transaction.plan could not complete." } });
    expect(JSON.stringify(redacted)).not.toContain(hidden);
  });

  it("does not turn a plan into commit authorization", async () => {
    const root = await fixtureRoot(); const source = join(root, "source"); const outDir = join(root, "revision");
    await writePackage(source);
    const base = await identity(source);
    const steps = [{ command: "motion.timeline.layer.text.set", layerId: "title", text: "Planned" }];
    const plan = await dispatchRevisionTransactionPlanCommand("motion.revision.transaction.plan", { packageRoot: source, base, steps }, services(root));
    expect(plan).toMatchObject({ ok: true });
    const commit = await dispatchRevisionTransactionCommand("motion.revision.transaction", {
      packageRoot: source, outDir, base, steps, plan
    }, { packageLoader: loadMotionPackage, isUnsafePackageOutputDirectory: async () => false, isEmptyOrAbsentDirectory: async (path) => (await stat(path).catch(() => null)) === null });
    expect(commit).toMatchObject({ ok: false, error: { code: "invalid_args", message: "motion.revision.transaction does not accept plan." } });
    expect(await stat(outDir).catch(() => null)).toBeNull();
  });
});

function services(inputRoot: string) { return { packageLoader: loadMotionPackage, authoringInputRoots: [inputRoot] }; }
async function fixtureRoot(): Promise<string> { const root = await mkdtemp(join(tmpdir(), "shellx-motion-revision-plan-")); roots.push(root); return root; }
async function identity(root: string) {
  const pkg = await loadMotionPackage(root);
  return { packageId: pkg.manifest.id, motionId: pkg.motion.id, manifestSha256: await hashPackageFile(join(root, "manifest.json")), motionSha256: await hashPackageFile(join(root, "motion.json")) };
}
async function writePackage(root: string): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeFile(join(root, "manifest.json"), `${JSON.stringify({ schema: "shellx-motion/package-manifest@1", id: "revision-plan-fixture", name: "Revision plan fixture", motion: "motion.json", assets: [], sourceApp: "shellx-motion-test", compatibility: { lanes: ["browser"], hosts: ["shellx-motion"] } }, null, 2)}\n`);
  await writeFile(join(root, "motion.json"), `${JSON.stringify({ schema: "shellx-motion/motion@1", id: "revision-plan-motion", name: "Revision plan fixture", durationMs: 1_000, fps: 30, width: 320, height: 180, layers: [{ id: "title", type: "text", text: "Before", startMs: 0, durationMs: 1_000, width: 320, height: 80, style: { color: "#ffffff" } }], assets: [], provenance: { sourceApp: "shellx-motion", createdBy: "test" } }, null, 2)}\n`);
}
