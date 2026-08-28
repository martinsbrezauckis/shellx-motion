import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MotionPackage, OperationReceipt } from "@shellx-motion/core";
import {
  assertConfiguredAuthoringInputRoot,
  assertConfiguredAuthoringOutputRoot
} from "./authoring-root-policy.js";
import { commitMotionDocumentEdit } from "./package-edit-transaction.js";

const roots: string[] = [];

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("authoring root policy", () => {
  it("fails closed for undefined and empty host roots at both shared directory helpers", async () => {
    const root = await privateRoot("shellx-motion-authoring-root-policy-");
    const input = join(root, "input");
    const output = join(root, "output");
    await Promise.all([mkdir(input, { mode: 0o700 }), mkdir(output, { mode: 0o700 })]);

    await expect(assertConfiguredAuthoringInputRoot(input, undefined, "Test input")).rejects.toMatchObject({ code: "authoring_path_not_approved" });
    await expect(assertConfiguredAuthoringInputRoot(input, [], "Test input")).rejects.toMatchObject({ code: "authoring_path_not_approved" });
    await expect(assertConfiguredAuthoringOutputRoot(join(output, "revision"), undefined, "Test output")).rejects.toMatchObject({ code: "authoring_path_not_approved" });
    await expect(assertConfiguredAuthoringOutputRoot(join(output, "revision"), [], "Test output")).rejects.toMatchObject({ code: "authoring_path_not_approved" });
  });

  it("does not let the shared package-edit transaction bypass missing host roots", async () => {
    const root = await privateRoot("shellx-motion-package-edit-roots-");
    const sourcePackage = { root: join(root, "source") } as MotionPackage;
    const receipt: OperationReceipt = {
      schema: "shellx-motion/receipt@1",
      id: "authoring-root-policy-test",
      operation: "timeline.test",
      status: "passed",
      packageId: "authoring-root-policy-test",
      inputHashes: {},
      createdAt: "2026-08-26T00:00:00.000Z",
      lane: "debug-api",
      output: {},
      warnings: []
    };

    await expect(commitMotionDocumentEdit({
      sourcePackage,
      outputRoot: join(root, "unapproved-revision"),
      patchedMotion: {} as MotionPackage["motion"],
      receipt,
      receiptFileName: "test.receipt.json"
    })).rejects.toMatchObject({ code: "authoring_path_not_approved" });
  });
});

async function privateRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}
