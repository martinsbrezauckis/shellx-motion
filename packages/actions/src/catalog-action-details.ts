import type { MotionAction } from "./catalog.js";

/** A typed invocation shape that illustrates an action without supplying authority. */
export interface MotionActionPlanExample {
  description: string;
  call: string;
  args: Record<string, unknown>;
  note: string;
}

export interface ActionPlanDetails {
  cautions: string[];
  examples: MotionActionPlanExample[];
  relatedActionIds: string[];
}

export function actionPlanDetails(actionId: string): ActionPlanDetails | undefined {
  const details: Record<string, ActionPlanDetails> = {
    "motion.package.patch": {
      cautions: [
        "For a large, bounded layer batch, send one motion.package.patch call with one add operation for each complete layer at /layers/-. Motion validates the copied document once; do not turn that batch into repeated motion.timeline.layer.create calls.",
        "Requires a host-granted edit_motion tier. When Motion reports the held tier, the refusal is `motion.package.patch requires edit_motion; this session holds <granted-tier>.` A caller cannot raise that grant.",
        "packageRoot is an existing source package and outDir is an empty or absent destination outside it. Both stay inside host-approved authoring input/output roots; these arguments do not configure or widen those roots.",
        "The copied package's receipt path is returned. motion.receipts.read needs a host receiptsRoot that contains that receipt; do not invent a receipts root."
      ],
      examples: [
        {
          description: "Copy an inspected package and replace a title field without changing the source package.", call: "motion.package.patch",
          args: { packageRoot: "<host-approved-existing-package>", outDir: "<host-approved-empty-or-absent-output>", patch: [{ op: "replace", path: "/layers/0/text", value: "Updated title" }] },
          note: "Illustrative only: inspect the package first and use JSON Pointer paths that exist in that package. The host, not this example, grants the tier and root authority."
        },
        {
          description: "Append one complete text layer as one operation in a larger layer batch.", call: "motion.package.patch",
          args: {
            packageRoot: "<host-approved-existing-package>", outDir: "<host-approved-empty-or-absent-output>",
            patch: [{
              op: "add", path: "/layers/-",
              value: {
                id: "caption-001", type: "text", text: "Caption 001", startMs: 0, durationMs: 3000,
                transform: { x: 120, y: 820, scale: 1, rotation: 0 },
                style: { fontFamily: "Inter", fontSize: 64, color: "#ffffff" }
              }
            }]
          },
          note: "Illustrative one-operation shape for a batch: repeat complete /layers/- add operations in one request, at most 1,000 operations total, and keep the final document within its 8,192-layer admission limit. Never hand-write package files; inspect the returned receipt."
        }
      ],
      relatedActionIds: ["motion.timeline.layer.create", "motion.revision.transaction"]
    },
    "motion.package.asset.import": {
      cautions: [
        "Requires a host-granted edit_motion tier. A caller cannot raise that grant.",
        "packageRoot and assetPath must already be inside host-approved authoring input roots, and outDir must be an empty or absent destination inside a host-approved output root. These arguments never widen host authority.",
        "The engine admits at most 64 MiB for one source file before reading bytes; request arguments cannot widen that ceiling.",
        "assetRef is a portable assets/ path. Import copies bytes into a new package revision and never replaces a source-package file; use a typed layer edit separately to bind the asset to a scene."
      ],
      examples: [{
        description: "Copy one approved external image into an ordinary package revision before binding it to a layer.", call: "motion.package.asset.import",
        args: { packageRoot: "<host-approved-existing-package>", outDir: "<host-approved-empty-or-absent-output>", assetPath: "<host-approved-external-file>", assetRef: "assets/imports/hero.png" },
        note: "The source must be a regular non-symlink file. Read the returned receipt and validate the copied package before rendering."
      }],
      relatedActionIds: ["motion.package.validate", "motion.timeline.layer.create", "motion.preview.frame"]
    },
    "motion.lottie.import": {
      cautions: [
        "Requires a host-granted write_local tier. A caller cannot raise its own tier.",
        "sourcePath and outDir must be inside host-approved authoring input and output roots. The import command accepts neither caller-supplied root configuration nor root widening.",
        "A success envelope is not a losslessness claim: inspect the returned loweringReceiptPath and diagnosticsReceiptPath in the created package."
      ],
      examples: [{
        description: "Create a package from one Lottie JSON source admitted by the host.", call: "motion.lottie.import",
        args: { sourcePath: "<host-approved-lottie-json>", outDir: "<host-approved-empty-or-absent-package-output>" },
        note: "sourcePath and outDir are typed command arguments, not authority. The host must already have configured the input and output roots."
      }],
      relatedActionIds: ["motion.dotlottie.import", "motion.scene3d.gltf.import", "motion.preview.frame"]
    },
    "motion.dotlottie.import": {
      cautions: [
        "Requires a host-granted write_local tier. A caller cannot raise its own tier.",
        "sourcePath and outDir must be inside host-approved authoring input and output roots. The import command accepts neither caller-supplied root configuration nor root widening.",
        "animationId and themeId are optional selectors; omitting them uses the container defaults. State machines are preserved but never executed, and both returned receipt paths must be inspected."
      ],
      examples: [{
        description: "Create a package from one selected animation and optional theme in a host-admitted dotLottie container.", call: "motion.dotlottie.import",
        args: { sourcePath: "<host-approved-dotlottie-container>", outDir: "<host-approved-empty-or-absent-package-output>", animationId: "<optional-container-animation-id>", themeId: "<optional-container-theme-id>" },
        note: "Omit animationId and themeId rather than sending placeholders when the container defaults are intended. The host must already have configured the input and output roots."
      }],
      relatedActionIds: ["motion.lottie.import", "motion.scene3d.gltf.import", "motion.preview.frame"]
    }
  };
  return details[actionId];
}

export function relatedActions(actions: MotionAction[], action: MotionAction | null, relatedActionIds: string[] | undefined): MotionAction[] {
  if (!action) return actions.slice(0, 3);
  if (relatedActionIds?.length) return relatedActionIds.map((id) => actions.find((candidate) => candidate.id === id)).filter((candidate): candidate is MotionAction => Boolean(candidate));
  return actions.filter((candidate) => candidate.id !== action.id).slice(0, 3);
}
