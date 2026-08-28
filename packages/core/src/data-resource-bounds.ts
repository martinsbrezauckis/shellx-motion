import {
  MAX_MOTION_DATA_ROW_BYTES,
  MAX_MOTION_DATA_ROW_FIELD_BYTES,
  MAX_MOTION_DATA_ROW_FIELDS,
  MAX_MOTION_DATA_ROW_ID_BYTES,
  MAX_MOTION_DATA_ROW_NESTING,
  MAX_MOTION_DATA_ROW_VALUES,
  MAX_MOTION_INTERPOLATED_BATCH_BYTES,
  MAX_MOTION_INTERPOLATED_DOCUMENT_BYTES,
  MAX_MOTION_INTERPOLATED_ROW_BYTES,
  MAX_MOTION_INTERPOLATED_STRING_BYTES
} from "./data-file-load";

const FORBIDDEN_PROTOTYPE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

interface RowValueBudget {
  fieldCount: number;
  valueCount: number;
  stringBytes: number;
  parents: object[];
}

/** Reject property names that could alter object prototypes in a later merge. */
export function assertSafeMotionDataRowKey(key: string, path: string): void {
  if (FORBIDDEN_PROTOTYPE_KEYS.has(key)) {
    throw new Error(`Motion data row ${path} must not use prototype-sensitive key ${JSON.stringify(key)}.`);
  }
  if (Buffer.byteLength(key, "utf8") > MAX_MOTION_DATA_ROW_FIELD_BYTES) {
    throw new Error(`Motion data row ${path} exceeds the ${MAX_MOTION_DATA_ROW_FIELD_BYTES}-byte field limit.`);
  }
}

/** Validate a decoded row before it is copied, hashed, or supplied to interpolation. */
export function assertBoundedMotionDataRowValue(value: unknown, rowIndex: number): void {
  const budget: RowValueBudget = { fieldCount: 0, valueCount: 0, stringBytes: 0, parents: [] };
  visitRowValue(value, `row ${rowIndex + 1}`, 0, budget);
}

/** Row ids become package and receipt path components, so bound both source and normalized values. */
export function assertBoundedMotionDataRowId(value: string, rowIndex: number): void {
  if (Buffer.byteLength(value, "utf8") > MAX_MOTION_DATA_ROW_ID_BYTES) {
    throw new Error(`Motion data row ${rowIndex + 1} id exceeds the ${MAX_MOTION_DATA_ROW_ID_BYTES}-byte limit.`);
  }
}

/** Every replacement string is charged before String#replace allocates its output. */
export function assertBoundedMotionInterpolatedString(value: string, rowId: string, path: string): void {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > MAX_MOTION_INTERPOLATED_STRING_BYTES) {
    throw new Error(`Motion data row ${rowId} interpolation ${path} exceeds the ${MAX_MOTION_INTERPOLATED_STRING_BYTES}-byte string limit.`);
  }
}

/** Tracks exact JSON byte work before generated packages or receipts are serialized. */
export class MotionDataExpansionBudget {
  private aggregateBytes = 0;

  assertDocument(value: unknown, rowId: string): void {
    measureJsonBytes(value, MAX_MOTION_INTERPOLATED_DOCUMENT_BYTES, `Motion data row ${rowId} interpolated document`, rowId);
  }

  reserveRow(value: unknown, rowId: string): void {
    const bytes = measureJsonBytes(value, MAX_MOTION_INTERPOLATED_ROW_BYTES, `Motion data row ${rowId} expanded row`, rowId);
    if (this.aggregateBytes + bytes > MAX_MOTION_INTERPOLATED_BATCH_BYTES) {
      throw new Error(`Motion batch interpolation exceeds the ${MAX_MOTION_INTERPOLATED_BATCH_BYTES}-byte aggregate limit before package fan-out.`);
    }
    this.aggregateBytes += bytes;
  }
}

function visitRowValue(value: unknown, path: string, depth: number, budget: RowValueBudget): void {
  if (depth > MAX_MOTION_DATA_ROW_NESTING) throw new Error(`Motion data row ${path} exceeds the ${MAX_MOTION_DATA_ROW_NESTING}-level nesting limit.`);
  budget.valueCount += 1;
  if (budget.valueCount > MAX_MOTION_DATA_ROW_VALUES) throw new Error(`Motion data row ${path} exceeds the ${MAX_MOTION_DATA_ROW_VALUES}-value limit.`);
  if (typeof value === "string") return chargeRowString(value, path, budget);
  if (value === null || typeof value === "boolean" || typeof value === "number") return;
  if (typeof value !== "object") throw new Error(`Motion data row ${path} must contain JSON values only.`);
  if (budget.parents.includes(value)) throw new Error(`Motion data row ${path} must not contain cycles.`);
  budget.parents.push(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) visitRowValue(value[index], `${path}[${index}]`, depth + 1, budget);
      return;
    }
    for (const key of Object.keys(value)) {
      assertSafeMotionDataRowKey(key, `${path}.${key}`);
      budget.fieldCount += 1;
      if (budget.fieldCount > MAX_MOTION_DATA_ROW_FIELDS) throw new Error(`Motion data row ${path} exceeds the ${MAX_MOTION_DATA_ROW_FIELDS}-field limit.`);
      chargeRowString(key, `${path}.${key}`, budget);
      visitRowValue((value as Record<string, unknown>)[key], `${path}.${key}`, depth + 1, budget);
    }
  } finally {
    budget.parents.pop();
  }
}

function chargeRowString(value: string, path: string, budget: RowValueBudget): void {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > MAX_MOTION_DATA_ROW_FIELD_BYTES) throw new Error(`Motion data row ${path} exceeds the ${MAX_MOTION_DATA_ROW_FIELD_BYTES}-byte field limit.`);
  budget.stringBytes += bytes;
  if (budget.stringBytes > MAX_MOTION_DATA_ROW_BYTES) throw new Error(`Motion data row ${path} exceeds the ${MAX_MOTION_DATA_ROW_BYTES}-byte total value limit.`);
}

function measureJsonBytes(value: unknown, limit: number, label: string, rowId: string): number {
  const state = { bytes: 0, parents: [] as object[] };
  const charge = (bytes: number): void => {
    state.bytes += bytes;
    if (state.bytes > limit) throw new Error(`${label} exceeds the ${limit}-byte limit before serialization.`);
  };
  const visit = (entry: unknown, path: string): void => {
    if (entry === null) return charge(4);
    if (typeof entry === "string") {
      assertBoundedMotionInterpolatedString(entry, rowId, path);
      return charge(Buffer.byteLength(JSON.stringify(entry), "utf8"));
    }
    if (typeof entry === "boolean") return charge(entry ? 4 : 5);
    if (typeof entry === "number") return charge(Buffer.byteLength(Number.isFinite(entry) ? JSON.stringify(entry) : "null", "utf8"));
    if (typeof entry === "bigint") throw new Error(`${label} contains a bigint and cannot be serialized.`);
    if (entry === undefined || typeof entry === "function" || typeof entry === "symbol") return charge(4);
    if (typeof entry !== "object") throw new Error(`${label} contains an unsupported value at ${path}.`);
    if (state.parents.includes(entry)) throw new Error(`${label} contains a cycle at ${path}.`);
    const parents = [...state.parents, entry];
    const children = Array.isArray(entry) ? entry : Object.keys(entry)
      .filter((key) => {
        const child = (entry as Record<string, unknown>)[key];
        return child !== undefined && typeof child !== "function" && typeof child !== "symbol";
      })
      .map((key) => [key, (entry as Record<string, unknown>)[key]] as const);
    charge(1);
    for (let index = 0; index < children.length; index += 1) {
      if (index > 0) charge(1);
      if (!Array.isArray(entry)) charge(Buffer.byteLength(JSON.stringify(children[index][0]), "utf8") + 1);
      const previousParents = state.parents;
      state.parents = parents;
      visit(Array.isArray(entry) ? children[index] : children[index][1], `${path}[${index}]`);
      state.parents = previousParents;
    }
    charge(1);
  };
  visit(value, "$");
  return state.bytes;
}
