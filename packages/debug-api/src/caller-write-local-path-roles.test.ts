import { cp, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { refuseUntrustedCallerPackageAuthoring } from "./caller-package-edit-boundary.js";
import { dispatchCallerSteeredCommand } from "./index.js";

const FIXTURE = resolve("../../fixtures/packages/lower-third");

describe("caller write_local filesystem path roles", () => {
  it("fences archive, extract, review, and support paths before their sinks and admits their approved roles", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-caller-write-local-"));
    const inputRoot = join(root, "input");
    const outputRoot = join(root, "output");
    const receiptsRoot = join(root, "receipts");
    const scratchRoot = join(root, "scratch");
    const foreignRoot = join(root, "foreign");
    const packageRoot = join(inputRoot, "package");
    const foreignPackage = join(foreignRoot, "package");
    const context = {
      tier: "write_local" as const,
      authoringInputRoots: [inputRoot],
      authoringOutputRoots: [outputRoot],
      receiptsRoot,
      scratchRoot
    };
    try {
      await Promise.all([
        mkdir(inputRoot, { mode: 0o700 }), mkdir(outputRoot, { mode: 0o700 }),
        mkdir(receiptsRoot, { mode: 0o700 }), mkdir(scratchRoot, { mode: 0o700 }),
        mkdir(foreignRoot, { mode: 0o700 })
      ]);
      await Promise.all([cp(FIXTURE, packageRoot, { recursive: true }), cp(FIXTURE, foreignPackage, { recursive: true })]);

      const archivePath = join(outputRoot, "package.shellxmotion");
      const archiveReceiptPath = join(receiptsRoot, "archive.receipt.json");
      const archiveAdmitted = await refuseUntrustedCallerPackageAuthoring("motion.package.archive", {
        packageRoot, out: archivePath, receiptPath: archiveReceiptPath
      }, context);
      expect(archiveAdmitted).toBeNull();

      const inputArchivePath = join(inputRoot, "package.shellxmotion");
      await writeFile(inputArchivePath, "test archive", "utf8");
      const extractedRoot = join(outputRoot, "extracted");
      const extractAdmitted = await refuseUntrustedCallerPackageAuthoring("motion.package.extract", {
        inPath: inputArchivePath, out: extractedRoot, receiptPath: join(outputRoot, "extract.receipt.json")
      }, context);
      expect(extractAdmitted).toBeNull();

      const reviewRoot = join(outputRoot, "review");
      const reviewAdmitted = await refuseUntrustedCallerPackageAuthoring("motion.review.html.bundle", { packageRoot, outDir: reviewRoot }, context);
      expect(reviewAdmitted).toBeNull();

      const supportRoot = join(scratchRoot, "support");
      const supportAdmitted = await refuseUntrustedCallerPackageAuthoring("motion.support.bundle", { packageRoot, outDir: supportRoot }, context);
      expect(supportAdmitted).toBeNull();

      const refusedArchivePath = join(outputRoot, "foreign-package.shellxmotion");
      const refusedArchive = await dispatchCallerSteeredCommand("motion.package.archive", {
        packageRoot: foreignPackage, archivePath: refusedArchivePath
      }, context);
      expect(refusedArchive).toMatchObject({ ok: false, error: { code: "authoring_path_not_approved" } });
      await expect(lstat(refusedArchivePath)).rejects.toMatchObject({ code: "ENOENT" });

      const foreignArchive = join(foreignRoot, "foreign.shellxmotion");
      await writeFile(foreignArchive, "foreign archive", "utf8");
      const refusedExtractRoot = join(outputRoot, "refused-extract");
      const refusedExtract = await dispatchCallerSteeredCommand("motion.package.extract", {
        archive: foreignArchive, outDir: refusedExtractRoot
      }, context);
      expect(refusedExtract).toMatchObject({ ok: false, error: { code: "authoring_path_not_approved" } });
      await expect(lstat(refusedExtractRoot)).rejects.toMatchObject({ code: "ENOENT" });

      const refusedReviewRoot = join(outputRoot, "refused-review");
      const refusedReview = await dispatchCallerSteeredCommand("motion.review.html.bundle", {
        packageRoot: foreignPackage, outDir: refusedReviewRoot
      }, context);
      expect(refusedReview).toMatchObject({ ok: false, error: { code: "authoring_path_not_approved" } });
      await expect(lstat(refusedReviewRoot)).rejects.toMatchObject({ code: "ENOENT" });

      const refusedSupportRoot = join(scratchRoot, "refused-support");
      const refusedSupport = await dispatchCallerSteeredCommand("motion.support.bundle", {
        packageRoot: foreignPackage, outDir: refusedSupportRoot
      }, context);
      expect(refusedSupport).toMatchObject({ ok: false, error: { code: "authoring_path_not_approved" } });
      await expect(lstat(refusedSupportRoot)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fences the effective default extraction receipt sibling before dispatch while preserving approved defaults and explicit receipts", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-caller-extract-receipt-"));
    const inputRoot = join(root, "input");
    const outputRoot = join(root, "output");
    const receiptsRoot = join(root, "receipts");
    const narrowPackageRoot = join(outputRoot, "package");
    const archivePath = join(inputRoot, "package.shellxmotion");
    const defaultReceiptPath = `${narrowPackageRoot}.package-extract.receipt.json`;
    try {
      await Promise.all([
        mkdir(inputRoot, { mode: 0o700 }), mkdir(outputRoot, { mode: 0o700 }), mkdir(receiptsRoot, { mode: 0o700 })
      ]);
      await mkdir(narrowPackageRoot, { mode: 0o700 });
      await writeFile(archivePath, "not an archive: the caller fence must run first", "utf8");

      const broadContext = {
        tier: "write_local" as const,
        authoringInputRoots: [inputRoot],
        authoringOutputRoots: [outputRoot],
        receiptsRoot
      };
      await expect(refuseUntrustedCallerPackageAuthoring("motion.package.extract", {
        archivePath, packageRoot: join(outputRoot, "approved-package")
      }, broadContext)).resolves.toBeNull();

      const narrowContext = { ...broadContext, authoringOutputRoots: [narrowPackageRoot] };
      await writeFile(defaultReceiptPath, "protected default receipt", "utf8");
      const exactRootAliases = [narrowPackageRoot, `${narrowPackageRoot}/`, `${narrowPackageRoot}/.`, join(narrowPackageRoot, "child", "..")];
      for (const rootAlias of exactRootAliases) {
        for (const args of [
          { archivePath, packageRoot: rootAlias },
          { archivePath, packageRoot: rootAlias, receiptPath: "" },
          { archivePath, packageRoot: rootAlias, receiptPath: null },
          { archivePath, outDir: rootAlias },
          { archivePath, out: rootAlias }
        ]) {
          await expect(dispatchCallerSteeredCommand("motion.package.extract", args, narrowContext))
            .resolves.toMatchObject({ ok: false, error: { code: "authoring_path_not_approved" } });
        }
      }
      await expect(readFile(defaultReceiptPath, "utf8")).resolves.toBe("protected default receipt");

      await expect(refuseUntrustedCallerPackageAuthoring("motion.package.extract", {
        archivePath, packageRoot: narrowPackageRoot, receiptPath: join(receiptsRoot, "extract.receipt.json")
      }, narrowContext)).resolves.toBeNull();
      await expect(readFile(defaultReceiptPath, "utf8")).resolves.toBe("protected default receipt");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fences raw caller tracking request package and packageDir roles before analysis", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-caller-tracking-"));
    const inputRoot = join(root, "input");
    const outputRoot = join(root, "output");
    const foreignRoot = join(root, "foreign");
    const packageRoot = join(inputRoot, "package");
    const foreignPackage = join(foreignRoot, "package");
    const context = { tier: "write_local" as const, authoringInputRoots: [inputRoot], authoringOutputRoots: [outputRoot] };
    try {
      await Promise.all([mkdir(inputRoot, { mode: 0o700 }), mkdir(outputRoot, { mode: 0o700 }), mkdir(foreignRoot, { mode: 0o700 })]);
      await Promise.all([cp(FIXTURE, packageRoot, { recursive: true }), cp(FIXTURE, foreignPackage, { recursive: true })]);

      const refusedOutDir = join(outputRoot, "refused");
      const refused = await dispatchCallerSteeredCommand("motion.analysis.tracking.request", {
        packageRoot: foreignPackage, packageDir: refusedOutDir
      }, context);
      expect(refused).toMatchObject({ ok: false, error: { code: "authoring_path_not_approved" } });
      await expect(lstat(refusedOutDir)).rejects.toMatchObject({ code: "ENOENT" });

      const foreignOutDir = join(foreignRoot, "refused-output");
      const refusedOutput = await dispatchCallerSteeredCommand("motion.analysis.tracking.request", {
        packageRoot, packageDir: foreignOutDir
      }, context);
      expect(refusedOutput).toMatchObject({ ok: false, error: { code: "authoring_path_not_approved" } });
      await expect(lstat(foreignOutDir)).rejects.toMatchObject({ code: "ENOENT" });

      // Missing analysis fields are an ordinary command-validation refusal, not a path refusal:
      // packageRoot/packageDir were admitted by the caller boundary first.
      const admittedToHandler = await dispatchCallerSteeredCommand("motion.analysis.tracking.request", {
        packageRoot, packageDir: join(outputRoot, "admitted")
      }, context);
      expect(admittedToHandler).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
