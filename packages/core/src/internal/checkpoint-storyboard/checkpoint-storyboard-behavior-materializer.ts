/** Private C6B2 host handoff. It exposes only sealed behavior-profile construction and compilation. */
export { createTransitionRecipe, readTransitionRecipe, readTransitionRecipeDescriptor } from "./checkpoint-storyboard-recipes";
export { createCheckpointStoryboard, readCheckpointStoryboard, readCheckpointStoryboardDescriptor } from "./checkpoint-storyboard-records";
export { admitCheckpointStoryboardBehaviorRecordProfile, compileCheckpointStoryboardBehaviorProfilePlan, readCheckpointStoryboardBehaviorProfileRequest } from "./checkpoint-storyboard-behavior-profile";
export type { CheckpointStoryboardBehaviorProfilePlan, CheckpointStoryboardBehaviorProfileRequest } from "./checkpoint-storyboard-behavior-profile-types";
