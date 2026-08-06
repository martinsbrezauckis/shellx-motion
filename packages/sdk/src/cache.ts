/**
 * Canonical JSON and SHA-256 cache keys shared by local and service transports.
 *
 * Serialization is NOT implemented here. The one canonical byte form in this repo lives in
 * `@shellx-motion/core`'s `canonical-json.ts`, and this module delegates to it. What this module
 * adds — and keeps — is a stricter ADMISSION POLICY than core's serializer applies.
 *
 * The distinction matters. Core's `canonicalJson` deliberately matches `JSON.stringify`'s value
 * semantics so existing hash callers keep their meaning: it honours `toJSON()`, drops `undefined`,
 * and turns non-finite numbers into `null`. Those are the right defaults for hashing a document
 * that was just read off disk. They are the WRONG defaults for a cache key, where a `Date`
 * silently becoming a string, or an accessor being invoked during serialization, means two
 * different requests can share a key. So a cache key is validated first and serialized second.
 *
 * Because validation rejects everything the two implementations could disagree about (non-plain
 * prototypes, accessors, non-finite numbers, symbol keys, non-enumerable properties), any value
 * that passes validation serializes to exactly the bytes core produces. `sdk.test.ts` asserts that
 * equality over a corpus rather than trusting this paragraph.
 */
import { canonicalJson as canonicalJsonBytes } from "@shellx-motion/core";
import { MOTION_SDK_SCHEMA, type MotionSdkOperation } from "./types";

/**
 * Content address of an SDK operation, stable across transports and machines.
 *
 * @param operation the SDK operation name.
 * @param input the request input.
 * @returns lowercase hex SHA-256 of the canonical JSON encoding.
 */
export async function motionSdkCacheKey(operation: MotionSdkOperation, input: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson({ schema: MOTION_SDK_SCHEMA, operation, input }));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Canonical JSON text for a cache-key value: validated as plain JSON data, then serialized by the
 * single canonical serializer in `@shellx-motion/core`.
 *
 * @param value the value to encode.
 * @returns the canonical JSON text — key order is UTF-16 code-unit order on every host and locale.
 * @throws {TypeError} when the value is not plain JSON data (see the module comment).
 */
export function canonicalJson(value: unknown): string {
  assertPlainJsonData(value, new Set<object>(), "$");
  return canonicalJsonBytes(value);
}

/**
 * Reject anything a cache key must not silently absorb.
 *
 * Validation only: it builds no JSON text, so this module is not a second serializer.
 *
 * @param value   the value under inspection.
 * @param seen    objects on the current path, for cycle detection. Walked as a set and unwound in
 *                `finally`, so a value repeated in sibling positions is not mistaken for a cycle.
 * @param path    human-readable location used in the thrown message.
 * @throws {TypeError} naming the offending path.
 */
function assertPlainJsonData(value: unknown, seen: Set<object>, path: string): void {
  if (value === null) return;
  if (typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`Non-finite number at ${path}.`);
    return;
  }
  if (value === undefined) return;
  if (typeof value !== "object") throw new TypeError(`Unsupported cache-key value at ${path}.`);
  if (seen.has(value)) throw new TypeError(`Cyclic cache-key value at ${path}.`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getOwnPropertySymbols(value).length > 0) throw new TypeError(`Cache-key array at ${path} must not contain symbol keys.`);
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const extraKey = Object.keys(descriptors).find((key) => key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key));
      if (extraKey) throw new TypeError(`Cache-key array at ${path} contains unsupported property ${extraKey}.`);
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        // A hole is legal and encodes as null, matching JSON.
        if (!descriptor) continue;
        if (!("value" in descriptor)) throw new TypeError(`Cache-key array at ${path}[${index}] must not use accessors.`);
        assertPlainJsonData(descriptor.value, seen, `${path}[${index}]`);
      }
      return;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`Cache-key object at ${path} must be plain JSON data.`);
    if (Object.getOwnPropertySymbols(value).length > 0) throw new TypeError(`Cache-key object at ${path} must not contain symbol keys.`);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Object.keys(descriptors)) {
      const descriptor = descriptors[key]!;
      if (!("value" in descriptor)) throw new TypeError(`Cache-key object at ${path}.${key} must not use accessors.`);
      // Canonical JSON enumerates with Object.keys, so a non-enumerable own property would be
      // validated here and then silently dropped from the bytes. Refuse it instead of letting two
      // different values share a key.
      if (!descriptor.enumerable) throw new TypeError(`Cache-key object at ${path}.${key} must not use non-enumerable properties.`);
      assertPlainJsonData(descriptor.value, seen, `${path}.${key}`);
    }
  } finally {
    seen.delete(value);
  }
}
