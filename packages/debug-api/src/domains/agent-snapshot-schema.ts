/** Published closed schema for the compact agent snapshot. */
import type { JsonSchemaDocument } from "@shellx-motion/core";
import {
  AGENT_SNAPSHOT_SCHEMA, MAX_AGENT_SNAPSHOT_ACTION_CALLS, MAX_AGENT_SNAPSHOT_ID_SCALARS,
  MAX_AGENT_SNAPSHOT_JOBS, MAX_AGENT_SNAPSHOT_JOB_COUNT, MAX_AGENT_SNAPSHOT_LABEL_SCALARS,
  MAX_AGENT_SNAPSHOT_NEAREST_ACTIONS, MAX_AGENT_SNAPSHOT_OPERATION_SCALARS,
  MAX_AGENT_SNAPSHOT_PLAN_ARGUMENT_ALTERNATIVES, MAX_AGENT_SNAPSHOT_PLAN_ARGUMENT_GROUPS,
  MAX_AGENT_SNAPSHOT_PLAN_ARGUMENTS, MAX_AGENT_SNAPSHOT_PLAN_CAUTIONS, MAX_AGENT_SNAPSHOT_PLAN_STEPS,
  MAX_AGENT_SNAPSHOT_RECEIPTS, MAX_AGENT_SNAPSHOT_RECEIPT_DISCOVERY_ENTRIES, MAX_AGENT_SNAPSHOT_SAFE_INTEGER,
  MAX_AGENT_SNAPSHOT_TIMESTAMP_SCALARS, MAX_AGENT_SNAPSHOT_WARNINGS, MAX_AGENT_SNAPSHOT_WARNING_SCALARS,
} from "./agent-snapshot-contract.js";

const text = (scalars: number): JsonSchemaDocument => ({ type: "string", maxLength: scalars });
const integer = (maximum = MAX_AGENT_SNAPSHOT_SAFE_INTEGER): JsonSchemaDocument => ({ type: "integer", minimum: 0, maximum });
const number = (): JsonSchemaDocument => ({ type: "number", minimum: 0, maximum: MAX_AGENT_SNAPSHOT_SAFE_INTEGER });

/** Public, machine-readable output contract generated into schemas/agent-snapshot.schema.json. */
export const AGENT_SNAPSHOT_SCHEMA_DOCUMENT: JsonSchemaDocument = {
  $schema: "https://json-schema.org/draft/2020-12/schema", $id: AGENT_SNAPSHOT_SCHEMA,
  title: "ShellX Motion compact agent snapshot",
  description: "A read-only, path-free, private no-cache agent context. Serialized UTF-8 output must not exceed 12288 bytes.",
  type: "object", additionalProperties: false,
  required: ["schema", "snapshotId", "observedAt", "freshness", "identity", "state", "selection", "actions", "receipts", "jobs", "warnings", "truncation"],
  properties: {
    schema: { const: AGENT_SNAPSHOT_SCHEMA }, snapshotId: { type: "string", minLength: 64, maxLength: 64 }, observedAt: text(MAX_AGENT_SNAPSHOT_TIMESTAMP_SCALARS),
    freshness: { $ref: "#/$defs/freshness" }, identity: { $ref: "#/$defs/identity" }, state: { $ref: "#/$defs/state" }, selection: { $ref: "#/$defs/selection" }, actions: { $ref: "#/$defs/actions" }, receipts: { $ref: "#/$defs/receipts" }, jobs: { $ref: "#/$defs/jobs" },
    warnings: { type: "array", maxItems: MAX_AGENT_SNAPSHOT_WARNINGS, items: { $ref: "#/$defs/warning" } }, truncation: { $ref: "#/$defs/truncation" }
  },
  $defs: {
    sourceFreshness: closed(["available", "complete", "observedAt"], { available: bool(), complete: bool(), observedAt: text(MAX_AGENT_SNAPSHOT_TIMESTAMP_SCALARS) }),
    cacheFreshness: closed(["scope", "mode", "maxAgeMs"], { scope: { const: "private" }, mode: { const: "none" }, maxAgeMs: { const: 0 } }),
    freshness: closed(["cache", "package", "timeline", "receipts", "jobs"], {
      cache: ref("cacheFreshness"), package: ref("sourceFreshness"), timeline: ref("sourceFreshness"), receipts: ref("sourceFreshness"),
      jobs: closed(["available", "complete", "observedAt", "scope"], { available: bool(), complete: bool(), observedAt: text(MAX_AGENT_SNAPSHOT_TIMESTAMP_SCALARS), scope: { const: "own" } })
    }),
    packageIdentity: closed(["id", "motionId", "fingerprint"], { id: text(MAX_AGENT_SNAPSHOT_ID_SCALARS), motionId: text(MAX_AGENT_SNAPSHOT_ID_SCALARS), name: text(MAX_AGENT_SNAPSHOT_LABEL_SCALARS), fingerprint: { type: "string", minLength: 64, maxLength: 64 } }),
    identity: closed(["engineVersion"], { engineVersion: text(MAX_AGENT_SNAPSHOT_LABEL_SCALARS), package: ref("packageIdentity") }),
    range: closed(["startMs", "endMs"], { startMs: number(), endMs: number() }),
    viewport: closed(["startMs", "endMs"], { startMs: number(), endMs: number(), zoom: number(), pixelsPerSecond: number() }),
    timeline: closed(["playheadMs"], { playheadMs: number(), selectedRange: ref("range"), viewport: ref("viewport") }),
    motion: closed(["durationMs", "fps", "width", "height", "layerCount", "assetCount", "sceneCount", "trackCount", "markerCount", "keyframeCount"], {
      durationMs: number(), fps: number(), width: number(), height: number(), layerCount: integer(), assetCount: integer(), sceneCount: integer(), trackCount: integer(), markerCount: integer(), keyframeCount: integer()
    }),
    state: closed(["packageOpen"], { packageOpen: bool(), motion: ref("motion"), timeline: ref("timeline") }),
    selection: closed(["status", "persisted", "reason"], { status: { const: "unavailable" }, persisted: { const: false }, reason: text(MAX_AGENT_SNAPSHOT_LABEL_SCALARS) }),
    entrypoint: closed(["command", "permission", "mutates"], { command: text(MAX_AGENT_SNAPSHOT_OPERATION_SCALARS), permission: { const: "read_motion" }, mutates: { const: false } }),
    action: closed(["id", "alias", "permission", "mutates", "callCount", "calls"], {
      id: text(MAX_AGENT_SNAPSHOT_ID_SCALARS), alias: text(MAX_AGENT_SNAPSHOT_LABEL_SCALARS), permission: text(32), mutates: bool(), callCount: integer(), calls: list(MAX_AGENT_SNAPSHOT_ACTION_CALLS, text(MAX_AGENT_SNAPSHOT_OPERATION_SCALARS))
    }),
    planStep: closed(["order", "command", "permission", "mutates"], {
      order: integer(), command: text(MAX_AGENT_SNAPSHOT_OPERATION_SCALARS), permission: text(32), mutates: bool(),
      requiredArgs: list(MAX_AGENT_SNAPSHOT_PLAN_ARGUMENTS, text(64)),
      requiredArgGroups: list(MAX_AGENT_SNAPSHOT_PLAN_ARGUMENT_GROUPS, closed(["mode", "alternatives"], {
        mode: { enum: ["anyOf", "oneOf"] },
        alternatives: list(MAX_AGENT_SNAPSHOT_PLAN_ARGUMENT_ALTERNATIVES, list(MAX_AGENT_SNAPSHOT_PLAN_ARGUMENTS, text(64)))
      }))
    }),
    actionFind: closed(["matched", "nearest"], { matched: bool(), action: ref("action"), nearest: list(MAX_AGENT_SNAPSHOT_NEAREST_ACTIONS, ref("action")) }),
    actionPlan: closed(["steps", "cautionCount", "cautions"], { steps: list(MAX_AGENT_SNAPSHOT_PLAN_STEPS, ref("planStep")), cautionCount: integer(), cautions: list(MAX_AGENT_SNAPSHOT_PLAN_CAUTIONS, text(MAX_AGENT_SNAPSHOT_LABEL_SCALARS)) }),
    requestActions: closed(["find", "guide", "plan"], { find: ref("actionFind"), guide: closed(["equivalentTo"], { equivalentTo: { const: "plan" } }), plan: ref("actionPlan") }),
    actions: closed(["entrypoints"], { entrypoints: { type: "array", minItems: 3, maxItems: 3, items: ref("entrypoint") }, request: ref("requestActions") }),
    receipt: closed(["id", "operation", "status", "createdAt"], { id: text(MAX_AGENT_SNAPSHOT_ID_SCALARS), operation: text(MAX_AGENT_SNAPSHOT_OPERATION_SCALARS), status: { enum: ["passed", "failed", "warning", "not_run", "other"] }, createdAt: text(MAX_AGENT_SNAPSHOT_TIMESTAMP_SCALARS), packageId: text(MAX_AGENT_SNAPSHOT_ID_SCALARS), lane: text(64) }),
    receiptCounts: closed(["passed", "failed", "warning", "notRun", "other"], { passed: integer(MAX_AGENT_SNAPSHOT_RECEIPT_DISCOVERY_ENTRIES), failed: integer(MAX_AGENT_SNAPSHOT_RECEIPT_DISCOVERY_ENTRIES), warning: integer(MAX_AGENT_SNAPSHOT_RECEIPT_DISCOVERY_ENTRIES), notRun: integer(MAX_AGENT_SNAPSHOT_RECEIPT_DISCOVERY_ENTRIES), other: integer(MAX_AGENT_SNAPSHOT_RECEIPT_DISCOVERY_ENTRIES) }),
    receipts: closed(["count", "countExact", "statusCounts", "statusCountsExact", "recent"], { count: integer(MAX_AGENT_SNAPSHOT_RECEIPT_DISCOVERY_ENTRIES), countExact: bool(), statusCounts: ref("receiptCounts"), statusCountsExact: bool(), recent: list(MAX_AGENT_SNAPSHOT_RECEIPTS, ref("receipt")) }),
    job: closed(["id", "state", "lifecycle", "operation", "lane", "createdAtMs", "warningCount"], { id: text(MAX_AGENT_SNAPSHOT_ID_SCALARS), state: { enum: ["pending", "running", "succeeded", "failed", "cancelled", "skipped"] }, lifecycle: { enum: ["pending", "running", "ended"] }, operation: text(MAX_AGENT_SNAPSHOT_OPERATION_SCALARS), lane: text(64), outcome: { enum: ["succeeded", "failed", "cancelled", "skipped"] }, createdAtMs: integer(), pollAfterMs: integer(), warningCount: integer() }),
    jobs: closed(["count", "countExact", "recent"], { count: integer(MAX_AGENT_SNAPSHOT_JOB_COUNT), countExact: bool(), recent: list(MAX_AGENT_SNAPSHOT_JOBS, ref("job")) }),
    warning: closed(["source", "message"], { source: { enum: ["package", "timeline", "receipts", "jobs"] }, message: text(MAX_AGENT_SNAPSHOT_WARNING_SCALARS) }),
    countTruncation: closed(["omitted", "exact"], { omitted: integer(MAX_AGENT_SNAPSHOT_RECEIPT_DISCOVERY_ENTRIES), exact: bool() }),
    truncation: closed(["valuesTruncated", "warningsTruncated", "receiptRows", "jobRows", "nearestActions", "planSteps", "receiptDiscoveryIncomplete"], { valuesTruncated: bool(), warningsTruncated: bool(), receiptRows: ref("countTruncation"), jobRows: ref("countTruncation"), nearestActions: integer(), planSteps: integer(), receiptDiscoveryIncomplete: bool() })
  }
};

function bool(): JsonSchemaDocument { return { type: "boolean" }; }
function ref(name: string): JsonSchemaDocument { return { $ref: `#/$defs/${name}` }; }
function list(maxItems: number, items: JsonSchemaDocument): JsonSchemaDocument { return { type: "array", maxItems, items }; }
function closed(required: string[], properties: Record<string, JsonSchemaDocument>): JsonSchemaDocument {
  return { type: "object", required, additionalProperties: false, properties };
}
