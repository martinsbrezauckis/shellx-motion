import { describe, expect, it } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJsonSha256, removeMotionLayoutGapAnimationTrack, runMotionLayoutDebug, upsertMotionLayoutGapAnimationTrack, type MotionDocument, type MotionPackage, type OperationReceipt } from "@shellx-motion/core";
import { hasMotionLayoutRemovalAuthorization } from "@shellx-motion/core/internal/layout-removal-authority";
import {
  authorizeLayoutApplicationRemoval,
  layoutApplyHostReceiptId,
  persistLayoutApplicationAuthority,
  prepareLayoutApplicationAuthority,
} from "./timeline-layout-application-authority.js";
import { trustedAuthorityDirectory } from "./timeline-layout-application-authority-store.js";
import { createHostLayoutAuthorityPairRepair } from "../internal/layout-authority-repair.js";
import {
  prepareLayoutGapAnimationContinuation,
  prepareLayoutGapAnimationContinuationPair,
  persistLayoutGapAnimationContinuation,
  restoreLayoutRemovalAuthorityAfterGapTeardown,
} from "./timeline-layout-gap-animation-authority.js";

describe("layout gap host continuation authority", () => {
  it("recovers actual static and C2 pre-install, installed, and foreign-output authority prefixes", async () => {
    const root = await mkdtemp(join(tmpdir(), "layout-gap-authority-cow-prefix-"));
    const receiptsRoot = await mkdtemp(join(tmpdir(), "layout-gap-authority-cow-host-"));
    const staticStage = join(root, "static-stage");
    const staticOutput = join(root, "static-output");
    const absentStage = join(root, "c2-absent-stage");
    const absentOutput = join(root, "c2-absent-output");
    const installedStage = join(root, "c2-installed-stage");
    const installedOutput = join(root, "c2-installed-output");
    const foreignStage = join(root, "c2-foreign-stage");
    const foreignOutput = join(root, "c2-foreign-output");
    const displacedOutput = join(root, "c2-displaced-output");
    try {
      const staticMotion = applied(motion());
      const application = staticMotion.layoutApplications?.[0];
      if (!application) throw new Error("expected static application");
      const staticReceiptValue = staticReceipt("pkg_layout_gap_authority", application, staticMotion);
      await writePackage(staticStage, staticMotion);
      const staticPrepared = await prepareLayoutApplicationAuthority({
        receiptsRoot,
        packageRoot: staticOutput,
        manifestPath: join(staticOutput, "manifest.json"),
        motionPath: join(staticOutput, "motion.json"),
        stagedPackageRoot: staticStage,
        expectedPackageRoot: staticOutput,
        stagedManifestPath: join(staticStage, "manifest.json"),
        stagedMotionPath: join(staticStage, "motion.json"),
        persistedMotionSha256: canonicalJsonSha256(staticMotion),
        packageId: "pkg_layout_gap_authority",
        applicationId: application.id,
        applicationFingerprint: application.fingerprint,
        receipt: staticReceiptValue,
      });
      await rename(staticStage, staticOutput);
      const repair = createHostLayoutAuthorityPairRepair(receiptsRoot);
      await expect(repair.repairNextPage()).resolves.toMatchObject({
        actions: [{ action: "finalized_installed_output" }], complete: true,
      });
      expect(staticPrepared).toBeDefined();

      const staticPkg = packageAt(staticOutput, staticMotion);
      const continuation = await prepareLayoutGapAnimationContinuation({
        receiptsRoot,
        pkg: staticPkg,
        applicationId: application.id,
        applicationFingerprint: application.fingerprint,
      });
      const activeMotion = upsertMotionLayoutGapAnimationTrack(staticMotion, {
        track: {
          id: "gap",
          applicationId: application.id,
          applicationFingerprint: application.fingerprint,
          childLayerIds: application.childLayerIds,
          keyframes: [{ atUs: 0, value: 2 }],
        },
      }).motion;
      const activeReceipt = gapReceipt("pkg_layout_gap_authority", "timeline.layout-gap-animation.track.upsert", activeMotion);

      await writePackage(absentStage, activeMotion);
      await prepareLayoutGapAnimationContinuationPair(pairInput(
        continuation,
        receiptsRoot,
        absentStage,
        absentOutput,
        activeMotion,
        activeReceipt,
      ));
      await expect(repair.repairNextPage()).resolves.toMatchObject({
        actions: [{ action: "reclaimed_preinstall_prefix" }], complete: true,
      });
      await expect(readFile(join(absentOutput, "motion.json"))).rejects.toMatchObject({ code: "ENOENT" });

      await writePackage(installedStage, activeMotion);
      await prepareLayoutGapAnimationContinuationPair(pairInput(
        continuation,
        receiptsRoot,
        installedStage,
        installedOutput,
        activeMotion,
        activeReceipt,
      ));
      await rename(installedStage, installedOutput);
      await expect(repair.repairNextPage()).resolves.toMatchObject({
        actions: [{ action: "finalized_installed_output" }], complete: true,
      });

      await writePackage(foreignStage, activeMotion);
      await prepareLayoutGapAnimationContinuationPair(pairInput(
        continuation,
        receiptsRoot,
        foreignStage,
        foreignOutput,
        activeMotion,
        activeReceipt,
      ));
      await rename(foreignStage, foreignOutput);
      await rename(foreignOutput, displacedOutput);
      await writePackage(foreignOutput, { ...activeMotion, name: "foreign replacement" });
      await expect(repair.repairNextPage()).rejects.toThrow(/foreign output lineage mismatch/i);
      expect(JSON.parse(await readFile(join(foreignOutput, "motion.json"), "utf8"))).toMatchObject({
        name: "foreign replacement",
      });
      await expect(readFile(join(displacedOutput, "motion.json"))).resolves.toBeDefined();
    } finally {
      await Promise.all([root, receiptsRoot].map(async (path) => await rm(path, { recursive: true, force: true })));
    }
  });

  it("suspends static removal across a successor and restores it only after exact final teardown", async () => {
    const root = await mkdtemp(join(tmpdir(), "layout-gap-authority-"));
    const receiptsRoot = await mkdtemp(join(tmpdir(), "layout-gap-authority-host-"));
    const staticRoot = join(root, "static"), activeRoot = join(root, "active"), restoredRoot = join(root, "restored");
    try {
      const base = motion();
      const staticMotion = applied(base);
      const application = staticMotion.layoutApplications?.[0];
      if (!application) throw new Error("expected static application");
      await writePackage(staticRoot, staticMotion);
      const staticPkg = packageAt(staticRoot, staticMotion);
      await persistLayoutApplicationAuthority({ receiptsRoot, packageRoot: staticRoot, manifestPath: join(staticRoot, "manifest.json"), motionPath: join(staticRoot, "motion.json"), packageId: staticPkg.manifest.id, applicationId: application.id, applicationFingerprint: application.fingerprint, persistedMotionSha256: canonicalJsonSha256(staticMotion), receipt: staticReceipt(staticPkg.manifest.id, application, staticMotion) });

      const continuation = await prepareLayoutGapAnimationContinuation({ receiptsRoot, pkg: staticPkg, applicationId: application.id, applicationFingerprint: application.fingerprint });
      const attached = upsertMotionLayoutGapAnimationTrack(staticMotion, { track: { id: "gap", applicationId: application.id, applicationFingerprint: application.fingerprint, childLayerIds: application.childLayerIds, keyframes: [{ atUs: 0, value: 2 }] } }).motion;
      await writePackage(activeRoot, attached);
      const activePkg = packageAt(activeRoot, attached);
      await persistLayoutGapAnimationContinuation({ continuation, packageId: activePkg.manifest.id, commit: commit(receiptsRoot, activeRoot, attached, gapReceipt(activePkg.manifest.id, "timeline.layout-gap-animation.track.upsert", attached)), receipt: gapReceipt(activePkg.manifest.id, "timeline.layout-gap-animation.track.upsert", attached) });

      await expect(authorizeLayoutApplicationRemoval({ receiptsRoot, pkg: activePkg, applicationId: application.id, applicationFingerprint: application.fingerprint })).rejects.toThrow(/authority/);
      const next = await prepareLayoutGapAnimationContinuation({ receiptsRoot, pkg: activePkg, applicationId: application.id, applicationFingerprint: application.fingerprint });
      const detached = removeMotionLayoutGapAnimationTrack(attached, { trackId: "gap" }).motion;
      expect(detached).toEqual(staticMotion);
      await writePackage(restoredRoot, detached);
      const restoredPkg = packageAt(restoredRoot, detached);
      const teardownReceipt = gapReceipt(restoredPkg.manifest.id, "timeline.layout-gap-animation.track.remove", detached);
      await restoreLayoutRemovalAuthorityAfterGapTeardown({ continuation: next, packageId: restoredPkg.manifest.id, commit: commit(receiptsRoot, restoredRoot, detached, teardownReceipt), receipt: teardownReceipt });
      const token = await authorizeLayoutApplicationRemoval({ receiptsRoot, pkg: restoredPkg, applicationId: application.id, applicationFingerprint: application.fingerprint });
      expect(hasMotionLayoutRemovalAuthorization(token, { packageId: restoredPkg.manifest.id, applicationId: application.id, applicationFingerprint: application.fingerprint })).toBe(true);
      await expect(hostileRestoredAuthorityRefusal(receiptsRoot, restoredPkg, application.id, application.fingerprint, "x".repeat(4_097))).resolves.toMatchObject({ message: expect.stringMatching(/package path is invalid/i) });
      await expect(hostileRestoredAuthorityRefusal(receiptsRoot, restoredPkg, application.id, application.fingerprint, "safe\0path")).resolves.toMatchObject({ message: expect.stringMatching(/package path is invalid/i) });
    } finally {
      await Promise.all([root, receiptsRoot].map(async (path) => await rm(path, { recursive: true, force: true })));
    }
  });
});

async function hostileRestoredAuthorityRefusal(
  sourceReceiptsRoot: string,
  pkg: MotionPackage,
  applicationId: string,
  applicationFingerprint: string,
  hostilePackagePath: string,
): Promise<Error> {
  const sourceDirectory = join(sourceReceiptsRoot, ".shellx-motion-layout-authority");
  let pairName: string | undefined;
  for (const candidate of await readdir(sourceDirectory)) {
    if (!candidate.endsWith(".pair.json")) continue;
    const candidateJournal = JSON.parse(await readFile(join(sourceDirectory, candidate), "utf8")) as { recordKind?: unknown };
    if (candidateJournal.recordKind === "layout-gap-restored") {
      pairName = candidate;
      break;
    }
  }
  if (!pairName) throw new Error("expected restored layout authority pair");
  const journal = JSON.parse(await readFile(join(sourceDirectory, pairName), "utf8")) as Record<string, unknown>;
  if (journal.recordKind !== "layout-gap-restored" || typeof journal.key !== "string") throw new Error("expected restored authority journal");
  const authorityMember = journal.authority as { basename?: unknown };
  const receiptMember = journal.receipt as { basename?: unknown };
  if (typeof authorityMember.basename !== "string" || typeof receiptMember.basename !== "string") throw new Error("expected restored authority members");
  const hostileRoot = await mkdtemp(join(tmpdir(), "layout-gap-authority-hostile-path-"));
  try {
    const directory = await trustedAuthorityDirectory(hostileRoot, true);
    const authority = JSON.parse(await readFile(join(sourceDirectory, authorityMember.basename), "utf8")) as Record<string, unknown>;
    authority.receiptsRoot = directory.root;
    (authority.package as Record<string, unknown>).path = hostilePackagePath;
    journal.receiptsRoot = directory.root;
    (journal.authority as Record<string, unknown>).sha256 = canonicalJsonSha256(authority);
    await writeFile(join(directory.path, receiptMember.basename), await readFile(join(sourceDirectory, receiptMember.basename)));
    await writeFile(join(directory.path, authorityMember.basename), `${JSON.stringify(authority)}\n`);
    await writeFile(join(directory.path, pairName), `${JSON.stringify(journal)}\n`);
    try {
      await authorizeLayoutApplicationRemoval({ receiptsRoot: hostileRoot, pkg, applicationId, applicationFingerprint });
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
    throw new Error("hostile restored authority unexpectedly authorized layout removal");
  } finally {
    await rm(hostileRoot, { recursive: true, force: true });
  }
}

function packageAt(root: string, motion: MotionDocument): MotionPackage { return { root, manifest: { schema: "shellx-motion/package-manifest@1", id: "pkg_layout_gap_authority", name: "Gap authority", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["native"], hosts: ["motion"] } }, motion } as MotionPackage; }
async function writePackage(root: string, motion: MotionDocument): Promise<void> { await mkdir(root, { recursive: true }); await writeFile(join(root, "manifest.json"), `${JSON.stringify(packageAt(root, motion).manifest)}\n`); await writeFile(join(root, "motion.json"), `${JSON.stringify(motion)}\n`); }
function commit(receiptsRoot: string, packageRoot: string, motion: MotionDocument, receipt: OperationReceipt) { return { receiptsRoot, packageRoot, manifestPath: join(packageRoot, "manifest.json"), motionPath: join(packageRoot, "motion.json"), persistedMotionSha256: canonicalJsonSha256(motion), receipt }; }
function pairInput(
  continuation: Awaited<ReturnType<typeof prepareLayoutGapAnimationContinuation>>,
  receiptsRoot: string,
  stagedPackageRoot: string,
  expectedPackageRoot: string,
  persistedMotion: MotionDocument,
  receipt: OperationReceipt,
) {
  return {
    continuation,
    stagedPackageRoot,
    expectedPackageRoot,
    stagedManifestPath: join(stagedPackageRoot, "manifest.json"),
    stagedMotionPath: join(stagedPackageRoot, "motion.json"),
    persistedMotionSha256: canonicalJsonSha256(persistedMotion),
    receiptsRoot,
    packageId: "pkg_layout_gap_authority",
    receipt,
  };
}
function staticReceipt(packageId: string, application: NonNullable<MotionDocument["layoutApplications"]>[number], motion: MotionDocument): OperationReceipt { return { schema: "shellx-motion/receipt@1", id: layoutApplyHostReceiptId(packageId, application.id), operation: "timeline.layout.apply", status: "passed", packageId, inputHashes: { "manifest.json": "a".repeat(64), "motion.json": "b".repeat(64) }, createdAt: "2026-08-21T00:00:00.000Z", lane: "debug-api", output: { packageDir: "/unused", manifestPath: "/unused/manifest.json", motionPath: "/unused/motion.json", operation: "apply", compilation: {}, application: { disposition: "applied", id: application.id, fingerprint: application.fingerprint, groupId: application.groupId, sourceChildLayerIds: application.childLayerIds, materializedChildLayerIds: application.materializedChildLayerIds, generatedLayerIds: [], trackOrders: [] }, removal: { schema: "shellx-motion/debug-layout-removal@1", applicationId: application.id, applicationFingerprint: application.fingerprint }, layoutFingerprint: application.layoutFingerprint, layoutFingerprintInput: "test", budget: {}, overflow: {}, repeaters: [], changedLayerIds: application.patches.map((patch) => patch.layerId), outputMotionSha256: canonicalJsonSha256(motion), validation: { ok: true } }, warnings: [] }; }
function gapReceipt(packageId: string, operation: string, motion: MotionDocument): OperationReceipt { return { schema: "shellx-motion/receipt@1", id: `gap-${operation.slice(-6)}`, operation, status: "warning", packageId, inputHashes: { "manifest.json": "a".repeat(64), "motion.json": "b".repeat(64) }, createdAt: "2026-08-21T00:00:00.000Z", lane: "debug-api", output: { outputMotionSha256: canonicalJsonSha256(motion) }, warnings: ["renderer unavailable"] }; }
function applied(source: MotionDocument): MotionDocument { const result = runMotionLayoutDebug({ schema: "shellx-motion/debug-layout-intent@1", operation: "apply", motion: source, groupId: "pack", createdAt: "2026-08-21T00:00:00.000Z", layout: layout(), repeaters: [] }); if (result.status !== "ok" || result.operation !== "apply") throw new Error(result.status === "refused" ? result.issues.map((issue) => issue.message).join("; ") : "expected apply"); return result.motion; }
function motion(): MotionDocument { return { schema: "shellx-motion/motion@1", id: "layout_gap_authority", name: "Gap", durationMs: 1_000, fps: 30, width: 100, height: 100, layers: [{ id: "pack", type: "group", startMs: 0, durationMs: 900, childLayerIds: ["a", "b"] }, child("a"), child("b")], assets: [], provenance: { sourceApp: "test", createdBy: "test" } }; }
function layout() { return { schema: "shellx-motion/layout@1" as const, kind: "row" as const, width: 100, height: 100, padding: { top: 10, right: 10, bottom: 10, left: 10 }, gap: 2, align: { x: "start" as const, y: "center" as const }, distribution: "start" as const, overflow: "clip" as const }; }
function child(id: string) { return { id, type: "shape", shape: "rect", startMs: 0, durationMs: 100, transform: { x: 0, y: 0, width: 30, height: 20, scale: 1, rotation: 0, opacity: 1 } }; }
