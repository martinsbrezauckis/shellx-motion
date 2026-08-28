/** Closed text-runs@1 data types kept separate from the central document model. */
export interface MotionTextRun {
  text: string;
  fontAssetId: string;
  color?: string;
  fontSizePx?: number;
  letterSpacingPx?: number;
}

/** Ordered styled text content. It is mutually exclusive with legacy `text`. */
export interface MotionTextRuns {
  schema: "shellx-motion/text-runs@1";
  runs: readonly MotionTextRun[];
}
