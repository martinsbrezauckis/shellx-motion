import { describe, expect, it } from "vitest";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { hasMotionLayoutRemovalAuthorization } from "@shellx-motion/core/internal/layout-removal-authority";
import { canonicalJsonSha256, loadSchema, validateDocument, type MotionDocument, type MotionPackage, type OperationReceipt } from "@shellx-motion/core";
import {
  authorizeLayoutApplicationRemoval,
  layoutApplyHostReceiptId,
  persistLayoutApplicationAuthority,
} from "./timeline-layout-application-authority.js";
import { trustedAuthorityDirectory } from "./timeline-layout-application-authority-store.js";

const packageId = "pkg_layout_authority";
const applicationId = "layout-aaaaaaaaaaaaaaaaaaaaaaaa";
const applicationFingerprint = "b".repeat(64);

describe("timeline layout application host authority", () => {
  it("writes an immutable deterministic host receipt and rereads it before minting a one-shot Core token", async () => {
    const packageRoot = await writePackage();
    const receiptsRoot = await mkdtemp(join(tmpdir(), "shellx-motion-layout-authority-receipts-"));
    try {
      const pkg = packageAt(packageRoot);
      const receipt = applyReceipt();
      const receiptPath = await persistLayoutApplicationAuthority({
        receiptsRoot,
        packageRoot,
        manifestPath: join(packageRoot, "manifest.json"),
        motionPath: join(packageRoot, "motion.json"),
        packageId,
        applicationId,
        applicationFingerprint,
        persistedMotionSha256: canonicalJsonSha256(motionData()),
        receipt,
      });
      expect(receiptPath).toContain(".shellx-motion-layout-authority");
      const authorityKey = basename(receiptPath).replace(/\.receipt\.json$/u, "");
      expect(await readdir(join(receiptsRoot, ".shellx-motion-layout-authority"))).toEqual(expect.arrayContaining([
        `${authorityKey}.receipt.json`,
        `${authorityKey}.authority.json`,
        `${authorityKey}.pair.json`,
      ]));
      expect(receipt.id).toBe(layoutApplyHostReceiptId(packageId, applicationId));
      await expect(persistLayoutApplicationAuthority({
        receiptsRoot, packageRoot, manifestPath: join(packageRoot, "manifest.json"), motionPath: join(packageRoot, "motion.json"), packageId, applicationId, applicationFingerprint, persistedMotionSha256: canonicalJsonSha256(motionData()), receipt,
      })).resolves.toBe(receiptPath);
      const secondApplicationId = "layout-cccccccccccccccccccccccc";
      await expect(persistLayoutApplicationAuthority({
        receiptsRoot, packageRoot, manifestPath: join(packageRoot, "manifest.json"), motionPath: join(packageRoot, "motion.json"), packageId, applicationId: secondApplicationId, applicationFingerprint, persistedMotionSha256: canonicalJsonSha256(motionData()), receipt: applyReceipt(applicationFingerprint, secondApplicationId),
      })).resolves.toContain(".receipt.json");
      const token = await authorizeLayoutApplicationRemoval({ receiptsRoot, pkg, applicationId, applicationFingerprint });
      expect(hasMotionLayoutRemovalAuthorization(token, { packageId, applicationId, applicationFingerprint })).toBe(true);
    } finally {
      await Promise.all([packageRoot, receiptsRoot].map(async (path) => await rm(path, { recursive: true, force: true })));
    }
  });

  it("refuses missing, conflicting, and stale persisted authority without creating a removal token", async () => {
    const packageRoot = await writePackage();
    const receiptsRoot = await mkdtemp(join(tmpdir(), "shellx-motion-layout-authority-hostile-"));
    try {
      const pkg = packageAt(packageRoot);
      await expect(authorizeLayoutApplicationRemoval({ receiptsRoot, pkg, applicationId, applicationFingerprint })).rejects.toThrow();
      const receipt = applyReceipt();
      await persistLayoutApplicationAuthority({
        receiptsRoot, packageRoot, manifestPath: join(packageRoot, "manifest.json"), motionPath: join(packageRoot, "motion.json"), packageId, applicationId, applicationFingerprint, persistedMotionSha256: canonicalJsonSha256(motionData()), receipt,
      });
      await expect(persistLayoutApplicationAuthority({
        receiptsRoot,
        packageRoot,
        manifestPath: join(packageRoot, "manifest.json"),
        motionPath: join(packageRoot, "motion.json"),
        packageId,
        applicationId,
        applicationFingerprint: "c".repeat(64),
        persistedMotionSha256: canonicalJsonSha256(motionData()),
        receipt: applyReceipt("c".repeat(64)),
      })).rejects.toThrow(/different immutable bytes/);

      const copiedPackage = await mkdtemp(join(tmpdir(), "shellx-motion-layout-authority-copy-"));
      await cp(packageRoot, copiedPackage, { recursive: true });
      await expect(authorizeLayoutApplicationRemoval({ receiptsRoot, pkg: packageAt(copiedPackage), applicationId, applicationFingerprint })).rejects.toThrow();
      await persistLayoutApplicationAuthority({
        receiptsRoot, packageRoot: copiedPackage, manifestPath: join(copiedPackage, "manifest.json"), motionPath: join(copiedPackage, "motion.json"), packageId, applicationId, applicationFingerprint, persistedMotionSha256: canonicalJsonSha256(motionData()), receipt,
      });
      await expect(authorizeLayoutApplicationRemoval({ receiptsRoot, pkg: packageAt(copiedPackage), applicationId, applicationFingerprint })).resolves.toBeDefined();
      await rm(copiedPackage, { recursive: true, force: true });

      const receiptPath = await persistLayoutApplicationAuthority({
        receiptsRoot, packageRoot, manifestPath: join(packageRoot, "manifest.json"), motionPath: join(packageRoot, "motion.json"), packageId, applicationId, applicationFingerprint, persistedMotionSha256: canonicalJsonSha256(motionData()), receipt,
      });
      await rm(receiptPath.replace(".receipt.json", ".authority.json"), { force: true });
      await expect(authorizeLayoutApplicationRemoval({ receiptsRoot, pkg, applicationId, applicationFingerprint })).rejects.toThrow();
      await expect(persistLayoutApplicationAuthority({
        receiptsRoot, packageRoot, manifestPath: join(packageRoot, "manifest.json"), motionPath: join(packageRoot, "motion.json"), packageId, applicationId, applicationFingerprint, persistedMotionSha256: canonicalJsonSha256(motionData()), receipt,
      })).rejects.toThrow(/incomplete|competing/);
      // A pair whose journal no longer has both exact immutable members is never repaired or
      // reused.  That preserves the final-journal admission rule after crash/tamper evidence.
      expect(receiptPath).toContain(".receipt.json");

      await writeFile(join(packageRoot, "motion.json"), `${JSON.stringify({ schema: "shellx-motion/motion@1", forged: true })}\n`);
      await expect(authorizeLayoutApplicationRemoval({ receiptsRoot, pkg, applicationId, applicationFingerprint })).rejects.toThrow(/lineage/);
    } finally {
      await Promise.all([packageRoot, receiptsRoot].map(async (path) => await rm(path, { recursive: true, force: true })));
    }
  });

  it("admits a valid Motion document above receipt size while retaining the package Motion byte cap", async () => {
    const motion = motionData("x".repeat(512 * 1024));
    expect(await validateDocument(await loadSchema("motion"), motion)).toEqual({ ok: true });
    const packageRoot = await writePackage(motion);
    const receiptsRoot = await mkdtemp(join(tmpdir(), "shellx-motion-layout-authority-large-"));
    try {
      await expect(persistLayoutApplicationAuthority({
        receiptsRoot, packageRoot, manifestPath: join(packageRoot, "manifest.json"), motionPath: join(packageRoot, "motion.json"), packageId, applicationId, applicationFingerprint,
        persistedMotionSha256: canonicalJsonSha256(motion), receipt: applyReceipt(applicationFingerprint, applicationId, motion),
      })).resolves.toContain(".receipt.json");
    } finally {
      await Promise.all([packageRoot, receiptsRoot].map(async (path) => await rm(path, { recursive: true, force: true })));
    }
  });

  it("reads a preexisting v1 flat static authority but writes every new static authority through the pair journal", async () => {
    const packageRoot = await writePackage();
    const receiptsRoot = await mkdtemp(join(tmpdir(), "shellx-motion-layout-authority-pair-source-"));
    const legacyReceiptsRoot = await mkdtemp(join(tmpdir(), "shellx-motion-layout-authority-legacy-reader-"));
    try {
      const receipt = applyReceipt();
      const receiptPath = await persistLayoutApplicationAuthority({
        receiptsRoot,
        packageRoot,
        manifestPath: join(packageRoot, "manifest.json"),
        motionPath: join(packageRoot, "motion.json"),
        packageId,
        applicationId,
        applicationFingerprint,
        persistedMotionSha256: canonicalJsonSha256(motionData()),
        receipt,
      });
      const authorityKey = basename(receiptPath).replace(/\.receipt\.json$/u, "");
      const pairDirectory = join(receiptsRoot, ".shellx-motion-layout-authority");
      expect(await readdir(pairDirectory)).toContain(`${authorityKey}.pair.json`);

      const legacyDirectory = await trustedAuthorityDirectory(legacyReceiptsRoot, true);
      const authority = JSON.parse(await readFile(join(pairDirectory, `${authorityKey}.authority.json`), "utf8")) as Record<string, unknown>;
      authority.schema = "shellx-motion/timeline-layout-application-authority@1";
      authority.receiptsRoot = legacyDirectory.root;
      await writeFile(join(legacyDirectory.path, `${authorityKey}.receipt.json`), await readFile(receiptPath));
      await writeFile(join(legacyDirectory.path, `${authorityKey}.authority.json`), `${JSON.stringify(authority)}\n`);

      await expect(authorizeLayoutApplicationRemoval({
        receiptsRoot: legacyReceiptsRoot,
        pkg: packageAt(packageRoot),
        applicationId,
        applicationFingerprint,
      })).resolves.toBeDefined();
      expect(await readdir(legacyDirectory.path)).toEqual([
        `${authorityKey}.authority.json`,
        `${authorityKey}.receipt.json`,
      ]);
    } finally {
      await Promise.all([packageRoot, receiptsRoot, legacyReceiptsRoot].map(async (path) => await rm(path, { recursive: true, force: true })));
    }
  });
});

async function writePackage(motion = motionData()): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-layout-authority-package-"));
  await writeFile(join(root, "manifest.json"), `${JSON.stringify({ schema: "shellx-motion/package-manifest@1", id: packageId, name: "Authority", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["native"], hosts: ["motion"] } })}\n`);
  await writeFile(join(root, "motion.json"), `${JSON.stringify(motion)}\n`);
  return root;
}

function packageAt(root: string, motion = motionData()): MotionPackage {
  return {
    root,
    manifest: { schema: "shellx-motion/package-manifest@1", id: packageId, name: "Authority", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["native"], hosts: ["motion"] } },
    motion,
  } as MotionPackage;
}

function motionData(note?: string): MotionDocument { return { schema: "shellx-motion/motion@1", id: "motion_authority", name: "Authority", durationMs: 1, fps: 30, width: 1, height: 1, layers: [], assets: [], provenance: { sourceApp: "test", createdBy: "test" }, ...(note === undefined ? {} : { "x-note": note }) } as MotionDocument; }
function applyReceipt(fingerprint = applicationFingerprint, id = applicationId, motion = motionData()): OperationReceipt {
  return {
    schema: "shellx-motion/receipt@1",
    id: layoutApplyHostReceiptId(packageId, id),
    operation: "timeline.layout.apply",
    status: "passed",
    packageId,
    inputHashes: { "manifest.json": "a".repeat(64), "motion.json": "d".repeat(64) },
    createdAt: "2026-08-16T00:00:00.000Z",
    lane: "debug-api",
    output: {
      packageDir: "/output", manifestPath: "/output/manifest.json", motionPath: "/output/motion.json",
      operation: "apply", compilation: {},
      application: { disposition: "applied", id, fingerprint, groupId: "pack", sourceChildLayerIds: ["a"], materializedChildLayerIds: ["a"], generatedLayerIds: [], trackOrders: [] },
      removal: { schema: "shellx-motion/debug-layout-removal@1", applicationId: id, applicationFingerprint: fingerprint },
      layoutFingerprint: "f".repeat(64), layoutFingerprintInput: "layout", budget: {}, overflow: {}, repeaters: [], changedLayerIds: ["a"], outputMotionSha256: canonicalJsonSha256(motion), validation: { ok: true },
    },
    warnings: [],
  };
}
