import { buildActionMatch, nearestActions, type MotionActionMatch, type MotionActionSummary } from "./catalog-find.js";
import { MODULAR_ACTIONS } from "./catalog-modular.js";
// The static surface-to-command-id table lives in ./catalog-surface-commands to satisfy the module-size gate.
import { SURFACE_COMMANDS } from "./catalog-surface-commands.js";
// Multi-phase request handling lives in ./catalog-workflows (module-size gate).
import { buildWorkflowPlan, detectMotionWorkflow, normalizeRequest, type MotionWorkflow } from "./catalog-workflows.js";

export { nearestActions, type MotionActionMatch, type MotionActionSummary } from "./catalog-find.js";
export type { MotionWorkflow, MotionWorkflowPhase, MotionWorkflowPhaseId } from "./catalog-workflows.js";
export { debugServerGrantHint, requestedTierRefusal, tierRefusal, trustedRootRefusal,
  type MotionTierRefusal, type MotionTierRefusalDetail, type TierRefusalInput } from "./permission-refusal.js";

export type MotionPermissionTier =
  | "read_motion"
  | "draft_motion"
  | "render_motion"
  | "edit_motion"
  | "write_local"
  | "push_remote";

export interface MotionAction {
  id: string;
  aliases: string[];
  permission: MotionPermissionTier;
  mutates: boolean;
  calls: string[];
  verify: string[];
  surfaces: string[];
}

export interface MotionActionPlanStep {
  order: number;
  call: string;
  purpose: string;
}

export interface MotionActionPlan {
  ok: true;
  topic: string;
  action: MotionAction | null;
  steps: MotionActionPlanStep[];
  verify: string[];
  cautions: string[];
  related: MotionAction[];
  /**
   * Present when the request named more than one pipeline phase, e.g. "create a package with
   * animated layers and render it". `steps` is then the whole pipeline and `action` is the phase it
   * starts from; this field says which phases were named and which were added to make them
   * reachable. Absent for a single-action request, where `action` is the whole answer.
   */
  workflow?: MotionWorkflow;
}

export const ACTIONS: MotionAction[] = [
  {
    id: "motion.actions.find",
    aliases: ["find action", "what can motion do", "discover action"],
    permission: "read_motion",
    mutates: false,
    calls: ["motion.actions.find"],
    verify: ["Returns a matching action id or null."],
    surfaces: ["prompt"]
  },
  {
    id: "motion.actions.panel",
    aliases: [
      "show prompt action panel",
      "prompt action panel",
      "action panel",
      "show action panel",
      "open action panel",
      "show action catalog",
      "show prompt tools"
    ],
    permission: "read_motion",
    mutates: false,
    calls: ["motion.actions.panel"],
    verify: ["Action panel returns grouped actions, permission counts, prompt commands, and suggested prompt-run follow-ups."],
    surfaces: ["prompt"]
  },
  {
    id: "motion.capabilities.match",
    aliases: [
      "capabilities match",
      "renderer capability match",
      "choose renderer lane",
      "select renderer lane",
      "pick renderer lane",
      "choose renderer lane for mp4 with audio",
      "which renderer lane should I use",
      "explain renderer lane support",
      "check lane capability cards",
      "match motion package to render lane"
    ],
    permission: "read_motion",
    mutates: false,
    calls: ["motion.capabilities.match"],
    verify: ["Capability match returns lane cards, output/audio/alpha fit, unsupported features, recommended lane, and frame-to-final pipeline when final encoding needs a frame lane."],
    surfaces: ["prompt", "preview"]
  },
  {
    id: "motion.capabilities.panel",
    aliases: [
      "show renderer capability panel",
      "renderer capability panel",
      "show lane capability cards",
      "show render lane cards",
      "show capabilities panel",
      "inspect renderer lanes",
      "inspect lane support",
      "renderer lane panel"
    ],
    permission: "read_motion",
    mutates: false,
    calls: ["motion.capabilities.panel"],
    verify: ["Capability panel returns grouped lane cards, support badges, package fit, recommended lane, and follow-up match/export actions."],
    surfaces: ["prompt", "preview"]
  },
  {
    id: "motion.agent.panel",
    aliases: [
      "show local cli agent readiness panel",
      "show agent readiness panel",
      "agent readiness panel",
      "local cli agent panel",
      "show cli subscription agent policy",
      "show prompt agent policy",
      "inspect local agent adapters"
    ],
    permission: "read_motion",
    mutates: false,
    calls: ["motion.agent.panel"],
    verify: ["Agent panel returns default local CLI selection policy, adapter command shapes, safety guarantees, receipt coverage, and prompt follow-ups without probing or mutating packages."],
    surfaces: ["prompt"]
  },
  {
    id: "motion.agent.health",
    aliases: [
      "check local cli agent health",
      "agent health",
      "check agent health",
      "local agent readiness",
      "codex claude grok readiness",
      "show cli subscription agent status"
    ],
    permission: "read_motion",
    mutates: false,
    calls: ["motion.agent.health"],
    verify: ["Agent health returns local CLI subscription adapter readiness, transport, billing mode, and unavailable reasons without mutating packages."],
    surfaces: ["prompt"]
  },
  {
    id: "motion.agent.transcript",
    aliases: [
      "show agent transcript",
      "agent transcript",
      "prompt transcript",
      "transcript panel",
      "show prompt run transcript",
      "inspect agent messages"
    ],
    permission: "read_motion",
    mutates: false,
    calls: ["motion.agent.transcript", "motion.receipts.read"],
    verify: ["Agent transcript digest returns prompt and agent receipt links with redacted transcript messages."],
    surfaces: ["receipts", "prompt"]
  },
  {
    id: "motion.agent.revision.plan",
    aliases: [
      "create agent revision plan",
      "critique render and revise",
      "make revision plan from quality receipt",
      "review contact sheet and quality receipt",
      "plan prompt revision",
      "agent critique revise loop"
    ],
    permission: "write_local",
    mutates: true,
    calls: ["motion.agent.revision.plan", "motion.quality.check", "motion.prompt.run"],
    verify: ["Agent revision plan returns quality/contact-sheet findings, exact package/template ids, proposal-only mutation policy, and prompt-run follow-up actions before package mutation."],
    surfaces: ["receipts", "prompt", "review"]
  },
  {
    id: "motion.packages.browse",
    aliases: [
      "browse motion packages",
      "package browser",
      "show package browser",
      "list motion packages",
      "show motion packages",
      "open package browser"
    ],
    permission: "read_motion",
    mutates: false,
    calls: ["motion.packages.browse"],
    verify: ["Package browser returns package cards, template availability, asset counts, brand provenance, and skipped-package warnings."],
    surfaces: ["packages", "prompt"]
  },
  {
    id: "motion.timeline.panel",
    aliases: [
      "show timeline panel",
      "timeline panel",
      "open timeline panel",
      "show scene layer timeline",
      "show scene and layer timeline",
      "show timeline layers"
    ],
    permission: "read_motion",
    mutates: false,
    calls: ["motion.timeline.panel"],
    verify: ["Timeline panel returns playhead controls, scene and layer rows, markers, tracks, and suggested actions."],
    surfaces: ["timeline", "prompt"]
  },
  {
    id: "motion.timeline.keyframes.panel",
    aliases: [
      "show keyframe panel",
      "keyframe panel",
      "show keyframes panel",
      "timeline keyframes panel",
      "inspect keyframe panel",
      "show animated keyframes",
      "inspect timeline keyframes",
      "show easing keyframes"
    ],
    permission: "read_motion",
    mutates: false,
    calls: ["motion.timeline.keyframes.panel"],
    verify: ["Keyframe panel returns animated layers, target ranges, easing usage, preset counts, and suggested keyframe actions."],
    surfaces: ["timeline", "prompt"]
  },
  {
    id: "motion.timeline.transitions.panel",
    aliases: [
      "show timeline transition panel",
      "timeline transition panel",
      "show transition panel",
      "transition panel",
      "show transitions panel",
      "timeline transitions panel",
      "inspect transition panel",
      "show enter exit transitions",
      "inspect timeline transitions",
      "show transition easing"
    ],
    permission: "read_motion",
    mutates: false,
    calls: ["motion.timeline.transitions.panel"],
    verify: ["Transition panel returns layers with enter/exit transitions, timing windows, easing usage, type counts, and suggested transition actions."],
    surfaces: ["timeline", "prompt"]
  },
  {
    id: "motion.receipts.panel",
    aliases: [
      "show receipt panel",
      "receipt panel",
      "receipts panel",
      "receipt summary",
      "show receipt summary",
      "summarize receipts"
    ],
    permission: "read_motion",
    mutates: false,
    calls: ["motion.receipts.panel", "motion.receipts.read"],
    verify: [
      "Receipt panel summary returns counts, recent receipts, warnings, failures, and artifact links.",
      "Receipt panel summaries expose compact quality-manifest gate status on relevant receipts."
    ],
    surfaces: ["receipts", "prompt"]
  },
  {
    id: "motion.assets.panel",
    aliases: [
      "show asset panel",
      "asset panel",
      "show package assets",
      "list package assets",
      "show motion assets",
      "show layer asset usage"
    ],
    permission: "read_motion",
    mutates: false,
    calls: ["motion.assets.panel"],
    verify: ["Asset panel returns declared assets, layer references, missing assets, hashes, and usage counts."],
    surfaces: ["assets", "prompt"]
  },
  {
    id: "motion.media.panel",
    aliases: [
      "show media panel",
      "media panel",
      "show media readiness panel",
      "media readiness panel",
      "inspect media layers",
      "review package media",
      "check media sources",
      "media layer readiness",
      "show image video audio web layers"
    ],
    permission: "read_motion",
    mutates: false,
    calls: ["motion.media.panel"],
    verify: ["Media panel returns image, video, audio, and web layer source readiness, trim/loop/playback controls, and export-preset compatibility warnings."],
    surfaces: ["assets", "timeline", "preview", "prompt"]
  },
  {
    id: "motion.brand.panel",
    aliases: [
      "show brand pack panel",
      "brand pack panel",
      "show brand panel",
      "show design tokens",
      "show brand tokens",
      "inspect brand kit"
    ],
    permission: "read_motion",
    mutates: false,
    calls: ["motion.brand.panel"],
    verify: ["Brand panel returns design-token groups, color tokens, typography tokens, and source provenance."],
    surfaces: ["brand", "prompt"]
  },
  {
    id: "motion.audio.panel",
    aliases: [
      "show audio mix panel",
      "audio mix panel",
      "audio panel",
      "show audio panel",
      "inspect audio mix",
      "show resolved audio inputs",
      "show music narration mix",
      "audio export compatibility",
      "check audio export warnings"
    ],
    permission: "read_motion",
    mutates: false,
    calls: ["motion.audio.panel"],
    verify: ["Audio panel returns resolved audio inputs, automation counts, track controls, ducking, and export-preset compatibility warnings."],
    surfaces: ["timeline", "prompt"]
  },
  {
    id: "motion.package.patch",
    aliases: ["edit package", "change template", "update motion"],
    permission: "edit_motion",
    mutates: true,
    calls: ["motion.state", "motion.package.patch", "motion.receipts.read"],
    verify: ["Package diff receipt includes changed paths and input hashes."],
    surfaces: ["timeline", "templateInspector", "prompt"]
  },
  {
    id: "motion.template.plan",
    aliases: [
      "prompt to template plan for cut generate",
      "prompt to template plan",
      "plan template from prompt",
      "choose template for prompt",
      "plan lower third template",
      "template plan"
    ],
    permission: "read_motion",
    mutates: false,
    calls: ["motion.template.catalog", "motion.template.plan"],
    verify: ["Template plan returns selected template, request-fit suitability score, target fit, provided/default/missing input readiness, semantic story and media slots, representative review frames, quality gates, the apply-review-render-quality-revise-handoff loop, and follow-up actions before mutation."],
    surfaces: ["templateInspector", "prompt"]
  },
  {
    id: "motion.template.catalog",
    aliases: ["list motion templates in generate", "list motion templates", "show template catalog", "template catalog", "browse motion templates"],
    permission: "read_motion",
    mutates: false,
    calls: ["motion.template.catalog"],
    verify: ["Template catalog returns package ids, template ids, compatible hosts/lanes, control counts, suitability metadata, and suggested follow-up actions."],
    surfaces: ["templateInspector", "prompt"]
  },
  {
    id: "motion.template.panel",
    aliases: [
      "show template inspector panel",
      "template inspector panel",
      "open template inspector",
      "show template panel",
      "inspect template controls panel",
      "show grouped template controls"
    ],
    permission: "read_motion",
    mutates: false,
    calls: ["motion.template.panel"],
    verify: ["Template panel returns grouped controls, bindings, current values, suitability metadata, control type counts, and follow-up actions."],
    surfaces: ["templateInspector", "prompt"]
  },
  {
    id: "motion.template.controls",
    aliases: [
      "show editable template controls",
      "list template controls",
      "template control discovery",
      "inspect template params",
      "what fields can I edit"
    ],
    permission: "read_motion",
    mutates: false,
    calls: ["motion.state", "motion.template.controls"],
    verify: ["Template control response includes params, controls, bindings, and compatible lanes."],
    surfaces: ["templateInspector", "prompt"]
  },
  {
    id: "motion.template.apply",
    aliases: [
      "apply template control title",
      "set template control",
      "change template parameter",
      "update editable template field",
      "apply template controls"
    ],
    permission: "edit_motion",
    mutates: true,
    calls: ["motion.state", "motion.template.controls", "motion.template.apply", "motion.preview.frame", "motion.receipts.read"],
    verify: [
      "Template apply receipt includes changed param ids and bound MotionIR paths.",
      "Preview receipt includes output frame hash after applying controls."
    ],
    surfaces: ["templateInspector", "preview", "receipts", "prompt"]
  },
  {
    id: "motion.template.media.replace",
    aliases: [
      "replace template media slot",
      "replace media slot",
      "swap template image",
      "change template asset",
      "replace template asset",
      "set template media"
    ],
    permission: "edit_motion",
    mutates: true,
    calls: ["motion.state", "motion.template.controls", "motion.template.media.replace", "motion.preview.frame", "motion.receipts.read"],
    verify: [
      "Template media replace receipt includes param id, copied asset ref, changed bindings, manifest asset refs, and validation result.",
      "Preview receipt includes output frame hash after replacing media."
    ],
    surfaces: ["templateInspector", "preview", "receipts", "prompt"]
  },
  {
    id: "motion.preview.panel",
    aliases: [
      "show preview player panel",
      "preview player panel",
      "preview player",
      "show preview panel",
      "open preview panel",
      "preview panel"
    ],
    permission: "read_motion",
    mutates: false,
    calls: ["motion.preview.panel"],
    verify: ["Preview player panel returns package facts, playhead state, active timeline refs, preview modes, and render follow-ups without rendering."],
    surfaces: ["preview", "prompt"]
  },
  {
    id: "motion.preview.frame",
    aliases: ["preview", "show frame", "render still", "preview it"],
    permission: "render_motion",
    mutates: false,
    calls: ["motion.preview.frame", "motion.receipts.read"],
    verify: ["Preview receipt includes output frame hash."],
    surfaces: ["preview", "receipts", "prompt"]
  },
  {
    id: "motion.preview.playhead",
    aliases: ["preview current playhead", "preview playhead", "render playhead", "show playhead frame", "preview timeline playhead"],
    permission: "render_motion",
    mutates: false,
    calls: ["motion.preview.playhead", "motion.receipts.read"],
    verify: ["Playhead preview receipt includes timeline state, output frame hash, timestamp, and artifact path."],
    surfaces: ["preview", "receipts", "prompt"]
  },
  {
    id: "motion.preview.strip",
    aliases: ["preview strip", "show preview strip", "thumbnail strip", "show timeline thumbnail strip", "storyboard strip", "show timeline thumbnails"],
    permission: "render_motion",
    mutates: false,
    calls: ["motion.preview.strip", "motion.receipts.read"],
    verify: ["Preview strip receipt includes per-frame output hashes, timestamps, and artifact paths."],
    surfaces: ["preview", "receipts", "prompt"]
  },
  {
    id: "motion.timeline.inspect",
    aliases: [
      "inspect scenes tracks and timeline markers",
      "inspect timeline",
      "show timeline tracks",
      "show timeline markers",
      "list scenes and tracks",
      "timeline metadata"
    ],
    permission: "read_motion",
    mutates: false,
    calls: ["motion.timeline.inspect"],
    verify: ["Timeline inspect result includes scenes, tracks, markers, and layer track refs."],
    surfaces: ["timeline", "prompt"]
  },
  {
    id: "motion.timeline.playhead.set",
    aliases: [
      "set timeline playhead to 2 seconds",
      "set timeline playhead",
      "move timeline playhead",
      "scrub timeline playhead",
      "jump playhead",
      "set playhead",
      "move playhead",
      "scrub to timestamp"
    ],
    permission: "draft_motion",
    mutates: true,
    calls: ["motion.state", "motion.timeline.playhead.set", "motion.receipts.read"],
    verify: ["Timeline playhead receipt includes old/new playhead, state path, duration guard, and host receipt evidence."],
    surfaces: ["timeline", "receipts", "prompt"]
  },
  {
    id: "motion.timeline.range.select",
    aliases: [
      "select timeline range",
      "set timeline range selection",
      "select range on timeline",
      "mark timeline range",
      "set in and out points",
      "select in out range",
      "choose timeline segment"
    ],
    permission: "draft_motion",
    mutates: true,
    calls: ["motion.state", "motion.timeline.range.select", "motion.receipts.read"],
    verify: ["Timeline range receipt includes selected start/end, previous range, state path, and duration guard."],
    surfaces: ["timeline", "receipts", "prompt"]
  },
  {
    id: "motion.timeline.viewport.set",
    aliases: [
      "zoom timeline viewport",
      "set timeline viewport",
      "change timeline zoom",
      "zoom timeline",
      "pan timeline viewport",
      "fit timeline range",
      "set timeline pixels per second"
    ],
    permission: "draft_motion",
    mutates: true,
    calls: ["motion.state", "motion.timeline.viewport.set", "motion.receipts.read"],
    verify: ["Timeline viewport receipt includes start/end, zoom, pixels-per-second, previous viewport, and state path."],
    surfaces: ["timeline", "receipts", "prompt"]
  },
  {
    id: "motion.timeline.duration.policy",
    aliases: [
      "show protected intro outro regions",
      "show duration policy",
      "inspect duration policy",
      "read duration policy",
      "show protected regions",
      "list protected timeline regions",
      "show intro outro locks",
      "inspect protected duration regions"
    ],
    permission: "read_motion",
    mutates: false,
    calls: ["motion.timeline.duration.policy"],
    verify: ["Duration policy read returns min/max duration, resize mode, protected regions, and package duration."],
    surfaces: ["timeline", "prompt"]
  },
  {
    id: "motion.timeline.duration.policy.set",
    aliases: [
      "set protected intro outro duration policy",
      "set duration policy",
      "edit duration policy",
      "set protected regions",
      "protect intro outro regions",
      "protect intro and outro",
      "lock intro and outro duration",
      "set timeline protected duration regions",
      "set intro outro locks"
    ],
    permission: "edit_motion",
    mutates: true,
    calls: ["motion.state", "motion.timeline.duration.policy.set", "motion.timeline.duration.policy", "motion.receipts.read"],
    verify: ["Duration policy receipt includes protected regions, min/max duration, resize mode, changed path, and validation result."],
    surfaces: ["timeline", "receipts", "prompt"]
  },
  {
    id: "motion.timeline.marker.upsert",
    aliases: [
      "add timeline marker at playhead",
      "add timeline marker",
      "set timeline marker",
      "update timeline marker",
      "change timeline marker",
      "edit timeline marker",
      "move timeline marker",
      "modify timeline marker",
      "add marker",
      "set marker",
      "update marker",
      "change marker",
      "edit marker",
      "move marker",
      "modify marker",
      "update marker label",
      "edit marker label",
      "add beat marker",
      "add cue marker",
      "attach marker to scene"
    ],
    permission: "edit_motion",
    mutates: true,
    calls: ["motion.state", "motion.timeline.marker.upsert", "motion.timeline.inspect", "motion.receipts.read"],
    verify: ["Timeline marker receipt includes marker id, timestamp, changed paths, scene ref updates, and validation result."],
    surfaces: ["timeline", "receipts", "prompt"]
  },
  {
    id: "motion.timeline.marker.delete",
    aliases: [
      "delete timeline marker at playhead",
      "delete timeline marker",
      "remove timeline marker",
      "delete marker",
      "remove marker",
      "clear marker",
      "delete beat marker",
      "delete cue marker"
    ],
    permission: "edit_motion",
    mutates: true,
    calls: ["motion.state", "motion.timeline.marker.delete", "motion.timeline.inspect", "motion.receipts.read"],
    verify: ["Timeline marker delete receipt includes marker id, removed marker, changed paths, removed scene refs, and validation result."],
    surfaces: ["timeline", "receipts", "prompt"]
  },
  {
    id: "motion.timeline.scene.resize",
    aliases: [
      "resize intro scene duration with ripple",
      "resize scene duration",
      "set scene duration",
      "change scene duration",
      "extend scene with ripple",
      "shorten scene with ripple",
      "ripple scene duration",
      "retime scene"
    ],
    permission: "edit_motion",
    mutates: true,
    calls: ["motion.state", "motion.timeline.scene.resize", "motion.timeline.inspect", "motion.receipts.read"],
    verify: ["Timeline scene resize receipt includes scene id, old/new duration, ripple flag, shifted scenes/layers/markers, changed paths, and validation result."],
    surfaces: ["timeline", "receipts", "prompt"]
  },
  {
    id: "motion.timeline.scene.create",
    aliases: [
      "add storyboard scene",
      "add timeline scene",
      "add scene",
      "create timeline scene",
      "create scene",
      "insert storyboard scene",
      "insert timeline scene",
      "new storyboard section",
      "new scene",
      "add outro scene"
    ],
    permission: "edit_motion",
    mutates: true,
    calls: ["motion.state", "motion.timeline.scene.create", "motion.timeline.inspect", "motion.receipts.read"],
    verify: ["Timeline scene create receipt includes scene id, timing, optional layer/track/marker refs, changed paths, scene counts, duration evidence, and validation result."],
    surfaces: ["timeline", "receipts", "prompt"]
  },
  {
    id: "motion.timeline.scene.delete",
    aliases: [
      "delete storyboard scene",
      "delete timeline scene",
      "delete scene",
      "remove storyboard scene",
      "remove timeline scene",
      "remove scene",
      "drop storyboard scene",
      "drop timeline scene",
      "clear storyboard section",
      "remove outro scene"
    ],
    permission: "edit_motion",
    mutates: true,
    calls: ["motion.state", "motion.timeline.scene.delete", "motion.timeline.inspect", "motion.receipts.read"],
    verify: ["Timeline scene delete receipt includes scene id, removed scene, changed paths, scene counts, non-destructive duration evidence, and validation result."],
    surfaces: ["timeline", "receipts", "prompt"]
  },
  {
    id: "motion.timeline.scene.reorder",
    aliases: [
      "reorder storyboard scene",
      "reorder timeline scene",
      "reorder scene",
      "move storyboard scene",
      "move timeline scene",
      "move scene row",
      "move scene in storyboard",
      "move outro scene before intro",
      "send scene to top",
      "move scene order"
    ],
    permission: "edit_motion",
    mutates: true,
    calls: ["motion.state", "motion.timeline.scene.reorder", "motion.timeline.inspect", "motion.receipts.read"],
    verify: ["Timeline scene reorder receipt includes scene id, old/new index, old/new scene order, changed paths, non-destructive duration evidence, and validation result."],
    surfaces: ["timeline", "receipts", "prompt"]
  },
  {
    id: "motion.timeline.scene.name.set",
    aliases: [
      "rename selected scene",
      "rename scene",
      "rename timeline scene",
      "set scene name",
      "set selected scene name",
      "change scene name",
      "change selected scene name",
      "edit scene name",
      "label selected scene",
      "set scene display name"
    ],
    permission: "edit_motion",
    mutates: true,
    calls: ["motion.state", "motion.timeline.scene.name.set", "motion.timeline.inspect", "motion.receipts.read"],
    verify: ["Timeline scene name receipt includes scene id, old/new display name, changed paths, action, and validation result."],
    surfaces: ["timeline", "receipts", "prompt"]
  },
  {
    id: "motion.timeline.animation.presets",
    aliases: [
      "show animation presets",
      "list animation presets",
      "animation preset discovery",
      "show motion animation presets",
      "what animation presets are available",
      "list entrance and exit animations"
    ],
    permission: "read_motion",
    mutates: false,
    calls: ["motion.timeline.animation.presets"],
    verify: ["Animation preset response includes entrance and exit presets with target keyframe coverage."],
    surfaces: ["timeline", "prompt"]
  },
  {
    id: "motion.timeline.animation.preset.apply",
    aliases: [
      "apply lower third entrance animation",
      "apply lower third animation",
      "apply animation preset",
      "add entrance animation",
      "add exit animation",
      "animate layer in",
      "animate layer out",
      "animate title entrance",
      "apply fade in preset",
      "apply fade out preset",
      "apply slide up entrance",
      "apply lower third in",
      "make the title slide in",
      "make title slide in",
      "slide the title in",
      "slide title in",
      "title entrance animation",
      "give the title an entrance",
      "give title an entrance",
      "stagger title and subtitle entrance animation",
      "staggered layer entrance animation",
      "animate multiple layers in sequence",
      "apply animation preset to multiple layers"
    ],
    permission: "edit_motion",
    mutates: true,
    calls: ["motion.state", "motion.timeline.animation.preset.apply", "motion.preview.frame", "motion.receipts.read"],
    verify: [
      "Animation preset apply receipt includes layer id or layer ids, preset id, timing or staggered per-layer timings, affected targets, changed paths, validation result, and preview evidence.",
      "Preview receipt includes output frame hash after the timeline edit."
    ],
    surfaces: ["timeline", "preview", "receipts", "prompt"]
  },
  {
    id: "motion.timeline.easing.presets",
    aliases: [
      "show easing presets",
      "list easing presets",
      "easing preset discovery",
      "show animation easing presets",
      "what easing presets are available",
      "list spring easing presets",
      "show spring presets"
    ],
    permission: "read_motion",
    mutates: false,
    calls: ["motion.timeline.easing.presets"],
    verify: [
      "Easing preset response includes named and cubic-bezier presets usable by keyframes and transitions.",
      "Easing preset response includes spring presets (spring-gentle, spring-snappy, spring-bouncy) resolving to damped-spring param sets."
    ],
    surfaces: ["timeline", "prompt"]
  },
  {
    id: "motion.timeline.easing.panel",
    aliases: [
      "show easing panel",
      "show timeline easing panel",
      "show timeline easing curves",
      "inspect easing curves",
      "inspect animation curves",
      "show keyframe easing usage",
      "show transition easing usage",
      "review easing usage"
    ],
    permission: "read_motion",
    mutates: false,
    calls: ["motion.timeline.easing.panel"],
    verify: ["Easing panel returns sampled curves, keyframe and transition usage, custom easing detection, and suggested animation actions."],
    surfaces: ["timeline", "prompt"]
  },
  {
    id: "motion.timeline.keyframe.move",
    aliases: [
      "move opacity keyframe",
      "move timeline keyframe",
      "move keyframe",
      "retime keyframe",
      "shift keyframe",
      "nudge keyframe",
      "change keyframe time",
      "move transform keyframe"
    ],
    permission: "edit_motion",
    mutates: true,
    calls: ["motion.state", "motion.timeline.keyframe.move", "motion.preview.frame", "motion.receipts.read"],
    verify: [
      "Timeline keyframe move receipt includes layer id, target, old/new timestamps, moved keyframe value/easing, changed paths, and validation result.",
      "Preview receipt includes output frame hash after the timeline edit."
    ],
    surfaces: ["timeline", "preview", "receipts", "prompt"]
  },
  {
    id: "motion.timeline.keyframe.easing.apply",
    aliases: [
      "apply ease in out to selected keyframes",
      "apply easing to selected keyframes",
      "apply easing preset to keyframes",
      "set selected keyframe easing",
      "change selected keyframe easing",
      "set keyframe easing range",
      "apply cubic bezier to keyframes",
      "apply spring easing to keyframes",
      "make selected keyframes bouncy"
    ],
    permission: "edit_motion",
    mutates: true,
    calls: ["motion.state", "motion.timeline.keyframe.easing.apply", "motion.preview.frame", "motion.receipts.read"],
    verify: [
      "Timeline keyframe easing apply receipt includes layer id, target, easing preset, affected timestamp range, changed paths, updated count, and validation result.",
      "Preview receipt includes output frame hash after the timeline edit."
    ],
    surfaces: ["timeline", "preview", "receipts", "prompt"]
  },
  {
    id: "motion.timeline.keyframe.shift",
    aliases: [
      "nudge selected keyframes",
      "shift selected keyframes",
      "shift keyframe range",
      "move keyframe range",
      "nudge keyframe range",
      "slide keyframes",
      "offset selected keyframes",
      "shift opacity keyframes"
    ],
    permission: "edit_motion",
    mutates: true,
    calls: ["motion.state", "motion.timeline.keyframe.shift", "motion.preview.frame", "motion.receipts.read"],
    verify: [
      "Timeline keyframe shift receipt includes layer id, target, delta, affected timestamp range, shifted keyframes, changed paths, and validation result.",
      "Preview receipt includes output frame hash after the timeline edit."
    ],
    surfaces: ["timeline", "preview", "receipts", "prompt"]
  },
  {
    id: "motion.timeline.keyframe.scale",
    aliases: [
      "stretch selected keyframes",
      "scale selected keyframes",
      "compress selected keyframes",
      "stretch keyframe range",
      "scale keyframe range",
      "retime selected keyframes",
      "change selected keyframe timing",
      "spread keyframes around playhead"
    ],
    permission: "edit_motion",
    mutates: true,
    calls: ["motion.state", "motion.timeline.keyframe.scale", "motion.preview.frame", "motion.receipts.read"],
    verify: [
      "Timeline keyframe scale receipt includes layer id, target, scale factor, origin, affected timestamp range, scaled keyframes, changed paths, and validation result.",
      "Preview receipt includes output frame hash after the timeline edit."
    ],
    surfaces: ["timeline", "preview", "receipts", "prompt"]
  },
  {
    id: "motion.timeline.keyframe.upsert",
    aliases: [
      "add opacity keyframe with ease out",
      "add timeline keyframe",
      "set keyframe",
      "update keyframe",
      "change easing",
      "add transform keyframe",
      "keyframe opacity",
      "keyframe position",
      "animate title color keyframes",
      "animate text color",
      "keyframe fill color",
      "keyframe style color",
      "animate blur effect",
      "keyframe visual effect",
      "animate brightness",
      "keyframe playback rate",
      "animate mask crop keyframes",
      "animate image crop keyframes",
      "animate video crop keyframes",
      "keyframe image crop",
      "keyframe video crop",
      "keyframe source crop",
      "keyframe mask inset",
      "animate crop reveal",
      "keyframe clip mask",
      "add spring keyframe",
      "keyframe with spring easing",
      "animate with spring physics"
    ],
    permission: "edit_motion",
    mutates: true,
    calls: ["motion.state", "motion.timeline.keyframe.upsert", "motion.preview.frame", "motion.receipts.read"],
    verify: [
      "Timeline keyframe receipt includes layer id, target, timestamp, easing, changed path, target-specific value validation, and validation result.",
      "Preview receipt includes output frame hash after the timeline edit."
    ],
    surfaces: ["timeline", "preview", "receipts", "prompt"]
  },
  {
    id: "motion.timeline.keyframe.delete",
    aliases: [
      "delete opacity keyframe at playhead",
      "delete timeline keyframe",
      "remove keyframe",
      "remove opacity keyframe",
      "delete transform keyframe",
      "clear keyframe"
    ],
    permission: "edit_motion",
    mutates: true,
    calls: ["motion.state", "motion.timeline.keyframe.delete", "motion.preview.frame", "motion.receipts.read"],
    verify: [
      "Timeline keyframe delete receipt includes layer id, target, timestamp, removed value, changed path, and validation result.",
      "Preview receipt includes output frame hash after the timeline edit."
    ],
    surfaces: ["timeline", "preview", "receipts", "prompt"]
  },
  {
    id: "motion.timeline.keyframe.duplicate",
    aliases: [
      "duplicate selected keyframes",
      "copy selected keyframes",
      "duplicate keyframe range",
      "copy keyframe range",
      "repeat selected keyframes",
      "repeat keyframe animation",
      "paste keyframes later",
      "copy opacity keyframes"
    ],
    permission: "edit_motion",
    mutates: true,
    calls: ["motion.state", "motion.timeline.keyframe.duplicate", "motion.preview.frame", "motion.receipts.read"],
    verify: [
      "Timeline keyframe duplicate receipt includes layer id, target, delta, affected timestamp range, duplicated keyframes, changed paths, and validation result.",
      "Preview receipt includes output frame hash after the timeline edit."
    ],
    surfaces: ["timeline", "preview", "receipts", "prompt"]
  },
  {
    id: "motion.timeline.keyframe.distribute",
    aliases: [
      "distribute selected keyframes",
      "distribute keyframes evenly",
      "evenly space selected keyframes",
      "space keyframes evenly",
      "equalize keyframe spacing",
      "distribute opacity keyframes"
    ],
    permission: "edit_motion",
    mutates: true,
    calls: ["motion.state", "motion.timeline.keyframe.distribute", "motion.preview.frame", "motion.receipts.read"],
    verify: [
      "Timeline keyframe distribute receipt includes layer id, target, affected timestamp range, spacing, distributed keyframes, changed paths, and validation result.",
      "Preview receipt includes output frame hash after the timeline edit."
    ],
    surfaces: ["timeline", "preview", "receipts", "prompt"]
  },
  {
    id: "motion.timeline.keyframe.range.delete",
    aliases: [
      "delete selected keyframes",
      "remove selected keyframes",
      "delete keyframe range",
      "remove keyframe range",
      "clear selected keyframes",
      "clear keyframe range",
      "delete opacity keyframes"
    ],
    permission: "edit_motion",
    mutates: true,
    calls: ["motion.state", "motion.timeline.keyframe.range.delete", "motion.preview.frame", "motion.receipts.read"],
    verify: [
      "Timeline keyframe range delete receipt includes layer id, target, affected timestamp range, removed keyframes, changed paths, remaining count, and validation result.",
      "Preview receipt includes output frame hash after the timeline edit."
    ],
    surfaces: ["timeline", "preview", "receipts", "prompt"]
  },
  {
    id: "motion.timeline.keyframe.reverse",
    aliases: [
      "reverse selected keyframes",
      "reverse keyframe range",
      "mirror selected keyframes",
      "mirror keyframe range",
      "flip keyframe timing",
      "reverse opacity keyframes"
    ],
    permission: "edit_motion",
    mutates: true,
    calls: ["motion.state", "motion.timeline.keyframe.reverse", "motion.preview.frame", "motion.receipts.read"],
    verify: [
      "Timeline keyframe reverse receipt includes layer id, target, affected timestamp range, reversed keyframes, changed paths, and validation result.",
      "Preview receipt includes output frame hash after the timeline edit."
    ],
    surfaces: ["timeline", "preview", "receipts", "prompt"]
  },
  {
    id: "motion.timeline.keyframe.snap",
    aliases: [
      "snap selected keyframes to frames",
      "snap keyframes to frame grid",
      "align selected keyframes to frames",
      "frame snap keyframes",
      "snap opacity keyframes to frames",
      "align keyframe timing to frame grid"
    ],
    permission: "edit_motion",
    mutates: true,
    calls: ["motion.state", "motion.timeline.keyframe.snap", "motion.preview.frame", "motion.receipts.read"],
    verify: [
      "Timeline keyframe snap receipt includes layer id, target, fps, snap mode, affected timestamp range, snapped keyframes, changed paths, and validation result.",
      "Preview receipt includes output frame hash after the timeline edit."
    ],
    surfaces: ["timeline", "preview", "receipts", "prompt"]
  },
  {
    id: "motion.timeline.layer.create",
    aliases: [
      "add a text layer to the timeline",
      "add text layer",
      "create text layer",
      "add shape layer",
      "create shape layer",
      "add environment layer",
      "create environment layer",
      "add rain environment layer",
      "create rain environment",
      "add water environment layer",
      "create water environment",
      "add snow environment layer",
      "create snow environment",
      "add a cinematic snow environment",
      "insert timeline layer",
      "create timeline layer",
      "new timeline layer",
      "add layer"
    ],
    permission: "edit_motion",
    mutates: true,
    calls: ["motion.state", "motion.timeline.layer.create", "motion.timeline.inspect", "motion.receipts.read"],
    verify: ["Timeline layer create receipt includes layer id, stack index, optional track ref, changed paths, inserted track refs, and validation result."],
    surfaces: ["timeline", "receipts", "prompt"]
  },
  {
    id: "motion.timeline.layer.trim",
    aliases: [
      "trim selected layer duration",
      "trim layer",
      "move layer timing",
      "retime layer",
      "set layer start and duration",
      "change clip trim",
      "adjust layer timing"
    ],
    permission: "edit_motion",
    mutates: true,
    calls: ["motion.state", "motion.timeline.layer.trim", "motion.preview.frame", "motion.receipts.read"],
    verify: [
      "Timeline layer trim receipt includes layer id, old timing, new timing, changed paths, and validation result.",
      "Preview receipt includes output frame hash after the timeline edit."
    ],
    surfaces: ["timeline", "preview", "receipts", "prompt"]
  },
  {
    id: "motion.timeline.layer.split",
    aliases: [
      "split clip at playhead",
      "split selected layer at playhead",
      "split timeline layer",
      "split layer",
      "cut layer at playhead",
      "cut clip at playhead",
      "razor clip",
      "razor layer"
    ],
    permission: "edit_motion",
    mutates: true,
    calls: ["motion.state", "motion.timeline.layer.split", "motion.preview.frame", "motion.receipts.read"],
    verify: [
      "Timeline layer split receipt includes original layer id, new layer id, split timestamp, segment timings, changed paths, track order updates, and validation result.",
      "Preview receipt includes output frame hash after the timeline edit."
    ],
    surfaces: ["timeline", "preview", "receipts", "prompt"]
  },
  {
    id: "motion.timeline.layer.text.set",
    aliases: [
      "change title text",
      "update title text",
      "edit title text",
      "set layer text",
      "change layer text",
      "edit text layer",
      "update text layer",
      "set timeline layer text"
    ],
    permission: "edit_motion",
    mutates: true,
    calls: ["motion.state", "motion.timeline.layer.text.set", "motion.timeline.inspect", "motion.receipts.read"],
    verify: ["Timeline layer text receipt includes layer id, old/new text, changed paths, action, and validation result."],
    surfaces: ["timeline", "receipts", "prompt"]
  },
  {
    id: "motion.timeline.layer.style.set",
    aliases: [
      "make title blue",
      "make the title blue",
      "make the title blue and preview it",
      "change title color",
      "set title color",
      "set layer color",
      "change layer style",
      "set layer style",
      "set title font size",
      "change font size",
      "set layer font size"
    ],
    permission: "edit_motion",
    mutates: true,
    calls: ["motion.state", "motion.timeline.layer.style.set", "motion.preview.frame", "motion.receipts.read"],
    verify: ["Timeline layer style receipt includes layer id, property, old/new values, changed paths, action, and validation result."],
    surfaces: ["timeline", "preview", "receipts", "prompt"]
  },
  {
    id: "motion.timeline.layer.transform.set",
    aliases: [
      "move layer",
      "move title layer",
      "set layer position",
      "set layer x",
      "set layer y",
      "resize layer",
      "set layer width",
      "set layer height",
      "scale layer",
      "rotate layer",
      "set layer opacity"
    ],
    permission: "edit_motion",
    mutates: true,
    calls: ["motion.state", "motion.timeline.layer.transform.set", "motion.preview.frame", "motion.receipts.read"],
    verify: ["Timeline layer transform receipt includes layer id, property, old/new values, changed paths, action, and validation result."],
    surfaces: ["timeline", "preview", "receipts", "prompt"]
  },
  {
    id: "motion.timeline.layer.effect.set",
    aliases: [
      "blur layer",
      "blur title layer",
      "soften layer",
      "set layer blur",
      "change layer effect",
      "set layer effect",
      "set layer brightness",
      "adjust layer brightness",
      "set layer contrast",
      "adjust layer contrast",
      "set layer saturate",
      "desaturate layer",
      "set layer grayscale"
    ],
    permission: "edit_motion",
    mutates: true,
    calls: ["motion.state", "motion.timeline.layer.effect.set", "motion.preview.frame", "motion.receipts.read"],
    verify: ["Timeline layer effect receipt includes layer id, property, old/new values, changed paths, action, and validation result."],
    surfaces: ["timeline", "preview", "receipts", "prompt"]
  },
  {
    id: "motion.timeline.layer.rich.set",
    aliases: [
      "set rich motion control",
      "change rich motion control",
      "set rich layer parameter",
      "set environment intensity",
      "change environment intensity",
      "set rain intensity",
      "change rain intensity",
      "set snow intensity",
      "change snow intensity",
      "set water wave amplitude",
      "change water wave amplitude",
      "set snow turbulence",
      "set rain wetness",
      "set water caustics",
      "set shader uniform",
      "change shader uniform",
      "set particle emitter parameter",
      "change 3d scene parameter",
      "set camera depth control",
      "set motion blur shutter",
      "set film grain control"
    ],
    permission: "edit_motion",
    mutates: true,
    calls: ["motion.state", "motion.timeline.layer.rich.set", "motion.preview.frame", "motion.receipts.read"],
    verify: ["Timeline rich-control receipt includes layer id, allow-listed control path, old/new values, changed paths, action, validation result, and preview evidence."],
    surfaces: ["timeline", "preview", "receipts", "prompt"]
  },
  {
    id: "motion.timeline.layer.blend.set",
    aliases: [
      "set layer blend mode",
      "change layer blend mode",
      "set blend mode",
      "change blend mode",
      "set layer multiply",
      "set layer screen",
      "make layer multiply",
      "make layer screen",
      "set compositor blend mode",
      "change compositor blend"
    ],
    permission: "edit_motion",
    mutates: true,
    calls: ["motion.state", "motion.timeline.layer.blend.set", "motion.preview.frame", "motion.receipts.read"],
    verify: ["Timeline layer blend receipt includes layer id, old/new blend mode, changed paths, action, and validation result."],
    surfaces: ["timeline", "preview", "receipts", "prompt"]
  },
  {
    id: "motion.timeline.layer.crop.set",
    aliases: [
      "crop image layer",
      "crop video layer",
      "crop media layer",
      "crop layer",
      "set layer crop",
      "set image crop",
      "set video crop",
      "set source crop",
      "change source crop",
      "adjust media crop"
    ],
    permission: "edit_motion",
    mutates: true,
    calls: ["motion.state", "motion.timeline.layer.crop.set", "motion.preview.frame", "motion.receipts.read"],
    verify: ["Timeline layer crop receipt includes layer id, old/new crop rectangles, changed paths, action, and validation result."],
    surfaces: ["timeline", "preview", "receipts", "prompt"]
  },
  {
    id: "motion.timeline.layer.mask.set",
    aliases: [
      "mask layer",
      "set layer mask",
      "set rectangular mask",
      "set rounded mask",
      "round layer mask",
      "clip layer mask",
      "set mask inset",
      "change layer mask",
      "adjust layer mask",
      "mask visual layer"
    ],
    permission: "edit_motion",
    mutates: true,
    calls: ["motion.state", "motion.timeline.layer.mask.set", "motion.preview.frame", "motion.receipts.read"],
    verify: ["Timeline layer mask receipt includes layer id, old/new mask shapes, changed paths, action, and validation result."],
    surfaces: ["timeline", "preview", "receipts", "prompt"]
  },
  {
    id: "motion.timeline.layer.fit.set",
    aliases: [
      "fit image layer",
      "fit video layer",
      "set media fit",
      "set image fit",
      "set video fit",
      "set object fit",
      "change media fit",
      "set layer fit",
      "contain image layer",
      "cover image layer"
    ],
    permission: "edit_motion",
    mutates: true,
    calls: ["motion.state", "motion.timeline.layer.fit.set", "motion.preview.frame", "motion.receipts.read"],
    verify: ["Timeline layer fit receipt includes layer id, old/new media fit, changed paths, action, and validation result."],
    surfaces: ["timeline", "preview", "receipts", "prompt"]
  },
  {
    id: "motion.timeline.layer.media.set",
    aliases: [
      "set layer media source",
      "set image media source",
      "set video media source",
      "set audio media source",
      "change layer media source",
      "set layer source",
      "change layer source",
      "replace layer media",
      "swap layer media",
      "replace timeline layer source"
    ],
    permission: "edit_motion",
    mutates: true,
    calls: ["motion.state", "motion.timeline.layer.media.set", "motion.preview.frame", "motion.receipts.read"],
    verify: ["Timeline layer media receipt includes layer id, old/new source refs, changed paths, action, and validation result."],
    surfaces: ["timeline", "preview", "receipts", "prompt"]
  },
  {
    id: "motion.timeline.layer.name.set",
    aliases: [
      "rename selected layer",
      "rename layer",
      "rename timeline layer",
      "set layer name",
      "set selected layer name",
      "change layer name",
      "change selected layer name",
      "edit layer name",
      "label selected layer",
      "set layer display name"
    ],
    permission: "edit_motion",
    mutates: true,
    calls: ["motion.state", "motion.timeline.layer.name.set", "motion.timeline.inspect", "motion.receipts.read"],
    verify: ["Timeline layer name receipt includes layer id, old/new display name, changed paths, action, and validation result."],
    surfaces: ["timeline", "receipts", "prompt"]
  },
  {
    id: "motion.timeline.layer.visibility.set",
    aliases: [
      "hide layer",
      "show layer",
      "hide timeline layer",
      "show timeline layer",
      "set layer visibility",
      "toggle layer visibility",
      "hide selected layer",
      "show selected layer",
      "hide product layer",
      "show product layer"
    ],
    permission: "edit_motion",
    mutates: true,
    calls: ["motion.state", "motion.timeline.layer.visibility.set", "motion.preview.frame", "motion.receipts.read"],
    verify: ["Timeline layer visibility receipt includes layer id, old/new visibility, changed paths, action, and validation result."],
    surfaces: ["timeline", "preview", "receipts", "prompt"]
  },
  {
    id: "motion.timeline.layer.lock",
    aliases: [
      "lock layer",
      "unlock layer",
      "lock selected layer",
      "unlock selected layer",
      "lock timeline layer",
      "unlock timeline layer",
      "set layer lock",
      "set layer locked",
      "protect layer",
      "unprotect layer"
    ],
    permission: "edit_motion",
    mutates: true,
    calls: ["motion.state", "motion.timeline.layer.lock", "motion.timeline.inspect", "motion.receipts.read"],
    verify: ["Timeline layer lock receipt includes layer id, old/new lock state, changed paths, action, and validation result."],
    surfaces: ["timeline", "receipts", "prompt"]
  },
  {
    id: "motion.timeline.layer.delete",
    aliases: [
      "delete selected layer from timeline",
      "delete timeline layer",
      "remove timeline layer",
      "delete selected layer",
      "remove selected layer",
      "delete layer",
      "remove layer",
      "clear layer"
    ],
    permission: "edit_motion",
    mutates: true,
    calls: ["motion.state", "motion.timeline.layer.delete", "motion.timeline.inspect", "motion.receipts.read"],
    verify: ["Timeline layer delete receipt includes layer id, removed layer, changed paths, removed track refs, remaining count, and validation result."],
    surfaces: ["timeline", "receipts", "prompt"]
  },
  {
    id: "motion.timeline.layer.duplicate",
    aliases: [
      "duplicate selected layer on timeline",
      "duplicate selected layer",
      "duplicate timeline layer",
      "clone selected layer",
      "copy selected layer",
      "duplicate layer",
      "clone layer",
      "copy layer"
    ],
    permission: "edit_motion",
    mutates: true,
    calls: ["motion.state", "motion.timeline.layer.duplicate", "motion.timeline.inspect", "motion.receipts.read"],
    verify: ["Timeline layer duplicate receipt includes source layer id, new layer id, offset, changed paths, inserted track refs, and validation result."],
    surfaces: ["timeline", "receipts", "prompt"]
  },
  {
    id: "motion.timeline.layer.reorder",
    aliases: [
      "bring selected layer forward",
      "send selected layer backward",
      "move selected layer forward",
      "move selected layer backward",
      "move layer forward",
      "move layer backward",
      "move layer to front",
      "send layer to back",
      "reorder layer",
      "change layer stack order",
      "layer z order",
      "move selected layer in stack"
    ],
    permission: "edit_motion",
    mutates: true,
    calls: ["motion.state", "motion.timeline.layer.reorder", "motion.timeline.inspect", "motion.receipts.read"],
    verify: ["Timeline layer reorder receipt includes layer id, old/new stack indexes, changed paths, reordered track refs, and validation result."],
    surfaces: ["timeline", "receipts", "prompt"]
  },
  {
    id: "motion.timeline.cleanup",
    aliases: [
      "clean up stale timeline refs",
      "cleanup stale timeline refs",
      "clean timeline refs",
      "cleanup timeline refs",
      "fix stale timeline refs",
      "repair timeline refs",
      "clean up timeline",
      "timeline cleanup",
      "remove duplicate timeline refs"
    ],
    permission: "edit_motion",
    mutates: true,
    calls: ["motion.state", "motion.timeline.cleanup", "motion.timeline.inspect", "motion.receipts.read"],
    verify: ["Timeline cleanup receipt includes removed stale refs, duplicate refs, duration change, changed paths, and validation result."],
    surfaces: ["timeline", "receipts", "prompt"]
  },
  {
    id: "motion.timeline.track.create",
    aliases: [
      "create an overlay track",
      "create timeline track",
      "add timeline track",
      "add track",
      "new timeline track",
      "create overlay track",
      "add overlay track",
      "create audio track",
      "add audio track",
      "create caption track",
      "add caption track"
    ],
    permission: "edit_motion",
    mutates: true,
    calls: ["motion.state", "motion.timeline.track.create", "motion.timeline.inspect", "motion.receipts.read"],
    verify: ["Timeline track create receipt includes track id, stack index, attached layer ids, changed paths, and validation result."],
    surfaces: ["timeline", "receipts", "prompt"]
  },
  {
    id: "motion.timeline.track.reorder",
    aliases: [
      "move music track to top",
      "reorder timeline track",
      "move timeline track",
      "move selected timeline track",
      "move track to top",
      "move track up",
      "move track down",
      "change track order",
      "change timeline track order",
      "track stack order"
    ],
    permission: "edit_motion",
    mutates: true,
    calls: ["motion.state", "motion.timeline.track.reorder", "motion.timeline.inspect", "motion.receipts.read"],
    verify: ["Timeline track reorder receipt includes track id, old/new stack indexes, old/new track order, changed paths, and validation result."],
    surfaces: ["timeline", "receipts", "prompt"]
  },
  {
    id: "motion.timeline.track.delete",
    aliases: [
      "delete timeline track",
      "remove timeline track",
      "delete selected timeline track",
      "remove selected timeline track",
      "delete track",
      "remove track",
      "remove empty track",
      "delete empty track"
    ],
    permission: "edit_motion",
    mutates: true,
    calls: ["motion.state", "motion.timeline.track.delete", "motion.timeline.inspect", "motion.receipts.read"],
    verify: ["Timeline track delete receipt includes track id, removed track, detached layer ids, removed scene refs, changed paths, and validation result."],
    surfaces: ["timeline", "receipts", "prompt"]
  },
  {
    id: "motion.timeline.track.rename",
    aliases: [
      "rename timeline track",
      "rename selected timeline track",
      "rename track",
      "change timeline track name",
      "change track name",
      "edit timeline track name",
      "edit track name"
    ],
    permission: "edit_motion",
    mutates: true,
    calls: ["motion.state", "motion.timeline.track.rename", "motion.timeline.inspect", "motion.receipts.read"],
    verify: ["Timeline track rename receipt includes track id, old/new name, changed paths, action, and validation result."],
    surfaces: ["timeline", "receipts", "prompt"]
  },
  {
    id: "motion.timeline.track.lock",
    aliases: [
      "lock selected timeline track",
      "unlock selected timeline track",
      "lock timeline track",
      "unlock timeline track",
      "lock overlay track",
      "unlock overlay track",
      "prevent edits on track",
      "allow edits on track",
      "toggle track lock"
    ],
    permission: "edit_motion",
    mutates: true,
    calls: ["motion.state", "motion.timeline.track.lock", "motion.timeline.inspect", "motion.receipts.read"],
    verify: ["Timeline track lock receipt includes track id, old/new lock state, changed paths, action, and validation result."],
    surfaces: ["timeline", "receipts", "prompt"]
  },
  {
    id: "motion.timeline.track.mute",
    aliases: [
      "mute selected timeline track",
      "unmute selected timeline track",
      "mute timeline track",
      "unmute timeline track",
      "mute music track",
      "unmute music track",
      "mute audio track",
      "unmute audio track",
      "silence track",
      "restore track audio",
      "toggle track mute"
    ],
    permission: "edit_motion",
    mutates: true,
    calls: ["motion.state", "motion.timeline.track.mute", "motion.timeline.inspect", "motion.receipts.read"],
    verify: ["Timeline track mute receipt includes track id, old/new mute state, changed paths, action, and validation result."],
    surfaces: ["timeline", "receipts", "prompt"]
  },
  {
    id: "motion.timeline.track.solo",
    aliases: [
      "solo selected timeline track",
      "unsolo selected timeline track",
      "solo timeline track",
      "unsolo timeline track",
      "solo music track",
      "unsolo music track",
      "solo audio track",
      "unsolo audio track",
      "isolate track audio",
      "toggle track solo"
    ],
    permission: "edit_motion",
    mutates: true,
    calls: ["motion.state", "motion.timeline.track.solo", "motion.timeline.inspect", "motion.receipts.read"],
    verify: ["Timeline track solo receipt includes track id, old/new solo state, changed paths, action, and validation result."],
    surfaces: ["timeline", "receipts", "prompt"]
  },
  {
    id: "motion.timeline.track.volume",
    aliases: [
      "set music track volume",
      "change music track volume",
      "adjust music track volume",
      "set audio track volume",
      "change audio track volume",
      "adjust audio track volume",
      "lower music track volume",
      "raise music track volume",
      "set track gain",
      "adjust track gain",
      "track volume"
    ],
    permission: "edit_motion",
    mutates: true,
    calls: ["motion.state", "motion.timeline.track.volume", "motion.timeline.inspect", "motion.receipts.read"],
    verify: ["Timeline track volume receipt includes track id, old/new volume, changed paths, action, and validation result."],
    surfaces: ["timeline", "receipts", "prompt"]
  },
  {
    id: "motion.timeline.track.fade",
    aliases: [
      "set music track fade in and fade out",
      "set track fade in",
      "set track fade out",
      "change track fades",
      "adjust track fade",
      "fade audio track",
      "track fade",
      "music track fade"
    ],
    permission: "edit_motion",
    mutates: true,
    calls: ["motion.state", "motion.timeline.track.fade", "motion.timeline.inspect", "motion.receipts.read"],
    verify: ["Timeline track fade receipt includes track id, old/new fade values, changed paths, action, and validation result."],
    surfaces: ["timeline", "receipts", "prompt"]
  },
  {
    id: "motion.timeline.track.pan",
    aliases: [
      "pan music track left",
      "pan music track right",
      "center music track pan",
      "set music track pan",
      "set audio track pan",
      "change audio track pan",
      "adjust audio track pan",
      "balance music track",
      "pan audio track",
      "track pan",
      "track balance"
    ],
    permission: "edit_motion",
    mutates: true,
    calls: ["motion.state", "motion.timeline.track.pan", "motion.timeline.inspect", "motion.receipts.read"],
    verify: ["Timeline track pan receipt includes track id, old/new pan values, changed paths, action, and validation result."],
    surfaces: ["timeline", "receipts", "prompt"]
  },
  {
    id: "motion.timeline.layer.ducking.set",
    aliases: [
      "duck music under voice",
      "duck music when voice plays",
      "set audio ducking",
      "set layer ducking",
      "sidechain music under dialogue",
      "sidechain audio layer",
      "lower music during narration",
      "duck background music"
    ],
    permission: "edit_motion",
    mutates: true,
    calls: ["motion.state", "motion.timeline.layer.ducking.set", "motion.timeline.inspect", "motion.receipts.read"],
    verify: ["Timeline layer ducking receipt includes layer id, trigger layer ids, old/new ducking controls, changed paths, action, and validation result."],
    surfaces: ["timeline", "receipts", "prompt"]
  },
  {
    id: "motion.timeline.layer.track.assign",
    aliases: [
      "move selected layer to captions track",
      "move layer to track",
      "assign layer to track",
      "send layer to track",
      "reorder layer on track",
      "move layer between tracks",
      "set layer track",
      "change layer track",
      "put title on overlay track",
      "put captions on caption track"
    ],
    permission: "edit_motion",
    mutates: true,
    calls: ["motion.state", "motion.timeline.layer.track.assign", "motion.timeline.inspect", "motion.receipts.read"],
    verify: [
      "Timeline layer track assignment receipt includes layer id, old/new track ids, order indexes, changed paths, removed source track refs, and validation result."
    ],
    surfaces: ["timeline", "receipts", "prompt"]
  },
  {
    id: "motion.timeline.caption.import",
    aliases: [
      "import captions from srt",
      "import subtitle file",
      "import captions",
      "add captions from transcript",
      "add srt captions",
      "add vtt captions"
    ],
    permission: "edit_motion",
    mutates: true,
    calls: ["motion.state", "motion.timeline.caption.import", "motion.timeline.inspect", "motion.receipts.read"],
    verify: ["Caption import receipt includes source format, cue count, inserted layer ids, track refs, changed paths, and validation result."],
    surfaces: ["timeline", "receipts", "prompt"]
  },
  {
    id: "motion.timeline.caption.upsert",
    aliases: [
      "edit caption at playhead",
      "add caption at playhead",
      "update caption text",
      "set caption timing",
      "change caption text",
      "create caption layer"
    ],
    permission: "edit_motion",
    mutates: true,
    calls: ["motion.state", "motion.timeline.caption.upsert", "motion.timeline.inspect", "motion.receipts.read"],
    verify: ["Caption upsert receipt includes layer id, timing, text, track ref, changed paths, and validation result."],
    surfaces: ["timeline", "receipts", "prompt"]
  },
  {
    id: "motion.timeline.transition.upsert",
    aliases: [
      "add slide transition with ease out",
      "add timeline transition",
      "set transition",
      "update transition",
      "add fade in transition",
      "add wipe transition",
      "change transition easing",
      "set enter transition",
      "set exit transition"
    ],
    permission: "edit_motion",
    mutates: true,
    calls: ["motion.state", "motion.timeline.transition.upsert", "motion.preview.frame", "motion.receipts.read"],
    verify: [
      "Timeline transition receipt includes layer id, edge, transition type, duration, easing, changed path, and validation result.",
      "Preview receipt includes output frame hash after the timeline edit."
    ],
    surfaces: ["timeline", "preview", "receipts", "prompt"]
  },
  {
    id: "motion.timeline.transition.delete",
    aliases: [
      "delete transition at playhead",
      "delete transition",
      "remove transition",
      "clear transition",
      "remove enter transition",
      "remove exit transition",
      "delete fade transition",
      "delete slide transition",
      "delete wipe transition"
    ],
    permission: "edit_motion",
    mutates: true,
    calls: ["motion.state", "motion.timeline.transition.delete", "motion.preview.frame", "motion.receipts.read"],
    verify: [
      "Timeline transition delete receipt includes layer id, edge, removed transition, changed path, and validation result.",
      "Preview receipt includes output frame hash after the timeline edit."
    ],
    surfaces: ["timeline", "preview", "receipts", "prompt"]
  },
  {
    id: "motion.export.presets",
    aliases: [
      "show export presets and formats",
      "list export presets",
      "what video formats can motion export",
      "show render presets",
      "export preset metadata",
      "which exports support audio alpha"
    ],
    permission: "read_motion",
    mutates: false,
    calls: ["motion.export.presets"],
    verify: ["Export preset response includes extensions, MIME types, codec choices, and audio/alpha support."],
    surfaces: ["preview", "prompt"]
  },
  {
    id: "motion.export.panel",
    aliases: ["show export panel", "export panel", "open export panel", "show export cards", "choose export format"],
    permission: "read_motion",
    mutates: false,
    calls: ["motion.export.panel"],
    verify: ["Export panel groups presets with recommendations, badges, and suggested render arguments."],
    surfaces: ["preview", "prompt"]
  },
  {
    id: "motion.export.plan",
    aliases: [
      "plan transparent overlay export with quality gates",
      "plan export",
      "export plan",
      "plan export preset",
      "choose export preset before render",
      "plan transparent export",
      "plan canvas mp4 export",
      "plan cut timeline export",
      "check export preflight",
      "check export audio alpha impact"
    ],
    permission: "read_motion",
    mutates: false,
    calls: ["motion.export.plan"],
    verify: ["Export plan explains preset choice, audio/alpha feature impact, deterministic capture preflight, quality gates, platform verification, and render follow-up arguments."],
    surfaces: ["preview", "prompt", "receipts"]
  },
  {
    id: "motion.storyboard.panel",
    aliases: [
      "review scripted storyboard before cut handoff",
      "review scripted storyboard",
      "storyboard review panel",
      "show storyboard panel",
      "inspect scripted video storyboard",
      "inspect scripted-video json",
      "review cut generate storyboard",
      "source storyboard review",
      "check storyboard source refs",
      "show storyboard frames"
    ],
    permission: "read_motion",
    mutates: false,
    calls: ["motion.storyboard.panel"],
    verify: ["Storyboard panel returns review status, readiness diagnostics, source refs, frame timings, template/engine hints, and compile/Cut follow-up actions without mutating packages."],
    surfaces: ["receipts", "prompt"]
  },
  {
    id: "motion.storyboard.graph",
    aliases: [
      "show storyboard source graph",
      "storyboard source graph",
      "show source graph for storyboard",
      "inspect storyboard provenance graph",
      "content graph for scripted video",
      "show storyboard graph",
      "inspect scripted video graph",
      "show scripted video sources assets templates and engines"
    ],
    permission: "read_motion",
    mutates: false,
    calls: ["motion.storyboard.graph"],
    verify: ["Storyboard graph returns source, asset, template, engine, review, sequence nodes/edges, and readiness diagnostics before compile or Cut handoff."],
    surfaces: ["receipts", "prompt"]
  },
  {
    id: "motion.script.compile",
    aliases: [
      "generate scripted video",
      "scripted video from description frames",
      "cut generate video",
      "storyboard to motion",
      "description frames in cut"
    ],
    permission: "write_local",
    mutates: true,
    calls: ["motion.state", "motion.script.compile", "motion.preview.frame", "motion.render.final", "motion.receipts.read"],
    verify: [
      "Script compile receipt includes source storyboard hash.",
      "Render receipt includes output file hash, codec, duration, and dimensions."
    ],
    surfaces: ["prompt", "preview", "receipts"]
  },
  ...MODULAR_ACTIONS,
  {
    id: "motion.canvas.package",
    aliases: [
      "package this canvas frame for motion",
      "package canvas frame",
      "canvas package",
      "create motion package from canvas",
      "convert canvas frame to motion package"
    ],
    permission: "render_motion",
    mutates: true,
    calls: ["motion.canvas.package", "motion.receipts.read"],
    verify: ["Canvas package receipt includes source frame hash and resource catalog path."],
    surfaces: ["prompt", "preview", "receipts"]
  },
  {
    id: "motion.canvas.bridge_export",
    aliases: [
      "export canvas bridge frame selection",
      "canvas bridge export",
      "bridge canvas frame to motion",
      "make canvas frame selection json",
      "export canvas checkout frame"
    ],
    permission: "write_local",
    mutates: true,
    calls: ["motion.canvas.bridge_export", "motion.receipts.read"],
    verify: ["Canvas bridge export receipt includes trusted bridge path and frame-selection artifact evidence."],
    surfaces: ["prompt", "receipts"]
  },
  {
    id: "motion.connector.canvas_to_mp4",
    aliases: [
      "export this canvas frame to mp4 without cut",
      "canvas frame to mp4",
      "canvas mp4 export",
      "export canvas as video",
      "canvas independent mp4",
      "canvas export without cut"
    ],
    permission: "render_motion",
    mutates: true,
    calls: ["motion.connector.canvas_to_mp4", "motion.receipts.read"],
    verify: [
      "Canvas MP4 connector receipt includes package, render, and resource catalog paths."
    ],
    surfaces: ["prompt", "preview", "receipts"]
  },
  {
    id: "motion.connector.panel",
    aliases: [
      "show connector readiness panel for cut and canvas",
      "show connector panel",
      "connector panel",
      "connector readiness panel",
      "show cut canvas connectors",
      "inspect connector workflows",
      "review connector handoffs",
      "list motion connectors",
      "show canvas cut connector capabilities"
    ],
    permission: "read_motion",
    mutates: false,
    calls: ["motion.connector.panel"],
    verify: ["Connector panel lists Canvas, Cut Generate, scripted-video, source, and template connector workflows with required inputs, render behavior, receipts, quality gates, and Cut handoff support."],
    surfaces: ["prompt", "preview", "receipts"]
  },
  {
    id: "motion.browser.workflow.capture",
    aliases: [
      "capture browser workflow with replay trace",
      "browser workflow replay",
      "deterministic browser capture",
      "record browser workflow trace",
      "capture website video frame with workflow"
    ],
    permission: "render_motion",
    mutates: true,
    calls: ["motion.browser.workflow.capture", "motion.receipts.read"],
    verify: [
      "Browser capture receipt includes a redacted per-step workflow trace artifact.",
      "Workflow trace omits typed text while preserving step status and selectors.",
      "Optional workflow catalog records baseline/latest output hashes and drift status for replay diagnostics."
    ],
    surfaces: ["preview", "receipts", "prompt"]
  },
  {
    id: "motion.quality.panel",
    aliases: [
      "show quality manifest panel",
      "show quality panel",
      "inspect visual regression manifest",
      "review quality gates",
      "quality manifest panel",
      "quality gate summary"
    ],
    permission: "read_motion",
    mutates: false,
    calls: ["motion.quality.panel"],
    verify: ["Quality panel summarizes manifest samples, baselines, regions, audio policy, and quality-check follow-up commands."],
    surfaces: ["preview", "receipts", "prompt"]
  },
  {
    id: "motion.quality.check",
    aliases: [
      "run quality check on rendered video",
      "run quality check",
      "quality check",
      "check rendered video quality",
      "inspect video quality",
      "verify output quality",
      "visual quality check"
    ],
    permission: "render_motion",
    mutates: false,
    calls: ["motion.quality.check", "motion.receipts.read"],
    verify: ["Quality check receipt includes representative-frame visual and alpha facts."],
    surfaces: ["preview", "receipts", "prompt"]
  },
  {
    id: "motion.connector.canvas_to_cut",
    aliases: [
      "send this canvas frame to cut timeline",
      "canvas to cut",
      "send canvas to cut",
      "canvas frame into cut",
      "apply canvas export to cut",
      "canvas cut connector"
    ],
    permission: "write_local",
    mutates: true,
    calls: ["motion.connector.canvas_to_cut", "motion.receipts.read"],
    verify: ["Connector receipt includes package, render, and Cut import plan paths."],
    surfaces: ["prompt", "receipts"]
  },
  {
    id: "motion.connector.script_to_cut",
    aliases: [
      "send scripted video json to cut without canvas",
      "script to cut",
      "scripted video to cut",
      "scripted video json to cut",
      "send scripted video to cut",
      "render scripted video to cut timeline",
      "scripted storyboard to cut timeline"
    ],
    permission: "write_local",
    mutates: true,
    calls: [
      "motion.connector.script_to_cut",
      "motion.quality.check",
      "motion.receipts.read"
    ],
    verify: [
      "Script-to-Cut connector receipt includes script, render, quality, and Cut import plan evidence."
    ],
    surfaces: ["prompt", "receipts"]
  },
  {
    id: "motion.connector.source_to_cut",
    aliases: [
      "source markdown to cut timeline without canvas",
      "source to cut",
      "source to cut timeline",
      "import source to cut",
      "send source storyboard to cut",
      "turn imported source into cut video"
    ],
    permission: "write_local",
    mutates: true,
    calls: [
      "motion.connector.source_to_cut",
      "motion.quality.check",
      "motion.receipts.read"
    ],
    verify: [
      "Source-to-Cut connector receipt includes source Markdown, source refs, storyboard, render evidence, and Cut import plan path.",
      "Quality check receipt includes representative-frame visual and alpha facts."
    ],
    surfaces: ["prompt", "receipts"]
  },
  {
    id: "motion.connector.cut_generate_to_cut",
    aliases: [
      "apply cut generate scripted video to cut timeline",
      "cut generate to cut",
      "cut generate apply",
      "apply generated scripted video to cut",
      "cut generate rendered video to timeline"
    ],
    permission: "write_local",
    mutates: true,
    calls: [
      "motion.connector.cut_generate_to_cut",
      "motion.quality.check",
      "motion.receipts.read"
    ],
    verify: [
      "Cut Generate connector receipt includes script, render, quality, and Cut import plan evidence.",
      "Render and quality-check receipts include output media facts."
    ],
    surfaces: ["prompt", "receipts"]
  },
  {
    id: "motion.connector.template_to_cut",
    aliases: [
      "apply editable template to cut timeline",
      "template to cut",
      "send template to cut",
      "apply template controls to cut",
      "template rendered video to cut timeline",
      "editable template lower third to cut"
    ],
    permission: "write_local",
    mutates: true,
    calls: [
      "motion.template.controls",
      "motion.connector.template_to_cut",
      "motion.receipts.read"
    ],
    verify: ["Template-to-Cut connector receipt includes changed params, render evidence, and Cut import plan path."],
    surfaces: ["prompt", "templateInspector", "receipts"]
  },
  {
    id: "motion.render.final",
    aliases: [
      "render mp4",
      "export video",
      "final render",
      "render this lower third as mp4",
      "export png sequence frames",
      "render image sequence",
      "export frame sequence",
      "png sequence export",
      "export current frame as png still",
      "export still frame",
      "render png frame",
      "jpeg frame export",
      "export jpg frame",
      "render final mp4 with a quality manifest",
      "render with quality manifest",
      "quality manifest render"
    ],
    permission: "render_motion",
    mutates: true,
    calls: ["motion.render.final", "motion.render.status", "motion.receipts.read"],
    verify: [
      "Render receipt includes output file hash, codec, duration, and dimensions.",
      "Image-sequence render receipts include output frame directory, frame pattern, frame count, and PNG codec facts.",
      "Still-frame render receipts include output image path, timestamp, codec, and image artifact evidence.",
      "Optional quality manifests gate final renders and record quality-check status in render receipts.",
      "Render status returns queue-style job state and progress derived from host receipts."
    ],
    surfaces: ["preview", "receipts", "prompt"]
  },
  {
    id: "motion.render.batch",
    aliases: [
      "render csv rows with webm export preset",
      "batch render data rows",
      "render batch rows",
      "data driven render",
      "spreadsheet render",
      "render json rows",
      "batch export preset"
    ],
    permission: "render_motion",
    mutates: true,
    calls: ["motion.render.batch", "motion.render.status", "motion.receipts.read"],
    verify: [
      "Batch render receipt includes per-row output paths, preset, and statuses.",
      "Each row render receipt includes final media facts for the selected preset.",
      "Render status returns queue-style job state and progress derived from host receipts.",
      "Render status and queue rows expose compact quality-manifest gate status when present."
    ],
    surfaces: ["preview", "receipts", "prompt"]
  },
  {
    id: "motion.render.queue",
    aliases: ["show render queue", "render queue panel", "render queue", "queue panel", "export queue", "show export queue"],
    permission: "read_motion",
    mutates: false,
    calls: ["motion.render.queue", "motion.receipts.read"],
    verify: [
      "Render queue panel returns job state, progress, control receipts, and available cancel/retry actions.",
      "Queued and running render queue rows include render-job handoff metadata for future leased runners.",
      "Render status and queue rows expose compact quality-manifest gate status when present."
    ],
    surfaces: ["preview", "receipts", "prompt"]
  },
  {
    id: "motion.package.create",
    // Deliberately dense on the phrasings an agent with a blank page actually types. The failure
    // being fixed: "create new empty motion package" ranked the glTF IMPORTER first, so a cold-start
    // agent was sent to import a 3D model it did not have.
    aliases: [
      "create package", "create new package", "create new empty motion package", "new motion package",
      "create empty package", "start a new package", "init package", "initialise package",
      "make a new package", "scaffold package", "blank package", "start from scratch",
      "create a motion project", "new project", "bootstrap package", "first step"
    ],
    permission: "write_local",
    mutates: true,
    calls: ["motion.package.create", "motion.package.validate"],
    verify: [
      "A created package validates and renders as-is, so the next command can be a real edit.",
      "Creating into a non-empty directory is refused rather than merged, so an existing package is never half-overwritten."
    ],
    surfaces: ["packages", "preview"]
  },
  {
    id: "motion.package.validate",
    aliases: [
      "validate package", "check package", "is my package valid", "verify package",
      "package validation", "check motion.json", "lint package", "structural check"
    ],
    permission: "read_motion",
    mutates: false,
    calls: ["motion.package.validate"],
    verify: [
      "Validation reports identity, layer count, dimensions, hosts and lanes without rendering.",
      "An invalid package names the offending field rather than failing at render time."
    ],
    surfaces: ["packages", "receipts"]
  },
  {
    id: "motion.platform.requirements",
    aliases: [
      "check requirements", "is ffmpeg installed", "why does rendering fail", "environment check",
      "missing dependencies", "install ffmpeg", "prerequisites", "doctor", "check my setup"
    ],
    permission: "read_motion",
    mutates: false,
    calls: ["motion.platform.requirements"],
    verify: [
      "Requirements report names each external tool, what it is needed for, and whether it is present.",
      "A missing tool carries platform-specific install commands rather than a raw spawn error."
    ],
    surfaces: ["preview", "receipts", "prompt"]
  },
  {
    id: "motion.job.get",
    // Deliberately phrased the way a caller asks, not the way the command is named. The most
    // common question a host has is "is my render done yet", and it must not route to the
    // receipt-file views, which cannot see work that is still running.
    aliases: [
      "check job status", "is my render done", "job status", "get job", "check render progress",
      "poll job", "what is my job doing", "render still running", "job by id", "track render"
    ],
    permission: "read_motion",
    mutates: false,
    calls: ["motion.job.get"],
    verify: [
      "Job status reports lifecycle pending, running or ended, and an outcome only once it has ended.",
      "A job that does not exist, has expired, or belongs to another caller is reported as a typed query error rather than a job state."
    ],
    surfaces: ["preview", "receipts", "prompt"]
  },
  {
    id: "motion.job.list",
    aliases: [
      "list my jobs", "list jobs", "what is running", "show running renders", "active jobs",
      "job list", "recent jobs", "show my renders", "in flight work"
    ],
    permission: "read_motion",
    mutates: false,
    calls: ["motion.job.list"],
    verify: [
      "Job list returns this caller's live work first, then its finished work newest first.",
      "Another caller's jobs never appear unless the host granted cross-caller visibility."
    ],
    surfaces: ["preview", "receipts", "prompt"]
  },
  {
    id: "motion.prompt.queue",
    aliases: ["show prompt queue", "prompt queue panel", "prompt queue", "agent job queue", "show agent queue", "local agent queue"],
    permission: "read_motion",
    mutates: false,
    calls: ["motion.prompt.queue", "motion.agent.transcript", "motion.receipts.read"],
    verify: [
      "Prompt queue panel returns local-agent job state, transcript links, and available cancel/retry actions.",
      "Queued and running prompt queue rows include prompt-job handoff metadata for future local-agent runners."
    ],
    surfaces: ["receipts", "prompt"]
  },
  {
    id: "motion.prompt.cancel",
    aliases: ["cancel prompt job", "stop prompt job", "cancel queued prompt", "stop local agent prompt", "cancel agent job"],
    permission: "draft_motion",
    mutates: true,
    calls: ["motion.prompt.cancel", "motion.prompt.queue", "motion.receipts.read"],
    verify: ["Prompt cancel receipt references the target prompt job and prompt queue marks it cancelled."],
    surfaces: ["receipts", "prompt"]
  },
  {
    id: "motion.prompt.retry",
    aliases: ["retry failed prompt", "retry prompt job", "rerun failed prompt", "retry local agent prompt", "retry agent job"],
    permission: "draft_motion",
    mutates: true,
    calls: ["motion.prompt.retry", "motion.prompt.queue", "motion.receipts.read"],
    verify: ["Prompt retry receipt references the source prompt job and exposes queued prompt-job handoff metadata."],
    surfaces: ["receipts", "prompt"]
  },
  {
    id: "motion.render.cancel",
    aliases: ["cancel render job", "stop render job", "cancel export", "stop export", "cancel queued render"],
    permission: "render_motion",
    mutates: true,
    calls: ["motion.render.cancel", "motion.render.status", "motion.receipts.read"],
    verify: ["Render cancel receipt references the target job and render status marks it cancelled."],
    surfaces: ["preview", "receipts", "prompt"]
  },
  {
    id: "motion.render.retry",
    aliases: ["retry failed render", "retry render job", "rerun failed export", "retry export", "rerun render"],
    permission: "render_motion",
    mutates: true,
    calls: ["motion.render.retry", "motion.render.status", "motion.receipts.read"],
    verify: ["Render retry receipt references the source job and render status exposes the retry as queued."],
    surfaces: ["preview", "receipts", "prompt"]
  },
  {
    id: "motion.render.status",
    aliases: ["render status", "check render", "job status", "export progress"],
    permission: "read_motion",
    mutates: false,
    calls: ["motion.render.status"],
    verify: ["Render status returns queue-style job state and progress derived from host receipts."],
    surfaces: ["preview", "receipts", "prompt"]
  },
  {
    id: "motion.review.html.bundle",
    aliases: [
      "review html bundle",
      "html review bundle",
      "export review html",
      "export review html bundle",
      "make review bundle",
      "client review bundle",
      "share review html"
    ],
    permission: "write_local",
    mutates: false,
    calls: ["motion.review.html.bundle", "motion.receipts.list"],
    verify: ["Review HTML bundle includes public-safe artifact links and quality-gate summaries; its receipt records HTML path, copied artifacts, receipt count, and quality-gate counts."],
    surfaces: ["receipts", "preview", "prompt"]
  },
  {
    id: "motion.source.import",
    aliases: [
      "source import",
      "import source link",
      "import article link",
      "import repo link",
      "import article link for storyboard",
      "import source for storyboard",
      "fetch article for video",
      "fetch repo for video",
      "prepare link for scripted video",
      "turn link into storyboard source"
    ],
    permission: "write_local",
    mutates: false,
    calls: ["motion.source.import", "motion.receipts.read"],
    verify: ["Source import receipt includes public URL, kind, Markdown path, source hash, truncation evidence, and safe-fetch policy."],
    surfaces: ["receipts", "prompt"]
  },
  {
    id: "motion.source.to_scripted_video",
    aliases: [
      "source to scripted video",
      "source to storyboard",
      "turn imported source into scripted video",
      "turn imported source into storyboard",
      "lower source into scripted-video json",
      "make scripted video from imported source",
      "prepare source storyboard for cut",
      "source storyboard for script to cut"
    ],
    permission: "write_local",
    mutates: false,
    calls: ["motion.source.import", "motion.source.to_scripted_video", "motion.script.compile", "motion.receipts.read"],
    verify: ["Source-to-scripted-video emits deterministic scripted-video JSON, source refs, review-required storyboard metadata, and receipt artifacts before Script-to-Cut."],
    surfaces: ["receipts", "prompt"]
  },
  {
    id: "motion.html.snippet.export",
    aliases: [
      "html snippet export",
      "export html snippet",
      "export html css snippet",
      "export standalone html composition",
      "export hyperframes html snippet",
      "hyperframes html export",
      "browser lane html export"
    ],
    permission: "write_local",
    mutates: true,
    calls: ["motion.html.snippet.export", "motion.receipts.read"],
    verify: ["HTML snippet export receipt includes HTML path, sha256, layer timing metadata, and lossiness diagnostics."],
    surfaces: ["receipts", "preview", "prompt"]
  },
  {
    id: "motion.html.snippet.import",
    aliases: [
      "html snippet import",
      "import html snippet",
      "import html css snippet",
      "import standalone html composition",
      "import hyperframes html snippet",
      "hyperframes html import",
      "browser lane html import"
    ],
    permission: "write_local",
    mutates: true,
    calls: ["motion.html.snippet.import", "motion.receipts.read"],
    verify: ["HTML snippet import receipt includes package path, validated layer timing, staged local asset digests, and discarded HTML/CSS feature diagnostics."],
    surfaces: ["receipts", "preview", "prompt"]
  },
  {
    id: "motion.otio.export",
    aliases: [
      "otio export",
      "export otio",
      "export timeline as otio",
      "export this timeline as otio",
      "export this timeline as otio for premiere",
      "opentimelineio export",
      "editorial interchange export"
    ],
    permission: "write_local",
    mutates: true,
    calls: ["motion.otio.export", "motion.receipts.read"],
    verify: ["OTIO export receipt includes timeline path, sha256, track/clip/gap counts, and lossiness diagnostics."],
    surfaces: ["receipts", "preview", "prompt"]
  },
  {
    id: "motion.otio.import",
    aliases: [
      "otio import",
      "import otio",
      "import opentimelineio",
      "import opentimelineio edit into motion",
      "import editorial timeline",
      "open otio timeline",
      "convert otio to motion"
    ],
    permission: "write_local",
    mutates: true,
    calls: ["motion.otio.import", "motion.receipts.read"],
    verify: ["OTIO import receipt includes package path, layer/track counts, imported assets, and unsupported item warnings."],
    surfaces: ["receipts", "preview", "prompt"]
  },
  {
    id: "motion.package.archive",
    aliases: [
      "package archive",
      "motion package archive",
      "portable package archive",
      "export package archive",
      "export portable package archive",
      "make shellxmotion package",
      "create shellxmotion archive"
    ],
    permission: "write_local",
    mutates: false,
    calls: ["motion.package.archive", "motion.receipts.read"],
    verify: ["Package archive receipt includes archive path, file count, deterministic hash, and archived package file hashes."],
    surfaces: ["receipts", "prompt"]
  },
  {
    id: "motion.package.extract",
    aliases: [
      "package extract",
      "extract package archive",
      "extract shellxmotion package archive",
      "import shellxmotion package",
      "restore portable package archive",
      "unpack motion package archive"
    ],
    permission: "write_local",
    mutates: false,
    calls: ["motion.package.extract", "motion.receipts.read"],
    verify: ["Package extract receipt includes package root, extracted file count, archive hash, and validation result."],
    surfaces: ["receipts", "prompt"]
  },
  {
    id: "motion.support.bundle",
    aliases: ["support bundle", "debug bundle", "collect diagnostics", "export support data"],
    permission: "write_local",
    mutates: false,
    calls: ["motion.support.bundle", "motion.receipts.list"],
    verify: ["Support bundle lists diagnostics, receipts, and platform verification summaries without secret material."],
    surfaces: ["receipts", "prompt"]
  },
  {
    id: "motion.platform.verification.panel",
    aliases: [
      "platform verification panel",
      "show platform verification",
      "show host verification",
      "show linux windows macos host verification",
      "linux windows macos verification",
      "host matrix verification",
      "platform receipts panel"
    ],
    permission: "read_motion",
    mutates: false,
    calls: ["motion.platform.verification.panel", "motion.receipts.list"],
    verify: ["Platform verification panel returns required hosts, satisfied hosts, missing hosts, failed hosts, and aggregate receipt status."],
    surfaces: ["receipts", "prompt"]
  }
];

export function findAction(request: string): MotionAction | null {
  const requestedId = request.trim().toLowerCase();
  const exactAction = ACTIONS.find((action) => action.id.toLowerCase() === requestedId);
  if (exactAction) return exactAction;
  if (/^motion(?:\.[a-z0-9_-]+)+$/.test(requestedId)) return null;

  const normalized = normalize(request);
  let best: { action: MotionAction; score: number } | null = null;

  for (const action of ACTIONS) {
    const score = Math.max(...action.aliases.map((alias) => aliasScore(normalized, normalize(alias))));
    if (score > 0 && (!best || score > best.score)) {
      best = { action, score };
    }
  }

  return best?.action ?? null;
}

/**
 * `findAction` plus the answer for the miss case.
 *
 * Kept separate from `findAction` so the strict matcher's contract (an action or nothing) is
 * unchanged for `planAction` and every existing caller, while the published command can stop
 * returning a bare `null` that tells an agent nothing. See ./catalog-find.ts.
 */
export function findActionMatch(request: string): MotionActionMatch {
  return buildActionMatch(request, findAction(request), ACTIONS);
}

export function guideAction(request: string): MotionActionPlan {
  return planAction(request);
}

export function planAction(request: string): MotionActionPlan {
  const action = findAction(request);
  // A request naming several pipeline phases is a workflow, not an action; answering it with the
  // single best alias match is what dropped the authoring half of "create ... and render mp4".
  const workflow = detectMotionWorkflow(request);
  if (workflow) return buildWorkflowPlan({ request, workflow, actions: ACTIONS, purposeForCall, verificationForCalls });
  const normalized = normalize(request);
  const wantsPreview = normalized.includes("preview") || normalized.includes("show frame");
  const wantsEdit = normalized.includes("blue") || normalized.includes("change") || normalized.includes("edit");
  const calls = action?.mutates ? action.calls : wantsEdit && wantsPreview
    ? ["motion.state", "motion.package.patch", "motion.preview.frame", "motion.receipts.read"]
    : action?.calls ?? ["motion.actions.find"];

  return {
    ok: true,
    topic: request,
    action,
    steps: calls.map((call, index) => ({ order: index + 1, call, purpose: purposeForCall(call) })),
    verify: verificationForPlan(action, calls),
    cautions: action ? [] : ["No exact action matched; inspect related actions before mutation."],
    related: action ? ACTIONS.filter((candidate) => candidate.id !== action.id).slice(0, 3) : ACTIONS.slice(0, 3)
  };
}

export function actionCoverage(visibleSurfaces: string[]): { ok: boolean; uncovered: string[]; commands: string[] } {
  const commands = new Set<string>();
  const uncovered: string[] = [];

  for (const surface of visibleSurfaces) {
    const surfaceCommands = SURFACE_COMMANDS[surface] ?? [];
    if (surfaceCommands.length === 0) {
      uncovered.push(surface);
    }
    for (const command of surfaceCommands) {
      commands.add(command);
    }
  }

  return { ok: uncovered.length === 0, uncovered, commands: [...commands].sort() };
}

function verificationForPlan(action: MotionAction | null, calls: string[]): string[] {
  return [...new Set([...(action?.verify ?? []), ...verificationForCalls(calls)])];
}

function verificationForCalls(calls: string[]): string[] {
  const verify = new Set<string>();
  for (const call of calls) {
    if (call === "motion.package.patch") verify.add("Package diff receipt includes changed paths and input hashes.");
    if (call === "motion.preview.frame") verify.add("Preview receipt includes output frame hash.");
    if (call === "motion.preview.panel") verify.add("Preview player panel returns package facts, playhead state, active timeline refs, preview modes, and render follow-ups without rendering.");
    if (call === "motion.preview.playhead") verify.add("Playhead preview receipt includes timeline state, output frame hash, timestamp, and artifact path.");
    if (call === "motion.preview.strip") verify.add("Preview strip receipt includes per-frame output hashes, timestamps, and artifact paths.");
    if (call === "motion.render.final") {
      verify.add("Render receipt includes output file hash, codec, duration, and dimensions.");
      verify.add("Image-sequence render receipts include output frame directory, frame pattern, frame count, and PNG codec facts.");
    }
    if (call === "motion.render.batch") verify.add("Batch render receipt includes per-row output paths, preset, and statuses.");
    if (call === "motion.render.cancel") verify.add("Render cancel receipt references the target job and render status marks it cancelled.");
    if (call === "motion.render.retry") verify.add("Render retry receipt references the source job and render status exposes the retry as queued.");
    if (call === "motion.render.queue") {
      verify.add("Render queue panel returns job state, progress, control receipts, and available cancel/retry actions.");
      verify.add("Queued and running render queue rows include render-job handoff metadata for future leased runners.");
      verify.add("Render status and queue rows expose compact quality-manifest gate status when present.");
    }
    if (call === "motion.prompt.queue") {
      verify.add("Prompt queue panel returns local-agent job state, transcript links, and available cancel/retry actions.");
      verify.add("Queued and running prompt queue rows include prompt-job handoff metadata for future local-agent runners.");
    }
    if (call === "motion.prompt.cancel") verify.add("Prompt cancel receipt references the target prompt job and prompt queue marks it cancelled.");
    if (call === "motion.prompt.retry") verify.add("Prompt retry receipt references the source prompt job and exposes queued prompt-job handoff metadata.");
    if (call === "motion.actions.panel") verify.add("Action panel returns grouped actions, permission counts, prompt commands, and suggested prompt-run follow-ups.");
    if (call === "motion.capabilities.panel") verify.add("Capability panel returns grouped lane cards, support badges, package fit, recommended lane, and follow-up match/export actions.");
    if (call === "motion.agent.panel") verify.add("Agent panel returns default local CLI selection policy, adapter command shapes, safety guarantees, receipt coverage, and prompt follow-ups without probing or mutating packages.");
    if (call === "motion.agent.health") verify.add("Agent health returns local CLI subscription adapter readiness, transport, billing mode, and unavailable reasons without mutating packages.");
    if (call === "motion.packages.browse") verify.add("Package browser returns package cards, template availability, asset counts, brand provenance, and skipped-package warnings.");
    if (call === "motion.export.presets") verify.add("Export preset response includes extensions, MIME types, codec choices, and audio/alpha support.");
    if (call === "motion.export.panel") verify.add("Export panel groups presets with recommendations, badges, and suggested render arguments.");
    if (call === "motion.export.plan") verify.add("Export plan explains preset choice, audio/alpha feature impact, deterministic capture preflight, quality gates, platform verification, and render follow-up arguments.");
    if (call === "motion.timeline.panel") verify.add("Timeline panel returns playhead controls, scene and layer rows, markers, tracks, and suggested actions.");
    if (call === "motion.timeline.keyframes.panel") verify.add("Keyframe panel returns animated layers, target ranges, easing usage, preset counts, and suggested keyframe actions.");
    if (call === "motion.timeline.transitions.panel") verify.add("Transition panel returns layers with enter/exit transitions, timing windows, easing usage, type counts, and suggested transition actions.");
    if (call === "motion.timeline.inspect") verify.add("Timeline inspect result includes scenes, tracks, markers, and layer track refs.");
    if (call === "motion.timeline.playhead.set") verify.add("Timeline playhead receipt includes old/new playhead, state path, duration guard, and host receipt evidence.");
    if (call === "motion.timeline.range.select") verify.add("Timeline range receipt includes selected start/end, previous range, state path, and duration guard.");
    if (call === "motion.timeline.viewport.set") verify.add("Timeline viewport receipt includes start/end, zoom, pixels-per-second, previous viewport, and state path.");
    if (call === "motion.timeline.duration.policy") verify.add("Duration policy read returns min/max duration, resize mode, protected regions, and package duration.");
    if (call === "motion.timeline.duration.policy.set") verify.add("Duration policy receipt includes protected regions, min/max duration, resize mode, changed path, and validation result.");
    if (call === "motion.timeline.marker.upsert") verify.add("Timeline marker receipt includes marker id, timestamp, changed paths, scene ref updates, and validation result.");
    if (call === "motion.timeline.marker.delete") verify.add("Timeline marker delete receipt includes marker id, removed marker, changed paths, removed scene refs, and validation result.");
    if (call === "motion.timeline.scene.create") verify.add("Timeline scene create receipt includes scene id, timing, optional refs, changed paths, scene counts, duration evidence, and validation result.");
    if (call === "motion.timeline.scene.delete") verify.add("Timeline scene delete receipt includes scene id, removed scene, changed paths, scene counts, non-destructive duration evidence, and validation result.");
    if (call === "motion.timeline.scene.reorder") verify.add("Timeline scene reorder receipt includes scene id, old/new index, old/new scene order, changed paths, non-destructive duration evidence, and validation result.");
    if (call === "motion.timeline.scene.resize") verify.add("Timeline scene resize receipt includes scene id, old/new duration, ripple flag, shifted scenes/layers/markers, changed paths, and validation result.");
    if (call === "motion.timeline.scene.name.set") verify.add("Timeline scene name receipt includes scene id, old/new display name, changed paths, action, and validation result.");
    if (call === "motion.timeline.easing.panel") verify.add("Easing panel returns sampled curves, keyframe and transition usage, custom easing detection, and suggested animation actions.");
    if (call === "motion.timeline.easing.presets") verify.add("Easing preset response includes named and cubic-bezier presets usable by keyframes and transitions.");
    if (call === "motion.timeline.animation.presets") verify.add("Animation preset response includes entrance and exit presets with target keyframe coverage.");
    if (call === "motion.timeline.animation.preset.apply") verify.add("Animation preset apply receipt includes layer id or layer ids, preset id, timing or staggered per-layer timings, affected targets, changed paths, validation result, and preview evidence.");
    if (call === "motion.timeline.keyframe.upsert") verify.add("Timeline keyframe receipt includes layer id, target, timestamp, easing, changed path, target-specific value validation, and validation result.");
    if (call === "motion.timeline.keyframe.delete") verify.add("Timeline keyframe delete receipt includes layer id, target, timestamp, removed value, changed path, and validation result.");
    if (call === "motion.timeline.keyframe.move") verify.add("Timeline keyframe move receipt includes layer id, target, old/new timestamps, moved keyframe value/easing, changed paths, and validation result.");
    if (call === "motion.timeline.keyframe.easing.apply") verify.add("Timeline keyframe easing apply receipt includes layer id, target, easing preset, affected timestamp range, changed paths, updated count, and validation result.");
    if (call === "motion.timeline.keyframe.shift") verify.add("Timeline keyframe shift receipt includes layer id, target, delta, affected timestamp range, shifted keyframes, changed paths, and validation result.");
    if (call === "motion.timeline.keyframe.scale") verify.add("Timeline keyframe scale receipt includes layer id, target, scale factor, origin, affected timestamp range, scaled keyframes, changed paths, and validation result.");
    if (call === "motion.timeline.keyframe.duplicate") verify.add("Timeline keyframe duplicate receipt includes layer id, target, delta, affected timestamp range, duplicated keyframes, changed paths, and validation result.");
    if (call === "motion.timeline.keyframe.distribute") verify.add("Timeline keyframe distribute receipt includes layer id, target, affected timestamp range, spacing, distributed keyframes, changed paths, and validation result.");
    if (call === "motion.timeline.keyframe.range.delete") verify.add("Timeline keyframe range delete receipt includes layer id, target, affected timestamp range, removed keyframes, changed paths, remaining count, and validation result.");
    if (call === "motion.timeline.keyframe.reverse") verify.add("Timeline keyframe reverse receipt includes layer id, target, affected timestamp range, reversed keyframes, changed paths, and validation result.");
    if (call === "motion.timeline.keyframe.snap") verify.add("Timeline keyframe snap receipt includes layer id, target, fps, snap mode, affected timestamp range, snapped keyframes, changed paths, and validation result.");
    if (call === "motion.timeline.layer.create") verify.add("Timeline layer create receipt includes layer id, stack index, optional track ref, changed paths, inserted track refs, and validation result.");
    if (call === "motion.timeline.layer.trim") verify.add("Timeline layer trim receipt includes layer id, old timing, new timing, changed paths, and validation result.");
    if (call === "motion.timeline.layer.split") verify.add("Timeline layer split receipt includes original layer id, new layer id, split timestamp, segment timings, changed paths, track order updates, and validation result.");
    if (call === "motion.timeline.layer.text.set") verify.add("Timeline layer text receipt includes layer id, old/new text, changed paths, action, and validation result.");
    if (call === "motion.timeline.layer.style.set") verify.add("Timeline layer style receipt includes layer id, property, old/new values, changed paths, action, and validation result.");
    if (call === "motion.timeline.layer.transform.set") verify.add("Timeline layer transform receipt includes layer id, property, old/new values, changed paths, action, and validation result.");
    if (call === "motion.timeline.layer.effect.set") verify.add("Timeline layer effect receipt includes layer id, property, old/new values, changed paths, action, and validation result.");
    if (call === "motion.timeline.layer.rich.set") verify.add("Timeline rich-control receipt includes layer id, allow-listed control path, old/new values, changed paths, action, validation result, and preview evidence.");
    if (call === "motion.timeline.layer.blend.set") verify.add("Timeline layer blend receipt includes layer id, old/new blend mode, changed paths, action, and validation result.");
    if (call === "motion.timeline.layer.crop.set") verify.add("Timeline layer crop receipt includes layer id, old/new crop rectangles, changed paths, action, and validation result.");
    if (call === "motion.timeline.layer.mask.set") verify.add("Timeline layer mask receipt includes layer id, old/new mask shapes, changed paths, action, and validation result.");
    if (call === "motion.timeline.layer.fit.set") verify.add("Timeline layer fit receipt includes layer id, old/new media fit, changed paths, action, and validation result.");
    if (call === "motion.timeline.layer.media.set") verify.add("Timeline layer media receipt includes layer id, old/new source refs, changed paths, action, and validation result.");
    if (call === "motion.timeline.layer.name.set") verify.add("Timeline layer name receipt includes layer id, old/new display name, changed paths, action, and validation result.");
    if (call === "motion.timeline.layer.visibility.set") verify.add("Timeline layer visibility receipt includes layer id, old/new visibility, changed paths, action, and validation result.");
    if (call === "motion.timeline.layer.lock") verify.add("Timeline layer lock receipt includes layer id, old/new lock state, changed paths, action, and validation result.");
    if (call === "motion.timeline.layer.delete") verify.add("Timeline layer delete receipt includes layer id, removed layer, changed paths, removed track refs, remaining count, and validation result.");
    if (call === "motion.timeline.layer.duplicate") verify.add("Timeline layer duplicate receipt includes source layer id, new layer id, offset, changed paths, inserted track refs, and validation result.");
    if (call === "motion.timeline.layer.reorder") verify.add("Timeline layer reorder receipt includes layer id, old/new stack indexes, changed paths, reordered track refs, and validation result.");
    if (call === "motion.timeline.cleanup") verify.add("Timeline cleanup receipt includes removed stale refs, duplicate refs, duration change, changed paths, and validation result.");
    if (call === "motion.timeline.track.create") verify.add("Timeline track create receipt includes track id, stack index, attached layer ids, changed paths, and validation result.");
    if (call === "motion.timeline.track.reorder") verify.add("Timeline track reorder receipt includes track id, old/new stack indexes, old/new track order, changed paths, and validation result.");
    if (call === "motion.timeline.track.delete") verify.add("Timeline track delete receipt includes track id, removed track, detached layer ids, removed scene refs, changed paths, and validation result.");
    if (call === "motion.timeline.track.rename") verify.add("Timeline track rename receipt includes track id, old/new name, changed paths, action, and validation result.");
    if (call === "motion.timeline.track.lock") verify.add("Timeline track lock receipt includes track id, old/new lock state, changed paths, action, and validation result.");
    if (call === "motion.timeline.track.mute") verify.add("Timeline track mute receipt includes track id, old/new mute state, changed paths, action, and validation result.");
    if (call === "motion.timeline.track.solo") verify.add("Timeline track solo receipt includes track id, old/new solo state, changed paths, action, and validation result.");
    if (call === "motion.timeline.track.volume") verify.add("Timeline track volume receipt includes track id, old/new volume, changed paths, action, and validation result.");
    if (call === "motion.timeline.track.fade") verify.add("Timeline track fade receipt includes track id, old/new fade values, changed paths, action, and validation result.");
    if (call === "motion.timeline.track.pan") verify.add("Timeline track pan receipt includes track id, old/new pan values, changed paths, action, and validation result.");
    if (call === "motion.timeline.layer.ducking.set") verify.add("Timeline layer ducking receipt includes layer id, trigger layer ids, old/new ducking controls, changed paths, action, and validation result.");
    if (call === "motion.timeline.layer.track.assign") verify.add("Timeline layer track assignment receipt includes layer id, old/new track ids, order indexes, changed paths, removed source track refs, and validation result.");
    if (call === "motion.timeline.caption.import") verify.add("Caption import receipt includes source format, cue count, inserted layer ids, track refs, changed paths, and validation result.");
    if (call === "motion.timeline.caption.upsert") verify.add("Caption upsert receipt includes layer id, timing, text, track ref, changed paths, and validation result.");
    if (call === "motion.timeline.transition.upsert") verify.add("Timeline transition receipt includes layer id, edge, transition type, duration, easing, changed path, and validation result.");
    if (call === "motion.timeline.transition.delete") verify.add("Timeline transition delete receipt includes layer id, edge, removed transition, changed path, and validation result.");
    if (call === "motion.script.compile") verify.add("Script compile receipt includes source storyboard hash.");
    if (call === "motion.analysis.tracking.request") verify.add("Tracking request receipt includes package-local source identity, solver settings, confidence/lost spans, contained media resources, lifecycle path, and output package evidence.");
    if (call === "motion.analysis.tracking.inspect") verify.add("Tracking inspection reports lifecycle attempts, last-good analysis, and whether current package-local source bytes match the persisted identity.");
    if (call === "motion.analysis.tracking.apply") verify.add("Tracking apply receipt includes the selected confidence segment, compiled transform keyframes, reversible attachment, validation, source hash, and output package evidence.");
    if (call === "motion.analysis.tracking.detach") verify.add("Tracking detach receipt confirms exact restoration of prior transform keyframes and removal of the attachment.");
    if (call === "motion.analysis.tracking.verify") verify.add("Tracking verification reports attachment, analysis, source, and generated-keyframe drift without mutation.");
    if (call === "motion.canvas.package") verify.add("Canvas package receipt includes source frame hash and resource catalog path.");
    if (call === "motion.canvas.bridge_export") verify.add("Canvas bridge export receipt includes trusted bridge path and frame-selection artifact evidence.");
    if (call === "motion.quality.panel") verify.add("Quality panel summarizes manifest samples, baselines, regions, audio policy, and quality-check follow-up commands.");
    if (call === "motion.quality.check") verify.add("Quality check receipt includes representative-frame visual and alpha facts.");
    if (call === "motion.connector.panel") verify.add("Connector panel lists Canvas, Cut Generate, scripted-video, source, and template connector workflows with required inputs, render behavior, receipts, quality gates, and Cut handoff support.");
    if (call === "motion.connector.canvas_to_mp4") verify.add("Canvas MP4 connector receipt includes package, render, and resource catalog paths.");
    if (call === "motion.connector.canvas_to_cut") verify.add("Connector receipt includes package, render, and Cut import plan paths.");
    if (call === "motion.connector.script_to_cut") verify.add("Script-to-Cut connector receipt includes script, render, quality, and Cut import plan evidence.");
    if (call === "motion.connector.source_to_cut") verify.add("Source-to-Cut connector receipt includes source Markdown, source refs, storyboard, render evidence, and Cut import plan path.");
    if (call === "motion.connector.cut_generate_to_cut") verify.add("Cut Generate connector receipt includes script, render, quality, and Cut import plan evidence.");
    if (call === "motion.connector.template_to_cut") verify.add("Template-to-Cut connector receipt includes changed params, render evidence, and Cut import plan path.");
    if (call === "motion.template.catalog") verify.add("Template catalog returns package ids, template ids, compatible hosts/lanes, control counts, suitability metadata, and suggested follow-up actions.");
    if (call === "motion.template.panel") verify.add("Template panel returns grouped controls, bindings, current values, suitability metadata, control type counts, and follow-up actions.");
    if (call === "motion.template.media.replace") verify.add("Template media replace receipt includes param id, copied asset ref, changed bindings, manifest asset refs, and validation result.");
    if (call === "motion.render.status") {
      verify.add("Render status returns queue-style job state and progress derived from host receipts.");
      verify.add("Render status and queue rows expose compact quality-manifest gate status when present.");
    }
    if (call === "motion.review.html.bundle") verify.add("Review HTML bundle includes public-safe artifact links and quality-gate summaries; its receipt records HTML path, copied artifacts, receipt count, and quality-gate counts.");
    if (call === "motion.source.import") verify.add("Source import receipt includes public URL, kind, Markdown path, source hash, truncation evidence, and safe-fetch policy.");
    if (call === "motion.source.to_scripted_video") verify.add("Source-to-scripted-video emits deterministic scripted-video JSON, source refs, review-required storyboard metadata, and receipt artifacts before Script-to-Cut.");
    if (call === "motion.storyboard.panel") verify.add("Storyboard panel returns review status, readiness diagnostics, source refs, frame timings, template/engine hints, and compile/Cut follow-up actions without mutating packages.");
    if (call === "motion.storyboard.graph") verify.add("Storyboard graph returns source, asset, template, engine, review, sequence nodes/edges, and readiness diagnostics before compile or Cut handoff.");
    if (call === "motion.html.snippet.export") verify.add("HTML snippet export receipt includes HTML path, sha256, layer timing metadata, and lossiness diagnostics.");
    if (call === "motion.html.snippet.import") verify.add("HTML snippet import receipt includes package path, validated layer timing, staged local asset digests, and discarded HTML/CSS feature diagnostics.");
    if (call === "motion.otio.export") verify.add("OTIO export receipt includes timeline path, sha256, track/clip/gap counts, and lossiness diagnostics.");
    if (call === "motion.otio.import") verify.add("OTIO import receipt includes package path, layer/track counts, imported assets, and unsupported item warnings.");
    if (call === "motion.package.archive") verify.add("Package archive receipt includes archive path, file count, deterministic hash, and archived package file hashes.");
    if (call === "motion.package.extract") verify.add("Package extract receipt includes package root, extracted file count, archive hash, and validation result.");
    if (call === "motion.support.bundle") verify.add("Support bundle lists diagnostics, receipts, and platform verification summaries without secret material.");
    if (call === "motion.platform.verification.panel") verify.add("Platform verification panel returns required hosts, satisfied hosts, missing hosts, failed hosts, and aggregate receipt status.");
    if (call === "motion.agent.transcript") verify.add("Agent transcript digest returns prompt and agent receipt links with redacted transcript messages.");
    if (call === "motion.receipts.panel") {
      verify.add("Receipt panel summary returns counts, recent receipts, warnings, failures, and artifact links.");
      verify.add("Receipt panel summaries expose compact quality-manifest gate status on relevant receipts.");
    }
    if (call === "motion.assets.panel") verify.add("Asset panel returns declared assets, layer references, missing assets, hashes, and usage counts.");
    if (call === "motion.brand.panel") verify.add("Brand panel returns design-token groups, color tokens, typography tokens, and source provenance.");
    if (call === "motion.audio.panel") verify.add("Audio panel returns resolved audio inputs, automation counts, track controls, ducking, and export-preset compatibility warnings.");
    if (call === "motion.media.panel") verify.add("Media panel returns image, video, audio, and web layer source readiness, trim/loop/playback controls, and export-preset compatibility warnings.");
    if (call === "motion.receipts.read") verify.add("Receipt read returns host-owned evidence.");
  }
  return [...verify];
}

/**
 * One line saying what a command is FOR.
 *
 * Exported because the MCP tool listing needs it: a tool described only as
 * "debug command motion.render.final. permission=render_motion. mutates=true." tells an agent
 * nothing about when to reach for it. An independent agent tester called the bare listings
 * "near-useless" and had to fall back on actions.guide for every decision.
 */
export function purposeForCall(call: string): string {
  const purposes: Record<string, string> = {
    "motion.state": "Read current package and UI state before mutation.",
    "motion.package.patch": "Apply a validated Motion package patch.",
    "motion.preview.frame": "Render a deterministic preview frame.",
    "motion.preview.panel": "Show a read-only preview player with playhead state, active timeline refs, preview modes, and render follow-ups.",
    "motion.preview.playhead": "Render the current timeline playhead as a deterministic preview frame.",
    "motion.preview.strip": "Render a deterministic timeline preview strip with per-frame evidence.",
    "motion.render.status": "Read render job state and progress from host receipt files, which only describe work that has finished writing evidence.",
    "motion.package.create": "Create a new, valid, renderable Motion package from nothing. The first step when building something original rather than importing it.",
    "motion.package.validate": "Check a package is structurally valid without rendering it — identity, layers, dimensions, hosts and lanes.",
    "motion.platform.requirements": "Check whether the external tools Motion needs (FFmpeg) are installed, and get the exact command to install them.",
    "motion.job.get": "Ask what one job is doing right now: pending, running, or ended with an outcome. Answers live work the receipt views cannot see.",
    "motion.job.list": "List this caller's jobs, live work first and finished work newest first.",
    "motion.render.cancel": "Write a host-owned cancellation receipt for a queued or running render job.",
    "motion.render.retry": "Queue a retry receipt for a failed or cancelled render job.",
    "motion.render.queue": "Show render queue rows with state, progress, control receipts, available actions, and leased-runner handoff metadata.",
    "motion.prompt.queue": "Show prompt queue rows with local-agent job state, transcript links, available actions, and prompt-job handoff metadata.",
    "motion.prompt.cancel": "Write a host-owned cancellation receipt for a queued or running prompt job.",
    "motion.prompt.retry": "Queue a retry receipt for a failed or cancelled prompt job.",
    "motion.actions.panel": "Show grouped actions, permission tiers, prompt commands, and suggested prompt-run follow-ups.",
    "motion.agent.panel": "Show local CLI agent selection policy, adapter command shapes, safety guarantees, and prompt follow-ups.",
    "motion.agent.health": "Probe local CLI subscription agent readiness without mutating packages.",
    "motion.packages.browse": "Browse local Motion packages with package metadata, template availability, asset counts, and suggested follow-up actions.",
    "motion.media.panel": "Show media layer source readiness, trim/loop/playback controls, and export-preset compatibility warnings.",
    "motion.audio.panel": "Show resolved audio mix inputs, automation, track controls, ducking, and export-preset compatibility warnings.",
    "motion.analysis.tracking.request": "Run contained point or planar analysis for a manifest-declared package video and persist its retryable lifecycle in a copied package.",
    "motion.analysis.tracking.inspect": "Inspect tracking confidence, lifecycle attempts, last-good data, and current source identity without mutation.",
    "motion.analysis.tracking.apply": "Compile a current tracking result into reversible ordinary transform keyframes in a copied package.",
    "motion.analysis.tracking.detach": "Restore the exact transform keyframes that existed before tracking stabilization was attached.",
    "motion.analysis.tracking.verify": "Verify attachment identity, source bytes, and generated stabilization keyframes without mutation.",
    "motion.render.final": "Render final media through the selected renderer lane.",
    "motion.render.batch": "Render data rows into per-row media outputs with the selected export preset.",
    "motion.export.presets": "List supported export presets with codecs, extensions, MIME types, and audio/alpha support.",
    "motion.export.panel": "Show export presets as grouped UI cards with recommended choices and render arguments.",
    "motion.export.plan": "Plan the export preset, feature impact, deterministic capture preflight, quality gates, and render follow-up arguments.",
    "motion.timeline.panel": "Show the timeline as panel-ready playhead controls, layer rows, scenes, tracks, markers, and suggested actions.",
    "motion.timeline.keyframes.panel": "Show animated layers, keyframe target ranges, easing usage, preset counts, and suggested keyframe actions.",
    "motion.timeline.transitions.panel": "Show enter and exit transitions with timing windows, easing usage, type counts, and suggested transition actions.",
    "motion.timeline.inspect": "Inspect timeline scenes, tracks, markers, and layer track refs.",
    "motion.timeline.playhead.set": "Move the timeline playhead as durable editor state without mutating MotionIR.",
    "motion.timeline.range.select": "Select an in/out timeline range as durable editor state without mutating MotionIR.",
    "motion.timeline.viewport.set": "Set timeline viewport range, zoom, and pixels-per-second as durable editor state.",
    "motion.timeline.duration.policy": "Read package duration policy and protected intro/outro regions.",
    "motion.timeline.duration.policy.set": "Set package duration policy metadata for protected regions, min/max duration, and resize behavior.",
    "motion.timeline.marker.upsert": "Insert or replace a timeline marker and optionally attach it to a scene.",
    "motion.timeline.marker.delete": "Remove a timeline marker and prune stale scene marker refs.",
    "motion.timeline.scene.create": "Create a storyboard scene with timing, optional display name, and optional track or marker refs.",
    "motion.timeline.scene.delete": "Remove a storyboard scene while preserving referenced timeline content and package duration.",
    "motion.timeline.scene.reorder": "Reorder storyboard scene rows while preserving timing, refs, and package duration.",
    "motion.timeline.scene.resize": "Resize a scene duration and optionally ripple later scenes, layers, and markers.",
    "motion.timeline.scene.name.set": "Set a timeline scene display name without renaming stable scene ids or hand-authoring JSON pointer patches.",
    "motion.timeline.easing.panel": "Inspect sampled easing curves and package usage across keyframes and transitions.",
    "motion.timeline.easing.presets": "List named and cubic-bezier easing presets available for keyframes and transitions.",
    "motion.timeline.animation.presets": "List reusable entrance and exit animation presets available for layer keyframes.",
    "motion.timeline.animation.preset.apply": "Apply a reusable animation preset to one or more layers as deterministic keyframes with receipt evidence.",
    "motion.timeline.keyframe.upsert": "Insert or replace a typed timeline keyframe without hand-authoring JSON pointer patches.",
    "motion.timeline.keyframe.delete": "Remove a typed timeline keyframe without hand-authoring JSON pointer patches.",
    "motion.timeline.keyframe.move": "Move an existing typed timeline keyframe to a new timestamp while preserving its value and easing.",
    "motion.timeline.keyframe.easing.apply": "Apply an easing preset to one keyframe or a selected keyframe time range.",
    "motion.timeline.keyframe.shift": "Shift a selected typed keyframe range by a positive or negative delta while preserving values and easing.",
    "motion.timeline.keyframe.scale": "Stretch or compress a selected typed keyframe range around an origin while preserving values and easing.",
    "motion.timeline.keyframe.duplicate": "Copy a selected typed keyframe range by a positive or negative offset while preserving original keyframes, values, and easing.",
    "motion.timeline.keyframe.distribute": "Space three or more typed keyframes evenly between the first and last selected timestamps while preserving values and easing.",
    "motion.timeline.keyframe.range.delete": "Remove a selected typed keyframe range while preserving other targets and pruning empty keyframe containers.",
    "motion.timeline.keyframe.reverse": "Reverse a selected typed keyframe range in time while preserving values and easing.",
    "motion.timeline.keyframe.snap": "Snap a selected typed keyframe range to the package frame grid while preserving values and easing.",
    "motion.timeline.layer.create": "Create a typed text, shape, media, environment, or other bounded data-only layer with stack and optional track placement evidence.",
    "motion.timeline.layer.trim": "Update layer start, duration, and optional media source trim fields without hand-authoring JSON pointer patches.",
    "motion.timeline.layer.split": "Split a layer at an absolute timeline timestamp while preserving segment timing, media trim, keyframes, transitions, and track order.",
    "motion.timeline.layer.text.set": "Set text on an existing text or caption layer without hand-authoring JSON pointer patches.",
    "motion.timeline.layer.style.set": "Set a supported top-level layer style property without hand-authoring JSON pointer patches.",
    "motion.timeline.layer.transform.set": "Set a supported static layer transform or opacity value without hand-authoring JSON pointer patches.",
    "motion.timeline.layer.effect.set": "Set a supported static layer visual effect value without hand-authoring JSON pointer patches.",
    "motion.timeline.layer.rich.set": "Set one inspector-exposed, allow-listed environment, shader, particle, 3D, camera/depth, motion-blur, or film control.",
    "motion.timeline.layer.blend.set": "Set a supported static layer blend mode without hand-authoring JSON pointer patches.",
    "motion.timeline.layer.crop.set": "Set a static image or video source crop rectangle without hand-authoring JSON pointer patches.",
    "motion.timeline.layer.mask.set": "Set a static visual-layer rectangular or rounded mask without hand-authoring JSON pointer patches.",
    "motion.timeline.layer.fit.set": "Set a static image or video media fit mode without hand-authoring JSON pointer patches.",
    "motion.timeline.layer.media.set": "Set a media layer source and canonicalize stale direct source aliases without hand-authoring JSON pointer patches.",
    "motion.timeline.layer.name.set": "Set a timeline layer display name without renaming stable layer ids or hand-authoring JSON pointer patches.",
    "motion.timeline.layer.visibility.set": "Hide or show a timeline layer without deleting it or hand-authoring JSON pointer patches.",
    "motion.timeline.layer.lock": "Lock or unlock a timeline layer with receipt evidence so later edit commands can honor layer protection.",
    "motion.timeline.layer.delete": "Delete a layer while removing stale track refs and preserving receipt evidence.",
    "motion.timeline.layer.duplicate": "Duplicate a layer while preserving animation, transitions, timing, and track order evidence.",
    "motion.timeline.layer.reorder": "Reorder a layer in the global timeline stack while syncing track layer order evidence.",
    "motion.timeline.cleanup": "Remove stale or duplicate track, scene, and marker refs while normalizing package duration with receipt evidence.",
    "motion.timeline.track.create": "Create a timeline track and optionally attach existing untracked layers with receipt evidence.",
    "motion.timeline.track.reorder": "Reorder timeline tracks with old/new stack index and track-order receipt evidence.",
    "motion.timeline.track.delete": "Delete a timeline track while preserving layers, optionally detaching layer refs, and pruning scene refs.",
    "motion.timeline.track.rename": "Rename a timeline track with old/new name and changed-path receipt evidence.",
    "motion.timeline.track.lock": "Lock or unlock a timeline track with receipt evidence so later edit commands can honor track protection.",
    "motion.timeline.track.mute": "Mute or unmute a timeline track with receipt evidence so final renders can honor track audio state.",
    "motion.timeline.track.solo": "Solo or unsolo a timeline track with receipt evidence so final renders can isolate track audio state.",
    "motion.timeline.track.volume": "Set timeline track gain with receipt evidence so final renders can honor track audio level.",
    "motion.timeline.track.fade": "Set timeline track fade-in and fade-out defaults with receipt evidence so final renders can honor track audio fades.",
    "motion.timeline.track.pan": "Set timeline track stereo balance with receipt evidence so final renders can honor track audio pan.",
    "motion.timeline.layer.ducking.set": "Set ducking on an audio layer so final renders lower it under trigger layers. Default mode 'timed' lowers the layer across each trigger's time window (level-independent); mode 'sidechain' uses true level-dependent FFmpeg sidechaincompress (threshold/ratio/attack/release) so it only ducks while the trigger audio is actually loud.",
    "motion.timeline.layer.track.assign": "Assign or reorder a layer on a timeline track while keeping layer track refs and track layer order consistent.",
    "motion.timeline.caption.import": "Parse SRT, VTT, or plain captions into typed caption layers on a timeline caption track.",
    "motion.timeline.caption.upsert": "Insert or replace one caption layer with text, timing, style, and caption track evidence.",
    "motion.timeline.transition.upsert": "Insert or replace a layer enter or exit transition without hand-authoring JSON pointer patches.",
    "motion.timeline.transition.delete": "Remove a layer enter or exit transition without hand-authoring JSON pointer patches.",
    "motion.script.compile": "Compile a structured scripted-video storyboard into a local Motion package.",
    "motion.capabilities.match": "Match the package and requested output against renderer lane capability cards before rendering.",
    "motion.capabilities.panel": "Show grouped renderer lane cards with support badges, package fit, recommended lane, and follow-up match or export-plan actions.",
    "motion.template.catalog": "List available Motion templates from explicit package roots.",
    "motion.template.panel": "Show grouped TemplateIR controls with current bound Motion values and follow-up actions.",
    "motion.template.controls": "List host-editable template controls for the current package.",
    "motion.template.apply": "Apply host-editable template values through declared bindings.",
    "motion.template.media.replace": "Replace a TemplateIR media slot with a copied package-local asset and bound MotionIR refs.",
    "motion.canvas.package": "Convert the selected Canvas frame into a local Motion package and resource catalog.",
    "motion.canvas.bridge_export": "Export a Canvas checkout frame selection through the trusted Canvas bridge.",
    "motion.quality.panel": "Show quality-manifest samples, baselines, regions, audio policy, and suggested quality follow-up commands.",
    "motion.quality.check": "Inspect final media dimensions plus representative-frame visual and alpha quality.",
    "motion.connector.panel": "Show connector workflow readiness for Canvas, Cut Generate, scripted-video, source, and template handoffs.",
    "motion.connector.canvas_to_cut": "Run the Canvas-to-Cut connector harness.",
    "motion.connector.canvas_to_mp4": "Run the Canvas-to-MP4 connector harness.",
    "motion.connector.script_to_cut": "Run the Script-to-Cut scripted-video connector workflow without requiring Canvas.",
    "motion.connector.source_to_cut": "Run imported source Markdown through storyboard planning, Script-to-Cut, and Cut import planning.",
    "motion.connector.cut_generate_to_cut": "Run the Cut Generate scripted-video-to-Cut connector workflow.",
    "motion.connector.template_to_cut": "Apply TemplateIR values, render if needed, and create a Cut import plan.",
    "motion.review.html.bundle": "Collect render, preview, quality, and receipt evidence into a portable local HTML review bundle.",
    "motion.source.import": "Fetch or accept a pre-fetched public prompt source into Markdown with safe-fetch policy and receipt evidence.",
    "motion.source.to_scripted_video": "Lower imported source Markdown into deterministic scripted-video JSON with source refs and review-required storyboard metadata.",
    "motion.storyboard.panel": "Review scripted-video storyboard metadata, readiness diagnostics, source refs, frame timings, and follow-up compile or Cut handoff actions.",
    "motion.storyboard.graph": "Review scripted-video source, asset, template, engine, review, sequence graph facts, and readiness diagnostics before compile or Cut handoff.",
    "motion.html.snippet.export": "Export a standalone HTML/CSS composition artifact with ShellX timing metadata and adapter lossiness diagnostics.",
    "motion.html.snippet.import": "Import a bounded inert ShellX/HyperFrames-style HTML composition, stage verified local media, and record discarded HTML/CSS behavior in a receipt.",
    "motion.otio.export": "Export the current Motion package to an OpenTimelineIO editorial interchange timeline.",
    "motion.otio.import": "Import an OpenTimelineIO editorial interchange timeline into a local Motion package.",
    "motion.package.archive": "Export the current Motion package as a deterministic portable .shellxmotion archive with receipt evidence.",
    "motion.package.extract": "Extract a portable .shellxmotion archive into a local Motion package with receipt evidence.",
    "motion.support.bundle": "Collect local diagnostics for support handoff.",
    "motion.platform.verification.panel": "Summarize Linux, Windows, macOS, and aggregate platform verification receipts.",
    "motion.agent.transcript": "Read prompt and agent receipt transcripts as panel-ready redacted evidence.",
    "motion.receipts.panel": "Summarize host-owned receipts for a panel with recent activity, warnings, failures, and artifacts.",
    "motion.assets.panel": "Summarize package assets, MotionIR asset refs, layer usage, hashes, and missing local files.",
    "motion.brand.panel": "Summarize design-token groups and brand provenance for package handoff.",
    "motion.receipts.read": "Read host-owned evidence for the operation."
  };
  return purposes[call] ?? `Run ${call}.`;
}

function aliasScore(request: string, alias: string): number {
  const aliasWords = wordsForMatch(alias);
  const requestWords = wordsForMatch(request);
  const intentBoost = aliasWords.filter((word) => INTENT_WORDS.has(word) && requestWords.includes(word)).length * 25;
  if (request === alias) return alias.length + 200 + intentBoost;
  if (request.includes(alias)) return alias.length + 100 + intentBoost;
  const overlap = aliasWords.filter((word) => requestWords.includes(word)).length;
  return overlap >= 2 ? overlap : 0;
}

/** Shared with the workflow classifier so both passes tokenize a request identically. */
const normalize = normalizeRequest;

const INTENT_WORDS = new Set(["add", "animate", "apply", "capture", "change", "clear", "clone", "compile", "copy", "cut", "delete", "duplicate", "edit", "export", "extend", "generate", "modify", "move", "remove", "render", "resize", "retime", "ripple", "send", "set", "shorten", "slide", "split", "trim", "update"]);

function wordsForMatch(value: string): string[] {
  return [...new Set(value.split(" ").filter((word) => word.length > 2).map(stemForMatch))];
}

function stemForMatch(word: string): string {
  return word.endsWith("s") && word.length > 4 ? word.slice(0, -1) : word;
}
