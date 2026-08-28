/** End-to-end local SDK coverage for a read-only atomic revision plan. */
import { cp, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { hashPackageFile, loadMotionPackage } from "@shellx-motion/core";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalMotionSdk } from "./local";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("local Motion SDK revision transaction plans", () => {
  it("returns deterministic typed preflight facts without publishing a revision or receipt", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-sdk-revision-plan-"));
    tempDirs.push(root);
    const sourceRoot = join(root, "source");
    await cp(resolve("../../fixtures/packages/editable-lower-third"), sourceRoot, { recursive: true });
    const source = await loadMotionPackage(sourceRoot);
    const base = {
      packageId: source.manifest.id,
      motionId: source.motion.id,
      manifestSha256: await hashPackageFile(join(sourceRoot, "manifest.json")),
      motionSha256: await hashPackageFile(join(sourceRoot, "motion.json"))
    };
    const original = await readFile(join(sourceRoot, "motion.json"), "utf8");
    const sdk = createLocalMotionSdk({ authoringInputRoots: [root] });
    const request = {
      packageRoot: sourceRoot,
      base,
      steps: [{ command: "motion.timeline.layer.text.set" as const, layerId: "title", text: "SDK Planned Title" }]
    };

    const first = await sdk.revisionTransactionPlan(request);
    const second = await sdk.revisionTransactionPlan(request);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      ok: true,
      output: {
        packageId: source.manifest.id, motionId: source.motion.id, base,
        final: { manifestSha256: base.manifestSha256, motionSha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
        steps: [{ index: 0, command: "motion.timeline.layer.text.set", stepSha256: expect.stringMatching(/^[a-f0-9]{64}$/) }],
        validation: { ok: true, errorCount: 0 }, warnings: []
      }
    });
    expect(JSON.stringify(first)).not.toMatch(/receipt|outDir|packageRoot/i);
    expect(await readFile(join(sourceRoot, "motion.json"), "utf8")).toBe(original);
    expect(await stat(join(sourceRoot, "receipts")).catch(() => null)).toBeNull();
  });
});
