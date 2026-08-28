/** Host-side admission for closed C6A and C6D checkpoint storyboard descriptors. */
import {
  createCheckpointStoryboard,
  createTransitionRecipe,
  readTransitionRecipeDescriptor,
  snapshotCheckpointStoryboardData,
  type CheckpointStoryboard,
} from "@shellx-motion/core/internal/checkpoint-storyboard-scalar-spatial-materializer";
import {
  compileDataRecipeChoreography,
  compileDataRecipeCheckpoint,
  DATA_RECIPE_CHOREOGRAPHY_SCHEMA,
  DATA_RECIPE_CHECKPOINT_SCHEMA,
  isDataRecipeCheckpointStoryboard,
  isDataRecipeChoreographyStoryboard,
  readDataRecipeChoreographyDescriptor,
  readDataRecipeCheckpointDescriptor,
} from "@shellx-motion/core/internal/checkpoint-storyboard-data-recipe";
import {
  inspectCheckpointStoryboardStoredRecord,
  type CheckpointStoryboardRecordIdentity,
  type CheckpointStoryboardRecordStoreAuthority,
  CheckpointStoryboardRecordStoreError,
} from "./checkpoint-storyboard-record-store.js";

type DescriptorClassification =
  | { readonly kind: "c6a"; readonly snapshot: Record<string, unknown> }
  | { readonly kind: "trace-data-recipe"; readonly snapshot: Record<string, unknown> }
  | { readonly kind: "choreography-data-recipe"; readonly snapshot: Record<string, unknown> };

/** Create receives an unsealed descriptor only; all accepted identity/revision facts are host-sealed. */
export function sealUnparentedCheckpointStoryboardDescriptor(value: unknown): CheckpointStoryboard {
  const descriptor = snapshotAndClassifyDescriptor(value);
  if (descriptor.kind === "trace-data-recipe") {
    // Core owns the entire closed lowering and returns the normal sealed B7 storyboard that the
    // existing record store admits. There is no separate C6D record profile or journal.
    return compileDataRecipeCheckpoint(readDataRecipeCheckpointDescriptor(descriptor.snapshot)).storyboard;
  }
  if (descriptor.kind === "choreography-data-recipe") return compileDataRecipeChoreography(readDataRecipeChoreographyDescriptor(descriptor.snapshot)).storyboard;
  return createCheckpointStoryboard(sealUnparentedC6aDescriptor(descriptor.snapshot));
}

/** Revision reopens exactly one host record and injects its verified parent into C6A sealing. */
export async function sealCheckpointStoryboardRevisionDescriptor(
  value: unknown,
  parent: CheckpointStoryboardRecordIdentity,
  authority: CheckpointStoryboardRecordStoreAuthority,
): Promise<CheckpointStoryboard> {
  // Read the closed high-level descriptor before reopening a parent or touching the store. This
  // makes malformed C6D input a pure refusal with no durable record/store observation side effect.
  const classified = snapshotAndClassifyDescriptor(value);
  const dataRecipe = classified.kind === "trace-data-recipe"
    ? readDataRecipeCheckpointDescriptor(classified.snapshot)
    : undefined;
  const choreography = classified.kind === "choreography-data-recipe"
    ? readDataRecipeChoreographyDescriptor(classified.snapshot)
    : undefined;
  // Preserve the legacy C6A ordering as well: malformed B1-B7 descriptors still refuse before
  // any parent/store read, exactly as they did before the high-level descriptor alternative.
  const c6aDescriptor = classified.kind === "c6a"
    ? sealUnparentedC6aDescriptor(classified.snapshot)
    : undefined;
  const reopened = await inspectCheckpointStoryboardStoredRecord(authority, parent);
  if (reopened.target.state === "tombstoned") throw new CheckpointStoryboardRecordStoreError("record_tombstoned", "A tombstoned checkpoint storyboard record cannot be revised.");
  if (reopened.archive.terminal) throw new CheckpointStoryboardRecordStoreError("lineage_archived", "Checkpoint storyboard lineage is terminally archived.");
  if (dataRecipe) return compileDataRecipeCheckpoint(dataRecipe, reopened.storyboard).storyboard;
  if (choreography) return compileDataRecipeChoreography(choreography, reopened.storyboard).storyboard;
  if (isDataRecipeCheckpointStoryboard(reopened.storyboard) || isDataRecipeChoreographyStoryboard(reopened.storyboard)) throw new Error("A named data-recipe lineage can be revised only through its same closed descriptor schema.");
  return createCheckpointStoryboard({ ...c6aDescriptor!, parent: reopened.storyboard });
}

/** Snapshot once before choosing the closed high-level or legacy C6A descriptor grammar. */
function snapshotAndClassifyDescriptor(value: unknown): DescriptorClassification {
  const snapshot = snapshotCheckpointStoryboardData(value);
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) throw new Error("Checkpoint storyboard descriptor must be a bounded plain data object.");
  const record = snapshot as Record<string, unknown>;
  if (record.schema === DATA_RECIPE_CHECKPOINT_SCHEMA) return { kind: "trace-data-recipe", snapshot: record };
  if (record.schema === DATA_RECIPE_CHOREOGRAPHY_SCHEMA) return { kind: "choreography-data-recipe", snapshot: record };
  return { kind: "c6a", snapshot: record };
}

/** Seals every C6A recipe host-side before the existing C6A storyboard constructor runs. */
function sealUnparentedC6aDescriptor(record: Record<string, unknown>): Record<string, unknown> {
  if (Object.hasOwn(record, "parent")) throw new Error("Checkpoint storyboard lifecycle does not accept caller-supplied parent lineage.");
  if (!Array.isArray(record.recipes)) throw new Error("Checkpoint storyboard descriptor requires recipes.");
  const recipes = record.recipes.map((recipe) => {
    const descriptor = readTransitionRecipeDescriptor(recipe);
    if (descriptor.parent) throw new Error("Checkpoint storyboard lifecycle does not accept caller-supplied recipe lineage.");
    return createTransitionRecipe(descriptor);
  });
  // C6A remains the authoritative whole-storyboard parser, lifecycle validator, and sealer.
  return { ...record, recipes };
}
