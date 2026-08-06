/**
 * The five runtime-proven cases where Motion promised editable lowering and Cut hard-rejected it.
 *
 * Root cause was structural: Motion was a **deny-list producer** (it named a few features it knew
 * Cut refused and declared everything else supported) while Cut's receiver is an **allow-list
 * consumer** (`exact_payload_fields` rejects any field not on a fixed list). Motion therefore
 * emitted `mode: "editable_lowering"` with `unsupported: []` for payloads that failed on arrival.
 *
 * Each case below was read out of `app/server/src/motion_editable_import.rs` in the ShellX Cut
 * repository rather than guessed, and the control case guards the opposite failure: the allow-list
 * must not be so strict that genuinely lowerable packages stop lowering.
 */
import { describe, expect, it } from "vitest";
import type { MotionPackage } from "@shellx-motion/core";
import { planCutImport, type CutTargetCapabilities } from "./index";
import { CUT_EDITABLE_RECEIVER_SLICE, unacceptedKeys, violatesIdentityTransform } from "./editable-receiver-allowlist";

// A target standing in for the real ShellX Cut: it declares which editable receiver it runs, so
// the planner checks lowerings against that receiver's exact field set. A target that declares no
// receiver is not subject to these limits, which is why the check is opt-in rather than global.
const CAPABILITIES = {
  targetId: "shellx-cut",
  modes: ["editable_lowering", "live_overlay", "rendered_media"],
  lowerableLayerTypes: ["text", "shape", "caption", "image", "video", "audio"],
  lowerableFeatures: ["*"],
  editableReceiver: CUT_EDITABLE_RECEIVER_SLICE
} as unknown as CutTargetCapabilities;

function packageWith(layers: unknown[]): MotionPackage {
  return {
    root: "/tmp/editable-allowlist",
    manifest: {
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_probe",
      name: "Probe",
      motion: "motion.json",
      assets: [],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["ffmpeg"], hosts: ["cut"] }
    },
    motion: {
      schema: "shellx-motion/motion@1",
      id: "motion_probe",
      name: "Probe",
      durationMs: 1000,
      fps: 30,
      width: 1920,
      height: 1080,
      layers,
      assets: []
    },
    assets: []
  } as unknown as MotionPackage;
}

const MINIMAL_TEXT = {
  id: "t", type: "text", text: "Hi", startMs: 0, durationMs: 1000,
  transform: { x: 10, y: 20 }, style: { color: "#ffffff", fontSize: 40 }
};

function plan(layers: unknown[]) {
  return planCutImport(packageWith(layers), CAPABILITIES);
}

describe("editable lowering no longer promises what Cut refuses", () => {
  it("still lowers a package Cut genuinely accepts", () => {
    // The guard against over-correction: a text layer using only Cut's accepted style keys
    // (color, fontSize) and accepted transform keys must keep lowering editable.
    const result = plan([MINIMAL_TEXT]);

    expect(result.mode).toBe("editable_lowering");
    expect(result.unsupported).toEqual([]);
  });

  it("case 1: a real blend mode degrades, while the identity blend costs nothing", () => {
    // Cut's title payload allow-list has no blendMode at all, so emitting one loses editability.
    const real = plan([{ ...MINIMAL_TEXT, blendMode: "multiply" }]);
    expect(real.mode).not.toBe("editable_lowering");
    expect(real.unsupported.map((entry) => entry.feature)).toContain("cut.payload.blendMode");

    // "normal" is the identity blend. Emitting it changed nothing about the result and cost
    // editability outright, which is why it is now omitted rather than reported.
    const identity = plan([{ ...MINIMAL_TEXT, blendMode: "normal" }]);
    expect(identity.mode).toBe("editable_lowering");
    expect(identity.unsupported).toEqual([]);
  });

  it("case 2: an unknown transform field on text", () => {
    const result = plan([{ ...MINIMAL_TEXT, transform: { x: 10, y: 20, skewX: 5 } }]);

    expect(result.mode).not.toBe("editable_lowering");
    expect(result.unsupported.map((entry) => entry.feature)).toContain("cut.transform.skewX");
  });

  it("case 3: an unknown transform field on a shape", () => {
    const result = plan([{
      id: "s", type: "shape", shape: "rect", startMs: 0, durationMs: 1000,
      transform: { x: 1, y: 2, width: 10, height: 5, skewY: 3 }, style: { fill: "#ffffff" }
    }]);

    expect(result.mode).not.toBe("editable_lowering");
    expect(result.unsupported.map((entry) => entry.feature)).toContain("cut.transform.skewY");
  });

  it("case 4: volume and pan on video", () => {
    const result = plan([{
      id: "v", type: "video", source: "cut-asset:abc", startMs: 0, durationMs: 1000, volume: 0.5, pan: -0.2
    }]);

    // Cut accepts volume/pan on cut.audio.create but NOT on cut.media.create.
    expect(result.mode).not.toBe("editable_lowering");
    const features = result.unsupported.map((entry) => entry.feature);
    expect(features).toContain("cut.payload.volume");
    expect(features).toContain("cut.payload.pan");
  });

  it("case 5: muted on video", () => {
    const result = plan([{
      id: "v", type: "video", source: "cut-asset:abc", startMs: 0, durationMs: 1000, muted: true
    }]);

    expect(result.mode).not.toBe("editable_lowering");
    expect(result.unsupported.map((entry) => entry.feature)).toContain("cut.payload.muted");
  });

  it("reports fontFamily, which disqualifies every real text layer", () => {
    // the regression's compounding finding: 0 of 15 product templates lower editable, because Cut's
    // title style allow-list is exactly ["color", "fontSize"].
    const result = plan([{ ...MINIMAL_TEXT, style: { color: "#ffffff", fontSize: 40, fontFamily: "Inter" } }]);

    expect(result.mode).not.toBe("editable_lowering");
    expect(result.unsupported.map((entry) => entry.feature)).toContain("cut.style.fontFamily");
  });

  it("names the offending field in a reason a human can act on", () => {
    const result = plan([{ ...MINIMAL_TEXT, blendMode: "multiply" }]);

    const entry = result.unsupported.find((candidate) => candidate.feature === "cut.payload.blendMode");
    expect(entry?.layerId).toBe("t");
    expect(entry?.reason).toContain("blendMode");
  });

  it("degrades rather than failing, so the caller still gets a usable plan", () => {
    const result = plan([{ ...MINIMAL_TEXT, blendMode: "multiply" }]);

    // The point is an honest downgrade: the import still happens, just not as editable.
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("live_overlay");
  });
});

describe("allow-list helpers", () => {
  it("reports unaccepted keys in stable order", () => {
    expect(unacceptedKeys({ b: 1, a: 2, x: 3 }, ["x"])).toEqual(["a", "b"]);
    expect(unacceptedKeys({ x: 1 }, ["x"])).toEqual([]);
    expect(unacceptedKeys(undefined, ["x"])).toEqual([]);
  });

  it("treats scale 1 and rotation 0 as identity", () => {
    // Cut accepts the KEYS but requires identity VALUES, so both checks are needed.
    expect(violatesIdentityTransform({ scale: 1, rotation: 0 })).toBeNull();
    expect(violatesIdentityTransform({ scale: 1.5 })).toBe("scale");
    expect(violatesIdentityTransform({ rotation: 90 })).toBe("rotation");
    expect(violatesIdentityTransform(undefined)).toBeNull();
  });
});

describe("the receiver check is opt-in per target", () => {
  it("leaves a target that declares no receiver unconstrained", () => {
    // The field sets describe ShellX Cut's receiver specifically. A different host, or a future
    // Cut with a wider receiver, must not be held to them.
    const synthetic = {
      targetId: "some-other-host",
      modes: ["editable_lowering", "live_overlay", "rendered_media"],
      lowerableLayerTypes: ["text", "shape", "caption", "image", "video", "audio"]
    } as unknown as CutTargetCapabilities;

    const result = planCutImport(packageWith([{ ...MINIMAL_TEXT, blendMode: "multiply" }]), synthetic);

    expect(result.mode).toBe("editable_lowering");
  });
});
