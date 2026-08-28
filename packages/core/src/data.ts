import { canonicalJson } from "./canonical-json";
import { assertReadableLayerKeyframes } from "./keyframe-readability";
import { resolvePackageAsset } from "./package";
import { hashBuffer } from "./receipts";
import { applyMotionRowTemplateValues } from "./data-template-bindings";
import {
  assertBoundedMotionDataRowCount,
  MAX_BATCH_QUALITY_ROWS,
  readMotionDataRowsText
} from "./data-file-load";
import {
  assertBoundedMotionDataRowId,
  assertBoundedMotionDataRowValue,
  assertSafeMotionDataRowKey,
  MotionDataExpansionBudget
} from "./data-resource-bounds";
import { parseBoundedMotionDataRowsCsvRecords } from "./data-csv";
import { interpolateMotionDataJson, interpolateMotionDataString } from "./data-interpolation";
import { assertBoundedMotionDataRowsJsonText } from "./data-json-row-scan";
import { applyChartCompositionRecipe } from "./chart-composition-recipe";
import type { MotionDocument, MotionLayer, MotionPackage, PackageManifest } from "./types";
export {
  MAX_BATCH_QUALITY_ROWS,
  MAX_MOTION_DATA_ROWS_BYTES,
  MAX_MOTION_DATA_ROW_BYTES,
  MAX_MOTION_DATA_ROW_FIELD_BYTES,
  MAX_MOTION_DATA_ROW_FIELDS,
  MAX_MOTION_DATA_ROW_ID_BYTES,
  MAX_MOTION_DATA_ROW_NESTING,
  MAX_MOTION_DATA_ROW_VALUES,
  MAX_MOTION_INTERPOLATED_BATCH_BYTES,
  MAX_MOTION_INTERPOLATED_DOCUMENT_BYTES,
  MAX_MOTION_INTERPOLATED_ROW_BYTES,
  MAX_MOTION_INTERPOLATED_STRING_BYTES
} from "./data-file-load";
export interface MotionDataRow {
  id: string;
  index: number;
  values: Record<string, unknown>;
  hash: string;
  key: string;
}

export interface ExpandedMotionJob {
  row: MotionDataRow;
  manifest: PackageManifest;
  motion: MotionDocument;
}

export type MotionDataRowFilterResult =
  | { ok: true; rows: MotionDataRow[]; requestedRowIds: string[] }
  | { ok: false; requestedRowIds: string[]; missingRowIds: string[]; message: string };
export async function loadPackageDataRows(pkg: MotionPackage, ref?: string): Promise<MotionDataRow[]> {
  const rowsRef = ref ?? manifestRowsRef(pkg.manifest);
  if (!rowsRef) {
    throw new Error("Motion package has no data.rows ref; pass --rows or add manifest.data.rows.");
  }
  const rowsPath = resolvePackageAsset(pkg, rowsRef);
  return loadDataRowsFile(rowsPath, { withinRoot: pkg.root });
}

export async function loadDataRowsFile(rowsPath: string, options: { withinRoot?: string } = {}): Promise<MotionDataRow[]> {
  return parseMotionDataRowsText(await readMotionDataRowsText(rowsPath, options.withinRoot));
}

export function parseMotionDataRowsText(input: string): MotionDataRow[] {
  const text = input.replace(/^\uFEFF/, "").trimStart();
  if (text.startsWith("{") || text.startsWith("[")) {
    assertBoundedMotionDataRowsJsonText(text);
    return parseMotionDataRows(JSON.parse(text));
  }
  return parseMotionDataRowsCsv(input);
}

export function parseMotionDataRowsCsv(input: string): MotionDataRow[] {
  const records = parseBoundedMotionDataRowsCsvRecords(input.replace(/^\uFEFF/, ""));
  if (records.length === 0) throw new Error("Motion CSV data rows must include a header row.");
  assertBoundedMotionDataRowCount(records.length - 1);
  const headers = records[0].map((header, index) => {
    const key = header.trim();
    if (!key) throw new Error(`Motion CSV data row header ${index + 1} must be non-empty.`);
    assertSafeMotionDataRowKey(key, `header ${index + 1}`);
    return key;
  });
  const rows = records.slice(1).map((record, index) => {
    if (record.length > headers.length && record.slice(headers.length).some((field) => field.length > 0)) {
      throw new Error(`Motion CSV data row ${index + 1} has more fields than headers.`);
    }
    return Object.fromEntries(headers.map((header, headerIndex) => [header, record[headerIndex] ?? ""]));
  });
  return parseMotionDataRows(rows);
}

export function parseMotionDataRows(input: unknown): MotionDataRow[] {
  const rowsRecord = readRecord(input);
  const rowsInput = Array.isArray(input)
    ? input
    : rowsRecord && Array.isArray(rowsRecord.rows)
      ? rowsRecord.rows
      : null;
  if (!rowsInput) throw new Error("Motion data rows must be an array or { rows: [...] }.");
  if (rowsInput.length === 0) throw new Error("Motion data rows must include at least one row.");
  assertBoundedMotionDataRowCount(rowsInput.length);
  const seenIds = new Set<string>();
  return rowsInput.map((entry, index) => {
    assertBoundedMotionDataRowValue(entry, index);
    const entryRecord = readRecord(entry);
    if (!entryRecord) throw new Error(`Motion data row ${index + 1} must be an object.`);
    const values = { ...entryRecord };
    const rawId = String(values.id ?? `row-${index + 1}`);
    assertBoundedMotionDataRowId(rawId, index);
    const id = slugId(rawId);
    assertBoundedMotionDataRowId(id, index);
    if (seenIds.has(id)) {
      throw new Error(`Motion data row IDs must be unique after sanitization; duplicate id: ${id}.`);
    }
    seenIds.add(id);
    // Canonical JSON, not JSON.stringify: the row hash is an identity that must be reproducible on
    // any machine, so it may depend on the row's VALUES and never on the key order the CSV/JSON
    // author happened to use, nor on the ambient locale used to sort those keys.
    const hash = hashBuffer(Buffer.from(canonicalJson(values), "utf8"));
    return {
      id,
      index,
      values,
      hash,
      key: `${id}-${hash.slice(0, 16)}`
    };
  });
}

export function filterMotionDataRows(rows: MotionDataRow[], requestedRowIds: string[]): MotionDataRowFilterResult {
  const normalizedRequestedRowIds = uniqueStrings(requestedRowIds.map((id) => slugId(id)).filter(Boolean));
  if (normalizedRequestedRowIds.length === 0) {
    return { ok: true, rows, requestedRowIds: [] };
  }

  const availableRowIds = new Set(rows.map((row) => row.id));
  const missingRowIds = normalizedRequestedRowIds.filter((id) => !availableRowIds.has(id));
  if (missingRowIds.length > 0) {
    return {
      ok: false,
      requestedRowIds: normalizedRequestedRowIds,
      missingRowIds,
      message: `Motion data row IDs not found: ${missingRowIds.join(", ")}.`
    };
  }

  const selectedRowIds = new Set(normalizedRequestedRowIds);
  return {
    ok: true,
    rows: rows.filter((row) => selectedRowIds.has(row.id)),
    requestedRowIds: normalizedRequestedRowIds
  };
}

export function expandMotionPackageRows(pkg: MotionPackage, rows: MotionDataRow[]): ExpandedMotionJob[] {
  const budget = new MotionDataExpansionBudget();
  return rows.map((row) => {
    const manifestId = `${pkg.manifest.id}_${row.id}`;
    const motionId = `${pkg.motion.id}_${row.id}`;
    const replacements = readRowReplacementMaps(row.values);
    const manifest: PackageManifest = {
      ...pkg.manifest,
      id: manifestId,
      name: interpolateMotionDataString(pkg.manifest.name, row.values, row.id, "manifest.name"),
      motion: "motion.json",
      assets: mergeAssetRefs(pkg.manifest.assets ?? [], rowMediaReplacementAssetRefs(replacements)),
      workflow: String(pkg.manifest.workflow ?? "batch-render")
    };
    // Expansion order: tokens, template bindings, replacements, patches, overrides, family materialization.
    const interpolated = motionDocumentFromInterpolated(interpolateMotionDataJson(pkg.motion, row.values, row.id, "motion"));
    // The first document charge happens before template, replacement, patch, or recipe fan-out.
    budget.assertDocument(interpolated, row.id);
    const templateApplied = applyMotionRowTemplateValues(pkg, interpolated, row.values, row.id);
    const overridden = applyMotionRowOverrides(
      applyMotionRowLayerPatches(
        applyMotionRowReplacements(templateApplied, replacements),
        row.values,
        row.id
      ),
      row.values
    );
    const motion = applyChartCompositionRecipe(overridden, row.values, row.id);
    const provenanceRecord = readRecord(motion.provenance) ?? {};
    const expanded: ExpandedMotionJob = {
      row,
      manifest,
      motion: {
        ...motion,
        id: motionId,
        name: interpolateMotionDataString(pkg.motion.name, row.values, row.id, "motion.name"),
        provenance: {
          ...provenanceRecord,
          sourceApp: readRequiredString(provenanceRecord.sourceApp, "motion.provenance.sourceApp"),
          createdBy: readRequiredString(provenanceRecord.createdBy, "motion.provenance.createdBy"),
          workflow: String(provenanceRecord.workflow ?? "batch-render"),
          dataRowId: row.id,
          dataRowKey: row.key,
          dataRowHash: row.hash
        }
      }
    };
    // Reserve the final serialized row before the CLI or Debug API can fan it out into packages,
    // receipts, render plans, or Debug responses.
    budget.reserveRow({ manifest: expanded.manifest, motion: expanded.motion }, row.id);
    return expanded;
  });
}

interface RowReplacementMaps {
  text: Record<string, string>;
  media: Record<string, string>;
}

function readRowReplacementMaps(row: Record<string, unknown>): RowReplacementMaps {
  const replace = readRecord(row.replace);
  return {
    text: {
      ...readStringMap(readRecord(replace?.text)),
      ...readFlatStringMap(row, "replace.text.")
    },
    media: {
      ...readStringMap(readRecord(replace?.media)),
      ...readFlatStringMap(row, "replace.media.")
    }
  };
}

function applyMotionRowReplacements(motion: MotionDocument, replacements: RowReplacementMaps): MotionDocument {
  if (Object.keys(replacements.text).length === 0 && Object.keys(replacements.media).length === 0) return motion;
  return {
    ...motion,
    layers: motion.layers.map((layer) => {
      const text = replacements.text[layer.id];
      const media = replacements.media[layer.id];
      return {
        ...layer,
        ...(text !== undefined && layer.type === "text" ? { text } : {}),
        ...(media !== undefined && isMediaLayer(layer) ? { source: media, assetRef: media, src: media } : {})
      };
    })
  };
}

/**
 * Per-layer override patches carried by a data row under `layers`.
 *
 * Shape: `{ "<layerId>": { ...partial layer fields } }`. Each patch deep-merges into the layer whose
 * `id` matches the key — plain objects merge key-by-key (so `{ "transform": { "x": 72 } }` keeps the
 * base `transform.y`), while numbers, strings, arrays and `null` replace outright.
 *
 * Why this exists: without it, a package can only vary per row by carrying `{{token}}` placeholders,
 * which makes the shipped `motion.json` un-renderable on its own — `render <package>` paints raw
 * mustaches. With row patches, a package ships a LITERAL, fully-designed document and each row
 * carries only its diff (copy, palette, chart geometry, or a whole alternate layout for a different
 * canvas size). `templates/shellx-product-pack/product-metric-card` is the reference user.
 *
 * Fails loud on an unknown layer id, a non-object patch, or a patch that tries to rename a layer.
 * A silently-ignored patch is the same class of defect as a token that expands to an empty string:
 * the document still looks valid while the thing the author asked for never happened.
 *
 * It also fails loud on a patched keyframe track the evaluator cannot read. A track is an array, so
 * it REPLACES rather than merges (see `mergeJsonRecords`) — the row's array becomes the whole track,
 * unchecked. A row that writes `{ t, v }` therefore replaced a working track with keyframes that
 * animate nothing, and nothing looked at it: expansion has no schema step, and the render lane's
 * readability gate (ca8ee4c) fires far downstream, in a message about a layer in a generated
 * document with no way back to the row that wrote it. The refusal here names the row.
 *
 * @param motion the expanded document, after token interpolation and `replace.*` maps.
 * @param row the raw row values.
 * @param rowId the row's id, so a refusal names the row an author has to go and fix.
 * @returns a new document with the patched layers, or `motion` unchanged when the row has no patches.
 * @throws when a patch targets an unknown layer, is not an object, carries an `id` key, or leaves a
 *         keyframe the timeline evaluator cannot read.
 */
function applyMotionRowLayerPatches(motion: MotionDocument, row: Record<string, unknown>, rowId: string): MotionDocument {
  const patches = readRecord(row.layers);
  if (!patches || Object.keys(patches).length === 0) return motion;

  const knownLayerIds = motion.layers.map((layer) => layer.id);
  const unknownLayerIds = Object.keys(patches).filter((layerId) => !knownLayerIds.includes(layerId));
  if (unknownLayerIds.length > 0) {
    throw new Error(
      `Motion data row layer patches target unknown layer id(s): ${unknownLayerIds.join(", ")}. ` +
        `Known layer ids: ${knownLayerIds.join(", ")}.`
    );
  }

  return {
    ...motion,
    layers: motion.layers.map((layer, index) => {
      if (!Object.prototype.hasOwnProperty.call(patches, layer.id)) return layer;
      const patch = readRecord(patches[layer.id]);
      if (!patch) throw new Error(`Motion data row layer patch for ${layer.id} must be an object.`);
      if (Object.prototype.hasOwnProperty.call(patch, "id")) {
        throw new Error(`Motion data row layer patch for ${layer.id} must not change the layer id.`);
      }
      // Re-run the interpolated-layer guard so a patch cannot smuggle in a non-numeric startMs or a
      // missing type that the renderer would only discover mid-render.
      const patched = motionLayerFromInterpolated(mergeJsonRecords({ ...layer }, patch), index);
      // Same guard for the keyframe tracks this patch just replaced wholesale, and ONLY those: a
      // pre-existing defect elsewhere in the base document is the read gate's business, and refusing
      // a row for something the row did not write would be a check firing on good input. The shared
      // predicate, so a row cannot author a keyframe shape that validate and the lanes would refuse.
      assertReadableLayerKeyframes(
        { ...patched, keyframes: patchedKeyframeTracks(patched, patch) },
        index,
        `Motion data row ${rowId} layer patch for ${layer.id}`
      );
      return patched;
    })
  };
}

/**
 * The keyframe tracks a row patch actually wrote, taken from the merged layer.
 *
 * Read off the PATCHED layer rather than the patch, so the values checked are the ones that will
 * ship — token interpolation has already run over them by this point.
 *
 * @param patched the layer after the patch was merged in.
 * @param patch the row's raw patch object.
 * @returns a keyframe map holding only the targets the patch named, empty when it named none.
 */
function patchedKeyframeTracks(patched: MotionLayer, patch: Record<string, unknown>): MotionLayer["keyframes"] {
  const patchedTargets = readRecord(patch.keyframes);
  if (!patchedTargets) return {};
  const tracks: Record<string, unknown> = {};
  for (const target of Object.keys(patchedTargets)) {
    const track = (patched.keyframes as Record<string, unknown> | undefined)?.[target];
    if (track !== undefined) tracks[target] = track;
  }
  return tracks as MotionLayer["keyframes"];
}

/**
 * Recursive merge used by row layer patches. Plain objects merge; every other value replaces.
 * Arrays replace rather than concatenate so a patched `keyframes` track is the whole new track.
 */
function mergeJsonRecords(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const baseRecord = readRecord(merged[key]);
    const patchRecord = readRecord(value);
    merged[key] = baseRecord && patchRecord ? mergeJsonRecords(baseRecord, patchRecord) : value;
  }
  return merged;
}

function readStringMap(record: Record<string, unknown> | null): Record<string, string> {
  if (!record) return {};
  return Object.fromEntries(Object.entries(record).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function readFlatStringMap(row: Record<string, unknown>, prefix: string): Record<string, string> {
  return Object.fromEntries(Object.entries(row)
    .filter((entry): entry is [string, string] => entry[0].startsWith(prefix) && typeof entry[1] === "string")
    .map(([key, value]) => [key.slice(prefix.length), value]));
}

function rowMediaReplacementAssetRefs(replacements: RowReplacementMaps): string[] {
  return Object.values(replacements.media).filter(isPackageLocalAssetRef);
}

function mergeAssetRefs(existing: string[], extra: string[]): string[] {
  const assets = [...existing];
  for (const assetRef of extra) {
    if (!assets.includes(assetRef)) assets.push(assetRef);
  }
  return assets;
}

function isPackageLocalAssetRef(value: string): boolean {
  return !value.startsWith("/") && !/^[a-z][a-z0-9+.-]*:/i.test(value);
}

function isMediaLayer(layer: MotionLayer): boolean {
  return layer.type === "image" || layer.type === "video" || layer.type === "audio";
}

function manifestRowsRef(manifest: PackageManifest): string | null {
  const data = readRecord(manifest.data);
  return typeof data?.rows === "string" ? data.rows : null;
}

function applyMotionRowOverrides(motion: MotionDocument, row: Record<string, unknown>): MotionDocument {
  const overrides = readRecord(row.motion);
  if (!overrides) return motion;
  return {
    ...motion,
    ...(overrides.name !== undefined ? { name: readRequiredString(overrides.name, "row.motion.name") } : {}),
    ...(overrides.durationMs !== undefined ? { durationMs: readRequiredNumber(overrides.durationMs, "row.motion.durationMs") } : {}),
    ...(overrides.fps !== undefined ? { fps: readRequiredNumber(overrides.fps, "row.motion.fps") } : {}),
    ...(overrides.width !== undefined ? { width: readRequiredNumber(overrides.width, "row.motion.width") } : {}),
    ...(overrides.height !== undefined ? { height: readRequiredNumber(overrides.height, "row.motion.height") } : {}),
    ...(overrides.background !== undefined ? { background: readRequiredString(overrides.background, "row.motion.background") } : {})
  };
}

function slugId(value: string): string {
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return slug || "row";
}

function uniqueStrings(values: string[]): string[] { return [...new Set(values)]; }

function motionDocumentFromInterpolated(value: unknown): MotionDocument {
  const record = readRecord(value);
  if (!record) throw new Error("Interpolated Motion document must be an object.");
  const provenance = readRecord(record.provenance);
  if (!provenance) throw new Error("Interpolated Motion document provenance must be an object.");
  if (!Array.isArray(record.layers)) throw new Error("Interpolated Motion document layers must be an array.");
  return {
    ...record,
    schema: readMotionSchema(record.schema),
    id: readRequiredString(record.id, "motion.id"),
    name: readRequiredString(record.name, "motion.name"),
    durationMs: readRequiredNumber(record.durationMs, "motion.durationMs"),
    fps: readRequiredNumber(record.fps, "motion.fps"),
    width: readRequiredNumber(record.width, "motion.width"),
    height: readRequiredNumber(record.height, "motion.height"),
    ...(typeof record.background === "string" ? { background: record.background } : {}),
    layers: record.layers.map((layer, index) => motionLayerFromInterpolated(layer, index)),
    assets: Array.isArray(record.assets) ? record.assets : [],
    provenance: {
      ...provenance,
      sourceApp: readRequiredString(provenance.sourceApp, "motion.provenance.sourceApp"),
      createdBy: readRequiredString(provenance.createdBy, "motion.provenance.createdBy")
    }
  };
}

function motionLayerFromInterpolated(value: unknown, index: number): MotionLayer {
  const record = readRecord(value);
  if (!record) throw new Error(`Interpolated Motion layer ${index + 1} must be an object.`);
  return {
    ...record,
    id: readRequiredString(record.id, `motion.layers.${index}.id`),
    type: readRequiredString(record.type, `motion.layers.${index}.type`),
    startMs: readRequiredNumber(record.startMs, `motion.layers.${index}.startMs`),
    durationMs: readRequiredNumber(record.durationMs, `motion.layers.${index}.durationMs`)
  };
}

function readMotionSchema(value: unknown): "shellx-motion/motion@1" {
  if (value !== "shellx-motion/motion@1") throw new Error("Interpolated Motion document schema must be shellx-motion/motion@1.");
  return value;
}

function readRequiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Interpolated ${path} must be a non-empty string.`);
  return value;
}

function readRequiredNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Interpolated ${path} must be a finite number.`);
  return value;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}
