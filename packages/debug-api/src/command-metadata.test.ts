/**
 * Standing gate for the published argument contracts.
 *
 * These tests exist because the failure they prevent is silent: a new command lands, nobody
 * writes its argument schema, and the published contract quietly stops describing the engine.
 * A caller then has no way to learn the arguments except by reading TypeScript source.
 */
import { describe, expect, it } from "vitest";
import {
  MOTION_BEHAVIOR_MAX_COORDINATE,
  MOTION_BEHAVIOR_MAX_GRAVITY,
  MOTION_BEHAVIOR_MAX_RESTITUTION,
  MOTION_BEHAVIOR_MAX_SQUASH_AMOUNT,
  MOTION_BEHAVIOR_MAX_VELOCITY,
  MOTION_BEHAVIOR_MIN_BOUNCE_GRAVITY,
  MOTION_BEHAVIOR_MIN_COORDINATE,
  MOTION_BEHAVIOR_MIN_GRAVITY,
  MOTION_BEHAVIOR_MIN_RESTITUTION,
  MOTION_BEHAVIOR_MIN_SQUASH_AMOUNT,
  MOTION_BEHAVIOR_MIN_VELOCITY,
  readSupportedKeyframeTarget,
  isSupportedEasing,
  readSupportedTransitionType,
} from "@shellx-motion/core";
import { COMPOSITING_COMMAND_METADATA } from "./command-metadata-compositing.js";
import { CHECKPOINT_STORYBOARD_RECORD_COMMAND_METADATA } from "./command-metadata-checkpoint-storyboard.js";
import { CORE_COMMAND_METADATA } from "./command-metadata-core.js";
import { MOTION_DEBUG_ARG_ENUMS, debugArgEnum } from "./command-metadata-enums.js";
import { KEYING_COMMAND_METADATA } from "./command-metadata-keying.js";
import { SCENE3D_COMMAND_METADATA } from "./command-metadata-scene3d.js";
import { SURFACE_COMMAND_METADATA } from "./command-metadata-surfaces.js";
import { TIMELINE_KEYFRAME_COMMAND_METADATA } from "./command-metadata-timeline-keyframes.js";
import { TIMELINE_LAYER_COMMAND_METADATA } from "./command-metadata-timeline-layers.js";
import { TIMELINE_GROUP_COMMAND_METADATA } from "./command-metadata-timeline-groups.js";
import { TIMELINE_LAYOUT_COMMAND_METADATA } from "./command-metadata-timeline-layout.js";
import { TIMELINE_FIXED_ADJUSTMENT_COMMAND_METADATA } from "./command-metadata-timeline-adjustments.js";
import { TIMELINE_BEHAVIOR_COMMAND_METADATA } from "./command-metadata-timeline-behaviors.js";
import { TIMELINE_RELATION_COMMAND_METADATA } from "./command-metadata-timeline-relations.js";
import { TIMELINE_RELATION_ACTION_COMMAND_METADATA } from "./command-metadata-timeline-relation-actions.js";
import { TIMELINE_GRADIENT_COLOR_KEYFRAME_COMMAND_METADATA } from "./command-metadata-timeline-gradient-color-keyframes.js";
import { TIMELINE_POINT_COMMAND_METADATA } from "./command-metadata-timeline-points.js";
import { TIMELINE_PARTICLE_STRUCTURAL_COMMAND_METADATA } from "./command-metadata-timeline-particle-structural.js";
import { TIMELINE_SHAPE_GEOMETRY_COMMAND_METADATA } from "./command-metadata-timeline-shape-geometry.js";
import { TIMELINE_SHAPE_GEOMETRY_KEYFRAME_COMMAND_METADATA } from "./command-metadata-timeline-shape-geometry-keyframes.js";
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
  ["checkpoint-storyboard", CHECKPOINT_STORYBOARD_RECORD_COMMAND_METADATA],
  ["scene3d", SCENE3D_COMMAND_METADATA],
  ["compositing", COMPOSITING_COMMAND_METADATA],
  ["tracking", TRACKING_COMMAND_METADATA],
  ["keying", KEYING_COMMAND_METADATA],
  ["core", CORE_COMMAND_METADATA],
  ["surfaces", SURFACE_COMMAND_METADATA],
  ["timeline-layers", TIMELINE_LAYER_COMMAND_METADATA],
  ["timeline-groups", TIMELINE_GROUP_COMMAND_METADATA],
  ["timeline-layout", TIMELINE_LAYOUT_COMMAND_METADATA],
  ["timeline-fixed-adjustments", TIMELINE_FIXED_ADJUSTMENT_COMMAND_METADATA],
  ["timeline-behaviors", TIMELINE_BEHAVIOR_COMMAND_METADATA],
  ["timeline-relations", TIMELINE_RELATION_COMMAND_METADATA],
  ["timeline-relation-actions", TIMELINE_RELATION_ACTION_COMMAND_METADATA],
  ["timeline-gradient-color-keyframes", TIMELINE_GRADIENT_COLOR_KEYFRAME_COMMAND_METADATA],
  ["timeline-points", TIMELINE_POINT_COMMAND_METADATA],
  ["timeline-particle-structural", TIMELINE_PARTICLE_STRUCTURAL_COMMAND_METADATA],
  ["timeline-shape-geometry", TIMELINE_SHAPE_GEOMETRY_COMMAND_METADATA],
  ["timeline-shape-geometry-keyframes", TIMELINE_SHAPE_GEOMETRY_KEYFRAME_COMMAND_METADATA],
  ["timeline-keyframes", TIMELINE_KEYFRAME_COMMAND_METADATA],
  ["timeline-structure", TIMELINE_STRUCTURE_COMMAND_METADATA],
  ["timeline-tracks", TIMELINE_TRACK_COMMAND_METADATA]
] as const;

describe("published debug argument contracts", () => {
  it("keeps fixed adjustment set closed and behind the package COW boundary", () => {
    for (const command of ["motion.timeline.adjustment.fixed.set", "motion.timeline.adjustment.fixed.remove"] as const) {
      const schema = TIMELINE_FIXED_ADJUSTMENT_COMMAND_METADATA[command].argsSchema;
      expect(schema.properties, command).not.toHaveProperty("receiptsRoot");
      expect(schema.required ?? [], command).not.toContain("receiptsRoot");
      expect(schema.properties.packageRoot?.description, command).toContain("trusted Debug host");
      expect(schema.properties.packageRoot?.description, command).toContain("must not supply receiptsRoot");
    }
    const set = TIMELINE_FIXED_ADJUSTMENT_COMMAND_METADATA["motion.timeline.adjustment.fixed.set"].argsSchema;
    expect(set.required).toEqual(["packageRoot", "outDir", "adjustment"]);
    expect(set.properties.adjustment).toMatchObject({ type: "object", additionalProperties: false, required: ["id", "startMs", "durationMs", "effects"] });
    expect(set.properties.adjustment?.properties?.effects?.description).toContain("vignette-then-filmGrain");
  });

  it("keeps layout apply/remove receipt authority host-configured", () => {
    for (const command of ["motion.timeline.layout.apply", "motion.timeline.layout.remove"] as const) {
      const schema = TIMELINE_LAYOUT_COMMAND_METADATA[command].argsSchema;
      expect(schema.properties, command).not.toHaveProperty("receiptsRoot");
      expect(schema.required ?? [], command).not.toContain("receiptsRoot");
      expect(schema.properties.packageRoot?.description, command).toContain("trusted Debug host");
      expect(schema.properties.packageRoot?.description, command).toContain("must not supply receiptsRoot");
    }
  });

  it("keeps behavior mutations behind a host-configured receipt root", () => {
    for (const command of ["motion.timeline.behaviors.upsert", "motion.timeline.behaviors.remove"] as const) {
      const schema = TIMELINE_BEHAVIOR_COMMAND_METADATA[command].argsSchema;
      expect(schema.properties, command).not.toHaveProperty("receiptsRoot");
      expect(schema.required ?? [], command).not.toContain("receiptsRoot");
      expect(schema.properties.packageRoot?.description, command).toContain("trusted Debug host");
      expect(schema.properties.packageRoot?.description, command).toContain("must not supply receiptsRoot");
    }
  });

  it("publishes the exact 16-entry relation-action binding-map caps", () => {
    const request = TIMELINE_RELATION_ACTION_COMMAND_METADATA["motion.timeline.relation-actions.apply"].argsSchema.properties.request!;
    for (const name of ["roleBindings", "parameterValues"] as const) {
      const map = request.properties?.[name];
      expect(map, name).toMatchObject({ type: "object", additionalProperties: true, maxProperties: 16 });
      expect(map, name).not.toHaveProperty("maxLength");
    }
  });

  it("keeps relation lifecycle mutations behind host receipt authority", () => {
    for (const command of [
      "motion.timeline.relations.upsert",
      "motion.timeline.relations.enabled.set",
      "motion.timeline.relations.remove",
      "motion.timeline.relations.detach",
      "motion.timeline.relations.bake",
    ] as const) {
      const schema = TIMELINE_RELATION_COMMAND_METADATA[command].argsSchema;
      expect(schema.properties, command).not.toHaveProperty("receiptsRoot");
      expect(schema.required ?? [], command).not.toContain("receiptsRoot");
      expect(schema.properties.packageRoot?.description, command).toContain("trusted Debug host");
    }
    expect(TIMELINE_RELATION_COMMAND_METADATA["motion.timeline.relations.inspect"]).not.toHaveProperty("expectedReceipts");
  });

  it("keeps exact shape geometry snapshots off generic keyframes and behind host receipt authority", () => {
    for (const command of ["motion.timeline.shape.geometry-keyframes.upsert", "motion.timeline.shape.geometry-keyframes.delete", "motion.timeline.shape.geometry-keyframes.move"] as const) {
      const schema = TIMELINE_SHAPE_GEOMETRY_KEYFRAME_COMMAND_METADATA[command].argsSchema;
      expect(schema.properties, command).not.toHaveProperty("receiptsRoot");
      expect(schema.properties.packageRoot?.description, command).toContain("trusted Debug host");
      expect(schema.properties.packageRoot?.description, command).toContain("must not supply receiptsRoot");
    }
    expect(TIMELINE_SHAPE_GEOMETRY_KEYFRAME_COMMAND_METADATA["motion.timeline.shape.geometry-keyframes.upsert"].argsSchema.required)
      .toEqual(["packageRoot", "outDir", "layerId", "snapshot"]);
  });

  it("mirrors the shared transform bounds and leaves unbounded spring scalars unbounded", () => {
    const binding = TIMELINE_BEHAVIOR_COMMAND_METADATA["motion.timeline.behaviors.upsert"].argsSchema.properties.binding!;
    const path = binding.oneOf![0]!, transform = binding.oneOf![1]!;
    const spring = path.properties!.easing!.oneOf![1]!.properties!;
    expect(spring.stiffness).toMatchObject({ exclusiveMinimum: 0 });
    expect(spring.damping).toMatchObject({ exclusiveMinimum: 0 });
    expect(spring.mass).toMatchObject({ exclusiveMinimum: 0 });
    expect(spring.stiffness).not.toHaveProperty("maximum");
    expect(spring.damping).not.toHaveProperty("maximum");
    expect(spring.mass).not.toHaveProperty("maximum");
    expect(spring.initialVelocity).not.toHaveProperty("minimum");
    expect(spring.initialVelocity).not.toHaveProperty("maximum");
    const [gravity, bounce] = transform.properties!.motion!.oneOf!;
    expect(gravity!.properties).toMatchObject({
      velocityX: { minimum: MOTION_BEHAVIOR_MIN_VELOCITY, maximum: MOTION_BEHAVIOR_MAX_VELOCITY },
      velocityY: { minimum: MOTION_BEHAVIOR_MIN_VELOCITY, maximum: MOTION_BEHAVIOR_MAX_VELOCITY },
      gravityY: { minimum: MOTION_BEHAVIOR_MIN_GRAVITY, maximum: MOTION_BEHAVIOR_MAX_GRAVITY },
    });
    expect(bounce!.properties).toMatchObject({
      floorY: { minimum: MOTION_BEHAVIOR_MIN_COORDINATE, maximum: MOTION_BEHAVIOR_MAX_COORDINATE },
      velocityY: { minimum: MOTION_BEHAVIOR_MIN_VELOCITY, maximum: MOTION_BEHAVIOR_MAX_VELOCITY },
      gravityY: { minimum: MOTION_BEHAVIOR_MIN_BOUNCE_GRAVITY, maximum: MOTION_BEHAVIOR_MAX_GRAVITY },
      restitution: { minimum: MOTION_BEHAVIOR_MIN_RESTITUTION, maximum: MOTION_BEHAVIOR_MAX_RESTITUTION },
    });
    expect(transform.properties!.squash!.properties!.amount).toMatchObject({
      minimum: MOTION_BEHAVIOR_MIN_SQUASH_AMOUNT, maximum: MOTION_BEHAVIOR_MAX_SQUASH_AMOUNT,
    });
  });

  it("describes path reveal through the existing rich setter rather than inventing a new verb", () => {
    const metadata = TIMELINE_LAYER_COMMAND_METADATA["motion.timeline.layer.rich.set"];
    expect(metadata?.argsSchema?.properties.property?.description).toContain("pathReveal.start");
    expect(metadata?.argsSchema?.properties.property?.description).toContain("pathReveal.end");
  });

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

  it("keeps every edit_motion package mutation behind packageRoot and outDir", () => {
    const unfenced = DEBUG_COMMAND_CONTRACTS
      .filter((contract) => contract.permission === "edit_motion" && contract.mutates)
      .filter((contract) => {
        const required = new Set(contract.argsSchema?.required ?? []);
        return !required.has("packageRoot") || !required.has("outDir");
      })
      .map((contract) => contract.command);
    expect(unfenced).toEqual([]);
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

  it("does not publish a renderer-host execution policy to an agent command", () => {
    for (const contract of DEBUG_COMMAND_CONTRACTS) {
      expect(contract.argsSchema?.properties ?? {}, contract.command).not.toHaveProperty("untrustedExecution");
    }
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
      examples: [],
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
      examples: [],
      related: []
    });
    expect(annotated.steps[0].takesNoArguments).toBe(true);
    expect(annotated.steps[0].args).toEqual([]);
  });

  it("keeps metadata-defined alternative requirements visible instead of advertising a zero-argument call", () => {
    const annotated = annotatePlanWithArgumentContracts({
      ok: true,
      topic: "connector",
      action: null,
      steps: [{ order: 1, call: "motion.connector.script_to_cut", purpose: "connect" }],
      verify: [],
      cautions: [],
      examples: [],
      related: []
    });

    expect(annotated.steps[0]).toMatchObject({
      requiredArgs: ["outDir"],
      requiredArgGroups: [{
        mode: "oneOf",
        alternatives: [["scriptPath"], ["script"], ["storyboard"]]
      }]
    });
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
    const finalContract = debugCommandContract("motion.render.final");
    const cachePlanContract = debugCommandContract("motion.render.cache.plan");
    expect(finalContract?.argsSchema?.properties.frameLane.enum).toEqual(["browser", "native", "gpu"]);
    expect(cachePlanContract?.argsSchema?.properties.frameLane.enum).toEqual(["browser", "native"]);
    expect(cachePlanContract?.argsSchema?.properties.frameLane.description).toContain("GPU post-render identity is completed-render evidence only");
    expect(MOTION_DEBUG_ARG_ENUMS.deliveryLane.values).toEqual(["native", "ffmpeg"]);
    expect(MOTION_DEBUG_ARG_ENUMS.deliveryLane.description).toContain("--frame-lane");
  });

  it("exposes the argument schema for a single command lookup", () => {
    expect(debugCommandArgumentContract("motion.timeline.layer.create")?.required).toEqual(["packageRoot", "outDir"]);
    expect(debugCommandArgumentContract("not.a.debug.command")).toBeNull();
  });
});
