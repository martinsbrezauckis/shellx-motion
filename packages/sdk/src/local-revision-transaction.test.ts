/** End-to-end local SDK coverage for the bounded atomic revision transaction. */
import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { hashPackageFile, loadMotionPackage } from "@shellx-motion/core";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalMotionSdk } from "./local";
import { withTestAuthoringRoots } from "./local-test-authoring-context.test-support";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("local Motion SDK revision transactions", () => {
  it("publishes one verified package-contained aggregate receipt for typed edits", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-sdk-revision-transaction-"));
    tempDirs.push(root);
    const sourceRoot = join(root, "source");
    const outDir = join(root, "revision");
    await cp(resolve("../../fixtures/packages/editable-lower-third"), sourceRoot, { recursive: true });
    const source = await loadMotionPackage(sourceRoot);
    const base = {
      packageId: source.manifest.id,
      motionId: source.motion.id,
      manifestSha256: await hashPackageFile(join(sourceRoot, "manifest.json")),
      motionSha256: await hashPackageFile(join(sourceRoot, "motion.json"))
    };

    const result = await createLocalMotionSdk(withTestAuthoringRoots({}, {
      inputRoots: [root],
      outputRoots: [root],
    })).revisionTransaction({
      packageRoot: sourceRoot,
      outDir,
      base,
      steps: [
        { command: "motion.timeline.layer.text.set", layerId: "title", text: "SDK Atomic Title" },
        { command: "motion.timeline.layer.visibility.set", layerId: "title", visible: false }
      ]
    });

    expect(result).toMatchObject({
      ok: true,
      output: {
        packageRoot: outDir,
        base,
        final: { manifestSha256: base.manifestSha256, motionSha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
        steps: [
          { index: 0, command: "motion.timeline.layer.text.set" },
          { index: 1, command: "motion.timeline.layer.visibility.set" }
        ],
        receipt: { operation: "revision.transaction", status: "passed" }
      }
    });
    expect(JSON.parse(await readFile(join(outDir, "motion.json"), "utf8")).layers.find((layer: { id: string }) => layer.id === "title"))
      .toMatchObject({ text: "SDK Atomic Title", visible: false });
    expect(await readdir(join(outDir, "receipts"))).toEqual(["revision-transaction.receipt.json"]);
  });
});
