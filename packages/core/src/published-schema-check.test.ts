import { describe, expect, it } from "vitest";
import { isValidAgainstPublishedSchema, validateAgainstPublishedSchema, type JsonSchemaDocument } from "./published-schema-check";

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

    const list: JsonSchemaDocument = { type: "array", items: { type: "string", minLength: 1 } };
    expect(isValidAgainstPublishedSchema(list, ["a", "b"])).toBe(true);
    expect(validateAgainstPublishedSchema(list, ["a", ""])[0]).toMatchObject({ path: "/1" });
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

  describe("pattern evaluation is bounded", () => {
    // This module is exported from @shellx-motion/core, so a consumer can hand it a schema this
    // repository did not author. `new RegExp(node.pattern).test(value)` then compiles and runs
    // caller-supplied source over caller-supplied input, which is a denial-of-service primitive.
    // It refuses rather than evaluates, the same way it refuses an unimplemented keyword: this
    // module's one promise is that it never reports "valid" for something it did not check.

    // Every pattern the repository's own schemas actually use, read out of schemas/**/*.json.
    // If the guard rejected any of these it would break real validation to prevent an impossible
    // attack, so they are the regression half of this contract.
    const REPOSITORY_PATTERNS = [
      "^/",
      "^[1-9][0-9]*:[1-9][0-9]*$",
      "^[A-Fa-f0-9]{64}$",
      "^[A-Za-z0-9][A-Za-z0-9 ._-]{0,127}$",
      "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
      "^[a-f0-9]{64}$",
      "^[a-fA-F0-9]{64}$",
      "^artifact-[a-f0-9]{24}$",
      "^cubic-bezier\\(",
      "^https?://",
      "^quality/(?!.*\\.\\.)[^/].*$",
      "^steps\\("
    ];

    it.each(REPOSITORY_PATTERNS)("evaluates the repository's own pattern %s", (pattern) => {
      expect(() => validateAgainstPublishedSchema({ type: "string", pattern }, "test-value")).not.toThrow();
    });

    it("refuses a quantified group that already contains a quantifier", () => {
      expect(() => validateAgainstPublishedSchema({ type: "string", pattern: "^(a+)+$" }, "aaaaaaaaaaaaaaaaaaaaaaaa!"))
        .toThrow(/nests quantifiers/);
      expect(() => validateAgainstPublishedSchema({ type: "string", pattern: "^(\\w+\\s?)*$" }, "aaaaaaaaaaaaaaaaaaaaaaaa!"))
        .toThrow(/nests quantifiers/);
    });

    it("refuses a quantified group containing an alternation", () => {
      expect(() => validateAgainstPublishedSchema({ type: "string", pattern: "^(a|a)*$" }, "aaaaaaaaaaaaaaaaaaaaaaaa!"))
        .toThrow(/nests quantifiers/);
    });

    it("still allows a bounded quantifier on a group, which cannot blow up", () => {
      // The source-module gate uses exactly this shape: `(\.d)?\.(ts|tsx|js)(\.map)?$`.
      expect(() => validateAgainstPublishedSchema({ type: "string", pattern: "^(\\.d)?\\.(ts|tsx|js)(\\.map)?$" }, ".d.ts"))
        .not.toThrow();
    });

    it("refuses a pattern longer than the evaluation bound", () => {
      expect(() => validateAgainstPublishedSchema({ type: "string", pattern: `^${"x".repeat(250)}$` }, "x"))
        .toThrow(/exceeds 200 characters/);
    });

    it("still reports a genuine pattern mismatch rather than passing it", () => {
      expect(validateAgainstPublishedSchema({ type: "string", pattern: "^[a-f0-9]{64}$" }, "not-a-hash"))
        .toEqual([{ path: "", message: "must match pattern ^[a-f0-9]{64}$" }]);
    });
  });
});
