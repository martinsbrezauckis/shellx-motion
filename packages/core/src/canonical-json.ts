/**
 * Canonical JSON serialization for every hash, fingerprint, and identity path.
 *
 * Role: turn a JSON-shaped value into ONE byte string that depends only on the value, never on
 * how the value was built or on the machine that built it. `JSON.stringify` fails that contract in
 * two ways that both produced live defects in this repo:
 *
 *   1. Key ORDER follows insertion order, so `{ a: 1, b: 2 }` and `{ b: 2, a: 1 }` — identical
 *      values — serialize differently and therefore hash differently.
 *   2. Sorting keys with `String.prototype.localeCompare` is LOCALE-SENSITIVE. A live probe on this
 *      machine ordered the same three keys `a, ä, z` under `en-US` and `a, z, ä` under `sv-SE`, so a
 *      "deterministic" fingerprint silently depended on the ambient `LC_ALL` / ICU default locale.
 *
 * The rule enforced here:
 *
 *   - Object keys are emitted sorted by UTF-16 CODE UNIT (`left < right ? -1 : left > right ? 1 : 0`).
 *     That is the ordering the `<` operator gives: fixed by the language, identical on every host,
 *     unaffected by locale, ICU build, or `Intl` availability. It is NOT alphabetical and NOT
 *     case-insensitive: `"B"` (U+0042) sorts before `"a"` (U+0061), and `"z"` (U+007A) sorts before
 *     `"ä"` (U+00E4). For characters outside the BMP this is code-unit order, not code-point order —
 *     `"\u{1F600}"` (surrogate pair starting U+D83D) sorts below `"�"`. That is still totally
 *     deterministic, which is the property hashes need; it is simply not a human collation.
 *   - The output string is built directly rather than by re-inserting keys into an object, because a
 *     JS object re-orders integer-like keys ("2" before "10" before "a") no matter what order they
 *     were inserted in. Building the text ourselves keeps `"10"` before `"2"` as code-unit order says.
 *   - Array order is DATA and is preserved exactly.
 *
 * Value semantics deliberately match `JSON.stringify` so existing callers keep their meaning:
 * `toJSON()` is honoured, `undefined` / functions / symbols are dropped from objects and become
 * `null` inside arrays, and non-finite numbers become `null`. Two deliberate divergences:
 * `bigint` throws a named error instead of `JSON.stringify`'s generic TypeError, and cycles throw a
 * named error before the recursion can overflow the stack.
 *
 * Primary callers: `tracking-analysis.ts` (settings + receipt identity hashes), `data.ts` (data-row
 * hashes and row keys). Any NEW hash, fingerprint, or content-address path must serialize through
 * `canonicalJson` — never `JSON.stringify` — or it inherits both defects above.
 */

import { createHash } from "node:crypto";

/**
 * Fixed, locale-independent string comparator: UTF-16 code-unit order.
 *
 * Use this anywhere an ordering feeds a hash, a fingerprint, a canonical document, or any other
 * output that must be byte-identical across machines. `String.prototype.localeCompare` must not be
 * used on those paths — its result depends on the ambient locale and the host ICU data.
 * Human-facing display lists (a file browser, a picker) may still use `localeCompare`, because
 * there the point IS to follow the reader's locale.
 *
 * @param left  first string.
 * @param right second string.
 * @returns -1 when `left` sorts first, 1 when `right` sorts first, 0 when the strings are equal.
 */
export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Serialize a value to canonical JSON: same value in, same bytes out, on any machine, under any
 * locale, regardless of key insertion order.
 *
 * @param value any JSON-shaped value.
 * @returns the canonical JSON text.
 * @throws {Error} when the value contains a bigint, or a cycle (`canonical JSON cannot serialize a cycle`).
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, []) ?? "null";
}

/**
 * SHA-256 of the canonical JSON encoding of a value, lowercase hex.
 *
 * This is the only supported way to hash a structured value in this package. It exists so that a
 * caller cannot accidentally reach for `createHash("sha256").update(JSON.stringify(x))`, which is
 * exactly the pattern that made `trackingSettingsSha256` order-dependent.
 *
 * @param value any JSON-shaped value.
 * @returns lowercase hex SHA-256 of `canonicalJson(value)` encoded as UTF-8.
 */
export function canonicalJsonSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

/**
 * Recursive worker.
 *
 * @param value   the value to encode.
 * @param parents the object/array chain currently being encoded, used for cycle detection. An array
 *                is used rather than a Set because it is walked only to the current depth, so a
 *                value repeated in sibling positions (legal, and common in fixtures) is not
 *                mistaken for a cycle.
 * @returns the encoded text, or `undefined` for values JSON drops (undefined, functions, symbols).
 */
function serialize(value: unknown, parents: object[]): string | undefined {
  if (value === null) return "null";
  const type = typeof value;
  if (type === "string") return JSON.stringify(value);
  if (type === "boolean") return value ? "true" : "false";
  if (type === "number") return Number.isFinite(value as number) ? JSON.stringify(value) : "null";
  if (type === "bigint") throw new Error("canonical JSON cannot serialize a bigint; convert it to a string or number first");
  if (type === "undefined" || type === "function" || type === "symbol") return undefined;

  const object = value as Record<string, unknown>;
  const toJson = (object as { toJSON?: unknown }).toJSON;
  if (typeof toJson === "function") {
    // Match JSON.stringify: toJSON() replaces the value before any other handling (Date, Buffer-like
    // wrappers, class instances that opt into a serial form).
    return serialize((toJson as (key?: string) => unknown).call(object), parents);
  }
  if (parents.includes(object)) throw new Error("canonical JSON cannot serialize a cycle");
  const nested = [...parents, object];

  if (Array.isArray(object)) {
    // Array order is data: preserved exactly. Holes and dropped values become null, as in JSON.
    // An index loop rather than `.map` because `.map` skips holes, which would emit `[,]`.
    const items: string[] = [];
    for (let index = 0; index < object.length; index += 1) items.push(serialize(object[index], nested) ?? "null");
    return `[${items.join(",")}]`;
  }

  const parts: string[] = [];
  for (const key of Object.keys(object).sort(compareCodeUnits)) {
    const encoded = serialize(object[key], nested);
    if (encoded === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${encoded}`);
  }
  return `{${parts.join(",")}}`;
}
