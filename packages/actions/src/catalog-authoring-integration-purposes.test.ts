import { describe, expect, it } from "vitest";
import { AUTHORING_INTEGRATION_PURPOSES } from "./catalog-authoring-integration-purposes.js";

const DEFAULT_PURPOSE_COMMANDS = [
  "motion.keying.inspect",
  "motion.keying.apply",
  "motion.keying.remove",
  "motion.roto.upsert",
  "motion.roto.tracking.detach",
  "motion.roto.remove",
  "motion.compositing.graph.inspect",
  "motion.compositing.graph.set",
  "motion.compositing.graph.remove",
  "motion.procedural.inspect",
  "motion.procedural.relationship.set",
  "motion.procedural.relationship.enabled.set",
  "motion.procedural.relationship.bake",
  "motion.procedural.relationship.detach",
  "motion.timeline.cutout.rig.bake",
  "motion.scene3d.gltf.import",
  "motion.template.plan",
  "motion.connector.catalog",
  "motion.connector.submit",
  "motion.browser.workflow.capture",
] as const;

const COPY_ON_WRITE_COMMANDS = [
  "motion.keying.apply",
  "motion.keying.remove",
  "motion.roto.upsert",
  "motion.roto.tracking.detach",
  "motion.roto.remove",
  "motion.compositing.graph.set",
  "motion.compositing.graph.remove",
  "motion.procedural.relationship.set",
  "motion.procedural.relationship.enabled.set",
  "motion.procedural.relationship.bake",
  "motion.procedural.relationship.detach",
  "motion.timeline.cutout.rig.bake",
] as const;

describe("authoring and integration purpose map", () => {
  it("covers exactly the assigned default-purpose command set", () => {
    expect(Object.keys(AUTHORING_INTEGRATION_PURPOSES)).toEqual(DEFAULT_PURPOSE_COMMANDS);
  });

  it("keeps copy-on-write and receipt semantics explicit for authoring mutations", () => {
    for (const command of COPY_ON_WRITE_COMMANDS) {
      expect(AUTHORING_INTEGRATION_PURPOSES[command]).toContain("copy-on-write");
      expect(AUTHORING_INTEGRATION_PURPOSES[command]).toContain("receipt");
    }
    expect(AUTHORING_INTEGRATION_PURPOSES["motion.timeline.cutout.rig.bake"])
      .toContain("not a live rig");
  });

  it("preserves host-root, connector, and bounded browser-capture limits", () => {
    expect(AUTHORING_INTEGRATION_PURPOSES["motion.scene3d.gltf.import"])
      .toContain("host-approved input and output roots");
    expect(AUTHORING_INTEGRATION_PURPOSES["motion.scene3d.gltf.import"])
      .toContain("bounded static glTF 2.0 subset");
    expect(AUTHORING_INTEGRATION_PURPOSES["motion.connector.catalog"])
      .toContain("canonical v2 connector catalog");
    expect(AUTHORING_INTEGRATION_PURPOSES["motion.connector.catalog"])
      .toContain("host authority");
    expect(AUTHORING_INTEGRATION_PURPOSES["motion.connector.submit"])
      .toContain("caller-scoped opaque-reference authority");
    expect(AUTHORING_INTEGRATION_PURPOSES["motion.connector.submit"])
      .toContain("filesystem paths and URLs are refused");
    expect(AUTHORING_INTEGRATION_PURPOSES["motion.browser.workflow.capture"])
      .toContain("host-approved output roots");
    expect(AUTHORING_INTEGRATION_PURPOSES["motion.browser.workflow.capture"])
      .toContain("240 rendered samples");
  });
});
