import type {
  MotionSdkOperation,
  MotionSdkRequestMap,
  MotionSdkResponseMap,
  MotionSdkResult,
} from "./types.js";

type Invoke = <K extends MotionSdkOperation>(
  operation: K,
  input: MotionSdkRequestMap[K],
) => Promise<MotionSdkResult<MotionSdkResponseMap[K]>>;

/** Keep advanced authoring verbs out of the legacy client constructor. */
export function createAuthoringClientBindings(invoke: Invoke) {
  return {
    compositingInspect: (input: MotionSdkRequestMap["compositingInspect"]) => invoke("compositingInspect", input),
    compositingSet: (input: MotionSdkRequestMap["compositingSet"]) => invoke("compositingSet", input),
    compositingRemove: (input: MotionSdkRequestMap["compositingRemove"]) => invoke("compositingRemove", input),
    gltfImport: (input: MotionSdkRequestMap["gltfImport"]) => invoke("gltfImport", input),
    proceduralInspect: (input: MotionSdkRequestMap["proceduralInspect"]) => invoke("proceduralInspect", input),
    proceduralSet: (input: MotionSdkRequestMap["proceduralSet"]) => invoke("proceduralSet", input),
    proceduralSetEnabled: (input: MotionSdkRequestMap["proceduralSetEnabled"]) => invoke("proceduralSetEnabled", input),
    proceduralBake: (input: MotionSdkRequestMap["proceduralBake"]) => invoke("proceduralBake", input),
    proceduralDetach: (input: MotionSdkRequestMap["proceduralDetach"]) => invoke("proceduralDetach", input),
  };
}
