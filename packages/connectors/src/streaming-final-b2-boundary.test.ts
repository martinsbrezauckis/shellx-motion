/** Connector GPU final delivery remains direct-only during segmented hybrid work. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MotionPackage } from "@shellx-motion/core";

vi.mock("./artifact-handle.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./artifact-handle.js")>(),
  captureConnectorArtifactStagingTopology: async () => ({}),
  discardConnectorArtifactStaging: async () => true
}));

import { renderConnectorStreamingArtifact, type ConnectorStreamingFinalRenderer } from "./streaming-final";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

describe("connector GPU final B2 boundary", () => {
  it("does not forward durable-segmented or browser/provider/capture controls to its direct streaming renderer", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-connector-b2-"));
    roots.push(root);
    let forwarded: Record<string, unknown> | undefined;
    const renderer: ConnectorStreamingFinalRenderer = async (input) => {
      forwarded = { ...input };
      return {
        ok: false,
        transport: input.transport!,
        error: { code: "test_refusal", message: "stop after observing the direct renderer request" }
      };
    };

    await renderConnectorStreamingArtifact({
      pkg: gpuPackage(),
      frameLane: "gpu",
      outputPath: join(root, "final.mp4"),
      streamingRenderer: renderer,
      now: () => "2026-08-15T00:00:00.000Z"
    });

    expect(forwarded).toMatchObject({ frameLane: "gpu", transport: { delivery: "streamed", reason: "stream_default" } });
    for (const field of ["segmented", "scratchRoot", "callerId", "signal", "browserLocation", "browserSessionFactory", "openVideoProvider", "providerFactory", "openHybridCapture", "hybridCapture", "capturePlan"]) {
      expect(forwarded).not.toHaveProperty(field);
    }
  });
});

function gpuPackage(): MotionPackage {
  return {
    root: "/trusted/connector-package",
    manifest: {
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_connector_b2",
      name: "Connector B2 boundary",
      motion: "motion.json",
      assets: [],
      sourceApp: "test",
      compatibility: { lanes: ["gpu"], hosts: ["motion"] }
    },
    motion: {
      schema: "shellx-motion/motion@1",
      id: "motion_connector_b2",
      name: "Connector B2 boundary",
      durationMs: 1_000,
      fps: 1,
      width: 16,
      height: 16,
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" },
      layers: [{ id: "background", type: "shape", shape: "rect", fill: "#102030", startMs: 0, durationMs: 1_000 }]
    }
  };
}
