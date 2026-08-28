import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "./output-path-trusted-workspace";
import { loadMotionPackage } from "./package";
import {
  extractMotionPackageArchive,
  writeMotionPackageArchive,
  type MotionPackageArchiveExtractionLimits
} from "./package-archive";

const fixtureRoot = fileURLToPath(new URL("../../../fixtures/packages/lower-third", import.meta.url));

describe("package archive", () => {
  it("writes a deterministic portable archive with all package files and a receipt", async () => {
    const tempRoot = await testRoot("shellx-motion-package-archive-");
    const outDir = join(tempRoot, "exports");
    const firstArchivePath = join(outDir, "lower-third.shellxmotion");
    const secondArchivePath = join(outDir, "lower-third-copy.shellxmotion");
    try {
      await mkdir(outDir, { recursive: true, mode: 0o700 });

      const first = await writeMotionPackageArchive({
        packageRoot: fixtureRoot,
        archivePath: firstArchivePath,
        createdAt: "2026-07-02T05:00:00.000Z"
      });
      const second = await writeMotionPackageArchive({
        packageRoot: fixtureRoot,
        archivePath: secondArchivePath,
        createdAt: "2026-07-02T05:00:00.000Z"
      });

      const archive = await readFile(first.archivePath);
      const entries = readTarEntries(archive);
      const receipt = JSON.parse(await readFile(first.receiptPath, "utf8")) as Record<string, any>;

      expect(first).toMatchObject({
        ok: true,
        packageId: "pkg_lower_third",
        archivePath: firstArchivePath,
        receiptPath: `${firstArchivePath}.receipt.json`,
        fileCount: 3,
        archiveSha256: second.archiveSha256
      });
      expect(entries.map((entry) => entry.name)).toEqual(["expected-preview.json", "manifest.json", "motion.json"]);
      await expect(readFile(join(fixtureRoot, "manifest.json"), "utf8")).resolves.toBe(entries[1].data.toString("utf8"));
      await expect(readFile(join(fixtureRoot, "motion.json"), "utf8")).resolves.toBe(entries[2].data.toString("utf8"));
      expect(new Set(entries.map((entry) => entry.mtime))).toEqual(new Set([0]));
      expect(first.entries).toEqual(entries.map((entry) => ({
        path: entry.name,
        size: entry.data.byteLength,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/)
      })));
      expect(receipt).toMatchObject({
        operation: "package.archive",
        status: "passed",
        packageId: "pkg_lower_third",
        lane: "package",
        output: {
          archivePath: firstArchivePath,
          receiptPath: `${firstArchivePath}.receipt.json`,
          archiveFormat: "tar",
          packageExtension: ".shellxmotion",
          fileCount: 3,
          sha256: first.archiveSha256
        },
        artifacts: expect.arrayContaining([
          expect.objectContaining({ role: "motion_package_archive", path: firstArchivePath, status: "available", mediaType: "application/x-tar", primary: true }),
          expect.objectContaining({ role: "package_archive_receipt", path: `${firstArchivePath}.receipt.json`, status: "available", mediaType: "application/json" })
        ])
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("allows one concurrent writer to publish the archive and receipt pair without clobbering", async () => {
    const tempRoot = await testRoot("shellx-motion-package-archive-publication-race-");
    const archivePath = join(tempRoot, "exports", "lower-third.shellxmotion");
    try {
      const attempts = await Promise.allSettled([
        writeMotionPackageArchive({ packageRoot: fixtureRoot, archivePath, createdAt: "2026-07-02T05:00:00.000Z" }),
        writeMotionPackageArchive({ packageRoot: fixtureRoot, archivePath, createdAt: "2026-07-02T05:01:00.000Z" })
      ]);
      const winner = attempts.find((attempt): attempt is PromiseFulfilledResult<Awaited<ReturnType<typeof writeMotionPackageArchive>>> => attempt.status === "fulfilled");
      const loser = attempts.find((attempt): attempt is PromiseRejectedResult => attempt.status === "rejected");

      expect(winner).toBeDefined();
      expect(loser).toMatchObject({ reason: { code: "package_archive_output_busy", message: "Package archive output is already being published." } });
      await expect(readFile(archivePath)).resolves.toHaveLength(winner!.value.byteLength);
      await expect(readFile(`${archivePath}.receipt.json`, "utf8")).resolves.toContain(`"createdAt": "${winner!.value.receipt.createdAt}"`);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("preserves existing archive or receipt targets and never publishes their counterpart", async () => {
    const tempRoot = await testRoot("shellx-motion-package-archive-existing-output-");
    const archivePath = join(tempRoot, "exports", "occupied.shellxmotion");
    const receiptPath = `${archivePath}.receipt.json`;
    try {
      await mkdir(dirname(archivePath), { recursive: true, mode: 0o700 });
      await writeFile(archivePath, "caller archive", "utf8");
      await expect(writeMotionPackageArchive({ packageRoot: fixtureRoot, archivePath }))
        .rejects.toMatchObject({ code: "package_archive_output_exists", message: "Package archive output already exists." });
      await expect(readFile(archivePath, "utf8")).resolves.toBe("caller archive");
      await expect(lstat(receiptPath)).rejects.toMatchObject({ code: "ENOENT" });

      const secondArchivePath = join(tempRoot, "exports", "receipt-occupied.shellxmotion");
      const secondReceiptPath = `${secondArchivePath}.receipt.json`;
      await writeFile(secondReceiptPath, "caller receipt", "utf8");
      await expect(writeMotionPackageArchive({ packageRoot: fixtureRoot, archivePath: secondArchivePath }))
        .rejects.toMatchObject({ code: "package_archive_output_exists", message: "Package archive output already exists." });
      await expect(lstat(secondArchivePath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(secondReceiptPath, "utf8")).resolves.toBe("caller receipt");

      if (process.platform !== "win32") {
        const symlinkTarget = join(tempRoot, "caller-owned.shellxmotion");
        const symlinkArchivePath = join(tempRoot, "exports", "linked.shellxmotion");
        await writeFile(symlinkTarget, "caller target", "utf8");
        await symlink(symlinkTarget, symlinkArchivePath);
        await expect(writeMotionPackageArchive({ packageRoot: fixtureRoot, archivePath: symlinkArchivePath }))
          .rejects.toMatchObject({ code: "package_archive_output_exists", message: "Package archive output already exists." });
        await expect(readFile(symlinkTarget, "utf8")).resolves.toBe("caller target");
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("refuses symlinked archive parents without staging outside them", async ({ skip }) => {
    const tempRoot = await testRoot("shellx-motion-package-archive-symlink-output-");
    const outside = join(tempRoot, "outside");
    const linkedParent = join(tempRoot, "linked-exports");
    const archivePath = join(linkedParent, "lower-third.shellxmotion");
    try {
      await mkdir(outside);
      try {
        await symlink(outside, linkedParent, process.platform === "win32" ? "junction" : "dir");
      } catch (error) {
        if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
          skip("The standard Windows test account cannot create directory symbolic links.");
          return;
        }
        throw error;
      }

      await expect(writeMotionPackageArchive({ packageRoot: fixtureRoot, archivePath }))
        .rejects.toMatchObject({
          code: "package_archive_output_unsafe_parent",
          message: "Package archive output parent is not a canonical non-symlink directory."
        });
      await expect(lstat(join(outside, "lower-third.shellxmotion"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(join(outside, "lower-third.shellxmotion.receipt.json"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects a conflicting archive and receipt path with a stable path-free error", async () => {
    const tempRoot = await testRoot("shellx-motion-package-archive-path-conflict-");
    const archivePath = join(tempRoot, "exports", "same.shellxmotion");
    try {
      await expect(writeMotionPackageArchive({ packageRoot: fixtureRoot, archivePath, receiptPath: archivePath }))
        .rejects.toMatchObject({
          code: "package_archive_output_paths_conflict",
          message: "Package archive and receipt paths must differ."
        });
      await expect(lstat(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("refuses archive-write file-count, depth, aggregate, and per-file limits before creating an archive", async () => {
    const tempRoot = await testRoot("shellx-motion-package-archive-write-limits-");
    const archivePath = join(tempRoot, "exports", "blocked.shellxmotion");
    try {
      await expect(writeMotionPackageArchive({ packageRoot: fixtureRoot, archivePath, limits: { maxFiles: 2 } }))
        .rejects.toThrow(/file limit/);
      await expect(readFile(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(writeMotionPackageArchive({ packageRoot: fixtureRoot, archivePath, limits: { maxAggregateBytes: 32 } }))
        .rejects.toThrow(/aggregate limit/);
      await expect(writeMotionPackageArchive({ packageRoot: fixtureRoot, archivePath, limits: { maxFileBytes: 32 } }))
        .rejects.toThrow(/per-file limit/);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("extracts a portable archive back into a loadable Motion package with receipt evidence", async () => {
    const tempRoot = await testRoot("shellx-motion-package-archive-roundtrip-");
    const archivePath = join(tempRoot, "exports", "lower-third.shellxmotion");
    const extractedRoot = join(tempRoot, "imports", "lower-third");
    const receiptPath = join(tempRoot, "imports", "extract.receipt.json");
    try {
      const archived = await writeMotionPackageArchive({
        packageRoot: fixtureRoot,
        archivePath,
        createdAt: "2026-07-02T05:00:00.000Z"
      });

      const extracted = await extractMotionPackageArchive({
        archivePath,
        packageRoot: extractedRoot,
        receiptPath,
        createdAt: "2026-07-02T05:05:00.000Z"
      });
      const pkg = await loadMotionPackage(extractedRoot);
      const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, any>;

      expect(extracted).toMatchObject({
        ok: true,
        packageId: "pkg_lower_third",
        archivePath,
        packageRoot: extractedRoot,
        receiptPath,
        archiveSha256: archived.archiveSha256,
        fileCount: 3,
        entries: [
          expect.objectContaining({ path: "expected-preview.json", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
          expect.objectContaining({ path: "manifest.json", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
          expect.objectContaining({ path: "motion.json", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) })
        ]
      });
      expect(pkg.manifest.id).toBe("pkg_lower_third");
      await expect(readFile(join(fixtureRoot, "manifest.json"), "utf8")).resolves.toBe(await readFile(join(extractedRoot, "manifest.json"), "utf8"));
      await expect(readFile(join(fixtureRoot, "motion.json"), "utf8")).resolves.toBe(await readFile(join(extractedRoot, "motion.json"), "utf8"));
      expect(receipt).toMatchObject({
        operation: "package.archive.extract",
        status: "passed",
        packageId: "pkg_lower_third",
        lane: "package",
        inputHashes: {
          archive: archived.archiveSha256
        },
        output: {
          archivePath,
          packageRoot: extractedRoot,
          receiptPath,
          archiveFormat: "tar",
          packageExtension: ".shellxmotion",
          fileCount: 3,
          sha256: archived.archiveSha256
        },
        artifacts: expect.arrayContaining([
          expect.objectContaining({ role: "motion_package", path: extractedRoot, status: "available", mediaType: "application/vnd.shellx.motion.package", primary: true }),
          expect.objectContaining({ role: "motion_package_archive", path: archivePath, status: "available", mediaType: "application/x-tar" }),
          expect.objectContaining({ role: "package_archive_extract_receipt", path: receiptPath, status: "available", mediaType: "application/json" })
        ])
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects archive entries that would escape the target package root", async () => {
    const tempRoot = await testRoot("shellx-motion-package-archive-unsafe-");
    const archivePath = join(tempRoot, "unsafe.shellxmotion");
    const extractedRoot = join(tempRoot, "package");
    try {
      await writeFile(archivePath, createTestTar([{ path: "../escape.txt", data: Buffer.from("nope", "utf8") }]));

      await expect(extractMotionPackageArchive({ archivePath, packageRoot: extractedRoot })).rejects.toThrow(/escapes package root/);
      await expect(readFile(join(tempRoot, "escape.txt"), "utf8")).rejects.toThrow();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("extracts into an existing empty destination and commits only after validation", async () => {
    const tempRoot = await testRoot("shellx-motion-package-archive-empty-destination-");
    const archivePath = join(tempRoot, "package.shellxmotion");
    const extractedRoot = join(tempRoot, "package");
    try {
      await writeMotionPackageArchive({ packageRoot: fixtureRoot, archivePath });
      await mkdir(extractedRoot, { mode: 0o700 });

      const result = await extractMotionPackageArchive({ archivePath, packageRoot: extractedRoot });

      expect(result.expandedByteLength).toBe(result.entries.reduce((total, entry) => total + entry.size, 0));
      await expect(loadMotionPackage(extractedRoot)).resolves.toMatchObject({ manifest: { id: "pkg_lower_third" } });
      await expect(readFile(result.receiptPath, "utf8")).resolves.toContain('"operation": "package.archive.extract"');
      await expectNoPrivateStagingDirectories(tempRoot);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("does not overwrite a non-empty destination or leave staged files", async () => {
    const tempRoot = await testRoot("shellx-motion-package-archive-nonempty-");
    const archivePath = join(tempRoot, "package.shellxmotion");
    const extractedRoot = join(tempRoot, "package");
    const markerPath = join(extractedRoot, "keep.txt");
    try {
      await writeMotionPackageArchive({ packageRoot: fixtureRoot, archivePath });
      await mkdir(extractedRoot, { mode: 0o700 });
      await writeFile(markerPath, "user-owned", "utf8");

      await expect(extractMotionPackageArchive({ archivePath, packageRoot: extractedRoot }))
        .rejects.toThrow("Output directory is not empty");

      await expect(readFile(markerPath, "utf8")).resolves.toBe("user-owned");
      await expectNoPrivateStagingDirectories(tempRoot);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("cleans private staging and leaves no destination when package schema validation fails", async () => {
    const tempRoot = await testRoot("shellx-motion-package-archive-invalid-schema-");
    const archivePath = join(tempRoot, "invalid.shellxmotion");
    const extractedRoot = join(tempRoot, "package");
    try {
      await writeFile(archivePath, createTestTar([
        { path: "manifest.json", data: Buffer.from("{}", "utf8") },
        { path: "motion.json", data: Buffer.from("{}", "utf8") }
      ]));

      await expect(extractMotionPackageArchive({ archivePath, packageRoot: extractedRoot }))
        .rejects.toThrow("package manifest failed schema validation");

      await expect(lstat(extractedRoot)).rejects.toMatchObject({ code: "ENOENT" });
      await expectNoPrivateStagingDirectories(tempRoot);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("refuses an archive whose Motion document names a missing package asset", async () => {
    const tempRoot = await testRoot("shellx-motion-package-archive-missing-layer-asset-");
    const archivePath = join(tempRoot, "invalid-asset.shellxmotion");
    const extractedRoot = join(tempRoot, "package");
    try {
      const manifest = JSON.parse(await readFile(join(fixtureRoot, "manifest.json"), "utf8"));
      const motion = JSON.parse(await readFile(join(fixtureRoot, "motion.json"), "utf8"));
      motion.layers[0].source = "assets/missing.png";
      await writeFile(archivePath, createTestTar([
        { path: "manifest.json", data: Buffer.from(JSON.stringify(manifest), "utf8") },
        { path: "motion.json", data: Buffer.from(JSON.stringify(motion), "utf8") },
      ]));

      await expect(withTrustedWorkspaceAnchor(await createTrustedWorkspaceAnchor(tempRoot), async () =>
        await extractMotionPackageArchive({ archivePath, packageRoot: extractedRoot })
      )).rejects.toThrow("Extracted package asset reference is invalid at /motion/layers/0/source (missing).");
      await expect(lstat(extractedRoot)).rejects.toMatchObject({ code: "ENOENT" });
      await expectNoPrivateStagingDirectories(tempRoot);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("enforces archive, expanded, per-file, file-count, path, and JSON limits before commit", async () => {
    const tempRoot = await testRoot("shellx-motion-package-archive-limits-");
    const archivePath = join(tempRoot, "package.shellxmotion");
    try {
      await writeMotionPackageArchive({ packageRoot: fixtureRoot, archivePath });
      const cases: Array<{ name: string; limits: Partial<MotionPackageArchiveExtractionLimits>; message: RegExp }> = [
        { name: "archive", limits: { maxArchiveBytes: 512 }, message: /archive limit/ },
        { name: "expanded", limits: { maxExpandedBytes: 32 }, message: /expanded-data limit/ },
        { name: "file", limits: { maxFileBytes: 32 }, message: /per-file limit/ },
        { name: "count", limits: { maxFiles: 2 }, message: /file limit/ },
        { name: "path", limits: { maxPathBytes: 8 }, message: /path limit/ },
        { name: "json", limits: { maxJsonBytes: 8 }, message: /JSON limit/ }
      ];
      for (const testCase of cases) {
        const extractedRoot = join(tempRoot, `package-${testCase.name}`);
        await expect(extractMotionPackageArchive({
          archivePath,
          packageRoot: extractedRoot,
          limits: testCase.limits
        })).rejects.toThrow(testCase.message);
        await expect(lstat(extractedRoot)).rejects.toMatchObject({ code: "ENOENT" });
        await expectNoPrivateStagingDirectories(tempRoot);
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects case-folded duplicates, deep paths, and portable backslash escapes", async () => {
    const tempRoot = await testRoot("shellx-motion-package-archive-path-policy-");
    try {
      const cases: Array<{
        name: string;
        entries: Array<{ path: string; data: Buffer }>;
        limits?: Partial<MotionPackageArchiveExtractionLimits>;
        message: RegExp;
      }> = [
        {
          name: "duplicate",
          entries: [
            { path: "manifest.json", data: Buffer.from("{}") },
            { path: "MANIFEST.JSON", data: Buffer.from("{}") }
          ],
          message: /duplicate file/
        },
        {
          name: "depth",
          entries: [{ path: "a/b/c/d.json", data: Buffer.from("{}") }],
          limits: { maxPathDepth: 3 },
          message: /depth limit/
        },
        {
          name: "backslash",
          entries: [{ path: "..\\escape.json", data: Buffer.from("{}") }],
          message: /escapes package root/
        },
        {
          name: "portable",
          entries: [{ path: "C:/escape.json", data: Buffer.from("{}") }],
          message: /portable package path/
        }
      ];
      for (const testCase of cases) {
        const archivePath = join(tempRoot, `${testCase.name}.shellxmotion`);
        const extractedRoot = join(tempRoot, `package-${testCase.name}`);
        await writeFile(archivePath, createTestTar(testCase.entries));
        await expect(extractMotionPackageArchive({
          archivePath,
          packageRoot: extractedRoot,
          ...(testCase.limits ? { limits: testCase.limits } : {})
        })).rejects.toThrow(testCase.message);
        await expect(lstat(extractedRoot)).rejects.toMatchObject({ code: "ENOENT" });
        await expectNoPrivateStagingDirectories(tempRoot);
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it.each([
    ["absolute", "/escape.json", undefined, /escapes package root/],
    ["empty component", "nested//escape.json", undefined, /escapes package root/],
    ["dot component", "./escape.json", undefined, /escapes package root/],
    ["parent component", "nested/../escape.json", undefined, /escapes package root/],
    ["Windows device name", "aux.json", undefined, /portable package path/],
    ["trailing dot", "nested/escape.", undefined, /portable package path/],
    ["reserved character", "nested/escape:copy.json", undefined, /portable package path/],
    ["non-NFC spelling", "cafe\u0301.json", undefined, /NFC normalization/],
    ["non-regular tar entry", "ordinary.json", "5", /regular files only/]
  ] as Array<[string, string, string | undefined, RegExp]>)
  ("refuses %s archive containment vector without installing a destination", async (_label, path, type, message) => {
    const tempRoot = await testRoot("shellx-motion-package-archive-adversarial-");
    const archivePath = join(tempRoot, "adversarial.shellxmotion");
    const extractedRoot = join(tempRoot, "package");
    try {
      await writeFile(archivePath, createTestTar([{ path, data: Buffer.from("untrusted", "utf8"), ...(type ? { type } : {}) }]));
      await expect(extractMotionPackageArchive({ archivePath, packageRoot: extractedRoot })).rejects.toThrow(message);
      await expect(lstat(extractedRoot)).rejects.toMatchObject({ code: "ENOENT" });
      await expectNoPrivateStagingDirectories(tempRoot);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects symlink destinations and receipts placed inside the package root", async () => {
    const tempRoot = await testRoot("shellx-motion-package-archive-destination-policy-");
    const archivePath = join(tempRoot, "package.shellxmotion");
    const outsideRoot = join(tempRoot, "outside");
    const linkRoot = join(tempRoot, "package-link");
    try {
      await writeMotionPackageArchive({ packageRoot: fixtureRoot, archivePath });
      await mkdir(outsideRoot);
      await symlink(outsideRoot, linkRoot, process.platform === "win32" ? "junction" : "dir");

      await expect(extractMotionPackageArchive({ archivePath, packageRoot: linkRoot }))
        .rejects.toThrow("Output path already exists and is not a directory");
      await expect(extractMotionPackageArchive({
        archivePath,
        packageRoot: join(tempRoot, "package"),
        receiptPath: join(tempRoot, "package", "extract.receipt.json")
      })).rejects.toThrow("output paths must be outside packageRoot");
      await expectNoPrivateStagingDirectories(tempRoot);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("refuses an unavailable receipt parent before publishing the package", async () => {
    const tempRoot = await testRoot("shellx-motion-package-archive-receipt-rollback-");
    const archivePath = join(tempRoot, "package.shellxmotion");
    const extractedRoot = join(tempRoot, "package");
    const receiptParent = join(tempRoot, "receipt-parent-is-a-file");
    try {
      await writeMotionPackageArchive({ packageRoot: fixtureRoot, archivePath });
      await writeFile(receiptParent, "block receipt directory", "utf8");

      await expect(extractMotionPackageArchive({
        archivePath,
        packageRoot: extractedRoot,
        receiptPath: join(receiptParent, "extract.receipt.json")
      })).rejects.toThrow();

      await expect(lstat(extractedRoot)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(receiptParent, "utf8")).resolves.toBe("block receipt directory");
      await expectNoPrivateStagingDirectories(tempRoot);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

});

async function expectNoPrivateStagingDirectories(parent: string): Promise<void> {
  expect((await readdir(parent)).filter((name) => name.startsWith(".shellx-motion-stage-") || name.startsWith(".shellx-motion-final-"))).toEqual([]);
}

async function testRoot(prefix: string): Promise<string> {
  return await mkdtemp(join(process.platform === "win32" ? process.cwd() : tmpdir(), prefix));
}

function createTestTar(entries: Array<{ path: string; data: Buffer; type?: string }>): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    writeString(header, 0, 100, entry.path);
    writeOctal(header, 100, 8, 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, entry.data.byteLength);
    writeOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    writeString(header, 156, 1, entry.type ?? "0");
    writeString(header, 257, 6, "ustar");
    writeString(header, 263, 2, "00");
    let checksum = 0;
    for (const byte of header) checksum += byte;
    writeChecksum(header, checksum);
    chunks.push(header, entry.data);
    const padding = entry.data.byteLength % 512 === 0 ? 0 : 512 - (entry.data.byteLength % 512);
    if (padding > 0) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

function readTarEntries(buffer: Buffer): Array<{ name: string; data: Buffer; mtime: number }> {
  const entries: Array<{ name: string; data: Buffer; mtime: number }> = [];
  let offset = 0;
  while (offset + 512 <= buffer.byteLength) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = readNullTerminated(header.subarray(0, 100));
    const size = readOctal(header.subarray(124, 136));
    const mtime = readOctal(header.subarray(136, 148));
    const prefix = readNullTerminated(header.subarray(345, 500));
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    entries.push({
      name: prefix ? `${prefix}/${name}` : name,
      data: buffer.subarray(dataStart, dataEnd),
      mtime
    });
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function readNullTerminated(buffer: Buffer): string {
  const end = buffer.indexOf(0);
  return buffer.subarray(0, end === -1 ? buffer.byteLength : end).toString("utf8");
}

function readOctal(buffer: Buffer): number {
  const value = readNullTerminated(buffer).trim();
  return value.length === 0 ? 0 : Number.parseInt(value, 8);
}

function writeString(buffer: Buffer, offset: number, length: number, value: string): void {
  Buffer.from(value, "utf8").copy(buffer, offset, 0, length);
}

function writeOctal(buffer: Buffer, offset: number, length: number, value: number): void {
  buffer.write(value.toString(8).padStart(length - 1, "0"), offset, length - 1, "ascii");
}

function writeChecksum(buffer: Buffer, value: number): void {
  buffer.write(value.toString(8).padStart(6, "0"), 148, 6, "ascii");
  buffer[154] = 0;
  buffer[155] = 0x20;
}
