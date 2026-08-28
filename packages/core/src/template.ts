import { isImportablePackageAssetRef } from "./package-asset-references";
import type {
  MotionDocument,
  MotionPackage,
  PackageManifest,
  TemplateBinding,
  TemplateControl,
  TemplateControlGroup,
  TemplateMetadata,
  TemplateParam
} from "./types";

export type TemplateValue = string | number | boolean | null;

export interface TemplateControlsResult {
  ok: true;
  packageId: string;
  templateId: string;
  templateName: string;
  compatibleHosts: string[];
  compatibleLanes: string[];
  metadata?: TemplateMetadata;
  groups: TemplateControlGroup[];
  params: TemplateParam[];
  controls: TemplateControl[];
  bindings: TemplateBinding[];
}

export interface TemplateApplyError {
  paramId: string;
  message: string;
}

export interface TemplateChangedBinding {
  paramId: string;
  path: string;
  oldValue: unknown;
  newValue: TemplateValue;
}

export type TemplateApplyResult =
  | {
      ok: true;
      motion: MotionDocument;
      changedParams: string[];
      changedBindings: TemplateChangedBinding[];
      warnings: string[];
    }
  | {
      ok: false;
      errors: TemplateApplyError[];
    };

export interface TemplateMediaReplaceInput {
  paramId: string;
  assetRef: string;
}

export type TemplateMediaReplaceResult =
  | {
      ok: true;
      packageId: string;
      templateId: string;
      paramId: string;
      assetRef: string;
      manifest: PackageManifest;
      motion: MotionDocument;
      changedParams: string[];
      changedBindings: TemplateChangedBinding[];
      manifestAssets: string[];
      warnings: string[];
    }
  | {
      ok: false;
      errors: TemplateApplyError[];
    };

export function listTemplateControls(pkg: MotionPackage): TemplateControlsResult {
  if (!pkg.template) {
    throw new Error("package has no template sidecar");
  }

  return {
    ok: true,
    packageId: pkg.manifest.id,
    templateId: pkg.template.id,
    templateName: pkg.template.name,
    compatibleHosts: pkg.template.compatibleHosts ?? [],
    compatibleLanes: pkg.template.compatibleLanes,
    ...(pkg.template.metadata ? { metadata: pkg.template.metadata } : {}),
    groups: pkg.template.groups ?? [],
    params: pkg.template.params,
    controls: pkg.template.controls,
    bindings: pkg.template.bindings
  };
}

export function applyTemplateValues(pkg: MotionPackage, values: Record<string, TemplateValue>): TemplateApplyResult {
  if (!pkg.template) {
    return { ok: false, errors: [{ paramId: "", message: "package has no template sidecar" }] };
  }

  const paramsById = new Map(pkg.template.params.map((param) => [param.id, param]));
  const errors: TemplateApplyError[] = [];
  const updates: Array<{ param: TemplateParam; value: TemplateValue }> = [];
  for (const [paramId, rawValue] of Object.entries(values)) {
    const param = paramsById.get(paramId);
    if (!param) {
      errors.push({ paramId, message: "unknown template param" });
      continue;
    }
    const coerced = coerceTemplateValue(param, rawValue);
    if (!coerced.ok) {
      errors.push({ paramId, message: coerced.message });
      continue;
    }
    updates.push({ param, value: coerced.value });
  }

  if (errors.length > 0) return { ok: false, errors };

  const motion = structuredClone(pkg.motion);
  const changedParams: string[] = [];
  const changedBindings: TemplateChangedBinding[] = [];
  const warnings: string[] = [];
  for (const update of updates) {
    // Recorded after the bindings are attempted, not before. The push once happened at
    // the top of the loop, so a param whose every binding failed to apply was still reported as
    // changed: `template apply --set title=...` against a binding pointing at a missing layer
    // returned `changedParams: ["title"]`, `changedBindings: []`, and a document still holding the
    // old text. A caller comparing what it asked for against `changedParams` saw complete success.
    // `changedParams` is a claim about the document, so it may only name params the document
    // actually took.
    const bindings = pkg.template.bindings.filter((binding) => binding.paramId === update.param.id);
    const changedBindingsBefore = changedBindings.length;
    if (bindings.length === 0) {
      warnings.push(`Template param ${update.param.id} has no bindings.`);
      continue;
    }
    for (const binding of bindings) {
      if (binding.target.kind !== "motion_path") {
        warnings.push(`Template binding ${update.param.id} target kind ${binding.target.kind} is not applied by core.`);
        continue;
      }
      const applied = applyJsonPointerValue(motion, binding.target.path, update.value);
      if (!applied.ok) {
        warnings.push(`Template binding ${update.param.id} target ${binding.target.path} was not applied: ${applied.message}`);
        continue;
      }
      changedBindings.push({
        paramId: update.param.id,
        path: binding.target.path,
        oldValue: applied.oldValue,
        newValue: update.value
      });
    }
    if (changedBindings.length > changedBindingsBefore) changedParams.push(update.param.id);
  }

  return { ok: true, motion, changedParams, changedBindings, warnings };
}

export function replaceTemplateMedia(pkg: MotionPackage, input: TemplateMediaReplaceInput): TemplateMediaReplaceResult {
  const errors: TemplateApplyError[] = [];
  if (!pkg.template) {
    errors.push({ paramId: input.paramId ?? "", message: "package has no template sidecar" });
  }

  const paramsById = new Map(pkg.template?.params.map((param) => [param.id, param]) ?? []);
  const param = paramsById.get(input.paramId);
  if (!param) {
    errors.push({ paramId: input.paramId, message: "unknown template param" });
  } else if (param.type !== "media") {
    errors.push({ paramId: input.paramId, message: "template param is not a media slot" });
  }

  if (!isImportablePackageAssetRef(input.assetRef)) {
    errors.push({ paramId: input.paramId, message: "assetRef must be a package-local assets/ path" });
  }

  if (errors.length > 0 || !pkg.template || !param || param.type !== "media") return { ok: false, errors };

  const motion = structuredClone(pkg.motion);
  const changedBindings: TemplateChangedBinding[] = [];
  const warnings: string[] = [];
  const bindings = pkg.template.bindings.filter((binding) => binding.paramId === input.paramId);
  if (bindings.length === 0) {
    warnings.push(`Template param ${input.paramId} has no bindings.`);
  }
  for (const binding of bindings) {
    if (binding.target.kind !== "motion_path") {
      warnings.push(`Template binding ${input.paramId} target kind ${binding.target.kind} is not applied by core.`);
      continue;
    }
    const applied = applyJsonPointerValue(motion, binding.target.path, input.assetRef);
    if (!applied.ok) {
      warnings.push(`Template binding ${input.paramId} target ${binding.target.path} was not applied: ${applied.message}`);
      continue;
    }
    changedBindings.push({
      paramId: input.paramId,
      path: binding.target.path,
      oldValue: applied.oldValue,
      newValue: input.assetRef
    });
  }

  const manifestAssets = pkg.manifest.assets.includes(input.assetRef)
    ? [...pkg.manifest.assets]
    : [...pkg.manifest.assets, input.assetRef];
  return {
    ok: true,
    packageId: pkg.manifest.id,
    templateId: pkg.template.id,
    paramId: input.paramId,
    assetRef: input.assetRef,
    manifest: { ...pkg.manifest, assets: manifestAssets },
    motion,
    changedParams: [input.paramId],
    changedBindings,
    manifestAssets,
    warnings
  };
}

function coerceTemplateValue(
  param: TemplateParam,
  value: TemplateValue
): { ok: true; value: TemplateValue } | { ok: false; message: string } {
  if (value === null) return { ok: true, value };

  if (param.type === "number") {
    const numberValue = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
    if (!Number.isFinite(numberValue)) return { ok: false, message: "must be a finite number" };
    if (typeof param.min === "number" && numberValue < param.min) return { ok: false, message: `must be greater than or equal to ${param.min}` };
    if (typeof param.max === "number" && numberValue > param.max) return { ok: false, message: `must be less than or equal to ${param.max}` };
    return { ok: true, value: numberValue };
  }

  if (param.type === "boolean") {
    if (typeof value === "boolean") return { ok: true, value };
    if (typeof value === "string" && value === "true") return { ok: true, value: true };
    if (typeof value === "string" && value === "false") return { ok: true, value: false };
    return { ok: false, message: "must be a boolean" };
  }

  if (param.type === "select") {
    const optionValues = param.options?.map((option) => option.value) ?? [];
    const matchingOption = optionValues.find((optionValue) => optionValue === value || String(optionValue) === String(value));
    if (matchingOption === undefined) return { ok: false, message: "must match one select option value" };
    return { ok: true, value: matchingOption };
  }

  if (param.type === "text" || param.type === "color" || param.type === "media") {
    if (typeof value !== "string") return { ok: false, message: `must be a ${param.type} string` };
    return { ok: true, value };
  }

  return { ok: false, message: "unsupported template param type" };
}

function applyJsonPointerValue(
  document: unknown,
  pointer: string,
  value: TemplateValue
): { ok: true; oldValue: unknown } | { ok: false; message: string } {
  if (!pointer.startsWith("/")) return { ok: false, message: "target path must be a JSON pointer" };

  const parts = pointer.split("/").slice(1).map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
  if (parts.length === 0) return { ok: false, message: "target path must reference a property" };
  const unsafePart = parts.find(isUnsafeJsonPointerSegment);
  if (unsafePart) return { ok: false, message: `target path contains unsafe segment ${unsafePart}` };

  let current = document;
  for (const part of parts.slice(0, -1)) {
    if (typeof current !== "object" || current === null) return { ok: false, message: `cannot traverse ${part}` };
    if (Array.isArray(current)) {
      const index = readArrayIndex(part);
      if (index === null || index >= current.length) return { ok: false, message: `array index ${part} is not present` };
      current = current[index];
    } else {
      if (!Object.prototype.hasOwnProperty.call(current, part)) return { ok: false, message: `property ${part} is not present` };
      current = Reflect.get(current, part);
    }
  }

  if (typeof current !== "object" || current === null) return { ok: false, message: "target parent is not an object or array" };
  const leaf = parts[parts.length - 1] ?? "";
  if (Array.isArray(current)) {
    const index = readArrayIndex(leaf);
    if (index === null || index >= current.length) return { ok: false, message: `array index ${leaf} is not present` };
    const oldValue = current[index];
    current[index] = value;
    return { ok: true, oldValue };
  }

  const oldValue = Reflect.get(current, leaf);
  Reflect.set(current, leaf, value);
  return { ok: true, oldValue };
}

function isUnsafeJsonPointerSegment(value: string): boolean {
  return value === "__proto__" || value === "prototype" || value === "constructor";
}

function readArrayIndex(value: string): number | null {
  if (!/^(0|[1-9]\d*)$/.test(value)) return null;
  return Number(value);
}
