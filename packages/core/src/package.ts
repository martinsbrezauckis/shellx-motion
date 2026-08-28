import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type {
  MotionDocument,
  MotionPackage,
  PackageManifest,
  TemplateAssetAttribution,
  TemplateDocument,
  TemplateLicense,
  TemplateMetadata,
  TemplateMediaSlot,
  TemplateOutputBounds,
  TemplatePerformance,
  TemplatePreviewAssets,
  TemplateProvenance,
  TemplateQualityTargets,
  TemplateStory,
  TemplateSuitability
} from "./types";
import { PACKAGE_MANIFEST_MAX_BYTES, PACKAGE_MOTION_MAX_BYTES, PACKAGE_TEMPLATE_MAX_BYTES, readStablePackageJson, rememberLoadedPackageHashes } from "./package-loaded-inputs"; import { readMotionScene3DAnimationDocumentRoot } from "./motion-scene3d-animation-document"; import { readMotionLayoutGapAnimationDocumentRoot } from "./motion-layout-gap-animation-document"; import { motionDocumentRootPreflight } from "./motion-document-root-preflight";
export const MAX_MOTION_DOCUMENT_LAYERS = 8_192;
export async function loadMotionPackage(root: string): Promise<MotionPackage> {
  const packageRoot = resolve(root);
  const manifestFile = await readStablePackageJson(resolve(packageRoot, "manifest.json"), packageRoot, PACKAGE_MANIFEST_MAX_BYTES, "Package manifest"); const manifest = readPackageManifest(manifestFile.value);
  const motionPath = resolvePackageAsset({ root: packageRoot }, manifest.motion);
  const motionFile = await readStablePackageJson(motionPath, packageRoot, PACKAGE_MOTION_MAX_BYTES, "Motion document"); const motion = readMotionDocument(motionFile.value);
  const templateFile = manifest.template ? await readStablePackageJson(resolvePackageAsset({ root: packageRoot }, manifest.template), packageRoot, PACKAGE_TEMPLATE_MAX_BYTES, "Template document") : undefined;
  const template = templateFile ? readTemplateDocument(templateFile.value) : undefined;
  if (template) assertTemplatePackageSemantics(template, motion, packageRoot);
  const pkg: MotionPackage = {
    root: packageRoot, manifest, motion, ...(template ? { template } : {}),
  };
  rememberLoadedPackageHashes(pkg, {
      "manifest.json": manifestFile.sha256,
      [manifest.motion]: motionFile.sha256,
      ...(manifest.template && templateFile ? { [manifest.template]: templateFile.sha256 } : {}),
  });
  return pkg;
}
export function resolvePackageAsset(pkg: Pick<MotionPackage, "root">, assetRef: string): string {
  const resolved = resolve(pkg.root, assetRef);
  assertPathInsidePackageRoot(pkg.root, resolved, assetRef);
  try {
    assertPathInsidePackageRoot(realpathSync.native(pkg.root), realpathSync.native(resolved), assetRef);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Asset path escapes package root:")) throw error;
  }
  return resolved;
}

export async function hashPackageFile(path: string): Promise<string> { return hashBuffer(await readFile(path)); }
function assertPathInsidePackageRoot(root: string, candidate: string, assetRef: string): void {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  const rootWithSep = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
  if (normalizedCandidate !== normalizedRoot && !normalizedCandidate.startsWith(rootWithSep)) throw new Error(`Asset path escapes package root: ${assetRef}`);
}
export function readPackageManifest(value: unknown): PackageManifest {
  const record = readRecord(value);
  if (!record) throw new Error("Package manifest must be an object.");
  const compatibility = readRecord(record.compatibility);
  return {
    ...record,
    schema: readPackageManifestSchema(record.schema),
    id: readPathSafeId(record.id, "manifest.id"),
    name: readRequiredString(record.name, "manifest.name"),
    motion: readRequiredString(record.motion, "manifest.motion"),
    ...(typeof record.template === "string" ? { template: record.template } : {}),
    assets: Array.isArray(record.assets) ? record.assets.map(String) : [],
    sourceApp: readRequiredString(record.sourceApp, "manifest.sourceApp"),
    compatibility: {
      lanes: Array.isArray(compatibility?.lanes) ? compatibility.lanes.map(String) : [],
      hosts: Array.isArray(compatibility?.hosts) ? compatibility.hosts.map(String) : []
    }
  };
}
export function readTemplateDocument(value: unknown): TemplateDocument {
  const record = readRecord(value);
  if (!record) throw new Error("Template document must be an object.");
  if (!Array.isArray(record.params)) throw new Error("Template document params must be an array.");
  if (!Array.isArray(record.controls)) throw new Error("Template document controls must be an array.");
  if (!Array.isArray(record.bindings)) throw new Error("Template document bindings must be an array.");
  if (!Array.isArray(record.compatibleLanes)) throw new Error("Template document compatibleLanes must be an array.");
  return {
    ...record,
    schema: readTemplateSchema(record.schema),
    id: readRequiredString(record.id, "template.id"),
    name: readRequiredString(record.name, "template.name"),
    motion: readRequiredString(record.motion, "template.motion"),
    compatibleLanes: record.compatibleLanes.map(String),
    ...(Array.isArray(record.compatibleHosts) ? { compatibleHosts: record.compatibleHosts.map(String) } : {}),
    ...(record.metadata !== undefined ? { metadata: readTemplateMetadata(record.metadata) } : {}),
    ...(Array.isArray(record.groups) ? { groups: readRecordArray<NonNullable<TemplateDocument["groups"]>[number]>(record.groups) } : {}),
    params: readRecordArray<TemplateDocument["params"][number]>(record.params),
    controls: readRecordArray<TemplateDocument["controls"][number]>(record.controls),
    bindings: readRecordArray<TemplateDocument["bindings"][number]>(record.bindings)
  };
}

function readTemplateMetadata(value: unknown): TemplateMetadata {
  const record = readRecord(value);
  if (!record) throw new Error("Template metadata must be an object.");
  const metadata: TemplateMetadata = {};
  if (record.inputSchema !== undefined) {
    const inputSchema = readRecord(record.inputSchema);
    if (!inputSchema) throw new Error("template.metadata.inputSchema must be an object.");
    metadata.inputSchema = inputSchema;
  }
  if (record.inputExamples !== undefined) metadata.inputExamples = readTemplateInputExamples(record.inputExamples);
  if (record.outputBounds !== undefined) metadata.outputBounds = readTemplateOutputBounds(record.outputBounds);
  if (record.suitability !== undefined) metadata.suitability = readTemplateSuitability(record.suitability);
  if (record.license !== undefined) metadata.license = readTemplateLicense(record.license);
  if (record.provenance !== undefined) metadata.provenance = readTemplateProvenance(record.provenance);
  if (record.assetsAttribution !== undefined) metadata.assetsAttribution = readTemplateAssetAttributions(record.assetsAttribution);
  if (record.preview !== undefined) metadata.preview = readTemplatePreviewAssets(record.preview);
  if (record.performance !== undefined) metadata.performance = readTemplatePerformance(record.performance);
  if (record.story !== undefined) metadata.story = readTemplateStory(record.story);
  if (record.mediaSlots !== undefined) metadata.mediaSlots = readTemplateMediaSlots(record.mediaSlots);
  if (record.qualityTargets !== undefined) metadata.qualityTargets = readTemplateQualityTargets(record.qualityTargets);
  return metadata;
}

function readTemplateStory(value: unknown): TemplateStory {
  const record = readRecord(value);
  if (!record) throw new Error("template.metadata.story must be an object.");
  if (!Array.isArray(record.beats)) throw new Error("template.metadata.story.beats must be an array.");
  const kind = readOptionalString(record.kind, "template.metadata.story.kind");
  return {
    ...(kind !== undefined ? { kind } : {}),
    beats: record.beats.map((entry, index) => {
      const beat = readRecord(entry);
      if (!beat) throw new Error(`template.metadata.story.beats.${index} must be an object.`);
      const label = readOptionalString(beat.label, `template.metadata.story.beats.${index}.label`);
      const layerIds = readOptionalStringArray(beat.layerIds, `template.metadata.story.beats.${index}.layerIds`);
      const mediaParamIds = readOptionalStringArray(beat.mediaParamIds, `template.metadata.story.beats.${index}.mediaParamIds`);
      const cameraIntent = readOptionalString(beat.cameraIntent, `template.metadata.story.beats.${index}.cameraIntent`);
      return {
        id: readRequiredString(beat.id, `template.metadata.story.beats.${index}.id`),
        ...(label !== undefined ? { label } : {}),
        intent: readRequiredString(beat.intent, `template.metadata.story.beats.${index}.intent`),
        startMs: readRequiredNumber(beat.startMs, `template.metadata.story.beats.${index}.startMs`),
        durationMs: readRequiredNumber(beat.durationMs, `template.metadata.story.beats.${index}.durationMs`),
        ...(layerIds !== undefined ? { layerIds } : {}),
        ...(mediaParamIds !== undefined ? { mediaParamIds } : {}),
        ...(cameraIntent !== undefined ? { cameraIntent } : {})
      };
    })
  };
}

function readTemplateMediaSlots(value: unknown): TemplateMediaSlot[] {
  if (!Array.isArray(value)) throw new Error("template.metadata.mediaSlots must be an array.");
  return value.map((entry, index) => {
    const record = readRecord(entry);
    if (!record) throw new Error(`template.metadata.mediaSlots.${index} must be an object.`);
    if (!Array.isArray(record.acceptedKinds)) throw new Error(`template.metadata.mediaSlots.${index}.acceptedKinds must be an array.`);
    const description = readOptionalString(record.description, `template.metadata.mediaSlots.${index}.description`);
    const fit = readOptionalTemplateMediaFit(record.fit, `template.metadata.mediaSlots.${index}.fit`);
    const minWidth = readOptionalNumber(record.minWidth, `template.metadata.mediaSlots.${index}.minWidth`);
    const minHeight = readOptionalNumber(record.minHeight, `template.metadata.mediaSlots.${index}.minHeight`);
    const minDurationMs = readOptionalNumber(record.minDurationMs, `template.metadata.mediaSlots.${index}.minDurationMs`);
    const maxDurationMs = readOptionalNumber(record.maxDurationMs, `template.metadata.mediaSlots.${index}.maxDurationMs`);
    const rightsRequired = readOptionalBoolean(record.rightsRequired, `template.metadata.mediaSlots.${index}.rightsRequired`);
    return {
      paramId: readRequiredString(record.paramId, `template.metadata.mediaSlots.${index}.paramId`),
      role: readRequiredString(record.role, `template.metadata.mediaSlots.${index}.role`),
      ...(description !== undefined ? { description } : {}),
      acceptedKinds: record.acceptedKinds.map((kind, kindIndex) => readTemplateMediaKind(kind, `template.metadata.mediaSlots.${index}.acceptedKinds.${kindIndex}`)),
      ...(fit !== undefined ? { fit } : {}),
      ...(minWidth !== undefined ? { minWidth } : {}),
      ...(minHeight !== undefined ? { minHeight } : {}),
      ...(minDurationMs !== undefined ? { minDurationMs } : {}),
      ...(maxDurationMs !== undefined ? { maxDurationMs } : {}),
      ...(rightsRequired !== undefined ? { rightsRequired } : {})
    };
  });
}

function readTemplateQualityTargets(value: unknown): TemplateQualityTargets {
  const record = readRecord(value);
  if (!record) throw new Error("template.metadata.qualityTargets must be an object.");
  if (!Array.isArray(record.representativeFramesMs)) {
    throw new Error("template.metadata.qualityTargets.representativeFramesMs must be an array.");
  }
  const minDistinctFrames = readOptionalNumber(record.minDistinctFrames, "template.metadata.qualityTargets.minDistinctFrames");
  const maxBlankFrames = readOptionalNumber(record.maxBlankFrames, "template.metadata.qualityTargets.maxBlankFrames");
  const minEdgePixels = readOptionalNumber(record.minEdgePixels, "template.metadata.qualityTargets.minEdgePixels");
  const minLumaRange = readOptionalNumber(record.minLumaRange, "template.metadata.qualityTargets.minLumaRange");
  const requireTextFit = readOptionalBoolean(record.requireTextFit, "template.metadata.qualityTargets.requireTextFit");
  const requireSafeAreas = readOptionalBoolean(record.requireSafeAreas, "template.metadata.qualityTargets.requireSafeAreas");
  const manifest = readOptionalString(record.manifest, "template.metadata.qualityTargets.manifest");
  return {
    ...(manifest !== undefined ? { manifest } : {}),
    representativeFramesMs: record.representativeFramesMs.map((entry, index) => readRequiredNumber(entry, `template.metadata.qualityTargets.representativeFramesMs.${index}`)),
    ...(minDistinctFrames !== undefined ? { minDistinctFrames } : {}),
    ...(maxBlankFrames !== undefined ? { maxBlankFrames } : {}),
    ...(minEdgePixels !== undefined ? { minEdgePixels } : {}),
    ...(minLumaRange !== undefined ? { minLumaRange } : {}),
    ...(requireTextFit !== undefined ? { requireTextFit } : {}),
    ...(requireSafeAreas !== undefined ? { requireSafeAreas } : {})
  };
}

function readTemplateInputExamples(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("template.metadata.inputExamples must be an array.");
  return value.map((entry, index) => {
    const record = readRecord(entry);
    if (!record) throw new Error(`template.metadata.inputExamples.${index} must be an object.`);
    return record;
  });
}

function readTemplateOutputBounds(value: unknown): TemplateOutputBounds {
  const record = readRecord(value);
  if (!record) throw new Error("template.metadata.outputBounds must be an object.");
  const bounds: TemplateOutputBounds = {};
  const minWidth = readOptionalNumber(record.minWidth, "template.metadata.outputBounds.minWidth");
  const maxWidth = readOptionalNumber(record.maxWidth, "template.metadata.outputBounds.maxWidth");
  const minHeight = readOptionalNumber(record.minHeight, "template.metadata.outputBounds.minHeight");
  const maxHeight = readOptionalNumber(record.maxHeight, "template.metadata.outputBounds.maxHeight");
  const minDurationMs = readOptionalNumber(record.minDurationMs, "template.metadata.outputBounds.minDurationMs");
  const maxDurationMs = readOptionalNumber(record.maxDurationMs, "template.metadata.outputBounds.maxDurationMs");
  const aspectRatios = readOptionalStringArray(record.aspectRatios, "template.metadata.outputBounds.aspectRatios");
  if (minWidth !== undefined) bounds.minWidth = minWidth;
  if (maxWidth !== undefined) bounds.maxWidth = maxWidth;
  if (minHeight !== undefined) bounds.minHeight = minHeight;
  if (maxHeight !== undefined) bounds.maxHeight = maxHeight;
  if (minDurationMs !== undefined) bounds.minDurationMs = minDurationMs;
  if (maxDurationMs !== undefined) bounds.maxDurationMs = maxDurationMs;
  if (aspectRatios !== undefined) bounds.aspectRatios = aspectRatios;
  return bounds;
}

function readTemplateSuitability(value: unknown): TemplateSuitability {
  const record = readRecord(value);
  if (!record) throw new Error("template.metadata.suitability must be an object.");
  const suitability: TemplateSuitability = {};
  const bestFor = readOptionalStringArray(record.bestFor, "template.metadata.suitability.bestFor");
  const notFor = readOptionalStringArray(record.notFor, "template.metadata.suitability.notFor");
  if (bestFor !== undefined) suitability.bestFor = bestFor;
  if (notFor !== undefined) suitability.notFor = notFor;
  return suitability;
}

function readTemplateLicense(value: unknown): TemplateLicense {
  const record = readRecord(value);
  if (!record) throw new Error("template.metadata.license must be an object.");
  const license: TemplateLicense = {
    id: readRequiredString(record.id, "template.metadata.license.id")
  };
  const label = readOptionalString(record.label, "template.metadata.license.label");
  const url = readOptionalString(record.url, "template.metadata.license.url");
  const attribution = readOptionalString(record.attribution, "template.metadata.license.attribution");
  const spdxId = readOptionalString(record.spdxId, "template.metadata.license.spdxId");
  const attributionRequired = readOptionalBoolean(record.attributionRequired, "template.metadata.license.attributionRequired");
  const redistributionAllowed = readOptionalBoolean(record.redistributionAllowed, "template.metadata.license.redistributionAllowed");
  const commercialUse = readOptionalBoolean(record.commercialUse, "template.metadata.license.commercialUse");
  const notes = readOptionalString(record.notes, "template.metadata.license.notes");
  if (label !== undefined) license.label = label;
  if (url !== undefined) license.url = url;
  if (attribution !== undefined) license.attribution = attribution;
  if (spdxId !== undefined) license.spdxId = spdxId;
  if (attributionRequired !== undefined) license.attributionRequired = attributionRequired;
  if (redistributionAllowed !== undefined) license.redistributionAllowed = redistributionAllowed;
  if (commercialUse !== undefined) license.commercialUse = commercialUse;
  if (notes !== undefined) license.notes = notes;
  return license;
}

function readTemplateProvenance(value: unknown): TemplateProvenance {
  const record = readRecord(value);
  if (!record) throw new Error("template.metadata.provenance must be an object.");
  const provenance: TemplateProvenance = {};
  const source = readOptionalString(record.source, "template.metadata.provenance.source");
  const sourceUrl = readOptionalString(record.sourceUrl, "template.metadata.provenance.sourceUrl");
  const sourceHash = readOptionalString(record.sourceHash, "template.metadata.provenance.sourceHash");
  const generatedBy = readOptionalString(record.generatedBy, "template.metadata.provenance.generatedBy");
  if (source !== undefined) provenance.source = source;
  if (sourceUrl !== undefined) provenance.sourceUrl = sourceUrl;
  if (sourceHash !== undefined) provenance.sourceHash = sourceHash;
  if (generatedBy !== undefined) provenance.generatedBy = generatedBy;
  return provenance;
}

function readTemplateAssetAttributions(value: unknown): TemplateAssetAttribution[] {
  if (!Array.isArray(value)) throw new Error("template.metadata.assetsAttribution must be an array.");
  return value.map((entry, index) => {
    const record = readRecord(entry);
    if (!record) throw new Error(`template.metadata.assetsAttribution.${index} must be an object.`);
    const attribution: TemplateAssetAttribution = {
      name: readRequiredString(record.name, `template.metadata.assetsAttribution.${index}.name`)
    };
    const license = readOptionalString(record.license, `template.metadata.assetsAttribution.${index}.license`);
    const author = readOptionalString(record.author, `template.metadata.assetsAttribution.${index}.author`);
    const url = readOptionalString(record.url, `template.metadata.assetsAttribution.${index}.url`);
    const path = readOptionalString(record.path, `template.metadata.assetsAttribution.${index}.path`);
    if (license !== undefined) attribution.license = license;
    if (author !== undefined) attribution.author = author;
    if (url !== undefined) attribution.url = url;
    if (path !== undefined) attribution.path = path;
    return attribution;
  });
}

function readTemplatePreviewAssets(value: unknown): TemplatePreviewAssets {
  const record = readRecord(value);
  if (!record) throw new Error("template.metadata.preview must be an object.");
  const preview: TemplatePreviewAssets = {};
  const poster = readOptionalString(record.poster, "template.metadata.preview.poster");
  const loop = readOptionalString(record.loop, "template.metadata.preview.loop");
  const thumbnail = readOptionalString(record.thumbnail, "template.metadata.preview.thumbnail");
  if (poster !== undefined) preview.poster = poster;
  if (loop !== undefined) preview.loop = loop;
  if (thumbnail !== undefined) preview.thumbnail = thumbnail;
  return preview;
}

function readTemplatePerformance(value: unknown): TemplatePerformance {
  const record = readRecord(value);
  if (!record) throw new Error("template.metadata.performance must be an object.");
  const performance: TemplatePerformance = {};
  const recommendedLane = readOptionalString(record.recommendedLane, "template.metadata.performance.recommendedLane");
  const renderCost = readOptionalRenderCost(record.renderCost, "template.metadata.performance.renderCost");
  const previewFps = readOptionalNumber(record.previewFps, "template.metadata.performance.previewFps");
  const notes = readOptionalStringArray(record.notes, "template.metadata.performance.notes");
  if (recommendedLane !== undefined) performance.recommendedLane = recommendedLane;
  if (renderCost !== undefined) performance.renderCost = renderCost;
  if (previewFps !== undefined) performance.previewFps = previewFps;
  if (notes !== undefined) performance.notes = notes;
  return performance;
}
export function readMotionDocument(value: unknown): MotionDocument {
  const rootProblem = motionDocumentRootPreflight(value); if (rootProblem) throw new Error(`Motion document root is invalid: ${rootProblem.message}`);
  const record = readRecord(value);
  if (!record) throw new Error("Motion document must be an object.");
  const provenance = readRecord(record.provenance);
  if (!provenance) throw new Error("Motion document provenance must be an object.");
  if (!Array.isArray(record.layers)) throw new Error("Motion document layers must be an array.");
  if (record.layers.length > MAX_MOTION_DOCUMENT_LAYERS) {
    throw new Error(`Motion document layers exceed the ${MAX_MOTION_DOCUMENT_LAYERS}-layer admission limit.`);
  }
  const layers = record.layers.map((layer, index) => readMotionLayer(layer, index)); const scene3dAnimation = readMotionScene3DAnimationDocumentRoot(record.scene3dAnimation, { durationMs: record.durationMs, layers });
  const document = {
    ...record,
    schema: readMotionSchema(record.schema),
    id: readRequiredString(record.id, "motion.id"),
    name: readRequiredString(record.name, "motion.name"),
    durationMs: readRequiredNumber(record.durationMs, "motion.durationMs"),
    fps: readRequiredNumber(record.fps, "motion.fps"),
    width: readRequiredNumber(record.width, "motion.width"),
    height: readRequiredNumber(record.height, "motion.height"),
    ...(typeof record.background === "string" ? { background: record.background } : {}),
    layers,
    ...(scene3dAnimation ? { scene3dAnimation } : {}),
    assets: Array.isArray(record.assets) ? record.assets : [],
    provenance: {
      ...provenance,
      sourceApp: readRequiredString(provenance.sourceApp, "motion.provenance.sourceApp"),
      createdBy: readRequiredString(provenance.createdBy, "motion.provenance.createdBy")
    }
  } as MotionDocument;
  const layoutGapAnimation = readMotionLayoutGapAnimationDocumentRoot(record.layoutGapAnimation, document);
  return { ...document, ...(layoutGapAnimation ? { layoutGapAnimation } : {}) };
}

function readMotionLayer(value: unknown, index: number): MotionDocument["layers"][number] {
  const record = readRecord(value);
  if (!record) throw new Error(`Motion layer ${index + 1} must be an object.`);
  return {
    ...record,
    id: readRequiredString(record.id, `motion.layers.${index}.id`),
    type: readRequiredString(record.type, `motion.layers.${index}.type`),
    startMs: readRequiredNumber(record.startMs, `motion.layers.${index}.startMs`),
    durationMs: readRequiredNumber(record.durationMs, `motion.layers.${index}.durationMs`)
  };
}

function readPackageManifestSchema(value: unknown): "shellx-motion/package-manifest@1" {
  if (value !== "shellx-motion/package-manifest@1") throw new Error("Package manifest schema must be shellx-motion/package-manifest@1.");
  return value;
}

function readMotionSchema(value: unknown): "shellx-motion/motion@1" {
  if (value !== "shellx-motion/motion@1") throw new Error("Motion document schema must be shellx-motion/motion@1.");
  return value;
}

function readTemplateSchema(value: unknown): "shellx-motion/template@1" {
  if (value !== "shellx-motion/template@1") throw new Error("Template document schema must be shellx-motion/template@1.");
  return value;
}

function readRequiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${path} must be a non-empty string.`);
  return value;
}

/**
 * A package id that is safe to use as ONE path component.
 *
 * `manifest.id` is not just a label: it is joined onto the frames root
 * (`join(framesRoot, pkg.manifest.id)`), the receipts root and several scratch paths. It therefore
 * requires component-safe validation before any path is constructed.
 *
 * The charset is deliberately narrow -- alphanumerics plus `.`, `_`, `-`, and never leading with a
 * separator. All 34 ids shipped in fixtures and templates already conform, so this rejects attacks
 * without rejecting any real package. Path separators, `..`, NUL, drive letters and absolute forms
 * are all excluded by construction rather than by blocklist.
 */
const SAFE_PACKAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Read an identifier that will be used as a path component, refusing anything that could traverse.
 *
 * @param value The raw manifest field.
 * @param path Dotted field path, for the error message.
 * @returns The validated identifier.
 * @throws Error naming the field when the value is absent, empty, or not a safe single component.
 */
function readPathSafeId(value: unknown, path: string): string {
  const id = readRequiredString(value, path);
  if (!SAFE_PACKAGE_ID.test(id)) {
    throw new Error(
      `${path} must be a single path-safe component matching ${SAFE_PACKAGE_ID.source} — it is used to build ` +
      "frame, receipt and scratch directories, so a value containing a path separator or '..' could redirect " +
      "file operations outside the package."
    );
  }
  return id;
}

function readRequiredNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${path} must be a finite number.`);
  return value;
}

function readOptionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${path} must be a string.`);
  return value;
}

function readOptionalNumber(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  return readRequiredNumber(value, path);
}

function readOptionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${path} must be a boolean.`);
  return value;
}

function readOptionalStringArray(value: unknown, path: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${path} must be an array.`);
  return value.map((entry, index) => {
    if (typeof entry !== "string") throw new Error(`${path}.${index} must be a string.`);
    return entry;
  });
}

function readOptionalRenderCost(value: unknown, path: string): TemplatePerformance["renderCost"] | undefined {
  if (value === undefined) return undefined;
  if (value === "low" || value === "medium" || value === "high") return value;
  throw new Error(`${path} must be low, medium, or high.`);
}

function readTemplateMediaKind(value: unknown, path: string): TemplateMediaSlot["acceptedKinds"][number] {
  if (value === "image" || value === "video") return value;
  throw new Error(`${path} must be image or video.`);
}

function readOptionalTemplateMediaFit(value: unknown, path: string): TemplateMediaSlot["fit"] | undefined {
  if (value === undefined) return undefined;
  if (value === "cover" || value === "contain" || value === "fill") return value;
  throw new Error(`${path} must be cover, contain, or fill.`);
}

export function assertTemplatePackageSemantics(
  template: TemplateDocument,
  motion: MotionDocument,
  packageRoot: string,
  options?: { hasPackageFile?: (path: string) => boolean }
): void {
  const paramsById = new Map(template.params.map((param) => [param.id, param]));
  const layerIds = new Set(motion.layers.map((layer) => layer.id));
  const mediaSlotParamIds = new Set<string>();

  for (const slot of template.metadata?.mediaSlots ?? []) {
    const param = paramsById.get(slot.paramId);
    if (!param || param.type !== "media") {
      throw new Error(`template.metadata.mediaSlots paramId ${slot.paramId} must reference a media param.`);
    }
    if (mediaSlotParamIds.has(slot.paramId)) {
      throw new Error(`template.metadata.mediaSlots contains duplicate paramId ${slot.paramId}.`);
    }
    mediaSlotParamIds.add(slot.paramId);
  }

  const beatIds = new Set<string>();
  for (const beat of template.metadata?.story?.beats ?? []) {
    if (beatIds.has(beat.id)) throw new Error(`template.metadata.story contains duplicate beat id ${beat.id}.`);
    beatIds.add(beat.id);
    if (beat.startMs < 0 || beat.durationMs <= 0 || beat.startMs + beat.durationMs > motion.durationMs) {
      throw new Error(`template.metadata.story beat ${beat.id} must fit within the motion duration.`);
    }
    for (const layerId of beat.layerIds ?? []) {
      if (!layerIds.has(layerId)) throw new Error(`template.metadata.story beat ${beat.id} references unknown layer ${layerId}.`);
    }
    for (const paramId of beat.mediaParamIds ?? []) {
      const param = paramsById.get(paramId);
      if (!param || param.type !== "media") {
        throw new Error(`template.metadata.story beat ${beat.id} mediaParamIds must reference media params.`);
      }
    }
  }

  const quality = template.metadata?.qualityTargets;
  if (quality) {
    if (quality.manifest && (!quality.manifest.startsWith("quality/") || quality.manifest.includes("..") || quality.manifest.startsWith("/"))) {
      throw new Error("template.metadata.qualityTargets.manifest must be a package-local quality/ path.");
    }
    const manifestPath = quality.manifest ? resolvePackageAsset({ root: packageRoot }, quality.manifest) : undefined;
    if (quality.manifest && !(options?.hasPackageFile?.(manifestPath!) ?? existsSync(manifestPath!))) {
      throw new Error(`template.metadata.qualityTargets.manifest does not exist: ${quality.manifest}.`);
    }
    const distinctFrames = new Set(quality.representativeFramesMs);
    if (distinctFrames.size !== quality.representativeFramesMs.length) {
      throw new Error("template.metadata.qualityTargets.representativeFramesMs must be unique.");
    }
    for (const atMs of quality.representativeFramesMs) {
      if (atMs < 0 || atMs >= motion.durationMs) {
        throw new Error("template.metadata.qualityTargets representative frames must occur before the motion end.");
      }
    }
    if (quality.minDistinctFrames !== undefined && quality.minDistinctFrames > distinctFrames.size) {
      throw new Error("template.metadata.qualityTargets.minDistinctFrames cannot exceed representativeFramesMs length.");
    }
  }
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}

function readRecordArray<T>(values: unknown[]): T[] {
  return values.map((value) => ({ ...(readRecord(value) ?? {}) }) as unknown as T);
}

function hashBuffer(buffer: Buffer): string { return createHash("sha256").update(buffer).digest("hex"); }
