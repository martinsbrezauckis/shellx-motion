/** Read-only template discovery, planning, panel, and controls commands. */
import {
  hashBuffer,
  listTemplateControls,
  type MotionPackage,
  type TemplateValue
} from "@shellx-motion/core";
import { resolve } from "node:path";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import { booleanArg, nonNegativeNumberArg, objectArg, stringArg, stringArrayArg } from "./args.js";

export interface TemplateCatalogTarget {
  host?: string;
  lane?: string;
  aspectRatio?: string;
  durationMs?: number;
  width?: number;
  height?: number;
  commercialUse?: boolean;
}

export interface TemplateCatalogFilters {
  host?: string;
  aspectRatio?: string;
  outputType?: string;
  requiresMedia?: boolean;
  requiresAudio?: boolean;
  commercialUse?: boolean;
  renderCost?: "low" | "medium" | "high";
  designFamily?: string;
}

export interface TemplateCatalogView {
  templateCount: number;
  packageCount: number;
  controlCount: number;
  compatibleTemplateCount?: number;
  filteredTemplateCount?: number;
  target?: TemplateCatalogTarget;
  filters?: TemplateCatalogFilters;
  warnings: string[];
}

export interface TemplatePlanView {
  selectedTemplate: { templateId: string };
  missingRequiredParams: unknown[];
  inputReadiness: { status: unknown; reviewRequired: unknown };
}

export interface TemplatePanelView {
  templateId: string;
  groupCount: number;
  paramCount: number;
  controlCount: number;
  bindingCount: number;
  mediaParamCount: number;
  warnings: string[];
}

export interface TemplateReadServices {
  packageLoader?: (packageRoot: string) => Promise<MotionPackage>;
  templateCatalogBuilder?: (
    roots: string[],
    target?: TemplateCatalogTarget,
    filters?: TemplateCatalogFilters
  ) => Promise<TemplateCatalogView>;
  templatePlanBuilder?: (
    request: string,
    catalog: TemplateCatalogView,
    values?: Record<string, TemplateValue>
  ) => Promise<TemplatePlanView | null>;
  templatePanelBuilder?: (pkg: MotionPackage) => TemplatePanelView;
}

export async function dispatchTemplateReadCommand(
  command: MotionDebugCommand,
  args: unknown,
  services: TemplateReadServices
): Promise<MotionDebugResult | null> {
  if (command === "motion.template.plan") return plan(args, services);
  if (command === "motion.template.catalog") return catalog(args, services);
  if (command === "motion.template.panel") return panel(args, services);
  if (command === "motion.template.controls") return controls(args, services);
  return null;
}

async function plan(args: unknown, services: TemplateReadServices): Promise<MotionDebugResult> {
  const roots = catalogRoots(args);
  const request = stringArg(args, "request") ?? stringArg(args, "prompt");
  const target = catalogTarget(args);
  const values = templateValuesArg(args, "values") ?? {};
  if (roots.length === 0) return invalidArgs("motion.template.plan requires templateRoot, packageRoot, or packageRoots.");
  if (!request) return invalidArgs("motion.template.plan requires request.");
  if (target === false) return invalidArgs("motion.template.plan target width, height, and durationMs must be non-negative finite numbers.");
  if (!services.templateCatalogBuilder || !services.templatePlanBuilder) {
    return capabilityUnavailable("Template catalog planning is unavailable.");
  }
  const builtCatalog = await services.templateCatalogBuilder(roots, target, catalogFilters(args, target));
  const result = await services.templatePlanBuilder(request, builtCatalog, values);
  if (!result) {
    return { ok: false, error: { code: "template_plan_no_match", message: "No compatible Motion templates found." }, warnings: builtCatalog.warnings };
  }
  return {
    ok: true,
    visibleState: {
      panel: "templates",
      operation: "template.plan",
      templateCount: builtCatalog.templateCount,
      compatibleTemplateCount: builtCatalog.compatibleTemplateCount ?? builtCatalog.templateCount,
      selectedTemplateId: result.selectedTemplate.templateId,
      missingRequiredParamCount: result.missingRequiredParams.length,
      inputReadinessStatus: result.inputReadiness.status,
      reviewRequired: result.inputReadiness.reviewRequired,
      ...(builtCatalog.target?.host ? { targetHost: builtCatalog.target.host } : {}),
      ...(builtCatalog.target?.lane ? { targetLane: builtCatalog.target.lane } : {})
    },
    result: { ok: true, ...result },
    warnings: builtCatalog.warnings
  };
}

async function catalog(args: unknown, services: TemplateReadServices): Promise<MotionDebugResult> {
  const roots = catalogRoots(args);
  const target = catalogTarget(args);
  if (roots.length === 0) return invalidArgs("motion.template.catalog requires templateRoot, packageRoot, or packageRoots.");
  if (target === false) return invalidArgs("motion.template.catalog target width, height, and durationMs must be non-negative finite numbers.");
  if (!services.templateCatalogBuilder) return capabilityUnavailable("Template catalog discovery is unavailable.");
  const result = await services.templateCatalogBuilder(roots, target, catalogFilters(args, target));
  return {
    ok: true,
    visibleState: {
      panel: "templates",
      operation: "template.catalog",
      templateCount: result.templateCount,
      packageCount: result.packageCount,
      controlCount: result.controlCount,
      ...(result.filters ? { filterCount: Object.keys(result.filters).length, filteredTemplateCount: result.filteredTemplateCount } : {}),
      ...(result.target ? {
        compatibleTemplateCount: result.compatibleTemplateCount,
        ...(result.target.host ? { targetHost: result.target.host } : {}),
        ...(result.target.lane ? { targetLane: result.target.lane } : {})
      } : {})
    },
    result: { ok: true, ...result },
    warnings: result.warnings
  };
}

async function panel(args: unknown, services: TemplateReadServices): Promise<MotionDebugResult> {
  const packageRoot = stringArg(args, "packageRoot");
  if (!packageRoot) return invalidArgs("motion.template.panel requires packageRoot.");
  if (!services.packageLoader || !services.templatePanelBuilder) return capabilityUnavailable("Template panel reading is unavailable.");
  const pkg = await services.packageLoader(packageRoot);
  const result = services.templatePanelBuilder(pkg);
  const receiptId = `template-panel-${pkg.manifest.id}-${hashBuffer(Buffer.from(JSON.stringify(result), "utf8")).slice(0, 16)}`;
  return {
    ok: true,
    receiptId,
    visibleState: {
      panel: "templateInspector",
      operation: "template.panel",
      packageId: pkg.manifest.id,
      templateId: result.templateId,
      groupCount: result.groupCount,
      paramCount: result.paramCount,
      controlCount: result.controlCount,
      bindingCount: result.bindingCount,
      mediaParamCount: result.mediaParamCount
    },
    result: { ok: true, ...result },
    warnings: result.warnings
  };
}

async function controls(args: unknown, services: TemplateReadServices): Promise<MotionDebugResult> {
  const packageRoot = stringArg(args, "packageRoot");
  if (!packageRoot) return invalidArgs("motion.template.controls requires packageRoot.");
  if (!services.packageLoader) return capabilityUnavailable("Template controls reading is unavailable.");
  return { ok: true, result: listTemplateControls(await services.packageLoader(packageRoot)), warnings: [] };
}

function catalogRoots(args: unknown): string[] {
  const roots = [
    ...(stringArrayArg(args, "packageRoots") ?? []),
    stringArg(args, "packageRoot"), stringArg(args, "templateRoot"),
    stringArg(args, "templatesRoot"), stringArg(args, "root")
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  return [...new Set(roots.map((root) => resolve(root)))];
}

function catalogTarget(args: unknown): TemplateCatalogTarget | false | undefined {
  const host = stringArg(args, "targetHost") ?? stringArg(args, "host") ?? undefined;
  const lane = stringArg(args, "targetLane") ?? stringArg(args, "lane") ?? undefined;
  const durationMs = nonNegativeNumberArg(args, "durationMs") ?? nonNegativeNumberArg(args, "targetDurationMs");
  const width = nonNegativeNumberArg(args, "width") ?? nonNegativeNumberArg(args, "targetWidth");
  const height = nonNegativeNumberArg(args, "height") ?? nonNegativeNumberArg(args, "targetHeight");
  const commercialUse = booleanArg(args, "targetCommercialUse") ?? booleanArg(args, "commercialUse");
  if (durationMs === false || width === false || height === false) return false;
  const aspectRatio = stringArg(args, "aspectRatio") ?? stringArg(args, "targetAspectRatio")
    ?? (typeof width === "number" && typeof height === "number" && width > 0 && height > 0 ? aspectRatioFromDimensions(width, height) : undefined);
  const target: TemplateCatalogTarget = {
    ...(host ? { host } : {}), ...(lane ? { lane } : {}), ...(aspectRatio ? { aspectRatio } : {}),
    ...(durationMs !== null ? { durationMs } : {}), ...(width !== null ? { width } : {}),
    ...(height !== null ? { height } : {}), ...(commercialUse !== null ? { commercialUse } : {})
  };
  return Object.keys(target).length > 0 ? target : undefined;
}

function catalogFilters(args: unknown, target?: TemplateCatalogTarget): TemplateCatalogFilters | undefined {
  const renderCostArg = stringArg(args, "renderCost");
  const renderCost = renderCostArg === "low" || renderCostArg === "medium" || renderCostArg === "high" ? renderCostArg : undefined;
  const outputType = stringArg(args, "outputType");
  const requiresMedia = booleanArg(args, "requiresMedia");
  const requiresAudio = booleanArg(args, "requiresAudio");
  const designFamily = stringArg(args, "designFamily");
  const filters: TemplateCatalogFilters = {
    ...(target?.host ? { host: target.host } : {}), ...(target?.aspectRatio ? { aspectRatio: target.aspectRatio } : {}),
    ...(outputType ? { outputType } : {}), ...(requiresMedia !== null ? { requiresMedia } : {}),
    ...(requiresAudio !== null ? { requiresAudio } : {}),
    ...(target?.commercialUse !== undefined ? { commercialUse: target.commercialUse } : {}),
    ...(renderCost ? { renderCost } : {}), ...(designFamily ? { designFamily } : {})
  };
  return Object.keys(filters).length > 0 ? filters : undefined;
}

function templateValuesArg(args: unknown, key: string): Record<string, TemplateValue> | null {
  const record = objectArg(args);
  const raw = record && Object.hasOwn(record, key) ? objectArg(record[key]) : null;
  if (!raw) return null;
  const values: Record<string, TemplateValue> = {};
  for (const [paramId, value] of Object.entries(raw)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) values[paramId] = value;
  }
  return values;
}

function aspectRatioFromDimensions(width: number, height: number): string {
  let left = Math.trunc(Math.abs(width));
  let right = Math.trunc(Math.abs(height));
  while (right !== 0) [left, right] = [right, left % right];
  return `${width / left}:${height / left}`;
}

function invalidArgs(message: string): MotionDebugResult {
  return { ok: false, error: { code: "invalid_args", message }, warnings: [] };
}

function capabilityUnavailable(message: string): MotionDebugResult {
  return { ok: false, error: { code: "capability_unavailable", message, suggestedAction: "Configure the required host capability and retry." }, warnings: [] };
}
