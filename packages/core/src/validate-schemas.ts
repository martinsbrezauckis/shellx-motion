/**
 * Schema registry for ShellX Motion document validation.
 *
 * Role: the static `SCHEMAS` table mapping each SchemaName to its schema id and required top-level fields.
 * Extracted verbatim from `validate.ts` so the large validator no longer carries the registry data
 * for the module-size architecture gate. Data only; the validation logic and required-field checks are
 * unchanged.
 *
 * Dependencies: the `LoadedSchema` and `SchemaName` types from `./validate` (type-only import).
 *
 * Primary callers: `packages/core/src/validate.ts` (loadSchema, action/debug required-field validation).
 */
import type { LoadedSchema, SchemaName } from "./validate";

export const SCHEMAS: Record<SchemaName, LoadedSchema> = {
  motion: {
    name: "motion",
    schema: "shellx-motion/motion@1",
    required: ["schema", "id", "name", "durationMs", "fps", "width", "height", "layers", "assets", "provenance"]
  },
  packageManifest: {
    name: "packageManifest",
    schema: "shellx-motion/package-manifest@1",
    required: ["schema", "id", "name", "motion", "assets", "sourceApp", "compatibility"]
  },
  qualityManifest: {
    name: "qualityManifest",
    schema: "shellx-motion/quality-manifest@1",
    required: ["schema", "samples"]
  },
  expectedPreview: {
    name: "expectedPreview",
    schema: "shellx-motion/expected-preview@1",
    required: ["schema", "renderer", "fixture", "atMs", "width", "height", "sha256"]
  },
  browserWorkflow: {
    name: "browserWorkflow",
    schema: "shellx-motion/browser-workflow@1",
    required: ["schema", "steps"]
  },
  browserWorkflowTrace: {
    name: "browserWorkflowTrace",
    schema: "shellx-motion/browser-workflow-trace@1",
    required: ["schema", "workflowHash", "stepCount", "steps"]
  },
  browserWorkflowCatalog: {
    name: "browserWorkflowCatalog",
    schema: "shellx-motion/browser-workflow-catalog@1",
    required: ["schema", "entries"]
  },
  resourceCatalog: {
    name: "resourceCatalog",
    schema: "shellx-motion/resource-catalog@1",
    required: ["schema", "packageId", "sourceApp", "resources"]
  },
  cutImportPlan: {
    name: "cutImportPlan",
    schema: "shellx-motion/cut-import-plan@1",
    required: ["schema", "ok", "packageId", "motionId", "targetId", "mode", "operations", "unsupported", "document", "receipt"]
  },
  supportBundle: {
    name: "supportBundle",
    schema: "shellx-motion/support-bundle@1",
    required: ["schema", "createdAt", "receipts", "debug", "runtime", "redactions"]
  },
  scriptedVideo: {
    name: "scriptedVideo",
    schema: "shellx-motion/scripted-video@1",
    required: ["schema", "id", "name", "sourceApp", "workflow", "width", "height", "fps", "frames"]
  },
  dataRows: {
    name: "dataRows",
    schema: "shellx-motion/data-rows@1",
    required: ["schema", "rows"]
  },
  durationPolicy: {
    name: "durationPolicy",
    schema: "shellx-motion/duration-policy@1",
    required: ["schema", "protectedRegions"]
  },
  timelineState: {
    name: "timelineState",
    schema: "shellx-motion/timeline-state@1",
    required: ["schema", "packageId", "motionId", "durationMs", "playheadMs", "updatedAt"]
  },
  trackingAnalysis: {
    name: "trackingAnalysis",
    schema: "shellx-motion/tracking-analysis@1",
    required: ["schema", "id", "source", "mode", "model", "status", "reference", "settings", "settingsSha256", "solver", "samples", "spans", "createdAt"]
  },
  trackingLifecycle: {
    name: "trackingLifecycle",
    schema: "shellx-motion/tracking-lifecycle@1",
    required: ["schema", "id", "state", "attempt", "requestedSource", "updatedAt"]
  },
  template: {
    name: "template",
    schema: "shellx-motion/template@1",
    required: ["schema", "id", "name", "params", "motion", "compatibleLanes"]
  },
  asset: {
    name: "asset",
    schema: "shellx-motion/asset@1",
    required: ["schema", "id", "kind", "source", "hash"]
  },
  receipt: {
    name: "receipt",
    schema: "shellx-motion/receipt@1",
    required: ["schema", "id", "operation", "status", "inputHashes", "createdAt", "lane", "warnings"]
  },
  actions: {
    name: "actions",
    schema: "shellx-motion/actions@1",
    required: ["schema", "actionSchema", "generatedBy", "actionCount", "permissions", "surfaces", "actions"]
  },
  action: {
    name: "action",
    schema: "shellx-motion/action@1",
    required: ["id", "aliases", "permission", "mutates", "calls", "verify", "surfaces"]
  },
  debugContracts: {
    name: "debugContracts",
    schema: "shellx-motion/debug-contracts@1",
    required: ["schema", "debugSchema", "generatedBy", "commandCount", "permissions", "commands", "contracts"]
  },
  debug: {
    name: "debug",
    schema: "shellx-motion/debug@1",
    required: ["command", "permission", "mutates"]
  },
  renderJobHandoff: {
    name: "renderJobHandoff",
    schema: "shellx-motion/render-job-handoff@1",
    required: ["schema", "jobId", "receiptId", "receiptPath", "operation", "packageId", "lane", "state", "createdAt", "inputHashes"]
  },
  promptJobHandoff: {
    name: "promptJobHandoff",
    schema: "shellx-motion/prompt-job-handoff@1",
    required: ["schema", "jobId", "receiptId", "receiptPath", "operation", "packageId", "lane", "state", "createdAt", "inputHashes", "request"]
  },
  platformVerification: {
    name: "platformVerification",
    schema: "shellx-motion/platform-verification@1",
    required: ["schema", "status", "dryRun", "host", "repoRoot", "startedAt", "commands"]
  },
  platformVerificationAggregate: {
    name: "platformVerificationAggregate",
    schema: "shellx-motion/platform-verification-aggregate@1",
    required: ["schema", "status", "dryRun", "repoRoot", "startedAt", "requiredHosts", "requiredCommands", "summary", "receipts"]
  }
};
