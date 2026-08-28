/**
 * Carry frame-lane warnings into the receipt for the delivered render artifact.
 *
 * A final render has two stages: one lane rasterizes frames, then a delivery lane encodes or
 * packages them. The caller normally receives only the delivery receipt, so frame warnings and
 * audio handoff evidence must be folded into that receipt rather than disappearing with temporary
 * PNGs. This module is shared by the CLI and typed Debug API so their receipts describe the same
 * artifact facts.
 */
import { escalateReceiptStatusForWarnings, type OperationReceipt } from "@shellx-motion/core";

const STATUS_SEVERITY: Record<OperationReceipt["status"], number> = {
  not_run: 0,
  passed: 1,
  warning: 2,
  failed: 3
};

interface HandoffLayer {
  id: string;
  type: string;
}

type TypographyAttestation = "verified" | "unverified" | "not_applicable";

interface TypographyScope {
  kind: "motion-ir" | "html-web-canvas";
  attestation: "verified" | "unverified";
  layerIds: string[];
  reason?: "arbitrary_html_web_canvas_text_unobservable" | "requested_font_not_manifest_bound";
}

interface TypographyLayer {
  layerId: string;
  direction: "ltr" | "rtl";
  lang: string | null;
  requestedFontFamily: string | null;
  resolvedFontFamily: string;
  primaryFontAvailable: boolean | null;
  fontProvenance: "manifest-bound" | "unverified";
}

interface TypographyFontAsset {
  id: string;
  family: string;
  sha256: string;
}

interface BrowserTypographyFrameEvidence {
  attestation: TypographyAttestation;
  scopes: TypographyScope[];
  layers: TypographyLayer[];
  fontAssets: TypographyFontAsset[];
  fallbackLayerIds: string[];
}

/**
 * Bounded all-frame summary copied into a materialized final-delivery receipt. The browser frame
 * receipt is otherwise transient, and its terminal frame alone cannot prove the typography state
 * of an earlier frame.
 */
interface DeliveredBrowserTypographyEvidence {
  schema: "shellx-motion/browser-typography-delivery@1";
  authority: "chromium";
  coverage: "all-rasterized-frames" | "partial";
  rasterizedFrameCount: number;
  evidenceFrameCount: number;
  attestation: TypographyAttestation;
  fontProbe: "canvas-metric";
  scopes: TypographyScope[];
  layers: TypographyLayer[];
  fontAssets: TypographyFontAsset[];
  fallbackLayerIds: string[];
}

const MAX_TYPOGRAPHY_SCOPES = 64;
const MAX_TYPOGRAPHY_LAYERS = 512;
const MAX_TYPOGRAPHY_LAYER_IDS = 512;
const MAX_TYPOGRAPHY_FONT_ASSETS = 32;

export interface ResolvedAudioHandoff {
  status: "handled_downstream";
  handledBy: "ffmpeg";
  layers: HandoffLayer[];
  resolution: "muxed" | "not_delivered";
}

/** Accumulates distinct warnings and downstream audio handoffs from every rasterized frame. */
export class FrameLaneWarnings {
  private readonly warnings: string[] = [];
  private readonly seen = new Set<string>();
  private readonly handoffLayers: HandoffLayer[] = [];
  private readonly typographyScopes = new Map<string, TypographyScope>();
  private readonly typographyLayers = new Map<string, TypographyLayer>();
  private readonly typographyFontAssets = new Map<string, TypographyFontAsset>();
  private readonly typographyFallbackLayerIds = new Set<string>();
  private typographyEvidenceFrameCount = 0;
  private typographyAttestation: TypographyAttestation = "not_applicable";
  private observedFrameCount = 0;
  private severity = 0;

  observe(frameReceipt: unknown): void {
    const record = readRecord(frameReceipt);
    if (!record) return;
    this.observedFrameCount += 1;
    for (const warning of readStringArray(record.warnings)) {
      if (this.seen.has(warning)) continue;
      this.seen.add(warning);
      this.warnings.push(warning);
    }
    for (const layer of readHandoffLayers(record.output)) {
      if (this.handoffLayers.some((entry) => entry.id === layer.id)) continue;
      this.handoffLayers.push(layer);
    }
    this.observeTypography(readBrowserTypographyEvidence(record.output));
    const status = record.status;
    if (typeof status === "string" && status in STATUS_SEVERITY) {
      this.severity = Math.max(this.severity, STATUS_SEVERITY[status as OperationReceipt["status"]]);
    }
  }

  list(): string[] {
    return [...this.warnings];
  }

  audioHandoffLayers(): HandoffLayer[] {
    return [...this.handoffLayers];
  }

  applyTo(receipt: OperationReceipt): void {
    const output = readRecord(receipt.output);
    const typography = this.deliveredTypographyEvidence();
    if (output && typography) output.typography = typography;
    const undelivered = this.handoffLayers.length > 0 && !deliveryCarriesAudio(receipt.output);
    if (this.handoffLayers.length > 0 && output) {
      const resolved: ResolvedAudioHandoff = {
        status: "handled_downstream",
        handledBy: "ffmpeg",
        layers: this.audioHandoffLayers(),
        resolution: undelivered ? "not_delivered" : "muxed"
      };
      output.audioHandoff = resolved;
    }
    const undeliveredWarnings = undelivered
      ? [`Audio ${this.handoffLayers.length === 1 ? "layer" : "layers"} ${this.handoffLayers.map((layer) => layer.id).join(", ")} `
        + "were not drawn by the frame lane and the delivered artifact carries no audio track; this output is silent."]
      : [];
    if (this.warnings.length === 0 && undeliveredWarnings.length === 0 && this.severity < STATUS_SEVERITY.warning) return;
    const existing = receipt.warnings ?? [];
    const merged: string[] = [];
    const seen = new Set<string>();
    for (const warning of [...this.warnings, ...undeliveredWarnings, ...existing]) {
      if (seen.has(warning)) continue;
      seen.add(warning);
      merged.push(warning);
    }
    receipt.warnings = merged;
    const severity = Math.max(this.severity, undeliveredWarnings.length > 0 ? STATUS_SEVERITY.warning : 0);
    const current = STATUS_SEVERITY[receipt.status] ?? 0;
    if (severity > current && receipt.status !== "failed") {
      receipt.status = severity === STATUS_SEVERITY.failed ? "failed" : "warning";
    }
    receipt.status = escalateReceiptStatusForWarnings(receipt.status, receipt.warnings);
  }

  private observeTypography(evidence: BrowserTypographyFrameEvidence | null): void {
    if (!evidence) return;
    this.typographyEvidenceFrameCount += 1;
    if (evidence.attestation === "unverified") this.typographyAttestation = "unverified";
    else if (evidence.attestation === "verified" && this.typographyAttestation === "not_applicable") {
      this.typographyAttestation = "verified";
    }
    for (const scope of evidence.scopes) {
      if (this.typographyScopes.size >= MAX_TYPOGRAPHY_SCOPES) break;
      this.typographyScopes.set(typographyScopeKey(scope), scope);
    }
    for (const layer of evidence.layers) {
      if (this.typographyLayers.size >= MAX_TYPOGRAPHY_LAYERS) break;
      this.typographyLayers.set(typographyLayerKey(layer), layer);
    }
    for (const fontAsset of evidence.fontAssets) {
      if (this.typographyFontAssets.size >= MAX_TYPOGRAPHY_FONT_ASSETS) break;
      this.typographyFontAssets.set(typographyFontAssetKey(fontAsset), fontAsset);
    }
    for (const layerId of evidence.fallbackLayerIds) {
      if (this.typographyFallbackLayerIds.size >= MAX_TYPOGRAPHY_LAYER_IDS) break;
      this.typographyFallbackLayerIds.add(layerId);
    }
  }

  private deliveredTypographyEvidence(): DeliveredBrowserTypographyEvidence | null {
    if (this.typographyEvidenceFrameCount === 0) return null;
    const coverage = this.typographyEvidenceFrameCount === this.observedFrameCount
      ? "all-rasterized-frames"
      : "partial";
    return {
      schema: "shellx-motion/browser-typography-delivery@1",
      authority: "chromium",
      coverage,
      rasterizedFrameCount: this.observedFrameCount,
      evidenceFrameCount: this.typographyEvidenceFrameCount,
      attestation: coverage === "partial" ? "unverified" : this.typographyAttestation,
      fontProbe: "canvas-metric",
      scopes: [...this.typographyScopes.values()],
      layers: [...this.typographyLayers.values()],
      fontAssets: [...this.typographyFontAssets.values()],
      fallbackLayerIds: [...this.typographyFallbackLayerIds]
    };
  }
}

function deliveryCarriesAudio(output: unknown): boolean {
  const record = readRecord(output);
  return Boolean(record && readRecord(record.audio));
}

function readHandoffLayers(output: unknown): HandoffLayer[] {
  const handoff = readRecord(readRecord(output)?.audioHandoff);
  if (!handoff || handoff.status !== "handled_downstream" || !Array.isArray(handoff.layers)) return [];
  return handoff.layers.flatMap((entry) => {
    const layer = readRecord(entry);
    return layer && typeof layer.id === "string" && typeof layer.type === "string"
      ? [{ id: layer.id, type: layer.type }]
      : [];
  });
}

function readBrowserTypographyEvidence(output: unknown): BrowserTypographyFrameEvidence | null {
  const typography = readRecord(readRecord(output)?.typography);
  if (!typography || typography.schema !== "shellx-motion/browser-typography@1" || typography.authority !== "chromium"
    || typography.fontProbe !== "canvas-metric" || !isTypographyAttestation(typography.attestation)) {
    return null;
  }
  const scopes = Array.isArray(typography.scopes)
    ? typography.scopes.flatMap(readTypographyScope).slice(0, MAX_TYPOGRAPHY_SCOPES)
    : [];
  const layers = Array.isArray(typography.layers)
    ? typography.layers.flatMap(readTypographyLayer).slice(0, MAX_TYPOGRAPHY_LAYERS)
    : [];
  const fontAssets = Array.isArray(typography.fontAssets)
    ? typography.fontAssets.flatMap(readTypographyFontAsset).slice(0, MAX_TYPOGRAPHY_FONT_ASSETS)
    : [];
  const fallbackLayerIds = readBoundedStrings(typography.fallbackLayerIds, MAX_TYPOGRAPHY_LAYER_IDS);
  return { attestation: typography.attestation, scopes, layers, fontAssets, fallbackLayerIds };
}

function readTypographyScope(value: unknown): TypographyScope[] {
  const scope = readRecord(value);
  if (!scope || (scope.kind !== "motion-ir" && scope.kind !== "html-web-canvas")
    || (scope.attestation !== "verified" && scope.attestation !== "unverified")) {
    return [];
  }
  const reason = scope.reason === "arbitrary_html_web_canvas_text_unobservable"
    || scope.reason === "requested_font_not_manifest_bound"
    ? scope.reason
    : undefined;
  return [{
    kind: scope.kind,
    attestation: scope.attestation,
    layerIds: readBoundedStrings(scope.layerIds, MAX_TYPOGRAPHY_LAYER_IDS),
    ...(reason ? { reason } : {})
  }];
}

function readTypographyLayer(value: unknown): TypographyLayer[] {
  const layer = readRecord(value);
  if (!layer || typeof layer.layerId !== "string" || (layer.direction !== "ltr" && layer.direction !== "rtl")
    || (typeof layer.lang !== "string" && layer.lang !== null)
    || (typeof layer.requestedFontFamily !== "string" && layer.requestedFontFamily !== null)
    || typeof layer.resolvedFontFamily !== "string"
    || (typeof layer.primaryFontAvailable !== "boolean" && layer.primaryFontAvailable !== null)
    || (layer.fontProvenance !== "manifest-bound" && layer.fontProvenance !== "unverified")) {
    return [];
  }
  return [{
    layerId: layer.layerId,
    direction: layer.direction,
    lang: layer.lang,
    requestedFontFamily: layer.requestedFontFamily,
    resolvedFontFamily: layer.resolvedFontFamily,
    primaryFontAvailable: layer.primaryFontAvailable,
    fontProvenance: layer.fontProvenance
  }];
}

function readTypographyFontAsset(value: unknown): TypographyFontAsset[] {
  const asset = readRecord(value);
  if (!asset || typeof asset.id !== "string" || typeof asset.family !== "string"
    || typeof asset.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(asset.sha256)) {
    return [];
  }
  return [{ id: asset.id, family: asset.family, sha256: asset.sha256.toLowerCase() }];
}

function readBoundedStrings(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length <= 512).slice(0, limit);
}

function isTypographyAttestation(value: unknown): value is TypographyAttestation {
  return value === "verified" || value === "unverified" || value === "not_applicable";
}

function typographyScopeKey(scope: TypographyScope): string {
  return JSON.stringify(scope);
}

function typographyLayerKey(layer: TypographyLayer): string {
  return JSON.stringify(layer);
}

function typographyFontAssetKey(asset: TypographyFontAsset): string {
  return `${asset.id}\0${asset.sha256}`;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}
