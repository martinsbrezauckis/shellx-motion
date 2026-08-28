import {
  MAX_BATCH_QUALITY_ROWS,
  MAX_MOTION_DATA_ROW_FIELD_BYTES,
  MAX_MOTION_DATA_ROW_FIELDS
} from "./data-file-load";

/** Parse CSV incrementally enough to retain only the header plus 256 non-empty records. */
export function parseBoundedMotionDataRowsCsvRecords(input: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let fieldBytes = 0;
  let inQuotes = false;

  const append = (character: string): void => {
    // Code-unit accounting over-counts a surrogate pair but never under-counts its final UTF-8
    // payload, so rejection cannot admit an over-limit field.
    fieldBytes += Buffer.byteLength(character, "utf8");
    if (fieldBytes > MAX_MOTION_DATA_ROW_FIELD_BYTES) {
      throw new Error(`Motion CSV data row field exceeds the ${MAX_MOTION_DATA_ROW_FIELD_BYTES}-byte field limit.`);
    }
    field += character;
  };
  const closeField = (): void => {
    if (record.length >= MAX_MOTION_DATA_ROW_FIELDS) {
      throw new Error(`Motion CSV data row exceeds the ${MAX_MOTION_DATA_ROW_FIELDS}-field limit.`);
    }
    record.push(field);
    field = "";
    fieldBytes = 0;
  };
  const closeRecord = (): void => {
    closeField();
    if (!record.some((candidate) => candidate.length > 0)) {
      record = [];
      return;
    }
    if (records.length > 0 && records.length >= 1 + MAX_BATCH_QUALITY_ROWS) {
      throw new Error(`Motion data rows must contain at most ${MAX_BATCH_QUALITY_ROWS} rows.`);
    }
    records.push(record);
    record = [];
  };

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (inQuotes) {
      if (char === "\"") {
        if (input[index + 1] === "\"") {
          append("\"");
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        append(char);
      }
      continue;
    }
    if (char === "\"") {
      if (field.length !== 0) throw new Error("Motion CSV data rows contain an unexpected quote.");
      inQuotes = true;
      continue;
    }
    if (char === ",") {
      closeField();
      continue;
    }
    if (char === "\n" || char === "\r") {
      closeRecord();
      if (char === "\r" && input[index + 1] === "\n") index += 1;
      continue;
    }
    append(char);
  }
  if (inQuotes) throw new Error("Motion CSV data rows contain an unterminated quoted field.");
  if (field.length > 0 || record.length > 0 || input.endsWith(",")) closeRecord();
  return records;
}
