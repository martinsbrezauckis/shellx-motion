import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  expandMotionPackageRows,
  parseMotionDataRows,
  readMotionDocument,
  readPackageManifest,
  readTemplateDocument,
  type MotionPackage
} from "./index";

function templatePackage(): MotionPackage {
  return {
    root: "/synthetic/template-batch",
    manifest: {
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_template_batch",
      name: "Template batch",
      motion: "motion.json",
      template: "template.json",
      assets: [],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["browser", "ffmpeg"], hosts: ["shellx-motion"] }
    },
    motion: {
      schema: "shellx-motion/motion@1",
      id: "motion_template_batch",
      name: "Template batch",
      durationMs: 1_000,
      fps: 30,
      width: 640,
      height: 360,
      layers: [
        { id: "headline", type: "text", text: "Default headline", startMs: 0, durationMs: 1_000 },
        { id: "metric", type: "text", text: "0%", startMs: 0, durationMs: 1_000 },
        { id: "accent", type: "shape", fill: "#ffffff", startMs: 0, durationMs: 1_000 }
      ],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    },
    template: {
      schema: "shellx-motion/template@1",
      id: "template_batch",
      name: "Template batch",
      motion: "motion.json",
      compatibleLanes: ["browser", "ffmpeg"],
      compatibleHosts: ["shellx-motion"],
      metadata: {
        inputSchema: {
          type: "object",
          required: ["headline", "metricValue"],
          properties: {
            headline: { type: "string" },
            metricValue: { type: "string" },
            accentColor: { type: "string", format: "color" }
          }
        }
      },
      params: [
        { id: "headline", type: "text", defaultValue: "Default headline" },
        { id: "metricValue", type: "text", defaultValue: "0%" },
        { id: "accentColor", type: "color", defaultValue: "#ffffff" }
      ],
      controls: [
        { paramId: "headline", widget: "text" },
        { paramId: "metricValue", widget: "text" },
        { paramId: "accentColor", widget: "color" }
      ],
      bindings: [
        { paramId: "headline", target: { kind: "motion_path", path: "/layers/0/text", layerId: "headline" } },
        { paramId: "metricValue", target: { kind: "motion_path", path: "/layers/1/text", layerId: "metric" } },
        { paramId: "accentColor", target: { kind: "motion_path", path: "/layers/2/fill", layerId: "accent" } }
      ]
    }
  };
}

describe("typed template batch bindings", () => {
  it("drives the shipped social-stat-card from its documented compact row keys", () => {
    const root = fileURLToPath(new URL("../../../templates/shellx-product-pack/social-stat-card/", import.meta.url));
    const json = (name: string) => JSON.parse(readFileSync(resolve(root, name), "utf8"));
    const pkg: MotionPackage = {
      root,
      manifest: readPackageManifest(json("manifest.json")),
      motion: readMotionDocument(json("motion.json")),
      template: readTemplateDocument(json("template.json"))
    };
    const jobs = expandMotionPackageRows(pkg, parseMotionDataRows({
      rows: [
        { id: "first", headline: "First campaign", metricValue: "42%", metricLabel: "qualified conversions", delta: "+8 points", accentColor: "#ff3366" },
        { id: "second", headline: "Second campaign", metricValue: "81%", metricLabel: "qualified conversions", delta: "+19 points", accentColor: "#22cc88" }
      ]
    }));
    const layer = (jobIndex: number, id: string) => jobs[jobIndex]!.motion.layers.find((candidate) => candidate.id === id);

    expect(layer(0, "headline")).toMatchObject({ text: "First campaign" });
    expect(layer(0, "metric-value")).toMatchObject({ text: "42%" });
    expect(layer(0, "delta-pill")).toMatchObject({ fill: "#ff3366" });
    expect(layer(1, "headline")).toMatchObject({ text: "Second campaign" });
    expect(layer(1, "metric-value")).toMatchObject({ text: "81%" });
    expect(layer(1, "delta-pill")).toMatchObject({ fill: "#22cc88" });
    expect(JSON.stringify(jobs[0]!.motion.layers)).not.toBe(JSON.stringify(jobs[1]!.motion.layers));
  });

  it("applies documented template keys so distinct rows produce distinct documents", () => {
    const jobs = expandMotionPackageRows(templatePackage(), parseMotionDataRows({
      rows: [
        { id: "first", headline: "First campaign", metricValue: "42%", accentColor: "#ff3366" },
        { id: "second", headline: "Second campaign", metricValue: "81%", accentColor: "#22cc88" }
      ]
    }));

    expect(jobs[0]!.motion.layers).toMatchObject([
      { id: "headline", text: "First campaign" },
      { id: "metric", text: "42%" },
      { id: "accent", fill: "#ff3366" }
    ]);
    expect(jobs[1]!.motion.layers).toMatchObject([
      { id: "headline", text: "Second campaign" },
      { id: "metric", text: "81%" },
      { id: "accent", fill: "#22cc88" }
    ]);
    expect(JSON.stringify(jobs[0]!.motion.layers)).not.toBe(JSON.stringify(jobs[1]!.motion.layers));
  });

  it("keeps explicit layer patches stronger than typed template values", () => {
    const [job] = expandMotionPackageRows(templatePackage(), parseMotionDataRows({
      rows: [{
        id: "override",
        headline: "Typed headline",
        layers: { headline: { text: "Explicit layer headline" } }
      }]
    }));

    expect(job.motion.layers[0]).toMatchObject({ id: "headline", text: "Explicit layer headline" });
  });

  it("refuses a documented key that reaches no writable binding", () => {
    const pkg = templatePackage();
    if (!pkg.template) throw new Error("synthetic package is missing template");
    pkg.template.bindings = pkg.template.bindings.map((binding) => binding.paramId === "headline"
      ? { ...binding, target: { ...binding.target, path: "/layers/999/text" } }
      : binding);

    expect(() => expandMotionPackageRows(pkg, parseMotionDataRows({
      rows: [{ id: "broken", headline: "This must not be silently ignored" }]
    }))).toThrow(/row broken.*no writable binding: headline/i);
  });

  it("refuses an input-schema key without a matching template parameter", () => {
    const pkg = templatePackage();
    if (!pkg.template?.metadata?.inputSchema) throw new Error("synthetic package is missing inputSchema");
    const properties = pkg.template.metadata.inputSchema.properties as Record<string, unknown>;
    pkg.template.metadata.inputSchema.properties = { ...properties, orphanMetric: { type: "string" } };

    expect(() => expandMotionPackageRows(pkg, parseMotionDataRows({
      rows: [{ id: "orphan", orphanMetric: "unbound" }]
    }))).toThrow(/row orphan.*orphanMetric.*unknown template param/i);
  });
});
