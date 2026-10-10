import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  NESTED_SHAPE_DOCUMENT_LIMITS,
  NESTED_SHAPE_LIMITS,
  describeNestedContractShape,
  isNestedContractCandidate,
  reserveNestedFallbackBudget
} from "./debug-api-reference-shape.mjs";

const repoRoot = resolve(import.meta.dirname, "..", "..");
const reference = readFileSync(resolve(repoRoot, "docs/public/DEBUG_API_COMMANDS.md"), "utf8");
const sourceDebugSchema = JSON.parse(readFileSync(resolve(repoRoot, "schemas/debug.json"), "utf8")) as {
  argEnums?: Record<string, unknown>;
  contracts: Array<{ command: string; argsSchema?: unknown }>;
};

function commandSection(command: string): string {
  const start = reference.indexOf(`### \`${command}\``);
  expect(start, `generated reference section for ${command}`).toBeGreaterThanOrEqual(0);
  const end = reference.indexOf("\n### `", start + 1);
  return reference.slice(start, end === -1 ? reference.length : end);
}

function nestedSummary(command: string): string {
  const section = commandSection(command);
  const start = section.indexOf("#### Nested contract shape summary");
  expect(start, `nested summary for ${command}`).toBeGreaterThanOrEqual(0);
  return section.slice(start);
}

function canonicalSource(block: string): { command: string; href: string; pointer: string } {
  const match = block.match(
    /Canonical JSON Pointer: \[schemas\/debug\.json#(\/[^\]]+)\]\(([^)]+)\) \(command ("(?:[^"\\]|\\.)*")\)\./
  );
  expect(match, "canonical JSON Pointer and href").not.toBeNull();
  return { command: JSON.parse(match![3]), href: match![2], pointer: match![1] };
}

function resolveJsonPointer(document: unknown, pointer: string): unknown {
  expect(pointer.startsWith("/")).toBe(true);
  let current = document as Record<string, unknown>;
  for (const encoded of pointer.slice(1).split("/")) {
    const key = decodeURIComponent(encoded).replaceAll("~1", "/").replaceAll("~0", "~");
    expect(Object.hasOwn(current, key), `JSON Pointer segment ${key}`).toBe(true);
    current = current[key] as Record<string, unknown>;
  }
  return current;
}

const nestedCandidates = sourceDebugSchema.contracts.filter((contract) => (
  contract.argsSchema !== undefined && isNestedContractCandidate(contract.argsSchema)
));

describe("generated Debug API nested shape summaries", () => {
  it("covers every pre-enumerated current candidate exactly once with a unique, resolvable command and pointer", () => {
    // This is deliberately a current-contract assertion: if schema authors add a nested contract,
    // the generator must add a block (descriptive or explicit fallback) rather than hide it after
    // the global budget is spent.
    expect(nestedCandidates).toHaveLength(72);
    expect(new Set(nestedCandidates.map((contract) => contract.command)).size).toBe(nestedCandidates.length);
    expect((reference.match(/^#### Nested contract shape summary$/gm) ?? [])).toHaveLength(nestedCandidates.length);

    const seen = new Set<string>();
    let bytes = 0;
    let nodes = 0;
    for (const contract of nestedCandidates) {
      const block = nestedSummary(contract.command);
      const source = canonicalSource(block);
      expect(source.command).toBe(contract.command);
      expect(source.href).toBe(`../../schemas/debug.json#${source.pointer}`);
      expect(resolveJsonPointer(sourceDebugSchema, source.pointer)).toBe(contract.argsSchema);
      expect(seen.has(`${source.command}|${source.pointer}`)).toBe(false);
      seen.add(`${source.command}|${source.pointer}`);
      bytes += Buffer.byteLength(`${block}\n`, "utf8");
      nodes += block.split("\n").length;
      for (const line of block.split("\n")) {
        expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(NESTED_SHAPE_LIMITS.maxSummaryLineBytes);
      }
    }
    expect(bytes).toBeLessThanOrEqual(NESTED_SHAPE_DOCUMENT_LIMITS.maxBytes);
    expect(nodes).toBeLessThanOrEqual(NESTED_SHAPE_DOCUMENT_LIMITS.maxNodes);
  });

  it("states root exact-input alternatives separately from overlapping nested candidate-success unions", () => {
    const scriptToCut = nestedSummary("motion.connector.script_to_cut");
    const relationActions = nestedSummary("motion.timeline.relation-actions.upsert");
    expect(scriptToCut).toContain("root oneOf: 3 top-level alternative(s); exactly one declared input alternative is required (exact input-count semantics).");
    expect(scriptToCut).not.toContain("nested oneOf:");
    expect(relationActions).toContain("nested oneOf: 2 branch(es); production accepts any candidate-success branch.");

    const nestedOverlap = describeNestedContractShape({
      type: "object",
      properties: {
        payload: {
          type: "object",
          oneOf: [
            { type: "object", required: ["id"], additionalProperties: false, properties: { id: { type: "string" } } },
            { type: "object", required: ["id"], additionalProperties: false, properties: { id: { type: "string" } } }
          ]
        }
      }
    });
    expect(nestedOverlap).toMatchObject({ kind: "summary" });
    if (nestedOverlap.kind === "summary") {
      expect(nestedOverlap.lines.join("\n")).toContain("nested oneOf: 2 branch(es); production accepts any candidate-success branch.");
      expect(nestedOverlap.lines.join("\n")).not.toContain("exact input-count semantics");
    }

    const rootExact = describeNestedContractShape({
      type: "object",
      properties: { outDir: { type: "string" } },
      oneOf: [
        { type: "object", required: ["script"], additionalProperties: true, properties: { script: { type: "string" } } },
        { type: "object", required: ["storyboard"], additionalProperties: true, properties: { storyboard: { type: "string" } } }
      ]
    });
    expect(rootExact).toMatchObject({ kind: "summary" });
    if (rootExact.kind === "summary") {
      expect(rootExact.lines.join("\n")).toContain("root oneOf: 2 top-level alternative(s); exactly one declared input alternative is required (exact input-count semantics).");
      expect(rootExact.lines.join("\n")).not.toContain("nested oneOf:");
    }
  });

  it("keeps required alias semantics explicit while remaining descriptive-only", () => {
    const catalog = nestedSummary("motion.template.catalog");
    const plan = nestedSummary("motion.template.plan");
    expect(catalog).toContain('accepted aliases ["templatesRoot", "root"]');
    expect(plan).toContain('required: "request" (also satisfied by production prose alias "prompt")');
    expect(reference).not.toContain("Complete executable JSON Schema projection");
    expect(reference).not.toContain("```json");
    for (const command of [
      "motion.timeline.checkpoint-storyboard.create",
      "motion.timeline.relations.upsert",
      "motion.timeline.relation-actions.upsert",
      "motion.timeline.relation-actions.apply"
    ]) {
      expect(nestedSummary(command)).toContain("**Descriptive only — not executable and not a request validator.**");
    }
  });

  it("uses an allowlist and falls back for unsupported or internally inconsistent metadata", () => {
    for (const keyword of [
      "$ref", "not", "if", "then", "else", "dependentRequired", "dependentSchemas", "format",
      "allOf", "anyOf", "uniqueItems", "exclusiveMaximum", "minProperties", "const"
    ]) {
      const schema = { type: "object", properties: { nested: { type: "string", [keyword]: [] } } };
      expect(isNestedContractCandidate(schema)).toBe(true);
      expect(describeNestedContractShape(schema)).toMatchObject({ kind: "fallback", reason: "unsupported_keyword" });
    }
    expect(describeNestedContractShape({ type: "object", properties: { nested: true } }))
      .toMatchObject({ kind: "fallback", reason: "unsupported_boolean_or_noncanonical_schema" });
    expect(describeNestedContractShape({ type: "object", properties: { nested: { type: ["string", "null"] } } }))
      .toMatchObject({ kind: "fallback", reason: "unsupported_null_type" });
    expect(describeNestedContractShape({
      type: "object",
      properties: {
        nested: { type: "object", additionalProperties: false, required: ["missing"], properties: {} }
      }
    })).toMatchObject({ kind: "fallback", reason: "inconsistent_closed_object" });
    expect(describeNestedContractShape({
      type: "object",
      properties: {
        nested: {
          type: "object",
          properties: { primary: { type: "string", aliases: ["other"] }, other: { type: "string" } }
        }
      }
    })).toMatchObject({ kind: "fallback", reason: "alias_collision" });
  });

  it("preserves supported production bounds and refuses oversized or deep canonical metadata before rendering", () => {
    const bounded = describeNestedContractShape({
      type: "object",
      properties: {
        nested: { type: "object", maxProperties: 2, properties: { id: { type: "string" } } }
      }
    });
    expect(bounded).toMatchObject({ kind: "summary" });
    if (bounded.kind === "summary") expect(bounded.lines.join("\n")).toContain("maxProperties=2");

    // The helper accepts only values produced from the repository's bounded JSON file. These
    // ordinary JSON-shaped hostile cases still prove it refuses caps/depth rather than eliding a
    // partial branch after materializing it.
    const oversized = JSON.parse(JSON.stringify({
      type: "object",
      properties: {
        nested: { type: "string", enum: Array.from({ length: NESTED_SHAPE_LIMITS.maxEnumValues + 1 }, () => "x") }
      }
    }));
    expect(describeNestedContractShape(oversized)).toMatchObject({ kind: "fallback", reason: "enum_cap" });

    const deep: Record<string, unknown> = { type: "object", properties: {} };
    let cursor = deep;
    for (let index = 0; index < NESTED_SHAPE_LIMITS.maxDepth + 2; index += 1) {
      const child: Record<string, unknown> = { type: "object", properties: {} };
      (cursor.properties as Record<string, unknown>)[`step${index}`] = child;
      cursor = child;
    }
    expect(describeNestedContractShape(JSON.parse(JSON.stringify(deep))))
      .toMatchObject({ kind: "fallback", reason: "depth_cap" });
  });

  it("fails loudly when reserved fallbacks alone exceed the declared global cap", () => {
    expect(() => reserveNestedFallbackBudget(
      [{ bytes: 12, nodes: 2 }, { bytes: 12, nodes: 2 }],
      { maxBytes: 23, maxNodes: 4 }
    )).toThrow("fallback reservation");
    expect(reserveNestedFallbackBudget(
      [{ bytes: 12, nodes: 2 }, { bytes: 12, nodes: 2 }],
      { maxBytes: 24, maxNodes: 4 }
    )).toEqual({ bytes: 24, nodes: 4 });

    const generator = readFileSync(resolve(repoRoot, "scripts/public/generate-debug-api-reference.mjs"), "utf8");
    expect(generator).toContain("reserveNestedFallbackBudget");
    expect(generator).toContain("selected.size !== plans.length");
    expect(generator).toContain("MAX_DEBUG_SCHEMA_SOURCE_BYTES");
  });

  it("renders nested strings through deterministic JSON literals, not inline Markdown interpolation", () => {
    const escaped = describeNestedContractShape({
      type: "object",
      properties: {
        nested: {
          type: "object",
          properties: { "line\n`control\u0001": { type: "string", enum: ["one\n`two\u0002"] } }
        },
        "path\n`control\u0003": { type: "object", properties: {} }
      }
    });
    expect(escaped).toMatchObject({ kind: "summary" });
    if (escaped.kind === "summary") {
      const rendered = escaped.lines.join("\n");
      expect(rendered).toContain('"line\\n`control\\u0001"');
      expect(rendered).toContain('"one\\n`two\\u0002"');
      expect(rendered).toContain('args["path\\n`control\\u0003"]');
      expect(rendered).not.toContain("\u0001");
      expect(rendered).not.toContain("\u0002");
      expect(rendered).not.toContain("\u0003");
    }
  });
});
