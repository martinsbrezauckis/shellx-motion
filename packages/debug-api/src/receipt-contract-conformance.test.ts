/**
 * Representative receipt-contract conformance, deliberately executing the dispatcher rather than
 * restating command metadata. These cases cover copy-on-write timeline edits and batch planning.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { OperationReceipt, ReceiptArtifact } from "@shellx-motion/core";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "@shellx-motion/core/internal/trusted-host-workspace";
import { afterEach, describe, expect, it } from "vitest";
import { debugCommandContract } from "./command-metadata.js";
import type { MotionDebugCommand, MotionDebugResult } from "./command-registry.js";
import { dispatchDebugCommand } from "./index.js";

const temporaryRoots: string[] = [];
const DEBUG_SCRATCH_ROOT = fileURLToPath(new URL("../../../.scratch/", import.meta.url));
const PROJECT_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

describe("declared Debug receipt conformance", () => {
  it("binds a copy-on-write timeline edit declaration to its emitted receipt and artifacts", async () => {
    const root = await scratch("timeline");
    const outDir = join(root, "edited-package");
    const packageRoot = fixturePackage("lower-third");
    const result = await runInTrustedWorkspace(async () => await dispatchDebugCommand(
      "motion.timeline.layer.create",
      {
        packageRoot,
        outDir,
        layer: { id: "receipt-contract", type: "text", text: "Receipt contract", startMs: 0, durationMs: 500 }
      },
      { tier: "edit_motion", scratchRoot: root, authoringInputRoots: [packageRoot], authoringOutputRoots: [root] }
    ));
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;

    await expectRequiredReceiptEvidence(
      "motion.timeline.layer.create",
      result,
      [await readReceipt(join(outDir, "receipts", "timeline-layer-create.receipt.json"))]
    );
  });

  it("binds dry-run batch and row declarations to the receipts that planning actually emits", async () => {
    const root = await scratch("batch");
    const outDir = join(root, "batch-output");
    const packageRoot = fixturePackage("batch-card");
    const result = await runInTrustedWorkspace(async () => await dispatchDebugCommand(
      "motion.render.batch",
      { packageRoot, outDir, dryRun: true },
      { tier: "render_motion", scratchRoot: root, renderPackageRoots: [packageRoot], renderInputRoots: [packageRoot], renderOutputRoots: [root] }
    ));
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    const receiptsRoot = join(outDir, "receipts");
    const receipts = await Promise.all(
      (await readdir(receiptsRoot))
        .filter((name) => name.endsWith(".receipt.json"))
        .sort()
        .map(async (name) => await readReceipt(join(receiptsRoot, name)))
    );

    await expectRequiredReceiptEvidence("motion.render.batch", result, receipts);
  });
});

async function scratch(label: string): Promise<string> {
  await mkdir(DEBUG_SCRATCH_ROOT, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(DEBUG_SCRATCH_ROOT, `receipt-contract-${label}-`));
  temporaryRoots.push(root);
  return root;
}

function fixturePackage(name: string): string {
  return resolve(fileURLToPath(new URL(`../../../fixtures/packages/${name}`, import.meta.url)));
}

async function runInTrustedWorkspace(operation: () => Promise<MotionDebugResult>): Promise<MotionDebugResult> {
  return await withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(PROJECT_ROOT), operation);
}

async function readReceipt(path: string): Promise<OperationReceipt> {
  return JSON.parse(await readFile(path, "utf8")) as OperationReceipt;
}

async function expectRequiredReceiptEvidence(
  command: MotionDebugCommand,
  result: MotionDebugResult,
  receipts: readonly OperationReceipt[]
): Promise<void> {
  const contract = debugCommandContract(command);
  expect(contract?.expectedReceipts, command).toBeDefined();
  expect(result.ok, command).toBe(true);
  if (!contract?.expectedReceipts || !result.ok) return;

  const required = contract.expectedReceipts.filter((expected) => expected.required);
  const primaryReceipt = receipts.find((receipt) => receipt.id === result.receiptId);
  expect(primaryReceipt, `${command} must return the id of a persisted emitted receipt`).toBeDefined();

  for (const expected of required) {
    expect(expected.mode, `${command} emits ${expected.operation}`).toBe("emits");
    const emitted = receipts.filter((receipt) => receipt.operation === expected.operation);
    expect(emitted, `${command} must emit ${expected.operation}`).not.toHaveLength(0);

    for (const role of expected.artifactRoles ?? []) {
      const artifact = emitted.flatMap((receipt) => receipt.artifacts ?? []).find((candidate) => candidate.role === role);
      expect(artifact, `${expected.operation} must carry ${role}`).toBeDefined();
      if (artifact) await expectArtifactState(artifact);
    }
  }
}

async function expectArtifactState(artifact: ReceiptArtifact): Promise<void> {
  expect(artifact.path).toEqual(expect.any(String));
  expect(["available", "planned"]).toContain(artifact.status);
  if (artifact.status === "available") await expect(stat(artifact.path)).resolves.toBeDefined();
  else await expect(stat(artifact.path)).rejects.toMatchObject({ code: "ENOENT" });
}
