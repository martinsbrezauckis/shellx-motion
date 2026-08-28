import {
  MAX_BATCH_QUALITY_ROWS,
  MAX_MOTION_DATA_ROW_BYTES,
  MAX_MOTION_DATA_ROW_FIELD_BYTES,
  MAX_MOTION_DATA_ROW_FIELDS,
  MAX_MOTION_DATA_ROW_NESTING,
  MAX_MOTION_DATA_ROW_VALUES
} from "./data-file-load";
import { assertSafeMotionDataRowKey } from "./data-resource-bounds";

const MAX_NON_ROW_JSON_NESTING = 64;
const MAX_JSON_STRING_SOURCE_BYTES_FACTOR = 6;

interface LexicalRowBudget {
  fieldCount: number;
  valueCount: number;
  stringBytes: number;
}

/**
 * Performs a lexical pass before JSON.parse. It never builds the row array: element 257 is refused
 * at its opening byte, and each retained row is constrained before JSON.parse can materialize it.
 */
export function assertBoundedMotionDataRowsJsonText(input: string): void {
  new MotionDataJsonScanner(input).scanDocument();
}

class MotionDataJsonScanner {
  private index = 0;

  constructor(private readonly text: string) {}

  scanDocument(): void {
    this.skipWhitespace();
    if (this.peek() === "[") this.scanRowsArray();
    else if (this.peek() === "{") this.scanRootObject();
    else return;
    this.skipWhitespace();
  }

  private scanRootObject(): void {
    this.expect("{");
    this.skipWhitespace();
    let foundRows = false;
    const wrapperBudget: LexicalRowBudget = { fieldCount: 0, valueCount: 0, stringBytes: 0 };
    if (this.consume("}")) return;
    while (true) {
      const key = this.scanString(MAX_MOTION_DATA_ROW_FIELD_BYTES, "root key");
      this.skipWhitespace();
      this.expect(":");
      this.skipWhitespace();
      if (key === "rows") {
        if (foundRows) throw new Error("Motion data rows JSON must not define rows more than once.");
        foundRows = true;
        this.scanRowsArray();
      } else {
        this.chargeGenericField(key, `ignored wrapper.${key}`, wrapperBudget);
        this.scanGenericValue(wrapperBudget, 0, `ignored wrapper.${key}`);
      }
      this.skipWhitespace();
      if (this.consume("}")) return;
      this.expect(",");
      this.skipWhitespace();
    }
  }

  private scanRowsArray(): void {
    this.expect("[");
    this.skipWhitespace();
    if (this.consume("]")) return;
    let rowCount = 0;
    while (true) {
      rowCount += 1;
      if (rowCount > MAX_BATCH_QUALITY_ROWS) {
        throw new Error(`Motion data rows must contain at most ${MAX_BATCH_QUALITY_ROWS} rows.`);
      }
      this.scanBoundedRowValue({ fieldCount: 0, valueCount: 0, stringBytes: 0 }, 0, `row ${rowCount}`);
      this.skipWhitespace();
      if (this.consume("]")) return;
      this.expect(",");
      this.skipWhitespace();
    }
  }

  private scanBoundedRowValue(budget: LexicalRowBudget, depth: number, path: string): void {
    if (depth > MAX_MOTION_DATA_ROW_NESTING) {
      throw new Error(`Motion data row ${path} exceeds the ${MAX_MOTION_DATA_ROW_NESTING}-level nesting limit.`);
    }
    budget.valueCount += 1;
    if (budget.valueCount > MAX_MOTION_DATA_ROW_VALUES) {
      throw new Error(`Motion data row ${path} exceeds the ${MAX_MOTION_DATA_ROW_VALUES}-value limit.`);
    }
    this.skipWhitespace();
    const character = this.peek();
    if (character === "\"") {
      const value = this.scanString(MAX_MOTION_DATA_ROW_FIELD_BYTES, path);
      this.chargeLexicalString(value, path, budget);
      return;
    }
    if (character === "{") {
      this.expect("{");
      this.skipWhitespace();
      if (this.consume("}")) return;
      while (true) {
        const key = this.scanString(MAX_MOTION_DATA_ROW_FIELD_BYTES, path);
        assertSafeMotionDataRowKey(key, `${path}.${key}`);
        budget.fieldCount += 1;
        if (budget.fieldCount > MAX_MOTION_DATA_ROW_FIELDS) {
          throw new Error(`Motion data row ${path} exceeds the ${MAX_MOTION_DATA_ROW_FIELDS}-field limit.`);
        }
        this.chargeLexicalString(key, `${path}.${key}`, budget);
        this.skipWhitespace();
        this.expect(":");
        this.scanBoundedRowValue(budget, depth + 1, `${path}.${key}`);
        this.skipWhitespace();
        if (this.consume("}")) return;
        this.expect(",");
        this.skipWhitespace();
      }
    }
    if (character === "[") {
      this.expect("[");
      this.skipWhitespace();
      if (this.consume("]")) return;
      let arrayIndex = 0;
      while (true) {
        this.scanBoundedRowValue(budget, depth + 1, `${path}[${arrayIndex}]`);
        arrayIndex += 1;
        this.skipWhitespace();
        if (this.consume("]")) return;
        this.expect(",");
        this.skipWhitespace();
      }
    }
    this.scanPrimitive();
  }

  private chargeLexicalString(value: string, path: string, budget: LexicalRowBudget): void {
    const bytes = Buffer.byteLength(value, "utf8");
    if (bytes > MAX_MOTION_DATA_ROW_FIELD_BYTES) {
      throw new Error(`Motion data row ${path} exceeds the ${MAX_MOTION_DATA_ROW_FIELD_BYTES}-byte field limit.`);
    }
    budget.stringBytes += bytes;
    if (budget.stringBytes > MAX_MOTION_DATA_ROW_BYTES) {
      throw new Error(`Motion data row ${path} exceeds the ${MAX_MOTION_DATA_ROW_BYTES}-byte total value limit.`);
    }
  }

  private chargeGenericField(key: string, path: string, budget: LexicalRowBudget): void {
    budget.fieldCount += 1;
    if (budget.fieldCount > MAX_MOTION_DATA_ROW_FIELDS) {
      throw new Error(`Motion data rows JSON ${path} exceeds the ${MAX_MOTION_DATA_ROW_FIELDS}-field limit.`);
    }
    this.chargeGenericString(key, path, budget);
  }

  private chargeGenericString(value: string, path: string, budget: LexicalRowBudget): void {
    const bytes = Buffer.byteLength(value, "utf8");
    if (bytes > MAX_MOTION_DATA_ROW_FIELD_BYTES) {
      throw new Error(`Motion data rows JSON ${path} exceeds the ${MAX_MOTION_DATA_ROW_FIELD_BYTES}-byte field limit.`);
    }
    budget.stringBytes += bytes;
    if (budget.stringBytes > MAX_MOTION_DATA_ROW_BYTES) {
      throw new Error(`Motion data rows JSON ${path} exceeds the ${MAX_MOTION_DATA_ROW_BYTES}-byte total value limit.`);
    }
  }

  private scanGenericValue(budget: LexicalRowBudget, depth: number, path: string): void {
    if (depth > MAX_NON_ROW_JSON_NESTING) throw new Error("Motion data rows JSON has excessive non-row nesting.");
    budget.valueCount += 1;
    if (budget.valueCount > MAX_MOTION_DATA_ROW_VALUES) {
      throw new Error(`Motion data rows JSON ${path} exceeds the ${MAX_MOTION_DATA_ROW_VALUES}-value limit.`);
    }
    this.skipWhitespace();
    const character = this.peek();
    if (character === "\"") {
      this.chargeGenericString(this.scanString(MAX_MOTION_DATA_ROW_FIELD_BYTES, path), path, budget);
      return;
    }
    if (character === "{") {
      this.expect("{"); this.skipWhitespace(); if (this.consume("}")) return;
      while (true) {
        const key = this.scanString(MAX_MOTION_DATA_ROW_FIELD_BYTES, path);
        this.chargeGenericField(key, `${path}.${key}`, budget);
        this.skipWhitespace(); this.expect(":");
        this.scanGenericValue(budget, depth + 1, `${path}.${key}`); this.skipWhitespace();
        if (this.consume("}")) return;
        this.expect(","); this.skipWhitespace();
      }
    }
    if (character === "[") {
      this.expect("["); this.skipWhitespace(); if (this.consume("]")) return;
      while (true) {
        this.scanGenericValue(budget, depth + 1, path); this.skipWhitespace();
        if (this.consume("]")) return;
        this.expect(","); this.skipWhitespace();
      }
    }
    this.scanPrimitive();
  }

  private scanPrimitive(): void {
    const start = this.index;
    while (this.index < this.text.length && !/[\s,\]\}]/.test(this.text[this.index])) this.index += 1;
    if (this.index === start) throw new Error("Motion data rows JSON contains an invalid value.");
  }

  private scanString(limit: number | undefined, path: string): string {
    this.skipWhitespace();
    const start = this.index;
    this.expect("\"");
    let sourceBytes = 0;
    while (this.index < this.text.length) {
      const character = this.text[this.index];
      if (character === "\"") {
        this.index += 1;
        const source = this.text.slice(start, this.index);
        let value: unknown;
        try { value = JSON.parse(source); } catch { throw new Error(`Motion data rows JSON contains an invalid string at ${path}.`); }
        if (typeof value !== "string") throw new Error(`Motion data rows JSON contains an invalid string at ${path}.`);
        if (limit !== undefined && Buffer.byteLength(value, "utf8") > limit) {
          throw new Error(`Motion data row ${path} exceeds the ${limit}-byte field limit.`);
        }
        return value;
      }
      if (character === "\\") {
        sourceBytes += 1;
        this.index += 1;
        if (this.index >= this.text.length) break;
        sourceBytes += Buffer.byteLength(this.text[this.index], "utf8");
        this.index += 1;
      } else {
        sourceBytes += Buffer.byteLength(character, "utf8");
        this.index += 1;
      }
      // A JSON escape can use at most six source bytes for one decoded byte. This keeps the
      // lexical pass bounded without rejecting a valid field merely because it was escaped.
      if (limit !== undefined && sourceBytes > limit * MAX_JSON_STRING_SOURCE_BYTES_FACTOR) {
        throw new Error(`Motion data row ${path} exceeds the ${limit}-byte field limit.`);
      }
    }
    throw new Error(`Motion data rows JSON contains an unterminated string at ${path}.`);
  }

  private skipWhitespace(): void {
    while (this.index < this.text.length && /\s/.test(this.text[this.index])) this.index += 1;
  }

  private expect(character: string): void {
    if (!this.consume(character)) throw new Error(`Motion data rows JSON expected ${JSON.stringify(character)}.`);
  }

  private consume(character: string): boolean {
    if (this.text[this.index] !== character) return false;
    this.index += 1;
    return true;
  }

  private peek(): string | undefined { return this.text[this.index]; }
}
