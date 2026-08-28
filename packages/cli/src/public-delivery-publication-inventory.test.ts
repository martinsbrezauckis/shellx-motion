import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const mainPath = fileURLToPath(new URL("./main.ts", import.meta.url));
const receiptPath = fileURLToPath(new URL("./render-receipt-file.ts", import.meta.url));
const capturePath = fileURLToPath(new URL("./browser-capture-command.ts", import.meta.url));
const recordingPath = fileURLToPath(new URL("./browser-capture-recording.ts", import.meta.url));
const browserRendererPath = fileURLToPath(new URL("../../renderer-browser/src/index.ts", import.meta.url));
const browserOutputPublicationPath = fileURLToPath(new URL("../../renderer-browser/src/browser-output-publication.ts", import.meta.url));
const finalFrameLanePath = fileURLToPath(new URL("../../debug-api/src/render-final-frame-lane.ts", import.meta.url));
const gpuPreviewPath = fileURLToPath(new URL("./gpu-preview-cli.ts", import.meta.url));
const browserManifestPath = fileURLToPath(new URL("../../renderer-browser/package.json", import.meta.url));
const nativeManifestPath = fileURLToPath(new URL("../../renderer-native/package.json", import.meta.url));
const gpuSessionTypesPath = fileURLToPath(new URL("../../renderer-browser/src/gpu-preview-session-types.ts", import.meta.url));
const nativeRendererPath = fileURLToPath(new URL("../../renderer-native/src/index.ts", import.meta.url));
const nativePreviewFramePath = fileURLToPath(new URL("../../renderer-native/src/native-preview-frame.ts", import.meta.url));
const renderDeliverySupportPath = fileURLToPath(new URL("./render-delivery-publication-support.ts", import.meta.url));

function branch(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error(`Missing public-delivery branch boundary: ${start}`);
  return source.slice(from, to);
}

describe("CLI public-delivery publication inventory", () => {
  it("reserves every success artifact before its renderer can publish and keeps browser evidence private", async () => {
    const source = await readFile(mainPath, "utf8");
    const receiptPublication = await readFile(receiptPath, "utf8");
    const preview = branch(source, "async function previewCommand", "async function renderCommand");
    const render = branch(source, "async function renderCommand", "function retainedBatchQualityManifestFor");
    const capture = await readFile(capturePath, "utf8");
    const recording = await readFile(recordingPath, "utf8");
    const browserRenderer = await readFile(browserRendererPath, "utf8");
    const browserOutputPublication = await readFile(browserOutputPublicationPath, "utf8");
    const finalFrameLane = await readFile(finalFrameLanePath, "utf8");
    const gpuPreview = await readFile(gpuPreviewPath, "utf8");
    const gpuSessionTypes = await readFile(gpuSessionTypesPath, "utf8");
    const nativeRenderer = await readFile(nativeRendererPath, "utf8");
    const nativePreviewFrame = await readFile(nativePreviewFramePath, "utf8");
    const renderDeliverySupport = await readFile(renderDeliverySupportPath, "utf8");

    const browserPreview = branch(preview, 'if (lane === "browser")', 'if (lane === "gpu")');
    const gpuPreviewBranch = branch(preview, 'if (lane === "gpu")', "const previewPath");
    const nativePreview = preview.slice(preview.indexOf("const previewPath"));
    for (const route of [browserPreview, gpuPreviewBranch, nativePreview]) {
      expect(route).toContain("PairedOutputReceiptPublication.acquire");
      expect(route).toContain('pairedPublicationUncertaintyFields(error, "previewCommitUncertain")');
    }
    expect(browserPreview).toContain("withRendererPrivateOutputPublication");
    expect(browserPreview).not.toContain("privateOutputPublication: publication.outputPublication");
    expect(browserPreview).toContain("outDir: dirname(publication.outputPublication.stagingPath)");
    expect(browserPreview).toContain("stageSecondaryArtifact");
    expect(nativePreview).toContain("path: previewPath");
    expect(gpuPreview).toContain("gpu_preview_publication_required");
    expect(gpuPreview).not.toContain("publishJsonSidecar");

    for (const [start, end, required] of [
      ["if (lane === \"native\")", "if (lane !== \"ffmpeg\")", "PairedOutputReceiptPublication.acquire"],
      ["if (stillFramePreset)", "if (imageSequencePreset)", "PairedOutputReceiptPublication.acquire"],
      ["if (imageSequencePreset)", "const ffmpegPreset", "prepareImageSequencePublication(resolvedOutputPath, forceOutput)"],
      ["if (segmented !== undefined)", "const retainedBatchQualityManifest", "PairedOutputReceiptPublication.acquire"],
      ["if (frameTransport.delivery === \"streamed\")", "if (frameLane === \"gpu\")", "PairedOutputReceiptPublication.acquire"]
    ] as const) {
      const route = branch(render, start, end);
      expect(route).toContain(required);
      if (required === "PairedOutputReceiptPublication.acquire") {
        expect(route).toContain('pairedPublicationUncertaintyFields(error, "renderCommitUncertain")');
      } else {
        expect(route).toContain("DirectoryBundleCommitUncertainError");
      }
    }
    expect(renderDeliverySupport).toContain('acquireDerivedOutputPublication({ outputPath, kind: "directory", replaceEmptyDirectory: true })');

    expect(branch(source, "let materializedPublication: PairedOutputReceiptPublication | undefined;", "async function qualityCheckRenderManifest"))
      .toContain("PairedOutputReceiptPublication.acquire");

    const browserStill = branch(render, "if (stillFramePreset)", "if (imageSequencePreset)");
    expect(browserStill).toContain("withRendererPrivateOutputPublication");
    expect(browserStill).toContain("outDir: dirname(publication.outputPublication.stagingPath)");
    expect(branch(render, "if (imageSequencePreset)", "const ffmpegPreset")).toContain("withRendererPrivateOutputPublication");
    expect(branch(render, "if (lane === \"native\")", "if (lane !== \"ffmpeg\")")).toContain("path: resolvedOutputPath");
    expect(render).not.toContain("finalizeRenderReceipt(");
    expect(receiptPublication).toContain("prepareBrowserWorkflowCatalogUpsert");
    expect(receiptPublication).not.toContain("upsertBrowserWorkflowCatalog");
    for (const [start, end] of [
      ["if (stillFramePreset)", "if (imageSequencePreset)"],
      ["if (imageSequencePreset)", "const ffmpegPreset"],
      ["if (frameTransport.delivery === \"streamed\")", "if (frameLane === \"gpu\")"]
    ] as const) {
      const route = branch(render, start, end);
      expect(route).toContain("commitPreparedRenderCatalog");
      expect(route).toContain("render_catalog_update_failed");
      if (start === "if (imageSequencePreset)") {
        expect(route).toContain("DirectoryBundleCommitUncertainError");
      } else {
        expect(route).toContain('pairedPublicationUncertaintyFields(error, "renderCommitUncertain")');
      }
    }
    const materialized = branch(source, "const { encoded, lastFrameReceipt", "function retainedBatchQualityManifestFor");
    expect(materialized).toContain("commitPreparedRenderCatalog");
    expect(materialized).toContain("render_catalog_update_failed");
    expect(materialized).toContain('pairedPublicationUncertaintyFields(error, "renderCommitUncertain")');
    const segmented = branch(render, "if (segmented !== undefined)", "const retainedBatchQualityManifest");
    expect(segmented).toContain("Segmented final delivery does not support browser workflows.");
    expect(segmented).toContain("withSegmentedFinalCliPublication");
    expect(segmented).not.toContain("privateOutputPublication: publication.outputPublication");
    expect(branch(render, "if (imageSequencePreset)", "const ffmpegPreset")).toContain("DirectoryBundleCommitUncertainError");
    const batch = branch(source, "async function renderBatchCommand", "function supportsBatchQualityManifestPreset");
    expect(batch).toContain("const renderResult = await renderCommand(renderArgs");
    expect(batch).toContain("readRenderCommitUncertainDelivery(renderResult)");
    expect(batch).toContain("readRenderBatchChildDelivery(renderResult)");
    expect(batch).toContain("renderBatchChildDeliveryJobFields(childDelivery)");
    expect(batch).toContain("renderCommitUncertainResponseFields(uncertainDelivery)");
    expect(batch).toContain("renderBatchBookkeepingFailure");

    expect(capture).toContain("acquireDerivedOutputPublication({ outputPath: outputDir, kind: \"directory\" })");
    expect(capture).toContain("withRendererPrivateOutputPublication");
    expect(capture).toContain("publishAfterBrowserCaptureSessionClose(closeSession");
    expect(capture).toContain("publishGovernedDirectoryBundle");
    expect(capture).toContain("captureCommitUncertain: true");
    expect(capture).toContain("expectedPublications: [error.expectedPublication]");
    expect(capture).toContain("captureCatalogIsExternal");
    expect(recording).toContain("captureCommitUncertain: true");
    expect(recording).toContain("expectedPublications: [error.expectedPublication]");
    expect(capture).toContain("const failurePublication = await acquireDerivedOutputPublication({ outputPath: outputDir, kind: \"directory\" })");
    expect(recording).toContain('".browser-capture-samples", String(index).padStart(6, "0")');
    expect(recording).toContain("OutputDirectoryReservation.acquire(evidenceRoot, {");
    expect(recording).toContain("requireAbsent: true");
    expect(recording).toContain("requirePrivate: true");
    expect(recording).toContain("await evidenceRootReservation.assertCurrent()");
    expect(recording).not.toContain("chmod(evidenceRoot");
    expect(recording).toContain("withRendererPrivateOutputPublication");
    expect(browserRenderer).toContain("resolveRendererPrivateOutputPublication(options)");
    expect(browserRenderer).toContain("assertNoStructuralPrivatePublication(options)");
    expect(browserRenderer).not.toContain("privateOutputPublication?: DerivedOutputPublication");
    expect(gpuSessionTypes).not.toContain("privateOutputPublication?: DerivedOutputPublication");
    expect(branch(nativeRenderer, "export interface CreateNativeRenderSessionInput", "interface NativeRenderSessionState"))
      .not.toContain("privateOutputPublication?: DerivedOutputPublication");
    expect(branch(nativePreviewFrame, "export interface NativePreviewFrameInput", "export async function renderNativePreviewFrame"))
      .not.toContain("privateOutputPublication?: DerivedOutputPublication");
    expect(nativeRenderer).toContain("resolveNativePrivateOutputPublication(input)");
    expect(browserRenderer).toContain("publishBrowserOutput(artifactPath, Buffer.from(preparedHtml), privateArtifactPublication)");
    expect(browserOutputPublication).toContain("writeVerifiedBoundedFile");
    expect(browserOutputPublication).toContain("strictChildPath(stagePath, requestedPath)");
    expect(browserOutputPublication).toContain("publication.writePrivateFile");
    expect(browserOutputPublication).toContain("publication.writePrivateCompanionFile");
    expect(finalFrameLane).toContain("outDir: dirname(publication.stagingPath)");

    const browserManifest = JSON.parse(await readFile(browserManifestPath, "utf8")) as { exports: Record<string, string>; publishConfig: { exports: Record<string, unknown> } };
    const nativeManifest = JSON.parse(await readFile(nativeManifestPath, "utf8")) as { exports: Record<string, string>; publishConfig: { exports: Record<string, unknown> } };
    for (const manifest of [browserManifest, nativeManifest]) {
      expect(manifest.exports["./internal/private-output-publication"]).toBeDefined();
      expect(manifest.publishConfig.exports["./internal/private-output-publication"]).toBeDefined();
    }
  });
});
