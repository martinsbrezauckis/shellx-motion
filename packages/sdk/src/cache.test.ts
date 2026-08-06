/**
 * Contract tests for SDK cache keys.
 *
 * `cache.ts` is not a serializer — it is an admission policy in front of the single canonical
 * serializer in `@shellx-motion/core`. That claim is only worth anything if the bytes agree, so the
 * agreement is asserted over a corpus here rather than asserted in a comment. The strictness half
 * of the contract (what the policy refuses) lives in `sdk.test.ts` next to the client tests that
 * depend on it.
 */
import { describe, expect, it } from "vitest";
import { canonicalJson as coreCanonicalJson } from "@shellx-motion/core";
import { canonicalJson, motionSdkCacheKey } from "./cache";
import { MOTION_SDK_SCHEMA } from "./types";

describe("SDK cache keys", () => {
  it("emits exactly the bytes the single core serializer emits", () => {
    // The keys below are the ones that separate candidate orderings: mixed ASCII case and
    // non-ASCII (which locale collation orders differently from code units), and integer-like keys
    // (which JS re-orders on insertion, so an implementation that rebuilds the object instead of
    // building the text would disagree here).
    const corpus: unknown[] = [
      null,
      0,
      -0,
      "text",
      [1, 2, 3],
      [],
      {},
      { z: 1, a: 2, "10": 3, "2": 4, "ä": 5, Name: 6, avatar: 7 },
      { nested: { b: [{ y: 1, x: 2 }], a: null }, omitted: undefined },
      { deep: [[["ä", "z"], { "Ä": 1, "a": 2 }]] },
      { schema: MOTION_SDK_SCHEMA, operation: "render", input: { preset: "webm-vp9", packageRoot: "/pkg" } }
    ];
    for (const value of corpus) {
      expect(canonicalJson(value), JSON.stringify(value) ?? "undefined").toBe(coreCanonicalJson(value));
    }
  });

  it("keeps the same key when a request is built in a different order", async () => {
    const [left, right] = await Promise.all([
      motionSdkCacheKey("render", { preset: "webm-vp9", packageRoot: "/pkg", options: { fps: 30, width: 1920 } }),
      motionSdkCacheKey("render", { options: { width: 1920, fps: 30 }, packageRoot: "/pkg", preset: "webm-vp9" })
    ]);
    expect(left).toBe(right);
    expect(left).toMatch(/^[a-f0-9]{64}$/);
  });

  it("does not consult the locale while building a key", async () => {
    // The cache key is compared across transports and hosts, so a key that moved with LC_ALL would
    // turn a cache into a source of silent misses — or, worse, cross-host disagreement about
    // whether two requests are the same request.
    const input = { "ä": 1, z: 2, a: 3, Name: 4, "10": 5, "2": 6 };
    const baseline = await motionSdkCacheKey("render", input);
    const globals = globalThis as Record<string, unknown>;
    const savedIntl = globals.Intl;
    const savedCompare = String.prototype.localeCompare;
    const boom = () => { throw new Error("locale-sensitive path reached from an SDK cache key"); };
    let trapped: string;
    try {
      globals.Intl = new Proxy({}, { get: boom, has: boom, apply: boom });
      String.prototype.localeCompare = boom as typeof String.prototype.localeCompare;
      trapped = await motionSdkCacheKey("render", input);
    } finally {
      globals.Intl = savedIntl;
      String.prototype.localeCompare = savedCompare;
    }
    expect(trapped).toBe(baseline);
  });
});
