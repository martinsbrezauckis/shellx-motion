import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dispatchDebugCommand } from "../packages/debug-api/src/index";
import { runCli } from "../packages/cli/src/main";
import { inspectPngFile } from "../packages/core/src/index";
import { createTrustedWorkspaceAnchor, withTrustedWorkspaceAnchor } from "../packages/core/src/output-path-trusted-workspace";
import { renderingSamplesProofRoot } from "./rendering-samples-proof-root";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const fixturePath = join(repoRoot, "fixtures", "canvas", "frame-selection.json");
const outDir = renderingSamplesProofRoot(join(repoRoot, ".scratch", "canvas-package-preview-smoke"));
const sourceRoot = join(outDir, "canvas-source");
const selectionPath = join(sourceRoot, "frame-selection.json");
const assetPath = join(sourceRoot, "assets", "product-retouched.png");
const packageDir = join(outDir, "motion-package");
const receiptsRoot = join(outDir, "host-receipts");
const previewOutDir = join(outDir, "preview");

await rm(outDir, { recursive: true, force: true });
await mkdir(dirname(assetPath), { recursive: true });
const workspaceAuthority = await createTrustedWorkspaceAnchor(outDir);
const inWorkspace = async <T>(operation: () => Promise<T>): Promise<T> => await withTrustedWorkspaceAnchor(workspaceAuthority, operation);

const samplePng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64"
);
const samplePngSha256 = sha256(samplePng);
const selection = readObject(JSON.parse(await readFile(fixturePath, "utf8")), "Canvas frame selection");
const imageEditorOutputs = readArray(readObjectField(selection, "imageEditorOutputs", "selection.imageEditorOutputs"));
const imageOutput = readObject(imageEditorOutputs[0], "selection.imageEditorOutputs[0]");
Reflect.set(imageOutput, "sha256", samplePngSha256);
await writeFile(assetPath, samplePng);
await writeFile(selectionPath, `${JSON.stringify(selection, null, 2)}\n`, "utf8");

const packageResult = await inWorkspace(async () => await dispatchDebugCommand(
  "motion.canvas.package",
  {
    canvasSelectionPath: selectionPath,
    packageDir,
    sourceRoot,
    receiptsRoot,
    createdAt: "2026-07-03T00:00:00.000Z"
  },
  {
    tier: "write_local",
    scratchRoot: outDir,
    receiptsRoot,
    authoringInputRoots: [sourceRoot],
    authoringOutputRoots: [outDir]
  }
));

assert(packageResult.ok, `Canvas package preview smoke failed: ${JSON.stringify(packageResult, null, 2)}`);
assert(packageResult.receiptId === "receipt_canvas_export_frame_story_hero", `unexpected receipt id: ${String(packageResult.receiptId)}`);
const packagePayload = readObject(packageResult.result, "packageResult.result");
const copiedAssetRefs = readArray(readObjectField(packagePayload, "copiedAssetRefs", "packageResult.copiedAssetRefs")).map((value) =>
  readString(value, "copiedAssetRef")
);
const missingAssetRefs = readArray(readObjectField(packagePayload, "missingAssetRefs", "packageResult.missingAssetRefs"));
const packageReceiptPath = readString(readObjectField(packagePayload, "receiptPath", "packageResult.receiptPath"), "packageResult.receiptPath");
const resourceCatalogPath = readString(readObjectField(packagePayload, "resourceCatalogPath", "packageResult.resourceCatalogPath"), "packageResult.resourceCatalogPath");
const hostReceiptPath = readString(readObjectField(packagePayload, "hostReceiptPath", "packageResult.hostReceiptPath"), "packageResult.hostReceiptPath");

assert.deepEqual(copiedAssetRefs, ["assets/product-retouched.png"]);
assert.deepEqual(missingAssetRefs, []);
await stat(join(packageDir, "assets", "product-retouched.png"));
await stat(packageReceiptPath);
await stat(resourceCatalogPath);
await stat(hostReceiptPath);

const packageReceipt = readJsonObject(await readFile(packageReceiptPath, "utf8"), "canvas package receipt");
const hostReceipt = readJsonObject(await readFile(hostReceiptPath, "utf8"), "host canvas package receipt");
const resourceCatalog = readJsonObject(await readFile(resourceCatalogPath, "utf8"), "resource-catalog.json");
assert(readObjectField(packageReceipt, "operation", "packageReceipt.operation") === "export.final", "package receipt operation mismatch");
assert(readObjectField(hostReceipt, "operation", "hostReceipt.operation") === "export.final", "host receipt operation mismatch");
assert(readObjectField(resourceCatalog, "schema", "resourceCatalog.schema") === "shellx-motion/resource-catalog@1", "resource catalog schema mismatch");
const resources = readArray(readObjectField(resourceCatalog, "resources", "resourceCatalog.resources"));
assert(resources.some((resource) => readObjectField(resource, "ref", "resource.ref") === "assets/product-retouched.png"), "resource catalog missing copied image asset");

const previewResult = await inWorkspace(async () => await runCli(["preview", packageDir, "--lane", "browser", "--out", previewOutDir, "--at-ms", "1200"]));
assert(previewResult.ok, `Canvas package preview render failed: ${JSON.stringify(previewResult, null, 2)}`);
const previewPath = readString(readObjectField(previewResult, "outputPath", "previewResult.outputPath"), "previewResult.outputPath");
await stat(previewPath);
const previewPng = await readFile(previewPath);
assert(previewPng.subarray(0, 8).toString("hex") === "89504e470d0a1a0a", "Canvas package preview output is not a PNG");

const quality = await inspectPngFile(previewPath);
assert(quality.ok, `Canvas package preview PNG inspection failed: ${JSON.stringify(quality, null, 2)}`);
assert.equal(quality.width, 1080, "Canvas package preview width mismatch");
assert.equal(quality.height, 1920, "Canvas package preview height mismatch");
assert(!quality.blank, "Canvas package preview must not be blank");
assert(quality.luma.brightPixels >= 1000, "Canvas package preview has too few bright pixels");
assert(quality.edges.pixels >= 100, "Canvas package preview has too few edge pixels");
assert(quality.nonTransparentPixels >= 1000, "Canvas package preview has too few non-transparent pixels");

console.log(JSON.stringify({
  ok: true,
  command: "canvas-package-preview:smoke",
  fixturePath,
  selectionPath,
  sourceRoot,
  packageDir,
  copiedAssetRefs,
  missingAssetRefs,
  resourceCatalogPath,
  packageReceiptPath,
  hostReceiptPath,
  previewPath,
  quality: {
    ok: quality.ok,
    width: quality.width,
    height: quality.height,
    brightPixels: quality.luma.brightPixels,
    edgePixels: quality.edges.pixels,
    nonTransparentPixels: quality.nonTransparentPixels
  }
}, null, 2));

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function readJsonObject(text: string, label: string): object {
  const parsed: unknown = JSON.parse(text);
  return readObject(parsed, label);
}

function readObject(value: unknown, label: string): object {
  assert(typeof value === "object" && value !== null && !Array.isArray(value), `expected ${label} object, got ${typeof value}`);
  return value;
}

function readObjectField(value: unknown, key: string, label: string): unknown {
  const record = readObject(value, label);
  return Reflect.get(record, key);
}

function readArray(value: unknown): unknown[] {
  assert(Array.isArray(value), "expected array");
  return value;
}

function readString(value: unknown, label: string): string {
  assert(typeof value === "string" && value.length > 0, `missing ${label}`);
  return value;
}
