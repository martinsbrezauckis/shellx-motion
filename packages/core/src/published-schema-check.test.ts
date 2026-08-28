import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isValidAgainstPublishedSchema, validateAgainstPublishedSchema, type JsonSchemaDocument } from "./published-schema-check";

const REPOSITORY_PATTERNS = publishedSchemaPatterns();

function publishedSchemaPatterns(): string[] {
  const root = new URL("../../../schemas/", import.meta.url);
  const patterns = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { for (const entry of value) visit(entry); return; }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (typeof record.pattern === "string") patterns.add(record.pattern);
    for (const entry of Object.values(record)) visit(entry);
  };
  for (const name of readdirSync(root).filter((entry) => entry.endsWith(".json")).sort()) {
    visit(JSON.parse(readFileSync(new URL(name, root), "utf8")));
  }
  return [...patterns].sort();
}

describe("published schema checker (JSON Schema subset)", () => {
  it("validates type, required, string, and number constraints", () => {
    const schema: JsonSchemaDocument = {
      type: "object",
      required: ["id", "count"],
      properties: {
        id: { type: "string", minLength: 1 },
        count: { type: "number", minimum: 0, exclusiveMaximum: 10 }
      }
    };
    expect(validateAgainstPublishedSchema(schema, { id: "a", count: 5 })).toEqual([]);
    expect(validateAgainstPublishedSchema(schema, { count: 5 })).toEqual([{ path: "/id", message: "required" }]);
    expect(validateAgainstPublishedSchema(schema, { id: "", count: 5 })[0]).toMatchObject({ path: "/id" });
    expect(validateAgainstPublishedSchema(schema, { id: "a", count: 10 })[0]).toMatchObject({ path: "/count" });
    expect(validateAgainstPublishedSchema(schema, { id: "a", count: -1 })[0]).toMatchObject({ path: "/count" });
  });

  it("counts minLength and maxLength in Unicode scalars and rejects malformed bounds", () => {
    const bounded: JsonSchemaDocument = { type: "string", minLength: 2, maxLength: 2 };
    expect(validateAgainstPublishedSchema(bounded, "😀😃")).toEqual([]);
    expect(validateAgainstPublishedSchema(bounded, "😀")[0]).toMatchObject({ message: "must be at least 2 character(s)" });
    expect(validateAgainstPublishedSchema(bounded, "😀😃😄")[0]).toMatchObject({ message: "must contain at most 2 character(s)" });
    expect(() => validateAgainstPublishedSchema({ type: "string", maxLength: 1.5 }, "")).toThrow(/maxLength.*non-negative safe integer/);
    expect(() => validateAgainstPublishedSchema({ type: "string", maxLength: -1 }, "")).toThrow(/maxLength.*non-negative safe integer/);
  });

  it("honours const and enum", () => {
    expect(isValidAgainstPublishedSchema({ const: "x" }, "x")).toBe(true);
    expect(isValidAgainstPublishedSchema({ const: "x" }, "y")).toBe(false);
    expect(isValidAgainstPublishedSchema({ enum: ["a", "b"] }, "b")).toBe(true);
    expect(isValidAgainstPublishedSchema({ enum: ["a", "b"] }, "c")).toBe(false);
  });

  it("enforces additionalProperties: false and array items", () => {
    const closed: JsonSchemaDocument = { type: "object", additionalProperties: false, properties: { a: { type: "number" } } };
    expect(isValidAgainstPublishedSchema(closed, { a: 1 })).toBe(true);
    expect(validateAgainstPublishedSchema(closed, { a: 1, b: 2 })).toEqual([{ path: "/b", message: "unexpected property" }]);

    const list: JsonSchemaDocument = { type: "array", maxItems: 2, items: { type: "string", minLength: 1 } };
    expect(isValidAgainstPublishedSchema(list, ["a", "b"])).toBe(true);
    expect(validateAgainstPublishedSchema(list, ["a", ""])[0]).toMatchObject({ path: "/1" });
    expect(validateAgainstPublishedSchema(list, ["a", "b", "c"])).toEqual([{ path: "", message: "must contain at most 2 item(s)" }]);
    expect(() => validateAgainstPublishedSchema({ type: "array", maxItems: 1.5 }, [])).toThrow(/maxItems.*non-negative safe integer/);
  });

  it("enforces uniqueItems with deterministic JSON-value equality and bounded work", () => {
    const schema: JsonSchemaDocument = { type: "array", uniqueItems: true };
    expect(validateAgainstPublishedSchema(schema, ["a", "b", "a"]))
      .toEqual([{ path: "/2", message: "must contain unique items" }]);
    expect(validateAgainstPublishedSchema(schema, [{ a: 1, b: [true, null] }, { b: [true, null], a: 1 }]))
      .toEqual([{ path: "/1", message: "must contain unique items" }]);
    expect(validateAgainstPublishedSchema({ type: "array", uniqueItems: false }, ["a", "a"])).toEqual([]);
    expect(() => validateAgainstPublishedSchema({ type: "array", uniqueItems: "true" }, [])).toThrow(/uniqueItems.*boolean/);
    expect(() => validateAgainstPublishedSchema(schema, Array.from({ length: 4_097 }, (_, index) => index))).toThrow(/uniqueItems.*4096/);
  });

  it("resolves local $ref and applies if/then conditionals", () => {
    const schema: JsonSchemaDocument = {
      type: "object",
      properties: { kind: { type: "string" }, node: { $ref: "#/$defs/node" } },
      allOf: [
        {
          if: { required: ["kind"], properties: { kind: { const: "advanced" } } },
          then: { required: ["node"] }
        }
      ],
      $defs: { node: { type: "object", required: ["id"], properties: { id: { type: "string" } } } }
    };
    expect(isValidAgainstPublishedSchema(schema, { kind: "basic" })).toBe(true);
    expect(isValidAgainstPublishedSchema(schema, { kind: "advanced", node: { id: "n1" } })).toBe(true);
    expect(validateAgainstPublishedSchema(schema, { kind: "advanced" })).toEqual([{ path: "/node", message: "required" }]);
    expect(validateAgainstPublishedSchema(schema, { kind: "advanced", node: {} })[0]).toMatchObject({ path: "/node/id" });
  });

  it("throws on an unsupported keyword so a schema cannot silently rely on it", () => {
    expect(() => validateAgainstPublishedSchema({ type: "string", format: "email" }, "a@b.co")).toThrow(/Unsupported JSON Schema keyword 'format'/);
  });

  describe("pattern evaluation is closed and precompiled", () => {
    // This module is exported from @shellx-motion/core, so a consumer can hand it a schema this
    // repository did not author. `new RegExp(node.pattern).test(value)` then compiles and runs
    // caller-supplied source over caller-supplied input, which is a denial-of-service primitive.
    // It refuses rather than evaluates, the same way it refuses an unimplemented keyword: this
    // module's one promise is that it never reports "valid" for something it did not check.

    // Read the exact public schema corpus so adding a new pattern turns this test red until its
    // precompiled literal receives an explicit review beside the checker.
    it.each(REPOSITORY_PATTERNS)("evaluates the repository's own pattern %s", (pattern) => {
      expect(() => validateAgainstPublishedSchema({ type: "string", pattern }, "test-value")).not.toThrow();
    });

    it("refuses caller-selected nested-quantifier patterns", () => {
      expect(() => validateAgainstPublishedSchema({ type: "string", pattern: "^(a+)+$" }, "aaaaaaaaaaaaaaaaaaaaaaaa!"))
        .toThrow(/not one of Motion's reviewed published-schema patterns/);
      expect(() => validateAgainstPublishedSchema({ type: "string", pattern: "^(\\w+\\s?)*$" }, "aaaaaaaaaaaaaaaaaaaaaaaa!"))
        .toThrow(/not one of Motion's reviewed published-schema patterns/);
    });

    it("refuses caller-selected ambiguous-alternation patterns", () => {
      expect(() => validateAgainstPublishedSchema({ type: "string", pattern: "^(a|a)*$" }, "aaaaaaaaaaaaaaaaaaaaaaaa!"))
        .toThrow(/not one of Motion's reviewed published-schema patterns/);
    });

    it("refuses even a safe-looking regex that is not a published-schema pattern", () => {
      expect(() => validateAgainstPublishedSchema({ type: "string", pattern: "^(\\.d)?\\.(ts|tsx|js)(\\.map)?$" }, ".d.ts"))
        .toThrow(/not one of Motion's reviewed published-schema patterns/);
    });

    it("refuses a long caller-selected pattern without compiling it", () => {
      expect(() => validateAgainstPublishedSchema({ type: "string", pattern: `^${"x".repeat(250)}$` }, "x"))
        .toThrow(/not one of Motion's reviewed published-schema patterns/);
    });

    it("still reports a genuine pattern mismatch rather than passing it", () => {
      expect(validateAgainstPublishedSchema({ type: "string", pattern: "^[a-f0-9]{64}$" }, "not-a-hash"))
        .toEqual([{ path: "", message: "must match pattern ^[a-f0-9]{64}$" }]);
    });
  });
});
