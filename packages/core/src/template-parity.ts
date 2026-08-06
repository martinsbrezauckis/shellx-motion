export type TemplateParitySurface = "motion" | "cut" | "canvas";

export type TemplateParityGapId =
  | "template-catalog"
  | "media-rich-templates"
  | "audio-lane-examples"
  | "transition-library"
  | "kinetic-typography"
  | "data-chart-templates"
  | "asset-generator-connectors"
  | "template-browser-editor"
  | "agent-authoring-loop"
  | "advanced-imports"
  | "design-variety";

export type TemplateParityPhaseId = "P0" | "P1" | "P2" | "P3" | "P4" | "P5" | "P6";

export interface TemplateParityAssetRoute {
  id: "codex-subscription-cli" | "grok-build-cli";
  role: "planning-code-template-authoring-verification" | "generated-image-video-asset-source";
  boundary: string;
  receiptRequirement: string;
}

export interface TemplateParityGap {
  id: TemplateParityGapId;
  title: string;
  phase: TemplateParityPhaseId;
  problem: string;
  target: string;
  shellxSurfaces: TemplateParitySurface[];
  benchmarkFamilies: string[];
  proof: string[];
  firstImplementationSlice: string;
}

export interface TemplateParityPhase {
  id: TemplateParityPhaseId;
  title: string;
  gapIds: TemplateParityGapId[];
  deliverables: string[];
  verification: string[];
}

export interface TemplateParityProgram {
  schema: "shellx-motion/template-parity@1";
  updatedAt: string;
  goal: string;
  assetRoutes: TemplateParityAssetRoute[];
  qualityGates: string[];
  gaps: TemplateParityGap[];
  phases: TemplateParityPhase[];
}

export interface TemplateParitySummary {
  gapCount: number;
  phaseCount: number;
  assetRouteCount: number;
  qualityGateCount: number;
  firstPhase: TemplateParityPhaseId;
  finalPhase: TemplateParityPhaseId;
  shellxSurfaces: TemplateParitySurface[];
}

const TEMPLATE_PARITY_PROGRAM: TemplateParityProgram = {
  schema: "shellx-motion/template-parity@1",
  updatedAt: "2026-07-06",
  goal: "Close visible template-product gaps so ShellX Motion can produce polished Cut, Canvas, and standalone Motion outputs that compare credibly with mature scripted-video and HTML-video tools.",
  assetRoutes: [
    {
      id: "codex-subscription-cli",
      role: "planning-code-template-authoring-verification",
      boundary: "Use the local subscription CLI for implementation, template-pack authoring, prompt-plan refinement, deterministic checks, and code review receipts. It must not become a hidden hosted dependency for OSS renders.",
      receiptRequirement: "Record adapter, prompt summary, changed files, verification commands, and package/output receipts for each authored template or workflow."
    },
    {
      id: "grok-build-cli",
      role: "generated-image-video-asset-source",
      boundary: "Use Grok Build/Imagine as a source-asset generator for images, short generated video clips, and visual references. Import outputs into Motion packages as files with provenance instead of depending on Grok at render time.",
      receiptRequirement: "Record prompt, model/tool label, generated asset path, license/provenance note, dimensions, duration when video, and downstream package asset refs."
    }
  ],
  qualityGates: [
    "real-mp4-render",
    "audio-stream-check",
    "preview-final-frame-parity",
    "source-asset-provenance",
    "human-contact-sheet-review",
    "shellx-cut-canvas-receipts"
  ],
  gaps: [
    {
      id: "template-catalog",
      title: "Template catalog depth",
      phase: "P0",
      problem: "The repo has useful fixtures, but not a visible catalog of 15-25 polished templates a user can choose from.",
      target: "Ship a curated starter catalog with reusable package sidecars, preview posters, suitability metadata, and Cut/Canvas host targets.",
      shellxSurfaces: ["motion", "cut", "canvas"],
      benchmarkFamilies: ["Remotion templates", "HyperFrames-style HTML packs", "Canva/CapCut creator templates"],
      proof: ["catalog debug/API listing includes every template", "at least ten templates render to playable FHD MP4s in the first pack"],
      firstImplementationSlice: "Create the catalog quality matrix, then add the first production template pack beside existing fixtures."
    },
    {
      id: "media-rich-templates",
      title: "Media-rich templates",
      phase: "P1",
      problem: "Current examples mostly use text and shapes, so rendered clips can look static compared with modern video tools.",
      target: "Support templates with package images, generated stills/video clips, browser captures, masks, overlays, and provenance receipts.",
      shellxSurfaces: ["motion", "cut", "canvas"],
      benchmarkFamilies: ["Runway-style generated media workflows", "Canva video templates", "HTML-video asset bundles"],
      proof: ["template package includes real media assets with provenance", "final MP4 shows non-static visual change across sampled frames"],
      firstImplementationSlice: "Add one hero media slot template using checked-in placeholder assets and generated-asset receipt shape."
    },
    {
      id: "audio-lane-examples",
      title: "Audio lane examples",
      phase: "P2",
      problem: "Renderer capabilities include audio mixing, but visible templates and test videos currently ship without audio streams.",
      target: "Provide music, ambience, narration, ducking, fades, and loudness-checked export examples.",
      shellxSurfaces: ["motion", "cut"],
      benchmarkFamilies: ["Creatomate audio automation", "editor timeline music/narration lanes", "social video generators"],
      proof: ["ffprobe confirms audio streams", "quality receipt records level/loudness checks"],
      firstImplementationSlice: "Add a licensed synthetic tone/music fixture and an FHD campaign render with audio proof."
    },
    {
      id: "transition-library",
      title: "Transition library",
      phase: "P2",
      problem: "Fade, slide, wipe, and procedural effects exist, but there is not a named transition library with reusable presets.",
      target: "Ship reusable transition presets for product reveals, split-screen changes, card stacks, punch-in/out, and browser-lane HTML effects.",
      shellxSurfaces: ["motion", "cut", "canvas"],
      benchmarkFamilies: ["Remotion compositions", "CapCut transition packs", "HyperFrames CSS timing"],
      proof: ["preset catalog test covers every transition id", "real clips exercise at least five named presets"],
      firstImplementationSlice: "Move existing effect/transition names into a catalog and use them from one template pack."
    },
    {
      id: "kinetic-typography",
      title: "Kinetic typography",
      phase: "P2",
      problem: "Text can animate, but there is no high-level typography system for word/line reveals, counters, or emphasis beats.",
      target: "Add readable kinetic text presets that agents can request without hand-authoring every keyframe.",
      shellxSurfaces: ["motion", "cut", "canvas"],
      benchmarkFamilies: ["Motion Canvas text animation", "Remotion text reveal components", "marketing subtitle tools"],
      proof: ["typography presets generate deterministic keyframes", "safe-area and text-fit tests pass for FHD and social ratios"],
      firstImplementationSlice: "Create title, subtitle, statistic, and callout typography presets for the product-family pack."
    },
    {
      id: "data-chart-templates",
      title: "Data and chart templates",
      phase: "P3",
      problem: "Batch/data render lanes exist, but users do not yet see chart, metric, or comparison templates.",
      target: "Render CSV/JSON-driven charts, stat cards, comparison tables, timelines, and localized text variants.",
      shellxSurfaces: ["motion", "canvas"],
      benchmarkFamilies: ["Creatomate data renders", "chart video generators", "SaaS reporting clips"],
      proof: ["batch render emits per-row receipts", "chart templates validate data schemas and aspect variants"],
      firstImplementationSlice: "Add a three-row product metric campaign with FHD and square exports."
    },
    {
      id: "asset-generator-connectors",
      title: "Asset generator connectors",
      phase: "P1",
      problem: "Generated assets are useful, but Motion needs a disciplined CLI/provenance lane instead of ad hoc files.",
      target: "Use Codex subscription CLI for authoring and Grok Build/Imagine for generated image/video sources, both with receipts and package-local imports.",
      shellxSurfaces: ["motion", "cut", "canvas"],
      benchmarkFamilies: ["prompt-to-video tools", "HTML-video agents", "AI image/video generators"],
      proof: ["asset receipt records generator, prompt summary, and imported package ref", "render does not need network or hosted model access"],
      firstImplementationSlice: "Define the asset receipt schema and add one generated-asset placeholder workflow that can run offline in tests."
    },
    {
      id: "template-browser-editor",
      title: "Template browser and editor",
      phase: "P4",
      problem: "Debug APIs can list and apply controls, but users need a polished browser/editor surface in Motion, Cut Generate, and Canvas export.",
      target: "Expose template search, suitability, controls, media replacement, preview posters, and apply/render actions through host-ready APIs.",
      shellxSurfaces: ["motion", "cut", "canvas"],
      benchmarkFamilies: ["Canva template picker", "CapCut Generate", "HyperFrames prompt panels"],
      proof: ["debug/API panel snapshot covers cards and controls", "Cut and Canvas call the same template action contract"],
      firstImplementationSlice: "Add catalog filters and suitability scoring outputs needed by host UI panels."
    },
    {
      id: "agent-authoring-loop",
      title: "Agent authoring loop",
      phase: "P5",
      problem: "Prompt actions exist, but the product needs a repeatable loop: brief, plan, generate assets, build package, render, critique, revise.",
      target: "Make Codex/Grok-backed local jobs resumable, inspectable, cancelable, and fully receipted for OSS workflows.",
      shellxSurfaces: ["motion", "cut", "canvas"],
      benchmarkFamilies: ["agentic HTML-video repos", "AI video SaaS generation loops", "agent workflow-runner handoffs"],
      proof: ["job event log replays after reconnect", "failed/unavailable CLI agent returns typed refusal with no package mutation"],
      firstImplementationSlice: "Add a prompt-to-template execution plan that records intended asset routes before mutation."
    },
    {
      id: "advanced-imports",
      title: "Advanced imports and adapters",
      phase: "P6",
      problem: "Mature tools can ingest Lottie, SVG/CSS animation, HTML snippets, and engine-specific projects; Motion only has early import paths.",
      target: "Add adapter lanes with compatibility diagnostics and lossiness receipts for Lottie/dotLottie, Rive-like state, SVG path animation, and shader-like browser effects.",
      shellxSurfaces: ["motion", "cut", "canvas"],
      benchmarkFamilies: ["Lottie/dotLottie", "Rive", "Motion Canvas", "Remotion", "HyperFrames"],
      proof: ["adapter emits exact unsupported features by path", "round-trip fixtures define an explicit loss budget"],
      firstImplementationSlice: "Add adapter capability cards and one SVG path-animation import diagnostic fixture."
    },
    {
      id: "design-variety",
      title: "Design variety and polish",
      phase: "P0",
      problem: "Current campaigns prove the pipeline, but visual language is still narrow and can read like basic test material.",
      target: "Create multiple visual families: SaaS launch, data/report, social promo, tutorial overlay, product release, and editorial explainer.",
      shellxSurfaces: ["motion", "cut", "canvas"],
      benchmarkFamilies: ["Canva visual families", "editor template packs", "brand campaign systems"],
      proof: ["contact sheets show at least six distinct design families", "contrast, safe-area, and text-fit checks pass on desktop and social outputs"],
      firstImplementationSlice: "Define the design matrix and improve the next three templates against it before adding breadth."
    }
  ],
  phases: [
    {
      id: "P0",
      title: "Quality bar and catalog spine",
      gapIds: ["template-catalog", "design-variety"],
      deliverables: ["machine-readable parity program", "roadmap section", "template quality matrix", "starter pack acceptance rules"],
      verification: ["core parity tests", "roadmap diff check", "contact-sheet review criteria"]
    },
    {
      id: "P1",
      title: "Media and generated-asset foundation",
      gapIds: ["media-rich-templates", "asset-generator-connectors"],
      deliverables: ["package-local generated asset receipts", "Grok Build/Imagine source-asset workflow", "media slot template"],
      verification: ["offline render proves imported assets", "source asset provenance exists", "sampled frames are non-static"]
    },
    {
      id: "P2",
      title: "Motion language breadth",
      gapIds: ["audio-lane-examples", "transition-library", "kinetic-typography"],
      deliverables: ["audio example pack", "named transition presets", "kinetic text presets"],
      verification: ["ffprobe audio stream check", "preview/final parity", "text-fit and safe-area checks"]
    },
    {
      id: "P3",
      title: "Data and batch product templates",
      gapIds: ["data-chart-templates"],
      deliverables: ["chart/stat templates", "CSV/JSON examples", "aspect-ratio batch variants"],
      verification: ["per-row receipts", "idempotency keys", "FHD and square real renders"]
    },
    {
      id: "P4",
      title: "Template browser and host editor",
      gapIds: ["template-browser-editor"],
      deliverables: ["catalog filtering", "host-ready controls panel data", "media replacement preview/apply receipts"],
      verification: ["debug/API panel tests", "Cut Generate and Canvas export connector receipts"]
    },
    {
      id: "P5",
      title: "Agent authoring loop",
      gapIds: ["agent-authoring-loop"],
      deliverables: ["brief-to-plan-to-package job state", "CLI adapter receipts", "critique/revise loop"],
      verification: ["job replay after reconnect", "typed unavailable-agent refusal", "no hidden network requirement for render"]
    },
    {
      id: "P6",
      title: "Advanced adapter lanes",
      gapIds: ["advanced-imports"],
      deliverables: ["adapter capability cards", "SVG/Lottie/Rive diagnostics", "lossiness receipts"],
      verification: ["unsupported feature reports", "round-trip loss budget fixtures", "host import warnings"]
    }
  ]
};

export function templateParityProgram(): TemplateParityProgram {
  return structuredClone(TEMPLATE_PARITY_PROGRAM);
}

export function listTemplateParityGaps(): TemplateParityGap[] {
  return templateParityProgram().gaps;
}

export function summarizeTemplateParityProgram(): TemplateParitySummary {
  const program = templateParityProgram();
  const shellxSurfaces = Array.from(new Set(program.gaps.flatMap((gap) => gap.shellxSurfaces))).sort() as TemplateParitySurface[];
  return {
    gapCount: program.gaps.length,
    phaseCount: program.phases.length,
    assetRouteCount: program.assetRoutes.length,
    qualityGateCount: program.qualityGates.length,
    firstPhase: program.phases[0]?.id ?? "P0",
    finalPhase: program.phases[program.phases.length - 1]?.id ?? "P6",
    shellxSurfaces
  };
}
