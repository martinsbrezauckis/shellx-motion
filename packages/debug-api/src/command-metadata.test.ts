/**
 * Standing gate for the published argument contracts.
 *
 * These tests exist because the failure they prevent is silent: a new command lands, nobody
 * writes its argument schema, and the published contract quietly stops describing the engine.
 * A caller then has no way to learn the arguments except by reading TypeScript source.
 */
import { describe, expect, it } from "vitest";
import { readSupportedKeyframeTarget, isSupportedEasing, readSupportedTransitionType } from "@shellx-motion/core";
import { COMPOSITING_COMMAND_METADATA } from "./command-metadata-compositing.js";
import { CORE_COMMAND_METADATA } from "./command-metadata-core.js";
import { MOTION_DEBUG_ARG_ENUMS, debugArgEnum } from "./command-metadata-enums.js";
import { KEYING_COMMAND_METADATA } from "./command-metadata-keying.js";
import { SCENE3D_COMMAND_METADATA } from "./command-metadata-scene3d.js";
import { SURFACE_COMMAND_METADATA } from "./command-metadata-surfaces.js";
import { TIMELINE_KEYFRAME_COMMAND_METADATA } from "./command-metadata-timeline-keyframes.js";
import { TIMELINE_LAYER_COMMAND_METADATA } from "./command-metadata-timeline-layers.js";
import { TIMELINE_STRUCTURE_COMMAND_METADATA } from "./command-metadata-timeline-structure.js";
import { TIMELINE_TRACK_COMMAND_METADATA } from "./command-metadata-timeline-tracks.js";
import { TRACKING_COMMAND_METADATA } from "./command-metadata-tracking.js";
import {
  DEBUG_COMMAND_CONTRACTS,
  debugCommandArgumentContract,
  debugCommandContract,
  debugCommandsWithoutArgumentContracts
} from "./command-metadata.js";
import { DEBUG_COMMANDS } from "./command-registry.js";
import { annotatePlanWithArgumentContracts } from "./domains/agent-plan-arguments.js";
import { unsupportedEnumValue } from "./domains/enum-error.js";

const METADATA_MODULES = [
  ["scene3d", SCENE3D_COMMAND_METADATA],
  ["compositing", COMPOSITING_COMMAND_METADATA],
  ["tracking", TRACKING_COMMAND_METADATA],
  ["keying", KEYING_COMMAND_METADATA],
  ["core", CORE_COMMAND_METADATA],
  ["surfaces", SURFACE_COMMAND_METADATA],
  ["timeline-layers", TIMELINE_LAYER_COMMAND_METADATA],
  ["timeline-keyframes", TIMELINE_KEYFRAME_COMMAND_METADATA],
  ["timeline-structure", TIMELINE_STRUCTURE_COMMAND_METADATA],
  ["timeline-tracks", TIMELINE_TRACK_COMMAND_METADATA]
] as const;

describe("published debug argument contracts", () => {
  it("covers every registered command", () => {
    expect(debugCommandsWithoutArgumentContracts()).toEqual([]);
    expect(DEBUG_COMMAND_CONTRACTS).toHaveLength(DEBUG_COMMANDS.length);
    expect(DEBUG_COMMAND_CONTRACTS.filter((contract) => contract.argsSchema)).toHaveLength(DEBUG_COMMANDS.length);
  });

  it("covers every mutating command with a non-empty argument list", () => {
    const emptyMutations = DEBUG_COMMAND_CONTRACTS
      .filter((contract) => contract.mutates)
      .filter((contract) => Object.keys(contract.argsSchema?.properties ?? {}).length === 0)
      .map((contract) => contract.command);
    expect(emptyMutations).toEqual([]);
  });

  it("defines each command in exactly one metadata module", () => {
    const seen = new Map<string, string>();
    const duplicates: string[] = [];
    for (const [moduleName, metadata] of METADATA_MODULES) {
      for (const command of Object.keys(metadata)) {
        const previous = seen.get(command);
        if (previous) duplicates.push(`${command}: ${previous} and ${moduleName}`);
        seen.set(command, moduleName);
      }
    }
    expect(duplicates).toEqual([]);
  });

  it("only declares required arguments that the schema also defines", () => {
    const problems: string[] = [];
    for (const contract of DEBUG_COMMAND_CONTRACTS) {
      for (const name of contract.argsSchema?.required ?? []) {
        if (!Object.hasOwn(contract.argsSchema?.properties ?? {}, name)) problems.push(`${contract.command}.${name}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("resolves every enumRef against the published enum dictionary", () => {
    const dangling: string[] = [];
    for (const contract of DEBUG_COMMAND_CONTRACTS) {
      for (const [name, property] of Object.entries(contract.argsSchema?.properties ?? {})) {
        if (property.enumRef && !debugArgEnum(property.enumRef)) dangling.push(`${contract.command}.${name} -> ${property.enumRef}`);
      }
    }
    expect(dangling).toEqual([]);
  });

  it("never leaves an argument without a description", () => {
    const undocumented: string[] = [];
    for (const contract of DEBUG_COMMAND_CONTRACTS) {
      for (const [name, property] of Object.entries(contract.argsSchema?.properties ?? {})) {
        if (!property.description) undocumented.push(`${contract.command}.${name}`);
      }
    }
    expect(undocumented).toEqual([]);
  });
});

describe("published argument enumerations", () => {
  it("publishes keyframe targets the engine actually accepts", () => {
    const targets = MOTION_DEBUG_ARG_ENUMS.keyframeTarget.values;
    expect(targets.length).toBeGreaterThan(100);
    expect(targets).toContain("opacity");
    expect(targets).toContain("transform.x");
    for (const target of targets) expect(readSupportedKeyframeTarget(target)).toBe(target);
    expect(readSupportedKeyframeTarget("not.a.real.target")).toBeNull();
  });

  it("publishes easings and transition types the engine actually accepts", () => {
    for (const easing of MOTION_DEBUG_ARG_ENUMS.easing.values) expect(isSupportedEasing(easing)).toBe(true);
    for (const type of MOTION_DEBUG_ARG_ENUMS.transitionType.values) expect(readSupportedTransitionType(type)).toBe(type);
  });

  it("never publishes an empty or duplicated enumeration", () => {
    for (const [name, entry] of Object.entries(MOTION_DEBUG_ARG_ENUMS)) {
      expect(entry.values.length, name).toBeGreaterThan(0);
      expect(new Set(entry.values).size, name).toBe(entry.values.length);
      expect(entry.description.length, name).toBeGreaterThan(10);
    }
  });
});

describe("action plans carry argument contracts", () => {
  it("annotates each step with its arguments, required set, and resolved enum values", () => {
    const annotated = annotatePlanWithArgumentContracts({
      ok: true,
      topic: "motion.timeline.layer.create",
      action: null,
      steps: [
        { order: 1, call: "motion.timeline.layer.create", purpose: "create" },
        { order: 2, call: "motion.timeline.transition.upsert", purpose: "transition" },
        { order: 3, call: "not.a.debug.command", purpose: "unknown" }
      ],
      verify: [],
      cautions: [],
      related: []
    });

    expect(annotated.argumentContractsResolved).toBe(2);
    const create = annotated.steps[0];
    expect(create.mutates).toBe(true);
    expect(create.permission).toBe("edit_motion");
    expect(create.requiredArgs).toEqual(["packageRoot", "outDir"]);
    expect(create.args?.find((arg) => arg.name === "outDir")?.aliases).toEqual(["packageDir"]);
    expect(create.args?.map((arg) => arg.name)).toContain("durationMs");

    // enumRef values are resolved inline so the caller never has to chase a reference.
    const transitionType = annotated.steps[1].args?.find((arg) => arg.name === "type");
    expect(transitionType?.allowedValues).toEqual(["fade", "slide", "wipe"]);

    // Steps that are not registry commands pass through untouched rather than failing.
    expect(annotated.steps[2].args).toBeUndefined();
  });

  it("marks argument-free commands explicitly instead of looking like a gap", () => {
    const annotated = annotatePlanWithArgumentContracts({
      ok: true,
      topic: "presets",
      action: null,
      steps: [{ order: 1, call: "motion.timeline.easing.presets", purpose: "list presets" }],
      verify: [],
      cautions: [],
      related: []
    });
    expect(annotated.steps[0].takesNoArguments).toBe(true);
    expect(annotated.steps[0].args).toEqual([]);
  });
});

describe("rejected enum values name the fix", () => {
  it("carries the valid alternatives in suggestedAction and detail", () => {
    const result = unsupportedEnumValue("transition type", "zoom", "transitionType");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toBe("Unsupported transition type: zoom.");
    expect(result.error.suggestedAction).toBe("transition type must be one of: fade, slide, wipe.");
    expect(result.error.detail).toEqual({ argument: "transition type", value: "zoom", allowedValues: ["fade", "slide", "wipe"] });
  });

  it("names the frame-lane fix rather than only the rejected value", () => {
    const contract = debugCommandContract("motion.render.final");
    expect(contract?.argsSchema?.properties.frameLane.enum).toEqual(["browser"]);
    expect(MOTION_DEBUG_ARG_ENUMS.deliveryLane.values).toEqual(["native", "ffmpeg"]);
    expect(MOTION_DEBUG_ARG_ENUMS.deliveryLane.description).toContain("--frame-lane");
  });

  it("exposes the argument schema for a single command lookup", () => {
    expect(debugCommandArgumentContract("motion.timeline.layer.create")?.required).toEqual(["packageRoot", "outDir"]);
    expect(debugCommandArgumentContract("not.a.debug.command")).toBeNull();
  });
});
