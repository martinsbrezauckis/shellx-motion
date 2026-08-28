import { describe, expect, it } from "vitest";
import { SDK_OPERATION_TIER, readSdkOperation } from "./sdk-operation-policy.js";

describe("SDK operation policy", () => {
  it("assigns every keying and roto mutation to an explicit authenticated tier", () => {
    expect(SDK_OPERATION_TIER).toMatchObject({
      keyingInspect: "read_motion",
      keyingApply: "edit_motion",
      keyingRemove: "edit_motion",
      rotoUpsert: "edit_motion",
      rotoTrackingDetach: "edit_motion",
      rotoRemove: "edit_motion",
      compositingInspect: "read_motion",
      compositingSet: "edit_motion",
      compositingRemove: "edit_motion",
      gltfImport: "write_local",
      cutoutRigBake: "edit_motion",
      proceduralInspect: "read_motion",
      proceduralSet: "edit_motion",
      proceduralSetEnabled: "edit_motion",
      proceduralBake: "edit_motion",
      proceduralDetach: "edit_motion",
      proceduralAudioEnvelopeProduce: "edit_motion",
      audioMasterSet: "edit_motion",
      audioCrossfadeSet: "edit_motion",
    });
  });

  it("recognizes the complete registry and rejects inherited or unknown values", () => {
    expect(Object.keys(SDK_OPERATION_TIER).every((operation) => readSdkOperation(operation) === operation)).toBe(true);
    expect(readSdkOperation("keyingApply.extra")).toBeNull();
    expect(readSdkOperation({ toString: () => "keyingApply" })).toBeNull();
  });
});
