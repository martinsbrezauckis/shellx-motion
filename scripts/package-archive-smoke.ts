import assert from "node:assert/strict";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "../packages/cli/src/main";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const packageRoot = join(repoRoot, "fixtures/packages/lower-third");
const outDir = join(repoRoot, ".scratch", "package-archive-smoke");
const archivePath = join(outDir, "lower-third.shellxmotion");
const receiptPath = `${archivePath}.receipt.json`;
const roundTripPackageRoot = join(outDir, "roundtrip-package");
const roundTripReceiptPath = `${roundTripPackageRoot}.package-extract.receipt.json`;
const roundTripPreviewDir = join(outDir, "roundtrip-preview");

// Host gate for portable package handoff: archive, extract, validate, and preview.
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const result = await runCli(["package-archive", packageRoot, "--out", archivePath]);

assert(result.ok, `package-archive smoke failed: ${JSON.stringify(result, null, 2)}`);
assert(readObjectField(result, "command", "result.command") === "package-archive", "unexpected command");
assert(readObjectField(result, "packageId", "result.packageId") === "pkg_lower_third", "package id mismatch");
assert(readObjectField(result, "archivePath", "result.archivePath") === archivePath, "archive path mismatch");
assert(readObjectField(result, "receiptPath", "result.receiptPath") === receiptPath, "receipt path mismatch");
assert(readString(readObjectField(result, "archiveSha256", "result.archiveSha256"), "result.archiveSha256").match(/^[a-f0-9]{64}$/), "archive sha256 mismatch");
assert(readNumber(readObjectField(result, "fileCount", "result.fileCount"), "result.fileCount") === 3, "archive file count mismatch");

await stat(archivePath);
await stat(receiptPath);
const archive = await readFile(archivePath);
const entries = readTarEntries(archive);
assert(entries.map((entry) => entry.name).join(",") === "expected-preview.json,manifest.json,motion.json", "archive entries mismatch");
assert(entries.every((entry) => entry.mtime === 0), "archive mtimes must be deterministic");
assert(entries.some((entry) => entry.name === "manifest.json" && entry.data.toString("utf8").includes("pkg_lower_third")), "archive missing manifest payload");

const receipt = readJsonObject(await readFile(receiptPath, "utf8"), "archive receipt");
assert(readObjectField(receipt, "operation", "receipt.operation") === "package.archive", "receipt operation mismatch");
assert(readObjectField(receipt, "status", "receipt.status") === "passed", "receipt status mismatch");
assert(readObjectField(receipt, "lane", "receipt.lane") === "package", "receipt lane mismatch");
const output = readObject(readObjectField(receipt, "output", "receipt.output"), "receipt.output");
assert(readObjectField(output, "archivePath", "receipt.output.archivePath") === archivePath, "receipt archive path mismatch");
assert(readObjectField(output, "archiveFormat", "receipt.output.archiveFormat") === "tar", "receipt archive format mismatch");
assert(readObjectField(output, "packageExtension", "receipt.output.packageExtension") === ".shellxmotion", "receipt package extension mismatch");
assert(readObjectField(output, "sha256", "receipt.output.sha256") === readObjectField(result, "archiveSha256", "result.archiveSha256"), "receipt sha mismatch");

const artifacts = readArray(readObjectField(receipt, "artifacts", "receipt.artifacts"));
const archiveArtifact = artifacts.find((artifact) => readObjectField(artifact, "role", "artifact.role") === "motion_package_archive");
const receiptArtifact = artifacts.find((artifact) => readObjectField(artifact, "role", "artifact.role") === "package_archive_receipt");
assert(archiveArtifact, "receipt missing motion_package_archive artifact");
assert(receiptArtifact, "receipt missing package_archive_receipt artifact");
assert(readObjectField(archiveArtifact, "mediaType", "archiveArtifact.mediaType") === "application/x-tar", "archive artifact media type mismatch");
assert(readObjectField(receiptArtifact, "mediaType", "receiptArtifact.mediaType") === "application/json", "receipt artifact media type mismatch");

const extractResult = await runCli(["package-extract", archivePath, "--out", roundTripPackageRoot]);
assert(extractResult.ok, `package-extract round trip failed: ${JSON.stringify(extractResult, null, 2)}`);
assert(readObjectField(extractResult, "command", "extractResult.command") === "package-extract", "unexpected extract command");
assert(readObjectField(extractResult, "packageId", "extractResult.packageId") === "pkg_lower_third", "extract package id mismatch");
assert(readObjectField(extractResult, "archivePath", "extractResult.archivePath") === archivePath, "extract archive path mismatch");
assert(readObjectField(extractResult, "packageRoot", "extractResult.packageRoot") === roundTripPackageRoot, "extract package root mismatch");
assert(readObjectField(extractResult, "receiptPath", "extractResult.receiptPath") === roundTripReceiptPath, "extract receipt path mismatch");

await stat(roundTripReceiptPath);
const extractReceipt = readJsonObject(await readFile(roundTripReceiptPath, "utf8"), "extract receipt");
assert(readObjectField(extractReceipt, "operation", "package.archive.extract") === "package.archive.extract", "extract receipt operation mismatch");
assert(readObjectField(extractReceipt, "status", "extractReceipt.status") === "passed", "extract receipt status mismatch");
const extractOutput = readObject(readObjectField(extractReceipt, "output", "extractReceipt.output"), "extractReceipt.output");
assert(readObjectField(extractOutput, "packageRoot", "extractReceipt.output.packageRoot") === roundTripPackageRoot, "extract receipt package root mismatch");
assert(readObjectField(extractOutput, "sha256", "extractReceipt.output.sha256") === readObjectField(result, "archiveSha256", "result.archiveSha256"), "extract receipt sha mismatch");

const validateResult = await runCli(["validate", roundTripPackageRoot]);
assert(validateResult.ok, `round-trip package validate failed: ${JSON.stringify(validateResult, null, 2)}`);
assert(readObjectField(validateResult, "packageId", "validateResult.packageId") === "pkg_lower_third", "round-trip validate package mismatch");

const previewResult = await runCli(["preview", roundTripPackageRoot, "--out", roundTripPreviewDir]);
assert(previewResult.ok, `round-trip package preview failed: ${JSON.stringify(previewResult, null, 2)}`);
const roundTripPreviewPath = readString(readObjectField(previewResult, "outputPath", "previewResult.outputPath"), "previewResult.outputPath");
await stat(roundTripPreviewPath);
const roundTripPreview = await readFile(roundTripPreviewPath);
assert(roundTripPreview.subarray(0, 8).toString("hex") === "89504e470d0a1a0a", "round-trip preview output is not a PNG");

console.log(JSON.stringify({
  ok: true,
  command: "package-archive:smoke",
  packageRoot,
  archivePath,
  receiptPath,
  roundTripPackageRoot,
  roundTripReceiptPath,
  roundTripPreviewPath,
  archiveSha256: readObjectField(result, "archiveSha256", "result.archiveSha256"),
  entries: entries.map((entry) => ({ name: entry.name, size: entry.data.byteLength, mtime: entry.mtime })),
  artifacts: [
    { role: "motion_package_archive", mediaType: "application/x-tar" },
    { role: "package_archive_receipt", mediaType: "application/json" },
    { role: "package_archive_extract_receipt", mediaType: "application/json" }
  ]
}, null, 2));

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

function readJsonObject(source: string, label: string): object {
  return readObject(JSON.parse(source), label);
}

function readObject(value: unknown, label: string = "value"): object {
  assert(typeof value === "object" && value !== null && !Array.isArray(value), `expected ${label} object, got ${typeof value}`);
  return value;
}

function readObjectField(value: unknown, key: string, label = key): unknown {
  const record = readObject(value, label);
  return Reflect.get(record, key);
}

function readArray(value: unknown): unknown[] {
  assert(Array.isArray(value), "expected array");
  return value;
}

function readNumber(value: unknown, label: string): number {
  assert(typeof value === "number" && Number.isFinite(value), `expected ${label} finite number, got ${typeof value}`);
  return value;
}

function readString(value: unknown, label: string): string {
  assert(typeof value === "string", `expected ${label} string, got ${typeof value}`);
  return value;
}
