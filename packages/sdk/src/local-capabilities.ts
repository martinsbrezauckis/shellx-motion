/** Stable operation inventory advertised by the in-process SDK host. */
export const LOCAL_MOTION_SDK_OPERATIONS = [
  "validate", "compile", "preview", "render", "renderCachePlan", "submitRender", "status", "cancel", "timelineEdit", "revisionTransactionPlan", "revisionTransaction",
  "trackingRequest", "trackingInspect", "trackingApply", "trackingDetach", "trackingVerify",
  "keyingInspect", "keyingApply", "keyingRemove", "rotoUpsert", "rotoTrackingDetach", "rotoRemove",
  "compositingInspect", "compositingSet", "compositingRemove", "gltfImport",
  "proceduralInspect", "proceduralSet", "proceduralSetEnabled", "proceduralBake", "proceduralDetach",
  "proceduralAudioEnvelopeProduce", "audioMasterSet", "audioCrossfadeSet", "cutoutRigBake"
] as const;
