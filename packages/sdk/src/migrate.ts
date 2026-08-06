/** Explicit request-document migration keeps service and local clients version-aligned. */
import type { MotionSdkOperation, MotionSdkRequestMap } from "./types";

export interface MotionSdkRequestDocument<K extends MotionSdkOperation = MotionSdkOperation> {
  schema: "shellx-motion/sdk-request@1";
  operation: K;
  input: MotionSdkRequestMap[K];
}

export function migrateMotionSdkRequest(value: unknown): { document: MotionSdkRequestDocument; warnings: string[] } {
  const record = plainRecord(value);
  if (!record) throw new TypeError("Motion SDK request document must be an object.");
  if (record.schema === "shellx-motion/sdk-request@1") {
    return { document: readCurrent(record), warnings: [] };
  }
  if (record.schema === "shellx-motion/sdk-request@0") {
    const operation = readOperation(record.op);
    const input = plainRecord(record.payload);
    if (!input) throw new TypeError("Legacy Motion SDK request payload must be an object.");
    return {
      document: { schema: "shellx-motion/sdk-request@1", operation, input: migrateAliases(operation, input) } as unknown as MotionSdkRequestDocument,
      warnings: ["Migrated shellx-motion/sdk-request@0 to @1; replace op/payload and legacy field aliases."]
    };
  }
  throw new TypeError(`Unsupported Motion SDK request schema: ${String(record.schema)}.`);
}

function readCurrent(record: Record<string, unknown>): MotionSdkRequestDocument {
  const operation = readOperation(record.operation);
  const input = plainRecord(record.input);
  if (!input) throw new TypeError("Motion SDK request input must be an object.");
  return { schema: "shellx-motion/sdk-request@1", operation, input } as unknown as MotionSdkRequestDocument;
}

function migrateAliases(operation: MotionSdkOperation, input: Record<string, unknown>): MotionSdkRequestMap[MotionSdkOperation] {
  const migrated = { ...input };
  if (typeof migrated.root === "string" && migrated.packageRoot === undefined) migrated.packageRoot = migrated.root;
  if (typeof migrated.output === "string" && migrated.outputPath === undefined) migrated.outputPath = migrated.output;
  if (typeof migrated.id === "string" && migrated.jobId === undefined && (operation === "status" || operation === "cancel")) migrated.jobId = migrated.id;
  delete migrated.root;
  delete migrated.output;
  delete migrated.id;
  return migrated as unknown as MotionSdkRequestMap[MotionSdkOperation];
}

function readOperation(value: unknown): MotionSdkOperation {
  if (value === "validate" || value === "compile" || value === "preview" || value === "render" || value === "status" || value === "cancel") return value;
  throw new TypeError(`Unsupported Motion SDK operation: ${String(value)}.`);
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null || Object.getOwnPropertySymbols(value).length > 0) return null;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => "value" in descriptor)
    ? value as Record<string, unknown>
    : null;
}
