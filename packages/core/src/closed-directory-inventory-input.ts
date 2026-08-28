/** Bounded hostile-data admission for private closed-directory inventory verification. */
import { compareCodeUnits } from "./canonical-json";
import { DerivedOutputPublicationError } from "./derived-output-publication-types";

export const CLOSED_DIRECTORY_INVENTORY_LIMITS = Object.freeze({
  maxFiles: 1_024,
  maxEntries: 2_048,
  maxDepth: 16,
  maxFileBytes: 64 * 1024 * 1024,
  maxAggregateBytes: 256 * 1024 * 1024,
  maxWorkUnits: 8_192
});

export type ExactDirectoryInventoryEntry = Readonly<{ path: string; sha256: string; byteLength: number }>;
/** A complete-tree-only marker for a directory that must remain empty. */
export type EmptyDirectoryInventoryEntry = Readonly<{ path: string; kind: "empty-directory" }>;
export type CompleteDirectoryInventoryEntry = ExactDirectoryInventoryEntry | EmptyDirectoryInventoryEntry;

export function isEmptyDirectoryInventoryEntry(entry: CompleteDirectoryInventoryEntry): entry is EmptyDirectoryInventoryEntry {
  return Object.hasOwn(entry, "kind");
}

/**
 * Admit hostile runtime inventory data without reading values through getters or retaining an
 * over-limit input. This is the only expected-inventory normalizer.
 */
export function normalizeExpectedDirectoryInventory(entries: unknown, path: string, label: string): ExactDirectoryInventoryEntry[] {
  if (!Array.isArray(entries)) fail(`${label} expected inventory is not an array.`, path);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(entries, "length");
  const length = lengthDescriptor?.value;
  if (!lengthDescriptor || !("value" in lengthDescriptor) || !Number.isSafeInteger(length) || length <= 0 || length > CLOSED_DIRECTORY_INVENTORY_LIMITS.maxFiles) {
    fail(`${label} expected inventory exceeds its file limit.`, path);
  }

  let aggregate = 0;
  const normalized: ExactDirectoryInventoryEntry[] = [];
  for (let index = 0; index < length; index += 1) {
    const element = Object.getOwnPropertyDescriptor(entries, String(index));
    if (!element || !element.enumerable || !("value" in element)) {
      fail(`${label} expected inventory must contain dense enumerable data entries.`, path);
    }
    const entry = exactEntryFromOwnData(element.value, path, label);
    const depth = entry.path.split("/").length;
    if (!safeRelativeFilePath(entry.path) || entry.path.length > 4_096 || depth > CLOSED_DIRECTORY_INVENTORY_LIMITS.maxDepth) {
      fail(`${label} expected inventory is not a bounded content-addressed closed tree.`, path);
    }
    aggregate += entry.byteLength;
    if (!Number.isSafeInteger(aggregate) || aggregate > CLOSED_DIRECTORY_INVENTORY_LIMITS.maxAggregateBytes) {
      fail(`${label} expected inventory exceeds its aggregate-byte limit.`, path);
    }
    normalized.push(Object.freeze(entry));
  }

  normalized.sort((left, right) => compareCodeUnits(left.path, right.path));
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index - 1]!.path === normalized[index]!.path) {
      fail(`${label} expected inventory has duplicate paths.`, path);
    }
  }
  return normalized;
}

/**
 * Bounded hostile-data admission for the opt-in complete-tree mode.  File entries deliberately
 * retain the exact legacy shape so their digest rows remain byte-for-byte stable; only a distinct
 * empty-directory marker expands the tree vocabulary.
 */
export function normalizeCompleteDirectoryInventory(entries: unknown, path: string, label: string): CompleteDirectoryInventoryEntry[] {
  if (!Array.isArray(entries)) fail(`${label} expected inventory is not an array.`, path);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(entries, "length");
  const length = lengthDescriptor?.value;
  if (!lengthDescriptor || !("value" in lengthDescriptor) || !Number.isSafeInteger(length) || length <= 0 || length > CLOSED_DIRECTORY_INVENTORY_LIMITS.maxEntries) {
    fail(`${label} expected complete-tree inventory exceeds its entry limit.`, path);
  }

  let aggregate = 0;
  let files = 0;
  const normalized: CompleteDirectoryInventoryEntry[] = [];
  for (let index = 0; index < length; index += 1) {
    const element = Object.getOwnPropertyDescriptor(entries, String(index));
    if (!element || !element.enumerable || !("value" in element)) {
      fail(`${label} expected complete-tree inventory must contain dense enumerable data entries.`, path);
    }
    const entry = completeEntryFromOwnData(element.value, path, label);
    const depth = entry.path.split("/").length;
    if (!safeRelativeFilePath(entry.path) || entry.path.length > 4_096 || depth > CLOSED_DIRECTORY_INVENTORY_LIMITS.maxDepth) {
      fail(`${label} expected complete-tree inventory is not a bounded closed tree.`, path);
    }
    if (!isEmptyDirectoryInventoryEntry(entry)) {
      files += 1;
      if (files > CLOSED_DIRECTORY_INVENTORY_LIMITS.maxFiles) {
        fail(`${label} expected complete-tree inventory exceeds its file limit.`, path);
      }
      aggregate += entry.byteLength;
      if (!Number.isSafeInteger(aggregate) || aggregate > CLOSED_DIRECTORY_INVENTORY_LIMITS.maxAggregateBytes) {
        fail(`${label} expected complete-tree inventory exceeds its aggregate-byte limit.`, path);
      }
    }
    normalized.push(Object.freeze(entry));
  }

  normalized.sort((left, right) => compareCodeUnits(left.path, right.path));
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index - 1]!.path === normalized[index]!.path) {
      fail(`${label} expected complete-tree inventory has duplicate paths.`, path);
    }
  }
  return normalized;
}

function exactEntryFromOwnData(value: unknown, path: string, label: string): { path: string; sha256: string; byteLength: number } {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    fail(`${label} expected inventory entries must be plain data objects.`, path);
  }
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== 3 || !names.includes("path") || !names.includes("sha256") || !names.includes("byteLength")) {
    fail(`${label} expected inventory entries must have exactly path, sha256, and byteLength.`, path);
  }
  const pathDescriptor = Object.getOwnPropertyDescriptor(value, "path");
  const hashDescriptor = Object.getOwnPropertyDescriptor(value, "sha256");
  const byteLengthDescriptor = Object.getOwnPropertyDescriptor(value, "byteLength");
  if (!isEnumerableData(pathDescriptor) || !isEnumerableData(hashDescriptor) || !isEnumerableData(byteLengthDescriptor)) {
    fail(`${label} expected inventory entries must use enumerable data descriptors.`, path);
  }
  const entryPath = pathDescriptor.value;
  const sha256 = hashDescriptor.value;
  const byteLength = byteLengthDescriptor.value;
  if (typeof entryPath !== "string" || typeof sha256 !== "string" || !Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > CLOSED_DIRECTORY_INVENTORY_LIMITS.maxFileBytes || !/^[a-f0-9]{64}$/.test(sha256)) {
    fail(`${label} expected inventory is not a bounded content-addressed closed tree.`, path);
  }
  return { path: entryPath, sha256, byteLength };
}

function completeEntryFromOwnData(value: unknown, path: string, label: string): ExactDirectoryInventoryEntry | EmptyDirectoryInventoryEntry {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    fail(`${label} expected complete-tree inventory entries must be plain data objects.`, path);
  }
  const names = Object.getOwnPropertyNames(value);
  const descriptors = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(value, name)]));
  const pathDescriptor = descriptors.get("path");
  if (!isEnumerableData(pathDescriptor) || typeof pathDescriptor.value !== "string") {
    fail(`${label} expected complete-tree inventory entries must use enumerable data descriptors.`, path);
  }
  if (names.length === 2 && names.includes("path") && names.includes("kind")) {
    const kindDescriptor = descriptors.get("kind");
    if (!isEnumerableData(kindDescriptor) || kindDescriptor.value !== "empty-directory") {
      fail(`${label} expected complete-tree directory marker is invalid.`, path);
    }
    return { path: pathDescriptor.value, kind: "empty-directory" };
  }
  if (names.length === 3 && names.includes("path") && names.includes("sha256") && names.includes("byteLength")) {
    const hashDescriptor = descriptors.get("sha256");
    const byteLengthDescriptor = descriptors.get("byteLength");
    if (!isEnumerableData(hashDescriptor) || !isEnumerableData(byteLengthDescriptor)
      || typeof hashDescriptor.value !== "string" || !Number.isSafeInteger(byteLengthDescriptor.value)
      || byteLengthDescriptor.value < 0 || byteLengthDescriptor.value > CLOSED_DIRECTORY_INVENTORY_LIMITS.maxFileBytes
      || !/^[a-f0-9]{64}$/.test(hashDescriptor.value)) {
      fail(`${label} expected complete-tree file entry is invalid.`, path);
    }
    return { path: pathDescriptor.value, sha256: hashDescriptor.value, byteLength: byteLengthDescriptor.value };
  }
  fail(`${label} expected complete-tree inventory entries must be file rows or empty-directory markers.`, path);
}

function isEnumerableData(descriptor: PropertyDescriptor | undefined): descriptor is PropertyDescriptor & { value: unknown } {
  return !!descriptor && descriptor.enumerable === true && Object.prototype.hasOwnProperty.call(descriptor, "value");
}

function safeRelativeFilePath(name: string): boolean {
  return !!name && !name.includes("\\") && !name.startsWith("/") && !name.endsWith("/") && name.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function fail(message: string, path: string): never {
  throw new DerivedOutputPublicationError("derived_output_stage_invalid", message, path);
}
