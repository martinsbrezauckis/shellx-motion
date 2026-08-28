/** Reviewed pre-adoption facade. Root exports and persisted document admission remain intentionally absent. */
export * from "../../motion-relation-actions-types";
export { snapshotMotionRelationActionData, readMotionRelationActionStore, readMotionRelationActionMaterializationInput, readMotionRelationActionMaterializationContext } from "../../motion-relation-actions-read";
export { compileMotionRelationActionMaterializationPlan, type MotionRelationActionMaterializationPlanResult } from "./motion-relation-actions-plan";
