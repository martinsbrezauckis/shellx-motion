/**
 * Multi-phase workflow detection for `motion.actions.guide` / `motion.actions.plan`.
 *
 * Role: the catalog matches a request to ONE action. That is correct for "trim layer" and wrong
 * for "create a package with animated layers and render it", which names a pipeline. Before this
 * module the single best alias won and the rest of the request was silently dropped:
 *   - guide("create package with animated layers and render")
 *       -> motion.package.create, motion.package.validate      (stops at an empty scaffold)
 *   - plan("create original animated package and render mp4")
 *       -> motion.render.final, motion.render.status, ...      (renders a package that never existed)
 * An agent following either plan alone cannot complete the task it asked about, which for an
 * agent-first product is a functional defect and not a wording problem.
 *
 * Mechanism: classify the request into ordered pipeline PHASES. Two or more distinct phases means
 * the request is a workflow, and the returned plan is the whole pipeline instead of one action.
 * A single phase falls through to the existing single-action path, so narrow requests are unchanged.
 *
 * Dependencies: types only, from `./catalog.js` (type-only, matching `catalog-compositing.ts` and
 * the other modular catalogs; erased at runtime, so there is no module cycle).
 *
 * Primary caller: `planAction` in `./catalog.ts`. `guideAction` delegates to it.
 */
import type { MotionAction, MotionActionPlan, MotionActionPlanStep, MotionPermissionTier } from "./catalog.js";

/** Pipeline phases, declared in the order a package is actually built. */
export type MotionWorkflowPhaseId = "create" | "layers" | "animate" | "preview" | "render";

/** One phase of a detected workflow, resolved to the catalog action that owns it. */
export interface MotionWorkflowPhase {
  id: MotionWorkflowPhaseId;
  label: string;
  /** Catalog action this phase is drawn from, so a caller can read its aliases and verify list. */
  actionId: string;
  /** Ordered debug commands this phase contributes to the plan. */
  calls: string[];
  /**
   * False when the request named this phase, true when the pipeline requires it anyway.
   * Stated rather than hidden: an agent should be able to see which steps it did not ask for.
   */
  implied: boolean;
}

/** A request that spans more than one pipeline phase. */
export interface MotionWorkflow {
  id: "motion.workflow.authoring";
  label: string;
  phases: MotionWorkflowPhase[];
  /** Flattened, de-duplicated, canonically ordered command sequence. */
  calls: string[];
  requestedPhaseIds: MotionWorkflowPhaseId[];
  impliedPhaseIds: MotionWorkflowPhaseId[];
}

/** Ascending permission order; duplicated from the catalog's own list to avoid a value import. */
const TIER_RANK: MotionPermissionTier[] = ["read_motion", "draft_motion", "render_motion", "edit_motion", "write_local", "push_remote"];

/**
 * Canonical phase order. `calls` is the phase's contribution to the pipeline, not the owning
 * action's full `calls` list: an action lists its own verification tail, and concatenating five of
 * those produces a 20-step plan that repeats `motion.receipts.read` four times. The single shared
 * verification tail is appended once, at the end, by `buildWorkflowPlan`.
 */
const PHASES: Array<Omit<MotionWorkflowPhase, "implied">> = [
  {
    id: "create",
    label: "Create the package",
    actionId: "motion.package.create",
    calls: ["motion.package.create", "motion.package.validate"]
  },
  {
    id: "layers",
    label: "Add the layers",
    actionId: "motion.timeline.layer.create",
    // `motion.state` first: the agent needs the existing layer ids before it can target anything,
    // including in a package it just created (create seeds a placeholder layer by default).
    calls: ["motion.state", "motion.timeline.layer.create", "motion.timeline.inspect"]
  },
  {
    id: "animate",
    label: "Animate the layers",
    actionId: "motion.timeline.keyframe.upsert",
    calls: ["motion.timeline.keyframe.upsert"]
  },
  {
    id: "preview",
    label: "Preview a frame",
    actionId: "motion.preview.frame",
    calls: ["motion.preview.frame"]
  },
  {
    id: "render",
    label: "Render the final output",
    actionId: "motion.render.final",
    calls: ["motion.render.final", "motion.render.status"]
  }
];

/** Every workflow plan ends by reading the evidence, exactly once. */
const VERIFICATION_TAIL = "motion.receipts.read";

/**
 * Words that name a phase. Matched against the normalized request with word boundaries, so
 * "rendered" and "renders" hit via their stems below but "surrender" does not.
 */
const PHASE_WORDS: Record<MotionWorkflowPhaseId, string[]> = {
  create: ["create", "creates", "creating", "new", "scratch", "original", "scaffold", "bootstrap", "init", "initialise", "initialize", "author", "authored"],
  layers: ["layer", "layers"],
  // "easing" is deliberately absent: it is an attribute of keyframes that already exist, so
  // "change transition easing and preview it" is one edit plus a check, not an authoring pipeline.
  animate: ["animate", "animates", "animated", "animating", "animation", "keyframe", "keyframes"],
  preview: ["preview", "previews", "previewed"],
  render: ["render", "renders", "rendering", "export", "exports", "exported", "encode", "mp4", "webm", "mov", "prores", "gif", "final"]
};

/**
 * The `create` phase additionally requires a subject noun.
 *
 * Without it "create text layer" would score as create + layers and be promoted to a full
 * end-to-end pipeline, when it is a single edit against a package that already exists. The verb
 * alone does not distinguish "make a new package" from "make a new layer inside this one".
 */
const CREATE_SUBJECTS = ["package", "project", "motion", "video", "animation", "animated", "scene", "composition", "graphic", "movie", "clip"];

/**
 * Phases that make a request an authoring pipeline rather than an edit.
 *
 * A workflow needs somewhere for the content to come from. Without this rule
 * "change transition easing and preview it" reads as animate + preview and is promoted to a
 * ten-step pipeline, when it is one edit against a package that already exists — the request the
 * single-action path answers correctly.
 */
const ORIGIN_PHASES: MotionWorkflowPhaseId[] = ["create", "layers"];

/** Lowercase, strip punctuation, collapse whitespace. Shared with the catalog's alias matcher. */
export function normalizeRequest(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Classify a request into pipeline phases.
 *
 * @param request - the caller's natural-language request.
 * @returns null when the request is not an authoring pipeline, meaning the single-action path is
 *   correct; otherwise the expanded pipeline.
 *
 * The trigger is an ORIGIN phase plus at least one other: a request has to say where the content
 * comes from before "and render it" describes a pipeline rather than an edit.
 */
export function detectMotionWorkflow(request: string): MotionWorkflow | null {
  const words = new Set(normalizeRequest(request).split(" "));
  const requested = new Set<MotionWorkflowPhaseId>();
  for (const phase of PHASES) {
    if (!PHASE_WORDS[phase.id].some((word) => words.has(word))) continue;
    if (phase.id === "create" && !CREATE_SUBJECTS.some((subject) => words.has(subject))) continue;
    requested.add(phase.id);
  }
  if (requested.size < 2 || !ORIGIN_PHASES.some((phase) => requested.has(phase))) return null;

  const selected = new Set(requested);
  // You cannot keyframe a layer you do not have, and a freshly created package holds a placeholder
  // layer rather than the agent's content. So a create-and-animate (or create-and-render) request
  // needs a layer step even when it never said "layer".
  if (selected.has("create") && (selected.has("animate") || selected.has("render"))) selected.add("layers");
  // Preview before a final render: it is the cheap check that the frames are not blank, and it is
  // the step an agent skips when the plan does not name it.
  if (selected.has("render") && (selected.has("create") || selected.has("layers") || selected.has("animate"))) selected.add("preview");

  const phases = PHASES
    .filter((phase) => selected.has(phase.id))
    .map((phase): MotionWorkflowPhase => ({ ...phase, calls: [...phase.calls], implied: !requested.has(phase.id) }));
  const calls = [...new Set(phases.flatMap((phase) => phase.calls)).values()].filter((call) => call !== VERIFICATION_TAIL);
  calls.push(VERIFICATION_TAIL);

  return {
    id: "motion.workflow.authoring",
    label: phases.map((phase) => phase.label).join(" -> "),
    phases,
    calls,
    requestedPhaseIds: phases.filter((phase) => !phase.implied).map((phase) => phase.id),
    impliedPhaseIds: phases.filter((phase) => phase.implied).map((phase) => phase.id)
  };
}

/** Everything `buildWorkflowPlan` needs from `catalog.ts` without importing values from it. */
export interface WorkflowPlanInput {
  request: string;
  workflow: MotionWorkflow;
  actions: MotionAction[];
  purposeForCall: (call: string) => string;
  verificationForCalls: (calls: string[]) => string[];
}

/**
 * Turn a detected workflow into the plan the two planning commands return.
 *
 * @returns a plan whose `steps` are the whole pipeline. `action` is the phase the pipeline starts
 *   from rather than the single best alias match, because a workflow has no single owning action
 *   and naming the last phase (what `plan` used to return for "create ... and render") is what made
 *   the authoring half disappear.
 *
 * `cautions` states the tier span explicitly: a workflow plan routinely crosses write_local,
 * edit_motion and render_motion, and a caller granted less will be refused mid-pipeline.
 */
export function buildWorkflowPlan(input: WorkflowPlanInput): MotionActionPlan {
  const { request, workflow, actions } = input;
  const phaseActions = workflow.phases
    .map((phase) => actions.find((action) => action.id === phase.actionId))
    .filter((action): action is MotionAction => Boolean(action));
  const steps: MotionActionPlanStep[] = workflow.calls.map((call, index) => ({
    order: index + 1,
    call,
    purpose: input.purposeForCall(call)
  }));
  const highestTier = phaseActions.reduce<MotionPermissionTier>(
    (highest, action) => (TIER_RANK.indexOf(action.permission) > TIER_RANK.indexOf(highest) ? action.permission : highest),
    "read_motion"
  );
  const cautions = [
    `This request names ${workflow.requestedPhaseIds.length} phases of the authoring pipeline, so the plan is the end-to-end sequence rather than a single action.`,
    `Steps span permission tiers up to ${highestTier}. A step above the tier this caller was granted fails with permission_denied, and a caller cannot raise its own tier.`
  ];
  if (workflow.impliedPhaseIds.length > 0) {
    cautions.push(`Steps for ${workflow.impliedPhaseIds.join(", ")} were added because the named phases cannot be completed without them.`);
  }
  return {
    ok: true,
    topic: request,
    action: phaseActions[0] ?? null,
    steps,
    verify: [...new Set([...phaseActions.flatMap((action) => action.verify), ...input.verificationForCalls(workflow.calls)])],
    cautions,
    examples: [],
    // The other phases, rather than an arbitrary slice of the catalog: these are the actions whose
    // aliases and verify lists explain the steps the agent is about to run.
    related: phaseActions.slice(1),
    workflow
  };
}
