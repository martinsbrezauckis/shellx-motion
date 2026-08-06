/**
 * Canvas -> Motion frame-selection adapter.
 *
 * Role: convert a Canvas frame-selection document into a Motion package (manifest + motion +
 * receipt). Structural reading and rejection live in `./fixture-parse`; the published contract an
 * agent needs in order to write a valid document lives in `./fixture-contract`.
 *
 * Dependencies: `@shellx-motion/core`. Primary caller:
 * `packages/debug-api/src/domains/integration.ts` (`motion.canvas.package`).
 */
import {
  canonicalJsonSha256,
  hashBuffer,
  renderLanesFor,
  type MotionDocument,
  type MotionLayer,
  type MotionScene,
  type OperationReceipt,
  type PackageManifest,
  type ShellXIntegrationNegotiation
} from "@shellx-motion/core";
import {
  parseCanvasFrameSelection,
  readRecord,
  type CanvasImageEditorOutput,
  type CanvasFrame,
  type CanvasLayer,
  type JsonRecord
} from "./fixture-parse";

export * from "./package-writer";
export * from "./fixture-contract";
export {
  parseCanvasFrameSelection,
  type CanvasFrame,
  type CanvasFrameSelection,
  type CanvasImageEditorOutput,
  type CanvasLayer
} from "./fixture-parse";

export interface ConvertCanvasFrameOptions {
  selectedFrameId?: string;
  createdAt?: string;
  createdBy?: string;
  inputPath?: string;
  includeAllFrames?: boolean;
}

export interface CanvasMotionExport {
  manifest: PackageManifest;
  motion: MotionDocument;
  receipt: OperationReceipt;
  integration:
    | ShellXIntegrationNegotiation
    | {
        schema: "shellx-motion/integration-compatibility-adapter@1";
        ok: true;
        adapter: "shellx-canvas/frame-selection@1";
        payloadSchema: "shellx-canvas/frame-selection@1";
      };
}

const DEFAULT_INPUT_PATH = "fixtures/canvas/frame-selection.json";

export function convertCanvasFrameToMotionPackage(input: unknown, options: ConvertCanvasFrameOptions = {}): CanvasMotionExport {
  const selection = parseCanvasFrameSelection(input);
  const selectedFrameId = options.selectedFrameId ?? selection.selectedFrameId;
  const frame = selection.frames.find((candidate) => candidate.id === selectedFrameId);

  if (!frame) {
    throw new Error(`Selected Canvas frame not found: ${selectedFrameId}`);
  }

  const includeAllFrames = options.includeAllFrames === true;
  const frames = includeAllFrames ? selection.frames : [frame];
  const frameStarts = frameStartOffsets(frames);
  const packageId = includeAllFrames ? `pkg_${selection.project.id}_all_frames` : `pkg_${selection.project.id}_${frame.id}`;
  const motionId = includeAllFrames ? "motion_canvas_all_frames" : `motion_canvas_${frame.id}`;
  if (selection.schema === "shellx-motion/canvas-frame-selection@1") {
    if (includeAllFrames) throw new Error("Canonical Canvas frame selections cannot change package identity with includeAllFrames.");
    if (selection.identity?.packageId !== packageId || selection.identity.motionId !== motionId) {
      throw new Error("Canonical Canvas package identity does not match the selected frame.");
    }
  }
  const layerAssetRefs = uniqueStrings(frames.flatMap((candidate) => candidate.layers.flatMap((layer) => readLayerAssetRefs(layer))));
  const usedAssetRefs = new Set(layerAssetRefs);
  const assets = selection.imageEditorOutputs
    .filter((output) => usedAssetRefs.has(output.assetId) || usedAssetRefs.has(output.path))
    .map((output) => toMotionAsset(output, sourceFrameIdForAsset(output, frames) ?? frame.id));
  const imageEditorAssetIds = new Set(selection.imageEditorOutputs.map((output) => output.assetId));
  const imageEditorAssetPaths = new Set(selection.imageEditorOutputs.map((output) => output.path));
  const manifestAssets = uniqueStrings([
    ...assets.flatMap((asset) => {
      const source = readRecord(asset.source);
      if (typeof source?.path === "string") {
        return [source.path];
      }
      return [];
    }),
    ...layerAssetRefs.filter((assetRef) => !imageEditorAssetIds.has(assetRef) && !imageEditorAssetPaths.has(assetRef) && isPackageAssetRef(assetRef))
  ]);

  const motion: MotionDocument = {
    schema: "shellx-motion/motion@1",
    id: motionId,
    name: includeAllFrames ? selection.project.name : frame.name,
    durationMs: includeAllFrames ? frames.reduce((total, candidate) => total + candidate.durationMs, 0) : frame.durationMs,
    fps: frame.fps,
    width: frame.width,
    height: frame.height,
    background: frame.background,
    ...(includeAllFrames ? { scenes: frames.map((candidate, index) => toMotionScene(candidate, frameStarts[index])) } : {}),
    ...(frame.safeAreas ? { safeAreas: frame.safeAreas } : {}),
    layers: frames.flatMap((candidate, index) =>
      candidate.layers.map((layer) => toMotionLayer(layer, {
        startOffsetMs: frameStarts[index],
        ...(includeAllFrames ? { idPrefix: candidate.id } : {})
      }))
    ),
    assets,
    designTokens: selection.brand.tokens,
    provenance: {
      sourceApp: "shellx-canvas",
      createdBy: options.createdBy ?? "canvas-adapter",
      projectId: selection.project.id,
      selectedFrameId: frame.id,
      ...(selection.schema === "shellx-motion/canvas-frame-selection@1"
        ? { integrationProtocol: 1 }
        : { compatibilityAdapter: "shellx-canvas/frame-selection@1" }),
      ...(includeAllFrames ? { workflow: "canvas-page" } : {})
    }
  };

  const manifest: PackageManifest = {
    schema: "shellx-motion/package-manifest@1",
    id: packageId,
    name: includeAllFrames ? `${selection.project.name} - All Frames` : `${selection.project.name} - ${frame.name}`,
    motion: "motion.json",
    assets: manifestAssets,
    sourceApp: "shellx-canvas",
    compatibility: {
      lanes: compatibilityLanesFor(motion),
      hosts: ["shellx-motion", "shellx-canvas", "shellx-cut"]
    },
    selectedFrameId: frame.id
  };

  return {
    manifest,
    motion,
    integration: selection.negotiation ?? {
      schema: "shellx-motion/integration-compatibility-adapter@1",
      ok: true,
      adapter: "shellx-canvas/frame-selection@1",
      payloadSchema: "shellx-canvas/frame-selection@1"
    },
    receipt: createCanvasExportReceipt({
      packageId,
      motionId,
      manifestId: manifest.id,
      projectId: selection.project.id,
      selectedFrameId: frame.id,
      layerCount: motion.layers.length,
      assetCount: assets.length,
      safeAreaCount: Object.keys(frame.safeAreas ?? {}).length,
      frameIds: includeAllFrames ? frames.map((candidate) => candidate.id) : undefined,
      createdAt: options.createdAt ?? new Date().toISOString(),
      inputPath: options.inputPath ?? DEFAULT_INPUT_PATH,
      inputHash: hashCanonical(input)
    })
  };
}

function toMotionLayer(layer: CanvasLayer, options: { startOffsetMs?: number; idPrefix?: string } = {}): MotionLayer {
  const { kind, ...rest } = layer;
  return {
    ...rest,
    type: kind,
    id: options.idPrefix ? `${options.idPrefix}_${layer.id}` : layer.id,
    startMs: layer.startMs + (options.startOffsetMs ?? 0),
    durationMs: layer.durationMs,
    ...(options.idPrefix ? {
      "x-shellx-canvas-frameId": options.idPrefix,
      "x-shellx-canvas-layerId": layer.id
    } : {})
  };
}

function toMotionScene(frame: CanvasFrame, startMs: number): MotionScene {
  return {
    id: frame.id,
    name: frame.name,
    startMs,
    durationMs: frame.durationMs,
    "x-shellx-canvas-frame": {
      width: frame.width,
      height: frame.height,
      fps: frame.fps,
      ...(frame.background ? { background: frame.background } : {})
    }
  };
}

function frameStartOffsets(frames: CanvasFrame[]): number[] {
  const offsets: number[] = [];
  let cursor = 0;
  for (const frame of frames) {
    offsets.push(cursor);
    cursor += frame.durationMs;
  }
  return offsets;
}

function sourceFrameIdForAsset(output: CanvasImageEditorOutput, frames: CanvasFrame[]): string | undefined {
  const refs = new Set([output.assetId, output.path]);
  return frames.find((frame) =>
    frame.layers.some((layer) => readLayerAssetRefs(layer).some((ref) => refs.has(ref)))
  )?.id;
}

/**
 * Lanes advertised in the exported manifest's `compatibility.lanes`.
 *
 * Derived from the converted Motion document through core's `renderLanesFor`, which reads the
 * renderer capability cards each lane's runtime gate is projected from. This adapter deliberately
 * keeps no layer-type set of its own: the one it used to keep had drifted from the cards — it
 * listed kinds no card has ("canvas", "html") and omitted particles/shader/scene3d/camera/
 * adjustment/environment, so a package built from those kinds advertised `["canvas"]` while the
 * browser and ffmpeg lanes rendered it perfectly well, and an agent reading the field concluded its
 * package could not be rendered by the lane that could.
 *
 * "canvas" leads the list because the package is a faithful projection of a Design Studio document
 * and Canvas is its origin surface; it is a host lane, not one of the renderer cards.
 *
 * @param motion the converted document — not the source Canvas layers, so feature-level gaps
 *        (a supported kind using an option a lane lacks) narrow the answer too.
 */
function compatibilityLanesFor(motion: MotionDocument): string[] {
  return ["canvas", ...renderLanesFor(motion)];
}

function readLayerAssetRefs(layer: CanvasLayer): string[] {
  return uniqueStrings(
    [layer.assetId, layer.assetRef, layer.source, layer.src].flatMap((value) =>
      typeof value === "string" && value.length > 0 ? [value] : []
    )
  );
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function isPackageAssetRef(value: string): boolean {
  if (value.startsWith("/") || value.startsWith("\\") || value.includes("..")) return false;
  return !/^[a-z][a-z0-9+.-]*:/i.test(value);
}

function toMotionAsset(output: CanvasImageEditorOutput, sourceFrameId: string): JsonRecord {
  return {
    schema: "shellx-motion/asset@1",
    id: output.assetId,
    kind: output.kind,
    source: {
      app: "shellx-canvas/image-editor",
      path: output.path,
      mimeType: output.mimeType
    },
    hash: {
      sha256: output.sha256
    },
    size: {
      width: output.width,
      height: output.height
    },
    editStack: output.editStack,
    provenance: {
      sourceFrameId,
      imageEditorOutputId: output.id,
      receiptId: output.receiptId
    }
  };
}

function createCanvasExportReceipt(input: {
  packageId: string;
  motionId: string;
  manifestId: string;
  projectId: string;
  selectedFrameId: string;
  layerCount: number;
  assetCount: number;
  safeAreaCount: number;
  frameIds?: string[];
  createdAt: string;
  inputPath: string;
  inputHash: string;
}): OperationReceipt {
  return {
    schema: "shellx-motion/receipt@1",
    id: `receipt_canvas_export_${input.selectedFrameId}`,
    operation: "export.final",
    status: "passed",
    packageId: input.packageId,
    inputHashes: {
      [input.inputPath]: input.inputHash
    },
    createdAt: input.createdAt,
    lane: "canvas",
    output: {
      sourceApp: "shellx-canvas",
      projectId: input.projectId,
      selectedFrameId: input.selectedFrameId,
      motionId: input.motionId,
      manifestId: input.manifestId,
      layerCount: input.layerCount,
      assetCount: input.assetCount,
      ...(input.frameIds ? { frameCount: input.frameIds.length, frameIds: input.frameIds } : {}),
      ...(input.safeAreaCount > 0 ? { safeAreaCount: input.safeAreaCount } : {})
    },
    warnings: []
  };
}

/**
 * Content address of the canvas frame selection recorded in the conversion receipt.
 *
 * Delegates to core `canonicalJsonSha256` so there is one canonical byte form in the repo rather
 * than a per-adapter copy of the same 15 lines.
 */
function hashCanonical(value: unknown): string {
  return canonicalJsonSha256(value);
}
