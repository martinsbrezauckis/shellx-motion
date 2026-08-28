import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  expandMotionPackageRows,
  MAX_BATCH_QUALITY_ROWS,
  MAX_MOTION_DATA_ROW_BYTES,
  MAX_MOTION_DATA_ROW_FIELD_BYTES,
  MAX_MOTION_DATA_ROW_FIELDS,
  MAX_MOTION_DATA_ROW_ID_BYTES,
  MAX_MOTION_DATA_ROW_NESTING,
  MAX_MOTION_DATA_ROW_VALUES,
  parseMotionDataRows,
  parseMotionDataRowsCsv,
  parseMotionDataRowsText,
  type MotionPackage
} from "./index";
import { MotionDataExpansionBudget } from "./data-resource-bounds";

describe("motion data resource bounds", () => {
  it("admits the shipped Product Metric row through both JSON routes and refuses the shared field ceiling", () => {
    const text = readFileSync(PRODUCT_METRIC_ROWS_PATH, "utf8");
    const decoded = JSON.parse(text) as { rows: unknown[] };
    expect(objectFieldCount(decoded.rows[2])).toBe(150);
    expect(MAX_MOTION_DATA_ROW_FIELDS).toBe(160);

    // `parseMotionDataRowsText` runs the lexical scanner before JSON.parse; direct callers
    // use the decoded-value path. The same shipped payload must be admitted by both.
    expect(parseMotionDataRowsText(text)).toEqual(parseMotionDataRows(decoded));

    const hostile = Object.fromEntries(Array.from(
      { length: MAX_MOTION_DATA_ROW_FIELDS + 1 },
      (_, index) => [`field${index}`, index]
    ));
    const expected = `${MAX_MOTION_DATA_ROW_FIELDS}-field limit`;
    expect(() => parseMotionDataRowsText(JSON.stringify({ rows: [hostile] }))).toThrow(expected);
    expect(() => parseMotionDataRows({ rows: [hostile] })).toThrow(expected);
  });

  it("stops compact JSON and CSV input at row 257 before parsing or retaining the extra row", () => {
    const compactRows = Array.from({ length: MAX_BATCH_QUALITY_ROWS }, (_, index) => `{"id":"r${index}"}`);
    // The invalid 257th JSON element proves the lexical guard refuses on the row boundary, before
    // JSON.parse would inspect or materialize that element.
    expect(() => parseMotionDataRowsText(`[${compactRows.join(",")},invalid-257]`))
      .toThrow(`Motion data rows must contain at most ${MAX_BATCH_QUALITY_ROWS} rows.`);
    expect(() => parseMotionDataRowsCsv(["id", ...compactRows.map((_, index) => `r${index}`), "overflow"].join("\n")))
      .toThrow(`Motion data rows must contain at most ${MAX_BATCH_QUALITY_ROWS} rows.`);
  });

  it("bounds ignored JSON wrapper members before JSON.parse while admitting ordinary metadata", () => {
    const wrapped = JSON.stringify({
      schema: "shellx-motion/data-rows@1",
      source: { campaign: "autumn", labels: ["launch", "social"] },
      rows: [{ id: "ada", title: "Ada Lovelace" }]
    });
    expect(parseMotionDataRowsText(wrapped)).toMatchObject([{ id: "ada", values: { title: "Ada Lovelace" } }]);

    const tooManyWrapperFields = Array.from(
      { length: MAX_MOTION_DATA_ROW_FIELDS },
      (_, index) => `"field${index}":0`
    ).join(",");
    // The invalid rows value is never inspected: this is a lexical pre-JSON.parse refusal.
    expect(() => parseMotionDataRowsText(`{"metadata":{${tooManyWrapperFields}},"rows":[invalid]}`))
      .toThrow(`${MAX_MOTION_DATA_ROW_FIELDS}-field limit`);

    const tooManyWrapperValues = Array.from({ length: MAX_MOTION_DATA_ROW_VALUES + 1 }, () => "0").join(",");
    expect(() => parseMotionDataRowsText(`{"metadata":[${tooManyWrapperValues}],"rows":[{"id":"unreached"}]}`))
      .toThrow(`${MAX_MOTION_DATA_ROW_VALUES}-value limit`);

    const wrapperStringsOverBudget = Array.from(
      { length: 17 },
      (_, index) => `"field${index}":"${"x".repeat(MAX_MOTION_DATA_ROW_FIELD_BYTES)}"`
    ).join(",");
    expect(() => parseMotionDataRowsText(`{"metadata":{${wrapperStringsOverBudget}},"rows":[{"id":"unreached"}]}`))
      .toThrow(`${MAX_MOTION_DATA_ROW_BYTES}-byte total value limit`);
  });

  it("bounds CSV header allocation at the shared field ceiling and admits a complete ceiling-width row", () => {
    const headers = ["id", ...Array.from({ length: MAX_MOTION_DATA_ROW_FIELDS - 1 }, (_, index) => `field${index}`)];
    const values = ["ada", ...Array.from({ length: MAX_MOTION_DATA_ROW_FIELDS - 1 }, (_, index) => `value${index}`)];
    const [row] = parseMotionDataRowsCsv([headers.join(","), values.join(",")].join("\n"));
    expect(Object.keys(row.values)).toHaveLength(MAX_MOTION_DATA_ROW_FIELDS);
    expect(row.values).toMatchObject({ id: "ada", field0: "value0", field158: "value158" });

    const tooManyHeaders = Array.from({ length: MAX_MOTION_DATA_ROW_FIELDS + 1 }, (_, index) => `field${index}`).join(",");
    // The unterminated data record is never retained because the 161st header is refused first.
    expect(() => parseMotionDataRowsCsv(`${tooManyHeaders}\n"unterminated`))
      .toThrow(`${MAX_MOTION_DATA_ROW_FIELDS}-field limit`);
  });

  it("bounds fields, ids, nesting, and prototype-sensitive row keys before hashing", () => {
    const tooManyFields = Object.fromEntries(Array.from({ length: MAX_MOTION_DATA_ROW_FIELDS + 1 }, (_, index) => [`field${index}`, index]));
    expect(() => parseMotionDataRows({ rows: [tooManyFields] })).toThrow(`${MAX_MOTION_DATA_ROW_FIELDS}-field limit`);
    expect(() => parseMotionDataRows({ rows: [{ id: "x".repeat(MAX_MOTION_DATA_ROW_ID_BYTES + 1) }] })).toThrow(`${MAX_MOTION_DATA_ROW_ID_BYTES}-byte limit`);
    expect(() => parseMotionDataRows({ rows: [{ title: "x".repeat(MAX_MOTION_DATA_ROW_FIELD_BYTES + 1) }] })).toThrow(`${MAX_MOTION_DATA_ROW_FIELD_BYTES}-byte field limit`);
    expect(() => parseMotionDataRowsText('{"rows":[{"__proto__":"no"}]}')).toThrow(/prototype-sensitive key/);
    expect(() => parseMotionDataRowsCsv("id,constructor\nada,no\n")).toThrow(/prototype-sensitive key/);
    let nested: unknown = "leaf";
    for (let index = 0; index <= MAX_MOTION_DATA_ROW_NESTING; index += 1) nested = { next: nested };
    expect(() => parseMotionDataRows({ rows: [{ nested }] })).toThrow(`${MAX_MOTION_DATA_ROW_NESTING}-level nesting limit`);
  });

  it("refuses bounded input that would amplify strings or documents before fan-out", () => {
    const repeated = amplificationPackage(160, "{{copy}}");
    const rows = parseMotionDataRows({ rows: [{ id: "amplified", copy: "x".repeat(MAX_MOTION_DATA_ROW_FIELD_BYTES) }] });
    expect(() => expandMotionPackageRows(repeated, rows)).toThrow(/interpolated document exceeds.*before serialization/i);
    expect(() => expandMotionPackageRows(amplificationPackage(1, "{{copy}}{{copy}}{{copy}}{{copy}}{{copy}}"), rows)).toThrow(/string limit/);
  });

  it("reserves aggregate interpolation bytes before a caller can fan rows into output packages", () => {
    const budget = new MotionDataExpansionBudget();
    const boundedRow = Array.from({ length: 16 }, () => "x".repeat(64 * 1024));
    expect(() => {
      for (let index = 0; index < 33; index += 1) budget.reserveRow(boundedRow, `row-${index}`);
    }).toThrow(/aggregate limit before package fan-out/);
  });
});

const PRODUCT_METRIC_ROWS_PATH = resolve(
  fileURLToPath(import.meta.url),
  "../../../../templates/shellx-product-pack/product-metric-card/data/product-metrics.batch.json"
);

function objectFieldCount(value: unknown): number {
  if (value === null || typeof value !== "object") return 0;
  if (Array.isArray(value)) return value.reduce((total, item) => total + objectFieldCount(item), 0);
  return Object.values(value).reduce((total, item) => total + 1 + objectFieldCount(item), 0);
}

function amplificationPackage(layerCount: number, text: string): MotionPackage {
  return {
    root: "/fixture",
    manifest: {
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_amplification",
      name: "Amplification",
      motion: "motion.json",
      assets: [],
      sourceApp: "test",
      compatibility: { lanes: ["browser"], hosts: ["motion"] }
    },
    motion: {
      schema: "shellx-motion/motion@1",
      id: "motion_amplification",
      name: "Amplification",
      durationMs: 1000,
      fps: 30,
      width: 1920,
      height: 1080,
      layers: Array.from({ length: layerCount }, (_, index) => ({ id: `copy-${index}`, type: "text", text, startMs: 0, durationMs: 1000 })),
      assets: [],
      provenance: { sourceApp: "test", createdBy: "test" }
    }
  };
}
