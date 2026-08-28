import { readBoundedStableFile } from "./stable-file-read";

/** Row data drives expansion and receipts, so it remains a small control-plane input. */
export const MAX_MOTION_DATA_ROWS_BYTES = 16 * 1024 * 1024;
export const MAX_BATCH_QUALITY_ROWS = 256;

/**
 * Data rows are control-plane input, not arbitrary documents.  These limits are deliberately
 * smaller than the file cap: a 16 MiB input is still safe to open, but one row must not turn into
 * an unbounded interpolation value that gets copied into every generated package and receipt.
 */
export const MAX_MOTION_DATA_ROW_ID_BYTES = 128;
export const MAX_MOTION_DATA_ROW_FIELD_BYTES = 16 * 1024;
// The shipped Product Metric Card square recipe has 150 nested object fields. Keep the
// lexical and decoded-value routes at one bounded 160-field ceiling rather than making the
// production recipe depend on a parser-specific exception.
export const MAX_MOTION_DATA_ROW_FIELDS = 160;
export const MAX_MOTION_DATA_ROW_VALUES = 512;
export const MAX_MOTION_DATA_ROW_NESTING = 16;
export const MAX_MOTION_DATA_ROW_BYTES = 256 * 1024;

/** Limits charged while expanding rows, before any generated package is written. */
export const MAX_MOTION_INTERPOLATED_STRING_BYTES = 64 * 1024;
export const MAX_MOTION_INTERPOLATED_DOCUMENT_BYTES = 2 * 1024 * 1024;
export const MAX_MOTION_INTERPOLATED_ROW_BYTES = 2_304 * 1024;
export const MAX_MOTION_INTERPOLATED_BATCH_BYTES = 32 * 1024 * 1024;

export function assertBoundedMotionDataRowCount(count: number): void {
  if (count > MAX_BATCH_QUALITY_ROWS) throw new Error(`Motion data rows must contain at most ${MAX_BATCH_QUALITY_ROWS} rows.`);
}

export async function readMotionDataRowsText(rowsPath: string, withinRoot?: string): Promise<string> {
  const snapshot = await readBoundedStableFile(rowsPath, {
    label: "Motion data rows",
    maxBytes: MAX_MOTION_DATA_ROWS_BYTES,
    ...(withinRoot ? { withinRoot } : {})
  });
  return snapshot.bytes.toString("utf8");
}
