import type { MotionPermissionTier } from "@shellx-motion/actions";
import { CONNECTOR_CATALOG_COMMAND_DEFINITIONS } from "./command-registry-connector-catalog.js";
import { TIMELINE_EXTENSION_COMMAND_DEFINITIONS } from "./command-registry-timeline-extensions.js";
export type MotionDebugDomain = "surface" | "agent" | "render" | "timeline" | "authoring" | "integration" | "workspace";
export interface MotionDebugArgsSchema {
  type: "object";
  required?: string[];
  properties: Record<string, MotionDebugArgPropertySchema>;
  additionalProperties?: boolean;
  /** Closed `oneOf` or composable `anyOf` top-level input alternatives. */
  oneOf?: MotionDebugArgsSchema[]; anyOf?: MotionDebugArgsSchema[];
}
/** A JSON Schema scalar type, or a union of them where an argument genuinely accepts several. */
export type MotionDebugArgType = "string" | "number" | "boolean" | "object" | "array" | "null";
export interface MotionDebugArgPropertySchema {
  /**
   * Declared type. An array is a real union, not a convenience: a keyframe value is a number for
   * numeric targets and a colour string for colour ones, and declaring it as `string` alone made an
   * agent send "0" and get "Keyframe value must be a finite number" from the runtime. A contract
   * that disagrees with the code it describes is worse than no contract.
   */
  type: MotionDebugArgType | MotionDebugArgType[];
  description?: string;
  minimum?: number;
  /**
   * Upper bound, where the runtime has one.
   *
   * Added with the `motion.package.create` bounds : the command refuses a document
   * larger than the renderers serve, and a contract that declares only a minimum tells an agent the
   * ceiling does not exist. Declare it whenever the code enforces one, and source it from that code
   * rather than restating the number here.
   */
  maximum?: number;
  /** Strict lower bound, used when zero is syntactically valid but semantically prohibited. */
  exclusiveMinimum?: number;
  /**
   * Closed nested object fields. These use the same small property vocabulary as a command's
   * top-level schema so MCP can publish and enforce a data-only record rather than a vague object.
   */
  properties?: Record<string, MotionDebugArgPropertySchema>;
  /** Required fields for a nested object property. */
  required?: string[];
  /** Whether a nested object accepts keys not listed in `properties`. */
  additionalProperties?: boolean;
  /** Schema for each array entry. Array items are checked recursively on every transport. */
  items?: MotionDebugArgPropertySchema;
  /** Inclusive item-count lower bound for a declared array. */
  minItems?: number;
  /** Inclusive item-count upper bound for a declared array. */
  maxItems?: number;
  /** Inclusive property-count upper bound for a declared object map. */
  maxProperties?: number;
  /**
   * Closed alternatives for a value with one of several typed record shapes.
   *
   * This is deliberately a small JSON-Schema subset rather than an open dispatch hook: every
   * alternative still has to declare its own type, required fields and closed properties.
   */
  oneOf?: MotionDebugArgPropertySchema[];
  /** Longest accepted string, where the runtime bounds one. Same rule as `maximum`. */
  maxLength?: number;
  /** Exact scalar constraints a transport publishes and enforces alongside the runtime grammar. */
  minLength?: number; pattern?: string; multipleOf?: number;
  enum?: string[];
  /**
   * Name of a published entry in `MOTION_DEBUG_ARG_ENUMS` (schemas/debug.json `argEnums`).
   * Used instead of `enum` for value sets that are large or shared across many commands, so
   * the allowed values live in exactly one place and cannot drift between command schemas.
   */
  enumRef?: string;
  /** Argument names that the command accepts as synonyms for this property. */
  aliases?: string[];
  /** Value used when the argument is omitted, when the command has a documented default. */
  default?: string | number | boolean;
}

export interface MotionDebugExpectedReceipt {
  operation: string;
  mode: "emits" | "reads";
  required: boolean;
  artifactRoles?: string[];
}

export interface MotionDebugCommandDefinitionBase {
  command: string;
  domain: MotionDebugDomain;
  permission: MotionPermissionTier;
  mutates: boolean;
}

const COMMAND_DEFINITIONS = [
  { command: "motion.state", domain: "surface", permission: "read_motion", mutates: false },
  { command: "motion.open", domain: "surface", permission: "read_motion", mutates: false },
  { command: "motion.select", domain: "surface", permission: "read_motion", mutates: false },
  { command: "motion.highlight", domain: "surface", permission: "read_motion", mutates: false },
  { command: "motion.preview.frame", domain: "render", permission: "render_motion", mutates: true },
  { command: "motion.preview.panel", domain: "render", permission: "read_motion", mutates: false },
  { command: "motion.preview.playhead", domain: "render", permission: "render_motion", mutates: true },
  { command: "motion.preview.strip", domain: "render", permission: "render_motion", mutates: true },
  { command: "motion.render.final", domain: "render", permission: "render_motion", mutates: true },
  { command: "motion.render.cache.plan", domain: "render", permission: "render_motion", mutates: false },
  { command: "motion.render.batch", domain: "render", permission: "render_motion", mutates: true },
  { command: "motion.render.cancel", domain: "render", permission: "render_motion", mutates: true },
  { command: "motion.render.retry", domain: "render", permission: "render_motion", mutates: true },
  { command: "motion.render.status", domain: "render", permission: "read_motion", mutates: false },
  { command: "motion.render.queue", domain: "render", permission: "read_motion", mutates: false },
  // Live job queries, distinct from the two above: render.status/queue read receipt files and so
  // can only describe work that already finished writing evidence. These read the lease directory
  // and the terminal record store, which is what a host polling an in-flight render needs.
  { command: "motion.job.get", domain: "render", permission: "read_motion", mutates: false },
  { command: "motion.job.list", domain: "render", permission: "read_motion", mutates: false },
  { command: "motion.job.events", domain: "render", permission: "read_motion", mutates: false },
  { command: "motion.job.submit", domain: "render", permission: "render_motion", mutates: true },
  { command: "motion.job.cancel", domain: "render", permission: "render_motion", mutates: true },
  { command: "motion.job.retry", domain: "render", permission: "render_motion", mutates: true },
  ...CONNECTOR_CATALOG_COMMAND_DEFINITIONS,
  { command: "motion.connector.submit", domain: "integration", permission: "render_motion", mutates: true },
  { command: "motion.prompt.queue", domain: "agent", permission: "read_motion", mutates: false },
  { command: "motion.prompt.cancel", domain: "agent", permission: "draft_motion", mutates: true },
  { command: "motion.prompt.retry", domain: "agent", permission: "draft_motion", mutates: true },
  { command: "motion.packages.browse", domain: "workspace", permission: "read_motion", mutates: false },
  // The cold start. Every other authoring command edits a package that already exists, and every
  // route that made one was an importer — an agent asked to build something original had no first
  // step. Found by giving an outside agent only the docs and the tools.
  { command: "motion.package.create", domain: "workspace", permission: "write_local", mutates: true },
  { command: "motion.package.asset.import", domain: "workspace", permission: "edit_motion", mutates: true },
  // The CLI leads with `validate`; the Debug API had no equivalent, so an agent had to render to
  // discover whether its package was even well-formed.
  { command: "motion.package.validate", domain: "workspace", permission: "read_motion", mutates: false },
  { command: "motion.receipts.list", domain: "workspace", permission: "read_motion", mutates: false },
  { command: "motion.receipts.read", domain: "workspace", permission: "read_motion", mutates: false },
  { command: "motion.receipts.panel", domain: "workspace", permission: "read_motion", mutates: false },
  { command: "motion.platform.verification.panel", domain: "surface", permission: "read_motion", mutates: false },
  // "Is this machine able to render, and if not what is missing?" A host that gets
  // ffmpeg_not_configured needs somewhere to send the user, and an agent needs to answer it
  // without shelling out.
  { command: "motion.platform.requirements", domain: "surface", permission: "read_motion", mutates: false },
  // This is deliberately separate from the source-only requirements read:
  // it opens one pre-contained Chromium WebGPU session and performs a bounded
  // frame/readback before returning host proof.
  { command: "motion.platform.gpu.probe", domain: "surface", permission: "render_motion", mutates: true },
  { command: "motion.assets.panel", domain: "surface", permission: "read_motion", mutates: false },
  { command: "motion.brand.panel", domain: "surface", permission: "read_motion", mutates: false },
  { command: "motion.audio.panel", domain: "surface", permission: "read_motion", mutates: false },
  { command: "motion.audio.master.set", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.audio.crossfade.set", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.media.panel", domain: "surface", permission: "read_motion", mutates: false },
  { command: "motion.connector.panel", domain: "integration", permission: "read_motion", mutates: false },
  { command: "motion.storyboard.panel", domain: "surface", permission: "read_motion", mutates: false },
  { command: "motion.storyboard.graph", domain: "surface", permission: "read_motion", mutates: false },
  { command: "motion.actions.find", domain: "agent", permission: "read_motion", mutates: false },
  { command: "motion.actions.guide", domain: "agent", permission: "read_motion", mutates: false },
  { command: "motion.actions.plan", domain: "agent", permission: "read_motion", mutates: false },
  { command: "motion.actions.panel", domain: "agent", permission: "read_motion", mutates: false },
  { command: "motion.capabilities.match", domain: "surface", permission: "read_motion", mutates: false },
  { command: "motion.capabilities.panel", domain: "surface", permission: "read_motion", mutates: false },
  { command: "motion.agent.panel", domain: "agent", permission: "read_motion", mutates: false },
  { command: "motion.agent.health", domain: "agent", permission: "read_motion", mutates: false },
  { command: "motion.agent.snapshot", domain: "agent", permission: "read_motion", mutates: false },
  { command: "motion.agent.transcript", domain: "agent", permission: "read_motion", mutates: false },
  { command: "motion.agent.revision.plan", domain: "agent", permission: "write_local", mutates: true },
  { command: "motion.prompt.run", domain: "agent", permission: "draft_motion", mutates: true },
  { command: "motion.script.compile", domain: "authoring", permission: "write_local", mutates: true },
  { command: "motion.package.script.author", domain: "authoring", permission: "write_local", mutates: true },
  { command: "motion.analysis.tracking.request", domain: "authoring", permission: "write_local", mutates: true },
  { command: "motion.analysis.tracking.inspect", domain: "authoring", permission: "read_motion", mutates: false },
  { command: "motion.analysis.tracking.apply", domain: "authoring", permission: "edit_motion", mutates: true },
  { command: "motion.analysis.tracking.detach", domain: "authoring", permission: "edit_motion", mutates: true },
  { command: "motion.analysis.tracking.verify", domain: "authoring", permission: "read_motion", mutates: false },
  { command: "motion.keying.inspect", domain: "authoring", permission: "read_motion", mutates: false },
  { command: "motion.keying.apply", domain: "authoring", permission: "edit_motion", mutates: true },
  { command: "motion.keying.remove", domain: "authoring", permission: "edit_motion", mutates: true },
  { command: "motion.roto.upsert", domain: "authoring", permission: "edit_motion", mutates: true },
  { command: "motion.roto.tracking.detach", domain: "authoring", permission: "edit_motion", mutates: true },
  { command: "motion.roto.remove", domain: "authoring", permission: "edit_motion", mutates: true },
  { command: "motion.compositing.graph.inspect", domain: "authoring", permission: "read_motion", mutates: false },
  { command: "motion.compositing.graph.set", domain: "authoring", permission: "edit_motion", mutates: true },
  { command: "motion.compositing.graph.remove", domain: "authoring", permission: "edit_motion", mutates: true },
  { command: "motion.procedural.inspect", domain: "authoring", permission: "read_motion", mutates: false },
  { command: "motion.procedural.audio-envelope.produce", domain: "authoring", permission: "edit_motion", mutates: true },
  { command: "motion.procedural.relationship.set", domain: "authoring", permission: "edit_motion", mutates: true },
  { command: "motion.procedural.relationship.enabled.set", domain: "authoring", permission: "edit_motion", mutates: true },
  { command: "motion.procedural.relationship.bake", domain: "authoring", permission: "edit_motion", mutates: true },
  { command: "motion.procedural.relationship.detach", domain: "authoring", permission: "edit_motion", mutates: true },
  { command: "motion.timeline.cutout.rig.bake", domain: "authoring", permission: "edit_motion", mutates: true },
  { command: "motion.scene3d.gltf.import", domain: "authoring", permission: "write_local", mutates: true },
  { command: "motion.lottie.import", domain: "authoring", permission: "write_local", mutates: true },
  { command: "motion.dotlottie.import", domain: "authoring", permission: "write_local", mutates: true },
  { command: "motion.timeline.panel", domain: "timeline", permission: "read_motion", mutates: false },
  { command: "motion.timeline.inspect", domain: "timeline", permission: "read_motion", mutates: false },
  { command: "motion.timeline.playhead.set", domain: "timeline", permission: "draft_motion", mutates: true },
  { command: "motion.timeline.range.select", domain: "timeline", permission: "draft_motion", mutates: true },
  { command: "motion.timeline.viewport.set", domain: "timeline", permission: "draft_motion", mutates: true },
  { command: "motion.timeline.duration.policy", domain: "timeline", permission: "read_motion", mutates: false },
  { command: "motion.timeline.duration.policy.set", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.timeline.scene.create", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.timeline.scene.delete", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.timeline.scene.reorder", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.timeline.scene.resize", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.timeline.scene.name.set", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.timeline.marker.upsert", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.timeline.marker.delete", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.timeline.keyframe.upsert", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.timeline.keyframe.delete", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.timeline.keyframe.range.delete", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.timeline.keyframe.move", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.timeline.keyframe.easing.apply", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.timeline.keyframe.shift", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.timeline.keyframe.scale", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.timeline.keyframe.duplicate", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.timeline.keyframe.distribute", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.timeline.keyframe.reverse", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.timeline.keyframe.snap", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.timeline.spatial.position.upsert", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.timeline.spatial.position.move", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.timeline.spatial.position.delete", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.revision.transaction.plan", domain: "timeline", permission: "read_motion", mutates: false },
  { command: "motion.revision.transaction", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.timeline.keyframes.panel", domain: "timeline", permission: "read_motion", mutates: false },
  { command: "motion.timeline.transitions.panel", domain: "timeline", permission: "read_motion", mutates: false },
  { command: "motion.timeline.easing.panel", domain: "timeline", permission: "read_motion", mutates: false },
  { command: "motion.timeline.easing.presets", domain: "timeline", permission: "read_motion", mutates: false },
  { command: "motion.timeline.animation.presets", domain: "timeline", permission: "read_motion", mutates: false },
  { command: "motion.timeline.animation.preset.apply", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.timeline.transition.presets", domain: "timeline", permission: "read_motion", mutates: false },
  { command: "motion.timeline.transition.preset.apply", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.timeline.layer.create", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.timeline.layer.trim", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.timeline.layer.split", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.timeline.layer.text.set", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.timeline.layer.style.set", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.timeline.layer.transform.set", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.timeline.layer.effect.set", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.timeline.layer.rich.set", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.timeline.layer.blend.set", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.timeline.layer.crop.set", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.timeline.layer.mask.set", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.timeline.layer.fit.set", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.timeline.layer.media.set", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.timeline.layer.name.set", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.timeline.layer.visibility.set", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.timeline.layer.lock", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.timeline.layer.delete", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.timeline.layer.duplicate", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.timeline.layer.reorder", domain: "timeline", permission: "edit_motion", mutates: true },
  ...TIMELINE_EXTENSION_COMMAND_DEFINITIONS,
  { command: "motion.timeline.cleanup", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.timeline.track.create", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.timeline.track.reorder", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.timeline.track.delete", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.timeline.track.rename", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.timeline.track.lock", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.timeline.track.mute", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.timeline.track.solo", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.timeline.track.volume", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.timeline.track.fade", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.timeline.track.pan", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.timeline.layer.ducking.set", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.timeline.layer.track.assign", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.timeline.caption.import", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.timeline.caption.upsert", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.timeline.transition.upsert", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.timeline.transition.delete", domain: "timeline", permission: "edit_motion", mutates: true },
  { command: "motion.export.presets", domain: "surface", permission: "read_motion", mutates: false },
  { command: "motion.export.panel", domain: "surface", permission: "read_motion", mutates: false },
  { command: "motion.export.plan", domain: "surface", permission: "read_motion", mutates: false },
  { command: "motion.package.archive", domain: "workspace", permission: "write_local", mutates: true },
  { command: "motion.package.extract", domain: "workspace", permission: "write_local", mutates: true },
  { command: "motion.review.html.bundle", domain: "workspace", permission: "write_local", mutates: true },
  { command: "motion.source.import", domain: "authoring", permission: "write_local", mutates: true },
  { command: "motion.source.to_scripted_video", domain: "authoring", permission: "write_local", mutates: true },
  { command: "motion.html.snippet.export", domain: "authoring", permission: "write_local", mutates: true },
  { command: "motion.html.snippet.import", domain: "authoring", permission: "write_local", mutates: true },
  { command: "motion.otio.export", domain: "authoring", permission: "write_local", mutates: true },
  { command: "motion.otio.import", domain: "authoring", permission: "write_local", mutates: true },
  { command: "motion.canvas.package", domain: "integration", permission: "write_local", mutates: true },
  { command: "motion.canvas.bridge_export", domain: "integration", permission: "write_local", mutates: true },
  { command: "motion.browser.workflow.capture", domain: "integration", permission: "render_motion", mutates: true },
  // Canvas-to-MP4 creates a package, resource catalog, receipts, and final output outside an
  // existing package. Its authority is therefore write_local, not merely render_motion.
  { command: "motion.connector.canvas_to_mp4", domain: "integration", permission: "write_local", mutates: true },
  { command: "motion.connector.canvas_to_cut", domain: "integration", permission: "write_local", mutates: true },
  { command: "motion.connector.script_to_cut", domain: "integration", permission: "write_local", mutates: true },
  { command: "motion.connector.source_to_cut", domain: "integration", permission: "write_local", mutates: true },
  { command: "motion.connector.cut_generate_to_cut", domain: "integration", permission: "write_local", mutates: true },
  { command: "motion.connector.template_to_cut", domain: "integration", permission: "write_local", mutates: true },
  { command: "motion.quality.panel", domain: "render", permission: "read_motion", mutates: false },
  { command: "motion.quality.check", domain: "render", permission: "render_motion", mutates: true },
  { command: "motion.template.catalog", domain: "authoring", permission: "read_motion", mutates: false },
  { command: "motion.template.plan", domain: "authoring", permission: "read_motion", mutates: false },
  { command: "motion.template.panel", domain: "authoring", permission: "read_motion", mutates: false },
  { command: "motion.template.controls", domain: "authoring", permission: "read_motion", mutates: false },
  { command: "motion.template.apply", domain: "authoring", permission: "edit_motion", mutates: true },
  { command: "motion.template.media.replace", domain: "authoring", permission: "edit_motion", mutates: true },
  { command: "motion.support.bundle", domain: "workspace", permission: "write_local", mutates: true },
  { command: "motion.package.patch", domain: "workspace", permission: "edit_motion", mutates: true }
] as const satisfies readonly MotionDebugCommandDefinitionBase[];

export type MotionDebugCommand = (typeof COMMAND_DEFINITIONS)[number]["command"]; export type MotionDebugCommandDefinition = (typeof COMMAND_DEFINITIONS)[number];

export interface MotionDebugCommandContract {
  command: MotionDebugCommand;
  domain: MotionDebugDomain;
  permission: MotionPermissionTier;
  mutates: boolean; purpose?: string;
  argsSchema?: MotionDebugArgsSchema;
  expectedReceipts?: MotionDebugExpectedReceipt[];
}

export type MotionDebugResult =
  | { ok: true; result?: unknown; receiptId?: string; visibleState?: unknown; warnings: string[] }
  | {
      ok: false;
      error: { code: string; message: string; retryable?: boolean; remedy?: import("@shellx-motion/core").JobRemedyKind; retryAfterMs?: number; suggestedAction?: string; detail?: unknown };
      result?: unknown;
      receiptId?: string;
      visibleState?: unknown;
      warnings: string[];
    };

export type MotionDebugCommandMetadata = Partial<Record<MotionDebugCommand, Pick<MotionDebugCommandContract, "argsSchema" | "expectedReceipts">>>;

const COMMAND_BY_ID = new Map<MotionDebugCommand, MotionDebugCommandDefinition>(
  COMMAND_DEFINITIONS.map((definition) => [definition.command, definition])
);
if (COMMAND_BY_ID.size !== COMMAND_DEFINITIONS.length) throw new Error("Motion debug command registry contains duplicate commands");

export const DEBUG_COMMANDS: readonly MotionDebugCommand[] = Object.freeze(COMMAND_DEFINITIONS.map((definition) => definition.command));

export function debugCommandDefinition(command: unknown): MotionDebugCommandDefinition | null { return typeof command === "string" ? COMMAND_BY_ID.get(command as MotionDebugCommand) ?? null : null; }

export function buildDebugCommandContracts(metadata: MotionDebugCommandMetadata): MotionDebugCommandContract[] {
  return COMMAND_DEFINITIONS.map((definition) => {
    const commandMetadata = metadata[definition.command];
    return {
      ...definition,
      ...(commandMetadata?.argsSchema ? { argsSchema: commandMetadata.argsSchema } : {}),
      ...(commandMetadata?.expectedReceipts ? { expectedReceipts: commandMetadata.expectedReceipts } : {})
    };
  });
}

export function debugCommandsByDomain(domain: MotionDebugDomain): MotionDebugCommand[] { return COMMAND_DEFINITIONS.filter((definition) => definition.domain === domain).map((definition) => definition.command); }
