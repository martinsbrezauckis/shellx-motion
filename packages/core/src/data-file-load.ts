import { readBoundedStableFile } from "./stable-file-read";

/** Row data drives expansion and receipts, so it remains a small control-plane input. */
export const MAX_MOTION_DATA_ROWS_BYTES = 16 * 1024 * 1024;

export async function readMotionDataRowsText(rowsPath: string, withinRoot?: string): Promise<string> {
  const snapshot = await readBoundedStableFile(rowsPath, {
    label: "Motion data rows",
    maxBytes: MAX_MOTION_DATA_ROWS_BYTES,
    ...(withinRoot ? { withinRoot } : {})
  });
  return snapshot.bytes.toString("utf8");
}
