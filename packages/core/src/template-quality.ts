import type { MotionLayer, MotionPackage } from "./types";

export type TemplateQualityRuleId =
  | "template-sidecar-complete"
  | "preview-poster-contact-sheet"
  | "fhd-social-output-bounds"
  | "text-fit-safe-areas"
  | "source-asset-provenance"
  | "audio-stream-proof"
  | "cut-canvas-connector-receipts";

export type TemplateQualityStatus = "passed" | "failed" | "warning" | "not_applicable";

export interface TemplateQualityRule {
  id: TemplateQualityRuleId;
  title: string;
  severity: "blocker" | "required";
  evidence: string[];
}

export interface TemplateQualityRenderedOutput {
  path: string;
  width: number;
  height: number;
  container?: string;
}

export interface TemplateQualityCheckEvidence {
  contactSheetPath?: string;
  renderedOutputs?: TemplateQualityRenderedOutput[];
  textFit?: { status: "passed" | "failed" | "missing"; receiptPath?: string };
  safeAreas?: { status: "passed" | "failed" | "missing"; receiptPath?: string };
  generatedAssetReceiptPaths?: string[];
  audio?: { status: "passed" | "failed" | "missing"; streamCount?: number; receiptPath?: string };
  connectorReceipts?: Array<{
    host: "shellx-cut" | "shellx-canvas" | string;
    status: "passed" | "failed" | "missing";
    receiptPath?: string;
  }>;
}

export interface TemplateQualityRuleResult {
  ruleId: TemplateQualityRuleId;
  status: TemplateQualityStatus;
  message: string;
  evidence: string[];
}

export interface TemplateQualityAssessment {
  schema: "shellx-motion/template-quality-assessment@1";
  packageId: string;
  status: Exclude<TemplateQualityStatus, "not_applicable">;
  results: TemplateQualityRuleResult[];
}

export interface TemplateQualitySummary {
  status: Exclude<TemplateQualityStatus, "not_applicable">;
  passed: number;
  failed: number;
  warning: number;
  notApplicable: number;
}

const TEMPLATE_QUALITY_RULES: TemplateQualityRule[] = [
  {
    id: "template-sidecar-complete",
    title: "Template sidecar completeness",
    severity: "blocker",
    evidence: ["template.json", "params", "controls", "bindings", "metadata"]
  },
  {
    id: "preview-poster-contact-sheet",
    title: "Preview poster and contact-sheet review",
    severity: "required",
    evidence: ["metadata.preview.poster", "contact sheet artifact"]
  },
  {
    id: "fhd-social-output-bounds",
    title: "FHD and social output bounds",
    severity: "required",
    evidence: ["metadata.outputBounds.aspectRatios", "FHD MP4", "social MP4"]
  },
  {
    id: "text-fit-safe-areas",
    title: "Text fit and safe areas",
    severity: "required",
    evidence: ["text-fit receipt", "safe-area receipt", "motion.safeAreas"]
  },
  {
    id: "source-asset-provenance",
    title: "Source and generated asset provenance",
    severity: "required",
    evidence: ["metadata.provenance", "license", "asset attribution", "generated asset receipts"]
  },
  {
    id: "audio-stream-proof",
    title: "Audio stream proof when audio is advertised",
    severity: "required",
    evidence: ["audio layer", "ffprobe/audio quality receipt"]
  },
  {
    id: "cut-canvas-connector-receipts",
    title: "Cut and Canvas connector receipts",
    severity: "required",
    evidence: ["shellx-cut connector receipt", "shellx-canvas connector receipt"]
  }
];

export function listTemplateQualityRules(): TemplateQualityRule[] {
  return TEMPLATE_QUALITY_RULES.map((rule) => ({
    ...rule,
    evidence: [...rule.evidence]
  }));
}

export function assessTemplateQuality(
  pkg: MotionPackage,
  evidence: TemplateQualityCheckEvidence = {}
): TemplateQualityAssessment {
  const results: TemplateQualityRuleResult[] = [
    assessTemplateSidecar(pkg),
    assessPreviewAndContactSheet(pkg, evidence),
    assessOutputBounds(pkg, evidence),
    assessTextFitAndSafeAreas(pkg, evidence),
    assessSourceAssetProvenance(pkg, evidence),
    assessAudioProof(pkg, evidence),
    assessConnectorReceipts(pkg, evidence)
  ];
  const status = results.some((result) => result.status === "failed")
    ? "failed"
    : results.some((result) => result.status === "warning")
      ? "warning"
      : "passed";
  return {
    schema: "shellx-motion/template-quality-assessment@1",
    packageId: pkg.manifest.id,
    status,
    results
  };
}

export function summarizeTemplateQuality(assessment: TemplateQualityAssessment): TemplateQualitySummary {
  return {
    status: assessment.status,
    passed: assessment.results.filter((result) => result.status === "passed").length,
    failed: assessment.results.filter((result) => result.status === "failed").length,
    warning: assessment.results.filter((result) => result.status === "warning").length,
    notApplicable: assessment.results.filter((result) => result.status === "not_applicable").length
  };
}

function assessTemplateSidecar(pkg: MotionPackage): TemplateQualityRuleResult {
  const template = pkg.template;
  const metadata = template?.metadata;
  const ok = Boolean(
    template
    && template.params.length > 0
    && template.controls.length > 0
    && template.bindings.length > 0
    && template.compatibleLanes.length > 0
    && metadata?.inputSchema
    && metadata?.outputBounds
    && metadata?.suitability
    && metadata?.license
    && metadata?.provenance
    && metadata?.performance
  );
  return ruleResult(
    "template-sidecar-complete",
    ok ? "passed" : "failed",
    ok
      ? "Template sidecar includes controls, bindings, compatibility, and required metadata."
      : "Template packages require a complete template sidecar with controls, bindings, compatibility, and required metadata.",
    [
      ...(template ? ["template.json"] : []),
      ...(metadata ? ["metadata"] : [])
    ]
  );
}

function assessPreviewAndContactSheet(pkg: MotionPackage, evidence: TemplateQualityCheckEvidence): TemplateQualityRuleResult {
  const poster = pkg.template?.metadata?.preview?.poster;
  const ok = Boolean(poster && evidence.contactSheetPath);
  return ruleResult(
    "preview-poster-contact-sheet",
    ok ? "passed" : "failed",
    ok
      ? "Preview poster and contact-sheet review artifact are present."
      : "Template catalog entries require a preview poster and contact-sheet review artifact.",
    [
      ...(poster ? [poster] : []),
      ...(evidence.contactSheetPath ? [evidence.contactSheetPath] : [])
    ]
  );
}

function assessOutputBounds(pkg: MotionPackage, evidence: TemplateQualityCheckEvidence): TemplateQualityRuleResult {
  const aspectRatios = pkg.template?.metadata?.outputBounds?.aspectRatios ?? [];
  const renderedOutputs = evidence.renderedOutputs ?? [];
  const hasFhd = renderedOutputs.some((output) => output.width >= 1920 && output.height >= 1080);
  const hasSocial = renderedOutputs.some((output) => isSocialOutput(output));
  const advertisesFhd = aspectRatios.includes("16:9");
  const advertisesSocial = aspectRatios.some((ratio) => ["1:1", "9:16", "4:5"].includes(ratio));
  const ok = advertisesFhd && advertisesSocial && hasFhd && hasSocial;
  return ruleResult(
    "fhd-social-output-bounds",
    ok ? "passed" : "failed",
    ok
      ? "Template declares and proves FHD plus social output coverage."
      : "Template quality requires declared and rendered FHD plus at least one social aspect output.",
    [
      ...aspectRatios.map((ratio) => `aspect:${ratio}`),
      ...renderedOutputs.map((output) => output.path)
    ]
  );
}

function assessTextFitAndSafeAreas(pkg: MotionPackage, evidence: TemplateQualityCheckEvidence): TemplateQualityRuleResult {
  const textFitPassed = evidence.textFit?.status === "passed";
  const safeAreasPassed = evidence.safeAreas?.status === "passed";
  const hasSafeAreas = Boolean(pkg.motion.safeAreas && Object.keys(pkg.motion.safeAreas).length > 0);
  const ok = textFitPassed && safeAreasPassed && hasSafeAreas;
  return ruleResult(
    "text-fit-safe-areas",
    ok ? "passed" : "failed",
    ok
      ? "Text-fit and safe-area evidence passed."
      : "Templates require text-fit and safe-area evidence before catalog promotion.",
    [
      ...(evidence.textFit?.receiptPath ? [evidence.textFit.receiptPath] : []),
      ...(evidence.safeAreas?.receiptPath ? [evidence.safeAreas.receiptPath] : []),
      ...(hasSafeAreas ? ["motion.safeAreas"] : [])
    ]
  );
}

function assessSourceAssetProvenance(pkg: MotionPackage, evidence: TemplateQualityCheckEvidence): TemplateQualityRuleResult {
  const metadata = pkg.template?.metadata;
  const hasProvenance = Boolean(metadata?.provenance?.source && metadata.provenance.sourceHash);
  const hasLicense = Boolean(metadata?.license?.id);
  const hasAssetAttribution = Boolean(metadata?.assetsAttribution && metadata.assetsAttribution.length > 0);
  const usesGeneratedAssets = packageUsesGeneratedAssets(pkg);
  const hasGeneratedReceipts = (evidence.generatedAssetReceiptPaths ?? []).length > 0;
  const ok = hasProvenance && hasLicense && (!usesGeneratedAssets || (hasAssetAttribution && hasGeneratedReceipts));
  return ruleResult(
    "source-asset-provenance",
    ok ? "passed" : "failed",
    ok
      ? "Template source, license, attribution, and generated asset provenance are present."
      : "Templates require source provenance, license metadata, and generated asset receipts when generated assets are used.",
    [
      ...(hasProvenance ? ["metadata.provenance"] : []),
      ...(hasLicense ? ["metadata.license"] : []),
      ...(hasAssetAttribution ? ["metadata.assetsAttribution"] : []),
      ...(evidence.generatedAssetReceiptPaths ?? [])
    ]
  );
}

function assessAudioProof(pkg: MotionPackage, evidence: TemplateQualityCheckEvidence): TemplateQualityRuleResult {
  if (!pkg.motion.layers.some(isAudioLayer)) {
    return ruleResult(
      "audio-stream-proof",
      "not_applicable",
      "Template does not advertise package audio.",
      []
    );
  }
  const ok = evidence.audio?.status === "passed" && (evidence.audio.streamCount ?? 0) > 0;
  return ruleResult(
    "audio-stream-proof",
    ok ? "passed" : "failed",
    ok
      ? "Audio layers have ffprobe/audio quality evidence."
      : "Audio layers require ffprobe/audio quality evidence with at least one audio stream.",
    [
      ...(evidence.audio?.receiptPath ? [evidence.audio.receiptPath] : [])
    ]
  );
}

function assessConnectorReceipts(pkg: MotionPackage, evidence: TemplateQualityCheckEvidence): TemplateQualityRuleResult {
  const requiredHosts = pkg.manifest.compatibility.hosts.filter((host) => host === "shellx-cut" || host === "shellx-canvas");
  if (requiredHosts.length === 0) {
    return ruleResult(
      "cut-canvas-connector-receipts",
      "not_applicable",
      "Template does not advertise Cut or Canvas host compatibility.",
      []
    );
  }
  const receipts = evidence.connectorReceipts ?? [];
  const passedHosts = new Set(receipts.filter((receipt) => receipt.status === "passed").map((receipt) => receipt.host));
  const ok = requiredHosts.every((host) => passedHosts.has(host));
  return ruleResult(
    "cut-canvas-connector-receipts",
    ok ? "passed" : "failed",
    ok
      ? "Advertised Cut and Canvas hosts have connector receipts."
      : "Templates advertised for Cut or Canvas require passed connector receipts for each advertised host.",
    receipts.flatMap((receipt) => receipt.receiptPath ? [receipt.receiptPath] : [])
  );
}

function ruleResult(
  ruleId: TemplateQualityRuleId,
  status: TemplateQualityStatus,
  message: string,
  evidence: string[]
): TemplateQualityRuleResult {
  return { ruleId, status, message, evidence };
}

function isSocialOutput(output: TemplateQualityRenderedOutput): boolean {
  const ratio = output.width / output.height;
  return Math.abs(ratio - 1) < 0.01
    || Math.abs(ratio - 9 / 16) < 0.01
    || Math.abs(ratio - 4 / 5) < 0.01;
}

function packageUsesGeneratedAssets(pkg: MotionPackage): boolean {
  return pkg.manifest.assets.some((asset) => asset.includes("/generated/"))
    || pkg.motion.layers.some((layer) => {
      const source = typeof layer.source === "string" ? layer.source : "";
      const assetRef = typeof layer.assetRef === "string" ? layer.assetRef : "";
      return source.includes("/generated/") || assetRef.includes("/generated/");
    });
}

function isAudioLayer(layer: MotionLayer): boolean {
  return layer.type === "audio";
}
