import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentScriptExecutionEvidenceForDataOnly,
  rememberLoadedPackageHashes,
  type AgentScriptExecutionEvidence,
  type MotionPackage
} from "@shellx-motion/core";
import { withSegmentedFinalCliPublication } from "./segmented-final-internal/segmented-final-cli-publication.js";

const renderInternal = vi.fn();
vi.mock("./segmented-final-internal/segmented-final-adapter.js", () => ({
  renderSegmentedFinal: renderInternal
}));

describe("public segmented final producer provenance", () => {
  beforeEach(() => renderInternal.mockReset());

  it("publishes complete data-only producer evidence at the top-level receipt", async () => {
    const pkg = motionPackage([]);
    const scriptExecution = agentScriptExecutionEvidenceForDataOnly(pkg.motion);
    renderInternal.mockResolvedValue(internalSuccess(scriptExecution));
    const { renderSegmentedFinal } = await import("./segmented-final.js");

    const result = await renderSegmentedFinal({
      pkg,
      frameLane: "browser",
      outputPath: "/private/final.mp4",
      segmented: { segmentFrames: 1 }
    });

    expect(renderInternal).toHaveBeenCalledWith(expect.objectContaining({
      producer: { frameLane: "browser", scriptExecution }
    }));
    expect(result).toMatchObject({
      ok: true,
      receipt: { output: { scriptExecution, frameTransport: { producer: { scriptExecution } } } }
    });
  });

  it("resolves and closes the current host session before binding active-script resume facts", async () => {
    const pkg = motionPackage([{ id: "agent-entry", type: "html", source: "agent-entry.html", startMs: 0, durationMs: 1_000 }]);
    const scriptExecution = activeEvidence();
    const close = vi.fn(async () => undefined);
    const sessionFactory = vi.fn(async () => ({ scriptExecution, close }));
    renderInternal.mockResolvedValue(internalSuccess(scriptExecution));
    const { renderSegmentedFinal } = await import("./segmented-final.js");

    const result = await renderSegmentedFinal({
      pkg,
      frameLane: "browser",
      outputPath: "/private/final.mp4",
      segmented: { segmentFrames: 1, resume: true },
      toolPolicy: { browser: { activeScriptSessionAvailable: true, sessionFactory: sessionFactory as never } }
    });

    expect(sessionFactory).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(renderInternal).toHaveBeenCalledWith(expect.objectContaining({
      store: { intent: "resume" }, producer: { frameLane: "browser", scriptExecution }
    }));
    expect(result).toMatchObject({ ok: true, receipt: { output: { scriptExecution } } });
  });

  it("does not accept caller GPU identity or range proof: it sends only an internal admitted-host request", async () => {
    const pkg = motionPackage([]);
    renderInternal.mockResolvedValue(internalSuccess(agentScriptExecutionEvidenceForDataOnly(pkg.motion)));
    const { renderSegmentedFinal } = await import("./segmented-final.js");

    const result = await renderSegmentedFinal({
      pkg,
      frameLane: "gpu",
      outputPath: "/private/gpu-final.mp4",
      segmented: { segmentFrames: 1 }
    });

    expect(renderInternal).toHaveBeenCalledWith(expect.objectContaining({
      frameLane: "gpu",
      gpuHost: expect.objectContaining({
        pkg,
        policy: undefined,
        preflight: expect.objectContaining({
          staticPlan: expect.objectContaining({ canonicalFrameCount: 1 })
        })
      })
    }));
    const internalInput = renderInternal.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(internalInput).not.toHaveProperty("producer");
    expect(internalInput).not.toHaveProperty("createRangeProducer");
    expect(result).toMatchObject({ ok: true, transport: { frameLane: "gpu" } });
  });

  it("does not let the internal CLI bridge bless a structurally forged publication", () => {
    const pkg = motionPackage([]);
    const publication = { outputPath: "/public/segmented.mp4", stagingPath: "/private/segmented.mp4" };

    expect(() => withSegmentedFinalCliPublication({
      pkg, frameLane: "browser" as const, outputPath: "/public/segmented.mp4", segmented: { segmentFrames: 1 }
    }, publication as never)).toThrow("Core-minted publication");
    expect(renderInternal).not.toHaveBeenCalled();
  });
});

function motionPackage(layers: MotionPackage["motion"]["layers"]): MotionPackage {
  const pkg = {
    root: "/private/package",
    manifest: { schema: "shellx-motion/package-manifest@1", id: "segmented-provenance", name: "segmented", motion: "motion.json", assets: [], sourceApp: "test", compatibility: { lanes: ["browser"], hosts: ["motion"] } },
    motion: { schema: "shellx-motion/motion@1", id: "motion", name: "motion", durationMs: 1_000, fps: 1, width: 16, height: 16, layers, assets: [], provenance: { sourceApp: "test", createdBy: "test" } }
  } as MotionPackage;
  rememberLoadedPackageHashes(pkg, { "manifest.json": "a".repeat(64), "motion.json": "b".repeat(64) });
  return pkg;
}

function activeEvidence(): AgentScriptExecutionEvidence {
  const entry = { layerId: "agent-entry", layerType: "html" as const, path: "agent-entry.html", sha256: "c".repeat(64), bytes: 128 };
  return {
    schema: "shellx-motion/script-execution@1", detectedClass: "active-content",
    requestedMode: "trusted-local-agent-authored", activeMode: "trusted-local-agent-authored", resolverVersion: 1,
    packageSnapshotSha256: "d".repeat(64), attestationId: "attestation-current", sources: [entry], entry
  };
}

function internalSuccess(scriptExecution: AgentScriptExecutionEvidence) {
  return {
    ok: true,
    output: { sha256: "e".repeat(64) },
    receiptEvidence: {
      inputHashes: { "manifest.json": "a".repeat(64), "motion.json": "b".repeat(64) },
      output: { path: "/private/final.mp4", sha256: "e".repeat(64) },
      artifacts: [],
      warnings: []
    },
    transport: {
      delivery: "resumable-ffv1-segments", producer: {
        schema: "shellx-motion/segment-range-producer@1", frameLane: "browser", scriptExecution,
        warningUnion: ["producer warning"], warningsOmitted: 0
      }
    }
  };
}
