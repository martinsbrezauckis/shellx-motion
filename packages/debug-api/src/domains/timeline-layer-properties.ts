/** Layer property mutations backed by the shared atomic package-edit executor. */
import {
  setTimelineLayerBlendMode,
  setTimelineLayerCrop,
  setTimelineLayerEffect,
  setTimelineLayerFit,
  setTimelineLayerLock,
  setTimelineLayerMask,
  setTimelineLayerMediaSource,
  setTimelineLayerName,
  setTimelineLayerRichControl,
  setTimelineLayerStyle,
  setTimelineLayerText,
  setTimelineLayerTransform,
  setTimelineLayerVisibility,
  type MotionDocument,
  type MotionLayer
} from "@shellx-motion/core";
import type { MotionDebugCommand, MotionDebugResult } from "../command-registry.js";
import { booleanArg, objectArg, stringArg } from "./args.js";
import {
  commitAtomicTimelineMutation,
  isTimelineCommonEditResult,
  readTimelineCommonEditArgs,
  type TimelineCommonEditArgs,
  type TimelinePackageEditServices
} from "./timeline-package-edit.js";

export interface TimelineLayerPropertiesServices extends TimelinePackageEditServices {}

type SetterResult = {
  motion: MotionDocument;
  changedPaths: string[];
  action: string;
  layerId: string;
  layer: MotionLayer;
  property?: string;
  oldValue?: unknown;
  newValue?: unknown;
  oldText?: string | null;
  newText?: string;
  oldBlendMode?: unknown;
  newBlendMode?: unknown;
  oldCrop?: unknown;
  newCrop?: unknown;
  oldMask?: unknown;
  newMask?: unknown;
  oldFit?: unknown;
  newFit?: unknown;
  oldSource?: unknown;
  newSource?: unknown;
  oldName?: unknown;
  newName?: unknown;
  oldVisible?: boolean;
  newVisible?: boolean;
  oldLocked?: boolean;
  newLocked?: boolean;
};

export async function dispatchTimelineLayerPropertiesCommand(
  command: MotionDebugCommand,
  args: unknown,
  services: TimelineLayerPropertiesServices
): Promise<MotionDebugResult | null> {
  if (command === "motion.timeline.layer.text.set") return setText(args, services);
  if (command === "motion.timeline.layer.style.set") return setStyle(args, services);
  if (command === "motion.timeline.layer.transform.set") return setTransform(args, services);
  if (command === "motion.timeline.layer.effect.set") return setEffect(args, services);
  if (command === "motion.timeline.layer.rich.set") return setRich(args, services);
  if (command === "motion.timeline.layer.blend.set") return setBlend(args, services);
  if (command === "motion.timeline.layer.crop.set") return setCrop(args, services);
  if (command === "motion.timeline.layer.mask.set") return setMask(args, services);
  if (command === "motion.timeline.layer.fit.set") return setFit(args, services);
  if (command === "motion.timeline.layer.media.set") return setMedia(args, services);
  if (command === "motion.timeline.layer.name.set") return setName(args, services);
  if (command === "motion.timeline.layer.visibility.set") return setVisibility(args, services);
  if (command === "motion.timeline.layer.lock") return setLock(args, services);
  return null;
}

async function setText(args: unknown, services: TimelineLayerPropertiesServices): Promise<MotionDebugResult> {
  const base = baseArgs("motion.timeline.layer.text.set", args, services);
  if (isResult(base)) return base;
  const text = stringArg(args, "text") ?? stringArg(args, "value");
  if (text === null) return invalidArgs("motion.timeline.layer.text.set requires text.");
  return execute(base, {
    command: "motion.timeline.layer.text.set",
    receiptPrefix: "timeline-layer-text-set",
    invalidCode: "timeline_layer_text_set_invalid",
    failureCode: "timeline_layer_text_set_failed",
    mutate: (motion) => setTimelineLayerText(motion, { layerId: base.layerId, text }),
    facts: (set) => ({ layerId: set.layerId, oldText: set.oldText, newText: set.newText, changedPaths: set.changedPaths, action: set.action, layer: set.layer }),
    visible: (set) => ({ layerId: set.layerId, action: set.action, oldText: set.oldText, newText: set.newText, changedPaths: set.changedPaths })
  }, services);
}

async function setStyle(args: unknown, services: TimelineLayerPropertiesServices): Promise<MotionDebugResult> {
  return propertySetter("motion.timeline.layer.style.set", args, services, {
    aliases: ["styleProperty", "style"], valueAlias: "styleValue", receiptPrefix: "timeline-layer-style-set",
    invalidCode: "timeline_layer_style_set_invalid", failureCode: "timeline_layer_style_set_failed",
    mutate: setTimelineLayerStyle
  });
}

async function setTransform(args: unknown, services: TimelineLayerPropertiesServices): Promise<MotionDebugResult> {
  return propertySetter("motion.timeline.layer.transform.set", args, services, {
    aliases: ["transformProperty", "transform"], valueAlias: "transformValue", receiptPrefix: "timeline-layer-transform-set",
    invalidCode: "timeline_layer_transform_set_invalid", failureCode: "timeline_layer_transform_set_failed",
    mutate: setTimelineLayerTransform
  });
}

async function setEffect(args: unknown, services: TimelineLayerPropertiesServices): Promise<MotionDebugResult> {
  return propertySetter("motion.timeline.layer.effect.set", args, services, {
    aliases: ["effectProperty", "effect"], valueAlias: "effectValue", receiptPrefix: "timeline-layer-effect-set",
    invalidCode: "timeline_layer_effect_set_invalid", failureCode: "timeline_layer_effect_set_failed",
    mutate: setTimelineLayerEffect
  });
}

async function setRich(args: unknown, services: TimelineLayerPropertiesServices): Promise<MotionDebugResult> {
  return propertySetter("motion.timeline.layer.rich.set", args, services, {
    aliases: ["richPath", "path"], valueAlias: "richValue", receiptPrefix: "timeline-layer-rich-set",
    invalidCode: "timeline_layer_rich_set_invalid", failureCode: "timeline_layer_rich_set_failed",
    mutate: (motion, input) => setTimelineLayerRichControl(motion, { layerId: input.layerId, path: input.property, value: input.value })
  });
}

async function setBlend(args: unknown, services: TimelineLayerPropertiesServices): Promise<MotionDebugResult> {
  const base = baseArgs("motion.timeline.layer.blend.set", args, services);
  if (isResult(base)) return base;
  const blendMode = stringArg(args, "blendMode") ?? stringArg(args, "mode") ?? stringArg(args, "value");
  if (!blendMode) return invalidArgs("motion.timeline.layer.blend.set requires blendMode.");
  return execute(base, {
    command: "motion.timeline.layer.blend.set", receiptPrefix: "timeline-layer-blend-set",
    invalidCode: "timeline_layer_blend_set_invalid", failureCode: "timeline_layer_blend_set_failed",
    mutate: (motion) => setTimelineLayerBlendMode(motion, { layerId: base.layerId, blendMode }),
    facts: (set) => ({ layerId: set.layerId, oldBlendMode: set.oldBlendMode, newBlendMode: set.newBlendMode, changedPaths: set.changedPaths, action: set.action, layer: set.layer }),
    visible: (set) => ({ layerId: set.layerId, action: set.action, oldBlendMode: set.oldBlendMode, newBlendMode: set.newBlendMode, changedPaths: set.changedPaths })
  }, services);
}

async function setCrop(args: unknown, services: TimelineLayerPropertiesServices): Promise<MotionDebugResult> {
  const base = baseArgs("motion.timeline.layer.crop.set", args, services);
  if (isResult(base)) return base;
  const parsed = cropArg(args, "motion.timeline.layer.crop.set");
  if (!parsed.ok) return invalidArgs(parsed.message);
  return execute(base, {
    command: "motion.timeline.layer.crop.set", receiptPrefix: "timeline-layer-crop-set",
    invalidCode: "timeline_layer_crop_set_invalid", failureCode: "timeline_layer_crop_set_failed",
    mutate: (motion) => setTimelineLayerCrop(motion, { layerId: base.layerId, crop: parsed.crop }),
    facts: (set) => ({ layerId: set.layerId, oldCrop: set.oldCrop, newCrop: set.newCrop, changedPaths: set.changedPaths, action: set.action, layer: set.layer }),
    visible: (set) => ({ layerId: set.layerId, action: set.action, oldCrop: set.oldCrop, newCrop: set.newCrop, changedPaths: set.changedPaths })
  }, services);
}

async function setMask(args: unknown, services: TimelineLayerPropertiesServices): Promise<MotionDebugResult> {
  const base = baseArgs("motion.timeline.layer.mask.set", args, services);
  if (isResult(base)) return base;
  const parsed = maskArg(args, "motion.timeline.layer.mask.set");
  if (!parsed.ok) return invalidArgs(parsed.message);
  return execute(base, {
    command: "motion.timeline.layer.mask.set", receiptPrefix: "timeline-layer-mask-set",
    invalidCode: "timeline_layer_mask_set_invalid", failureCode: "timeline_layer_mask_set_failed",
    mutate: (motion) => setTimelineLayerMask(motion, { layerId: base.layerId, mask: parsed.mask }),
    facts: (set) => ({ layerId: set.layerId, oldMask: set.oldMask, newMask: set.newMask, changedPaths: set.changedPaths, action: set.action, layer: set.layer }),
    visible: (set) => ({ layerId: set.layerId, action: set.action, oldMask: set.oldMask, newMask: set.newMask, changedPaths: set.changedPaths })
  }, services);
}

async function setFit(args: unknown, services: TimelineLayerPropertiesServices): Promise<MotionDebugResult> {
  const base = baseArgs("motion.timeline.layer.fit.set", args, services);
  if (isResult(base)) return base;
  const fit = stringArg(args, "fit") ?? stringArg(args, "value") ?? stringArg(args, "mode");
  if (!fit) return invalidArgs("motion.timeline.layer.fit.set requires fit.");
  return execute(base, {
    command: "motion.timeline.layer.fit.set", receiptPrefix: "timeline-layer-fit-set",
    invalidCode: "timeline_layer_fit_set_invalid", failureCode: "timeline_layer_fit_set_failed",
    mutate: (motion) => setTimelineLayerFit(motion, { layerId: base.layerId, fit }),
    facts: (set) => ({ layerId: set.layerId, oldFit: set.oldFit, newFit: set.newFit, changedPaths: set.changedPaths, action: set.action, layer: set.layer }),
    visible: (set) => ({ layerId: set.layerId, action: set.action, oldFit: set.oldFit, newFit: set.newFit, changedPaths: set.changedPaths })
  }, services);
}

async function setMedia(args: unknown, services: TimelineLayerPropertiesServices): Promise<MotionDebugResult> {
  const base = baseArgs("motion.timeline.layer.media.set", args, services);
  if (isResult(base)) return base;
  const source = stringArg(args, "source") ?? stringArg(args, "assetRef") ?? stringArg(args, "src") ?? stringArg(args, "ref");
  if (!source) return invalidArgs("motion.timeline.layer.media.set requires source.");
  return execute(base, {
    command: "motion.timeline.layer.media.set", receiptPrefix: "timeline-layer-media-set",
    invalidCode: "timeline_layer_media_set_invalid", failureCode: "timeline_layer_media_set_failed",
    mutate: (motion) => setTimelineLayerMediaSource(motion, { layerId: base.layerId, source }),
    facts: (set) => ({ layerId: set.layerId, oldSource: set.oldSource, newSource: set.newSource, changedPaths: set.changedPaths, action: set.action, layer: set.layer }),
    visible: (set) => ({ layerId: set.layerId, action: set.action, oldSource: set.oldSource, newSource: set.newSource, changedPaths: set.changedPaths })
  }, services);
}

async function setName(args: unknown, services: TimelineLayerPropertiesServices): Promise<MotionDebugResult> {
  const base = baseArgs("motion.timeline.layer.name.set", args, services);
  if (isResult(base)) return base;
  const name = stringArg(args, "name") ?? stringArg(args, "layerName") ?? stringArg(args, "value");
  if (!name?.trim()) return invalidArgs("motion.timeline.layer.name.set requires name.");
  return execute(base, {
    command: "motion.timeline.layer.name.set", receiptPrefix: "timeline-layer-name-set",
    invalidCode: "timeline_layer_name_set_invalid", failureCode: "timeline_layer_name_set_failed",
    mutate: (motion) => setTimelineLayerName(motion, { layerId: base.layerId, name }),
    facts: (set) => ({ layerId: set.layerId, oldName: set.oldName, newName: set.newName, changedPaths: set.changedPaths, action: set.action, layer: set.layer }),
    visible: (set) => ({ layerId: set.layerId, action: set.action, oldName: set.oldName, newName: set.newName, changedPaths: set.changedPaths })
  }, services);
}

async function setVisibility(args: unknown, services: TimelineLayerPropertiesServices): Promise<MotionDebugResult> {
  const base = baseArgs("motion.timeline.layer.visibility.set", args, services);
  if (isResult(base)) return base;
  const visible = booleanArg(args, "visible");
  if (visible === null) return invalidArgs("visible must be a boolean.");
  return execute(base, {
    command: "motion.timeline.layer.visibility.set", receiptPrefix: "timeline-layer-visibility-set",
    invalidCode: "timeline_layer_visibility_set_invalid", failureCode: "timeline_layer_visibility_set_failed",
    mutate: (motion) => setTimelineLayerVisibility(motion, { layerId: base.layerId, visible }),
    facts: (set) => ({ layerId: set.layerId, oldVisible: set.oldVisible, newVisible: set.newVisible, changedPaths: set.changedPaths, action: set.action, layer: set.layer }),
    visible: (set) => ({ layerId: set.layerId, action: set.action, oldVisible: set.oldVisible, newVisible: set.newVisible, changedPaths: set.changedPaths })
  }, services);
}

async function setLock(args: unknown, services: TimelineLayerPropertiesServices): Promise<MotionDebugResult> {
  const base = baseArgs("motion.timeline.layer.lock", args, services);
  if (isResult(base)) return base;
  const locked = booleanArg(args, "locked");
  if (locked === null) return invalidArgs("locked must be a boolean.");
  return execute(base, {
    command: "motion.timeline.layer.lock", receiptPrefix: "timeline-layer-lock",
    invalidCode: "timeline_layer_lock_invalid", failureCode: "timeline_layer_lock_failed",
    mutate: (motion) => setTimelineLayerLock(motion, { layerId: base.layerId, locked }),
    facts: (set) => ({ layerId: set.layerId, oldLocked: set.oldLocked, newLocked: set.newLocked, changedPaths: set.changedPaths, action: set.action, layer: set.layer }),
    visible: (set) => ({ layerId: set.layerId, action: set.action, oldLocked: set.oldLocked, newLocked: set.newLocked, changedPaths: set.changedPaths })
  }, services);
}

async function propertySetter(
  command: MotionDebugCommand,
  args: unknown,
  services: TimelineLayerPropertiesServices,
  config: {
    aliases: [string, string]; valueAlias: string; receiptPrefix: string; invalidCode: string; failureCode: string;
    mutate: (motion: MotionDocument, input: { layerId: string; property: string; value: unknown }) => SetterResult;
  }
): Promise<MotionDebugResult> {
  const base = baseArgs(command, args, services);
  if (isResult(base)) return base;
  const property = stringArg(args, "property") ?? stringArg(args, config.aliases[0]) ?? stringArg(args, config.aliases[1]);
  const value = rawArg(args, "value", config.valueAlias);
  if (!property) return invalidArgs(`${command} requires property.`);
  if (value === undefined) return invalidArgs(`${command} requires value.`);
  return execute(base, {
    command, receiptPrefix: config.receiptPrefix, invalidCode: config.invalidCode, failureCode: config.failureCode,
    mutate: (motion) => config.mutate(motion, { layerId: base.layerId, property, value }),
    facts: (set) => ({ layerId: set.layerId, property: set.property, oldValue: set.oldValue, newValue: set.newValue, changedPaths: set.changedPaths, action: set.action, layer: set.layer }),
    visible: (set) => ({ layerId: set.layerId, property: set.property, action: set.action, oldValue: set.oldValue, newValue: set.newValue, changedPaths: set.changedPaths })
  }, services);
}

interface BaseArgs extends TimelineCommonEditArgs { layerId: string }

function baseArgs(command: MotionDebugCommand, args: unknown, services: TimelineLayerPropertiesServices): BaseArgs | MotionDebugResult {
  const common = readTimelineCommonEditArgs(command, args, services);
  if (isTimelineCommonEditResult(common)) return common;
  const layerId = stringArg(args, "layerId") ?? stringArg(args, "layer");
  if (!layerId) return invalidArgs(`${command} requires layerId.`);
  return { ...common, layerId };
}

function execute(
  base: BaseArgs,
  config: {
    command: MotionDebugCommand; receiptPrefix: string; invalidCode: string; failureCode: string;
    mutate: (motion: MotionDocument) => SetterResult;
    facts: (mutation: SetterResult) => Record<string, unknown>;
    visible: (mutation: SetterResult) => Record<string, unknown>;
  },
  services: TimelineLayerPropertiesServices
): Promise<MotionDebugResult> {
  return commitAtomicTimelineMutation({
    ...base,
    command: config.command,
    receiptPrefix: config.receiptPrefix,
    receiptFileName: `${config.receiptPrefix}.receipt.json`,
    invalidCode: config.invalidCode,
    failureCode: config.failureCode,
    services,
    mutate: (pkg) => config.mutate(pkg.motion),
    outputFacts: config.facts,
    resultFacts: config.facts,
    visibleFacts: config.visible
  });
}

function rawArg(args: unknown, primary: string, alias: string): unknown {
  const record = objectArg(args);
  if (!record) return undefined;
  if (Object.hasOwn(record, primary)) return record[primary];
  return Object.hasOwn(record, alias) ? record[alias] : undefined;
}

function cropArg(args: unknown, command: string): { ok: true; crop: { x: unknown; y: unknown; width: unknown; height: unknown } } | { ok: false; message: string } {
  const record = objectArg(args);
  const crop = objectArg(record?.crop);
  const source = crop ?? record;
  if (!source) return { ok: false, message: `${command} requires crop.x.` };
  for (const field of ["x", "y", "width", "height"] as const) {
    if (!Object.hasOwn(source, field) || source[field] === undefined) return { ok: false, message: `${command} requires crop.${field}.` };
  }
  return { ok: true, crop: { x: source.x, y: source.y, width: source.width, height: source.height } };
}

function maskArg(args: unknown, command: string): { ok: true; mask: Record<string, unknown> } | { ok: false; message: string } {
  const record = objectArg(args);
  const mask = objectArg(record?.mask);
  if (mask) {
    if (!Object.hasOwn(mask, "type") || mask.type === undefined) return { ok: false, message: `${command} requires mask.type.` };
    return { ok: true, mask };
  }
  if (!record) return { ok: false, message: `${command} requires mask.type.` };
  const type = ownValue(record, "type") ?? ownValue(record, "maskType");
  if (type === undefined) return { ok: false, message: `${command} requires mask.type.` };
  const result: Record<string, unknown> = { type };
  const inset: Record<string, unknown> = {};
  for (const side of ["top", "right", "bottom", "left"] as const) {
    if (Object.hasOwn(record, side)) inset[side] = record[side];
  }
  if (Object.keys(inset).length > 0) result.inset = inset;
  const radius = ownValue(record, "radius") ?? ownValue(record, "maskRadius");
  if (radius !== undefined) result.radius = radius;
  return { ok: true, mask: result };
}

function ownValue(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function isResult(value: BaseArgs | MotionDebugResult): value is MotionDebugResult {
  return "ok" in value;
}

function invalidArgs(message: string): MotionDebugResult {
  return { ok: false, error: { code: "invalid_args", message }, warnings: [] };
}
