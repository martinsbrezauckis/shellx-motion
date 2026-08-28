const GIB = 1024 * 1024 * 1024;

/** Other measured browser behavior used only as a conservative above-reference complexity factor. */
const MATERIALIZED_BROWSER_COMPLEXITY_OBSERVATIONS = Object.freeze({
  oneEnvironmentThreeSampleBlurPeakProcessTreeRssBytes: Math.round(4.40 * GIB),
  twoEnvironmentsNoBlurPeakProcessTreeRssBytes: Math.round(2.65 * GIB)
});

interface BrowserMaterializationReference {
  environmentLayerCount: number;
  maxMotionBlurSamples: number;
  peakProcessTreeRssBytes: number;
}

interface BrowserMaterializationComplexity {
  visibleEnvironmentLayerCount: number;
  maxMotionBlurSamples: number;
}

/**
 * Source-behavior upper factor for complexity above the two-environment, three-sample reference.
 * It never discounts simpler scenes and is intentionally not a substitute for future streaming.
 */
export function browserComplexityUpperFactor(
  reference: BrowserMaterializationReference,
  complexity: BrowserMaterializationComplexity
): number {
  const environmentStep = (reference.peakProcessTreeRssBytes / MATERIALIZED_BROWSER_COMPLEXITY_OBSERVATIONS.oneEnvironmentThreeSampleBlurPeakProcessTreeRssBytes) - 1;
  const blurStep = ((reference.peakProcessTreeRssBytes / MATERIALIZED_BROWSER_COMPLEXITY_OBSERVATIONS.twoEnvironmentsNoBlurPeakProcessTreeRssBytes) - 1)
    / (reference.maxMotionBlurSamples - 1);
  return 1
    + Math.max(0, complexity.visibleEnvironmentLayerCount - reference.environmentLayerCount) * environmentStep
    + Math.max(0, complexity.maxMotionBlurSamples - reference.maxMotionBlurSamples) * blurStep;
}
