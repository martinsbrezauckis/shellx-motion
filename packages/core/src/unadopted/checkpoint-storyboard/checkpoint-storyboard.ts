/** Private C6A direct-import facade retained only for nonshipping source tests. */
export * from "../../internal/checkpoint-storyboard/checkpoint-storyboard-types.js";
export { snapshotCheckpointStoryboardData } from "../../internal/checkpoint-storyboard/checkpoint-storyboard-data.js";
export { createTransitionRecipe, readTransitionRecipe, readTransitionRecipeDescriptor } from "../../internal/checkpoint-storyboard/checkpoint-storyboard-recipes.js";
export { createCheckpointStoryboard, readCheckpointStoryboard, readCheckpointStoryboardDescriptor, compileCheckpointStoryboardPlan } from "../../internal/checkpoint-storyboard/checkpoint-storyboard-records.js";
export * from "../../internal/checkpoint-storyboard/checkpoint-storyboard-scalar-spatial-types.js";
export { admitCheckpointStoryboardScalarSpatialRecordProfile, compileCheckpointStoryboardScalarSpatialPlan, readCheckpointStoryboardScalarSpatialRequest } from "../../internal/checkpoint-storyboard/checkpoint-storyboard-scalar-spatial.js";
export * from "../../internal/checkpoint-storyboard/checkpoint-storyboard-behavior-profile-types.js";
export { compileCheckpointStoryboardBehaviorProfilePlan, readCheckpointStoryboardBehaviorProfileRequest } from "../../internal/checkpoint-storyboard/checkpoint-storyboard-behavior-profile.js";
