/**
 * receipt-card.test.ts — unit tests for the DOM-free receipt-card view-model
 * builder used by the engine-room History timeline (workbench/receipt-card.js).
 *
 * The module ships as a browser ES module (served static from workbench/), so it
 * is imported here through a computed file URL — that keeps it typecheck-safe as
 * untyped JS while exercising the exact code the browser runs. Coverage focuses on
 * the four "at a glance" facets (when / who / what / where), plus the encoder and
 * hardware-fallback fields the History cards surface.
 */
import { beforeAll, describe, expect, it } from "vitest";

interface ReceiptActorView {
  label: string;
  source: string;
  attributed: boolean;
  kind: string;
  transport: string;
  transportLabel: string;
  clientInfo: string;
  sessionId: string;
  grantedTier: string;
  via: string;
}

interface ReceiptCardModule {
  buildReceiptCard: (receipt: unknown, meta?: { path?: string }) => {
    id: string;
    operation: string;
    status: string;
    statusLabel: string;
    createdAt: string;
    packageId: string;
    lane: string;
    receiptPath: string;
    actor: ReceiptActorView;
    encoder: null | { name: string; source: string; reason: string; reasonLabel: string; fallback: null | { attemptedEncoder: string; reason: string } };
    outputs: Array<{ path: string; role: string; primary: boolean; dimensionsLabel: string; width: number | null; height: number | null }>;
    primaryOutputPath: string;
    gates: { status: string; checks: Array<{ label: string; status: string; message: string }>; passedCount: number; failedCount: number };
    warnings: string[];
    warningsCount: number;
    inputHashes: Array<{ key: string; hash: string }>;
    raw: unknown;
  };
  receiptActor: (receipt: unknown) => ReceiptActorView;
  receiptEncoder: (receipt: unknown) => null | { name: string; source: string; reason: string; reasonLabel: string; fallback: null | { attemptedEncoder: string; reason: string } };
  receiptFacets: (items: unknown) => { packages: string[]; operations: string[] };
  formatDimensions: (w: number | null, h: number | null, d: number | null) => string;
  formatActorVia: (facts: { transport: string; clientInfo: string; sessionId: string; grantedTier: string }) => string;
}

let mod: ReceiptCardModule;

beforeAll(async () => {
  const moduleUrl = new URL("../workbench/receipt-card.js", import.meta.url).href;
  mod = (await import(moduleUrl)) as ReceiptCardModule;
});

/** A hardware-encoded render receipt with a probe result and full output metadata. */
const HARDWARE_RENDER_RECEIPT = {
  schema: "shellx-motion/receipt@1",
  id: "ffmpeg-render-abcd1234",
  operation: "render.final",
  status: "passed",
  packageId: "pkg_launch",
  lane: "ffmpeg",
  createdAt: "2026-07-22T10:00:00.000Z",
  inputHashes: { frames: "sha256:aaa", audio: "sha256:bbb" },
  output: {
    path: ".scratch/exports/launch.mp4",
    width: 1920,
    height: 1080,
    durationMs: 4000,
    codec: "h264",
    container: "mp4",
    encoder: "h264_nvenc",
    encoderSource: "hardware",
    encoderReason: "probe-selected-hardware",
    encoderProbe: { usableHardwareEncoders: ["h264_nvenc"], selectedHardwareEncoder: "h264_nvenc" },
    createdBy: "agent:launch-bot",
    qualityCheck: { status: "passed" }
  },
  artifacts: [
    { role: "rendered_media", path: ".scratch/exports/launch.mp4", status: "available", mediaType: "video/mp4", primary: true }
  ],
  warnings: []
};

/** A software-fallback render receipt (hardware attempted, failed, retried software). */
const FALLBACK_RENDER_RECEIPT = {
  schema: "shellx-motion/receipt@1",
  id: "ffmpeg-render-fallback",
  operation: "render.final",
  status: "warning",
  packageId: "pkg_promo",
  lane: "ffmpeg",
  createdAt: "2026-07-22T11:00:00.000Z",
  inputHashes: { frames: "sha256:ccc" },
  output: {
    path: ".scratch/exports/promo.mp4",
    width: 1280,
    height: 720,
    durationMs: 3000,
    encoder: "libx264",
    encoderSource: "software",
    encoderReason: "hardware-fallback",
    encoderFallback: { attemptedEncoder: "h264_nvenc", reason: "nvenc session limit reached" }
  },
  warnings: ["Hardware encoder h264_nvenc failed; retried with software libx264."]
};

/** A template-apply receipt with provenance but no createdBy (sourceApp attribution). */
const APPLY_RECEIPT = {
  schema: "shellx-motion/receipt@1",
  id: "apply-xyz",
  operation: "template.apply",
  status: "passed",
  packageId: "pkg_applied",
  lane: "authoring",
  createdAt: "2026-07-22T09:00:00.000Z",
  inputHashes: {},
  output: { path: ".scratch/apply/out", provenance: { sourceApp: "shellx-motion" } },
  warnings: []
};

/**
 * A template-apply receipt stamped with a first-class actor by the MCP transport choke point: an
 * agent claimed a label via createdBy, but the observed transport facts ride alongside it.
 */
const MCP_ACTOR_RECEIPT = {
  schema: "shellx-motion/receipt@1",
  id: "apply-mcp",
  operation: "template.apply",
  status: "passed",
  packageId: "pkg_mcp",
  lane: "template",
  createdAt: "2026-07-22T12:00:00.000Z",
  inputHashes: {},
  output: { packageDir: ".scratch/apply/mcp", createdBy: "spoofed-label" },
  actor: {
    kind: "agent",
    label: "spoofed-label",
    transport: "mcp",
    clientInfo: "local-agent/1.0",
    sessionId: "srv-ab12:ws-3c4d",
    grantedTier: "render_motion"
  },
  warnings: []
};

describe("receipt actor attribution (BY WHO)", () => {
  it("prefers the first-class actor field and surfaces observed transport facts", () => {
    const actor = mod.receiptActor(MCP_ACTOR_RECEIPT);
    expect(actor.source).toBe("actor");
    expect(actor.attributed).toBe(true);
    expect(actor.label).toBe("spoofed-label");
    expect(actor.kind).toBe("agent");
    expect(actor.transport).toBe("mcp");
    expect(actor.transportLabel).toBe("Agent");
    expect(actor.clientInfo).toBe("local-agent/1.0");
    expect(actor.sessionId).toBe("srv-ab12:ws-3c4d");
    expect(actor.grantedTier).toBe("render_motion");
    // A spoofed label still rides visibly with the observed, non-spoofable transport evidence.
    expect(actor.via).toBe("via Agent · client local-agent/1.0 · Render access");
  });

  it("falls back to createdBy for receipts written before the actor field existed", () => {
    const actor = mod.receiptActor(HARDWARE_RENDER_RECEIPT);
    expect(actor.label).toBe("agent:launch-bot");
    expect(actor.source).toBe("createdBy");
    expect(actor.attributed).toBe(true);
    expect(actor.transport).toBe("");
    expect(actor.via).toBe("");
  });

  it("falls back to provenance.sourceApp when there is no createdBy or actor", () => {
    const actor = mod.receiptActor(APPLY_RECEIPT);
    expect(actor.label).toBe("shellx-motion");
    expect(actor.source).toBe("sourceApp");
    expect(actor.attributed).toBe(true);
  });

  it("reports 'unattributed' honestly when the receipt carries no actor field", () => {
    const actor = mod.receiptActor(FALLBACK_RENDER_RECEIPT);
    expect(actor.attributed).toBe(false);
    expect(actor.label).toBe("unattributed");
    expect(actor.source).toBe("none");
  });

  it("formatActorVia builds a via line from observed facts and omits absent ones", () => {
    expect(mod.formatActorVia({ transport: "http", clientInfo: "", sessionId: "srv-1", grantedTier: "read_motion" }))
      .toBe("via Local integration · Read access");
    expect(mod.formatActorVia({ transport: "", clientInfo: "", sessionId: "", grantedTier: "" })).toBe("");
  });

  it("replaces transport-generated actor placeholders with user-facing roles", () => {
    expect(mod.receiptActor({ actor: { kind: "unknown", label: "http client", transport: "http" } }).label).toBe("Local app");
    expect(mod.receiptActor({ actor: { kind: "unknown", label: "ws client", transport: "ws" } }).label).toBe("Local app");
    expect(mod.receiptActor({ actor: { kind: "agent", label: "mcp client", transport: "mcp" } }).label).toBe("Agent");
    expect(mod.receiptActor(MCP_ACTOR_RECEIPT).label).toBe("spoofed-label");
  });
});

describe("receipt encoder + hardware fallback mapping", () => {
  it("maps a hardware encoder with its reason label", () => {
    const encoder = mod.receiptEncoder(HARDWARE_RENDER_RECEIPT);
    expect(encoder).not.toBeNull();
    expect(encoder?.name).toBe("h264_nvenc");
    expect(encoder?.source).toBe("hardware");
    expect(encoder?.reasonLabel).toBe("Hardware (probe-verified)");
    expect(encoder?.fallback).toBeNull();
  });

  it("maps a software hardware-fallback with the attempted encoder and reason", () => {
    const encoder = mod.receiptEncoder(FALLBACK_RENDER_RECEIPT);
    expect(encoder?.source).toBe("software");
    expect(encoder?.reasonLabel).toBe("Software (hardware fallback)");
    expect(encoder?.fallback).toEqual({ attemptedEncoder: "h264_nvenc", reason: "nvenc session limit reached" });
  });

  it("returns null when the receipt carries no encoder fields (e.g. a template apply)", () => {
    expect(mod.receiptEncoder(APPLY_RECEIPT)).toBeNull();
  });
});

describe("receipt card full mapping", () => {
  it("maps when/what/where and carries the raw receipt for the JSON toggle", () => {
    const card = mod.buildReceiptCard(HARDWARE_RENDER_RECEIPT, { path: ".scratch/receipts/r1.json" });
    expect(card.createdAt).toBe("2026-07-22T10:00:00.000Z");
    expect(card.operation).toBe("render.final");
    expect(card.packageId).toBe("pkg_launch");
    expect(card.lane).toBe("ffmpeg");
    expect(card.statusLabel).toBe("Passed");
    expect(card.receiptPath).toBe(".scratch/receipts/r1.json");
    expect(card.primaryOutputPath).toBe(".scratch/exports/launch.mp4");
    expect(card.outputs[0]?.dimensionsLabel).toBe("1920 × 1080 · 4s");
    expect(card.gates.checks[0]).toEqual({ label: "Quality check", status: "passed", message: "" });
    expect(card.inputHashes).toEqual([
      { key: "audio", hash: "sha256:bbb" },
      { key: "frames", hash: "sha256:aaa" }
    ]);
    expect(card.raw).toBe(HARDWARE_RENDER_RECEIPT);
  });

  it("degrades safely on a nearly-empty receipt without throwing or inventing values", () => {
    const card = mod.buildReceiptCard({});
    expect(card.id).toBe("(no id)");
    expect(card.operation).toBe("unknown");
    expect(card.packageId).toBe("(no package)");
    expect(card.actor.attributed).toBe(false);
    expect(card.encoder).toBeNull();
    expect(card.outputs).toEqual([]);
    expect(card.primaryOutputPath).toBe("");
    expect(card.warningsCount).toBe(0);
  });

  it("merges output.path with a primary artifact of the same path without duplication", () => {
    const card = mod.buildReceiptCard(HARDWARE_RENDER_RECEIPT);
    const paths = card.outputs.map((entry) => entry.path);
    expect(paths.filter((path) => path === ".scratch/exports/launch.mp4")).toHaveLength(1);
    expect(card.outputs[0]?.primary).toBe(true);
  });
});

describe("receipt facets + dimensions helpers", () => {
  it("collects sorted distinct packages and operations for the filter controls", () => {
    const facets = mod.receiptFacets([HARDWARE_RENDER_RECEIPT, FALLBACK_RENDER_RECEIPT, APPLY_RECEIPT]);
    expect(facets.packages).toEqual(["pkg_applied", "pkg_launch", "pkg_promo"]);
    expect(facets.operations).toEqual(["render.final", "template.apply"]);
  });

  it("formats dimensions and duration, omitting absent parts", () => {
    expect(mod.formatDimensions(1920, 1080, 4000)).toBe("1920 × 1080 · 4s");
    expect(mod.formatDimensions(1280, 720, 3500)).toBe("1280 × 720 · 3.5s");
    expect(mod.formatDimensions(null, null, null)).toBe("");
    expect(mod.formatDimensions(640, 480, null)).toBe("640 × 480");
  });
});
