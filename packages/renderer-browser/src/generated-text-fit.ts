/** Browser-side rendered-glyph text-fit checks, including styled text-runs scaling. */
import type { Page } from "playwright-core";
import type { MotionPackage } from "@shellx-motion/core";

export interface BrowserTextFitStyledRunEvidence {
  index: number;
  fontAssetId: string;
  inheritsLayerFontSize: boolean;
  requestedFontSizePx: number | null;
  effectiveFontSizePx: number;
  requestedLetterSpacingPx: number | null;
  effectiveLetterSpacingPx: number;
}

export interface BrowserTextFitEvidence {
  policy: "rendered-glyph-bounds";
  atMs: number;
  visibilityThreshold: 0.5;
  checkedLayerCount: number;
  uncheckedLayerIds: string[];
  allowedCropLayerIds: string[];
  autoFittedLayerIds: string[];
  failedLayerIds: string[];
  layers: Array<{
    layerId: string;
    policy: "safe" | "allow-crop" | "auto-fit";
    safeAreaId: string | null;
    status: "passed" | "allowed-crop" | "auto-fitted" | "failed";
    requestedFontSize: number;
    appliedFontSize: number;
    minFontSize: number | null;
    sampleCount: number;
    visibleSampleCount: number;
    internalOverflowPx: { horizontal: number; vertical: number };
    safeAreaOverflowPx: { top: number; right: number; bottom: number; left: number };
    /** Present only for text-runs@1, preserving legacy text-fit evidence bytes. */
    textRuns?: { scale: number; runs: BrowserTextFitStyledRunEvidence[] };
  }>;
}

export async function collectBrowserTextFitEvidence(page: Page, pkg: MotionPackage, atMs: number): Promise<BrowserTextFitEvidence> {
  const safeAreas = Object.fromEntries(Object.entries(pkg.motion.safeAreas ?? {}).map(([id, area]) => [id, {
    top: typeof area.top === "number" ? area.top : 0, right: typeof area.right === "number" ? area.right : 0,
    bottom: typeof area.bottom === "number" ? area.bottom : 0, left: typeof area.left === "number" ? area.left : 0
  }]));
  // Source-driven Playwright serialization needs this name shim; production bundles inline it.
  await page.evaluate("globalThis.__name = function(target) { return target; }");
  return page.evaluate(({ safeAreas, atMs }) => {
    type FitPolicy = "safe" | "allow-crop" | "auto-fit";
    type Overflow = { top: number; right: number; bottom: number; left: number };
    const round = (value: number) => Math.max(0, Number(value.toFixed(3)));
    const dataNumber = (value: string | undefined): number | null => {
      if (value === undefined || value.trim() === "") return null;
      const number = Number(value); return Number.isFinite(number) ? number : null;
    };
    const root = document.querySelector<HTMLElement>("main") ?? document.body;
    const rootRect = root.getBoundingClientRect();
    const elements = [...document.querySelectorAll<HTMLElement>("[data-motion-text='true']")];
    const uncheckedLayerIds = [...new Set(elements.filter((element) => element.dataset.textFitPolicy === "unchecked" || !element.dataset.textFitPolicy).map((element) => element.dataset.layerId ?? "<unknown>"))].sort();
    const groups = new Map<string, HTMLElement[]>();
    for (const element of elements) {
      const policy = element.dataset.textFitPolicy;
      if (policy !== "safe" && policy !== "allow-crop" && policy !== "auto-fit") continue;
      const layerId = element.dataset.layerId ?? "<unknown>", group = groups.get(layerId) ?? [];
      group.push(element); groups.set(layerId, group);
    }
    const ownVisible = (element: HTMLElement): boolean => {
      const style = getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") >= 0.5 && element.getClientRects().length > 0;
    };
    const glyphRect = (element: HTMLElement): DOMRect => {
      const target = element.querySelector("span") ?? element, range = document.createRange();
      range.selectNodeContents(target); const measured = range.getBoundingClientRect();
      return measured.width > 0 || measured.height > 0 ? measured : target.getBoundingClientRect();
    };
    const safeRect = (safeAreaId: string | null) => {
      const area = safeAreaId ? safeAreas[safeAreaId] : undefined;
      return { top: rootRect.top + (area?.top ?? 0), right: rootRect.right - (area?.right ?? 0), bottom: rootRect.bottom - (area?.bottom ?? 0), left: rootRect.left + (area?.left ?? 0) };
    };
    const measureElement = (element: HTMLElement, area: ReturnType<typeof safeRect>) => {
      const rect = glyphRect(element);
      return { internalHorizontal: round(element.scrollWidth - element.clientWidth), internalVertical: round(element.scrollHeight - element.clientHeight), safe: {
        top: round(area.top - rect.top), right: round(rect.right - area.right), bottom: round(rect.bottom - area.bottom), left: round(area.left - rect.left)
      } satisfies Overflow };
    };
    const maxOverflow = (measurements: ReturnType<typeof measureElement>[]) => measurements.reduce((max, current) => ({
      internalHorizontal: Math.max(max.internalHorizontal, current.internalHorizontal), internalVertical: Math.max(max.internalVertical, current.internalVertical),
      safe: { top: Math.max(max.safe.top, current.safe.top), right: Math.max(max.safe.right, current.safe.right), bottom: Math.max(max.safe.bottom, current.safe.bottom), left: Math.max(max.safe.left, current.safe.left) }
    }), { internalHorizontal: 0, internalVertical: 0, safe: { top: 0, right: 0, bottom: 0, left: 0 } });
    const fits = (measurement: ReturnType<typeof maxOverflow>): boolean => measurement.internalHorizontal <= 0.5 && measurement.internalVertical <= 0.5 && measurement.safe.top <= 0.5 && measurement.safe.right <= 0.5 && measurement.safe.bottom <= 0.5 && measurement.safe.left <= 0.5;
    const scaleRunOverrides = (element: HTMLElement, scale: number): void => {
      for (const run of element.querySelectorAll<HTMLElement>("[data-motion-text-run='true']")) {
        const fontSize = dataNumber(run.dataset.motionRunFontSizePx), letterSpacing = dataNumber(run.dataset.motionRunLetterSpacingPx);
        if (fontSize !== null) run.style.fontSize = `${fontSize * scale}px`;
        if (letterSpacing !== null) run.style.letterSpacing = `${letterSpacing * scale}px`;
      }
    };
    const styledRunEvidence = (element: HTMLElement, scale: number) => {
      const runs = [...element.querySelectorAll<HTMLElement>("[data-motion-text-run='true']")];
      if (runs.length === 0) return undefined;
      return { scale: round(scale), runs: runs.map((run, index) => {
        const requestedFontSizePx = dataNumber(run.dataset.motionRunFontSizePx), requestedLetterSpacingPx = dataNumber(run.dataset.motionRunLetterSpacingPx);
        const computed = getComputedStyle(run);
        return { index, fontAssetId: run.dataset.motionFontAssetId ?? "", inheritsLayerFontSize: requestedFontSizePx === null, requestedFontSizePx, effectiveFontSizePx: round(Number.parseFloat(computed.fontSize) || 0), requestedLetterSpacingPx, effectiveLetterSpacingPx: round(Number.parseFloat(computed.letterSpacing) || 0) };
      }) };
    };
    // Code-unit ordering is receipt-stable; localeCompare would vary with the browser host locale.
    const layers = [...groups.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([layerId, samples]) => {
      const first = samples[0]!, policy = first.dataset.textFitPolicy as FitPolicy, safeAreaId = first.dataset.textFitSafeArea || null, area = safeRect(safeAreaId);
      const visibleSamples = samples.filter(ownVisible);
      const requestedFontSizes = new Map(samples.map((element) => [element, Number.parseFloat(getComputedStyle(element).fontSize) || 0]));
      const requestedFontSize = Math.max(0, ...requestedFontSizes.values()), parsedMinFontSize = Number.parseFloat(first.dataset.textFitMinFontSize ?? "");
      const minFontSize = policy === "auto-fit" ? (Number.isFinite(parsedMinFontSize) ? parsedMinFontSize : 12) : null;
      let appliedFontSize = requestedFontSize, measured = maxOverflow(visibleSamples.map((element) => measureElement(element, area)));
      if (policy === "auto-fit" && visibleSamples.length > 0 && !fits(measured)) {
        let shrinkBy = 0;
        while ([...requestedFontSizes.values()].some((size) => size - shrinkBy > Math.min(size, minFontSize ?? 12))) {
          shrinkBy += 1;
          for (const element of samples) {
            const requested = requestedFontSizes.get(element) ?? requestedFontSize;
            const candidate = Math.max(Math.min(requested, minFontSize ?? 12), requested - shrinkBy);
            element.style.fontSize = `${candidate}px`;
            scaleRunOverrides(element, requested > 0 ? candidate / requested : 1);
          }
          appliedFontSize = Math.max(0, ...samples.map((element) => Number.parseFloat(getComputedStyle(element).fontSize) || 0));
          measured = maxOverflow(visibleSamples.map((element) => measureElement(element, area)));
          if (fits(measured)) break;
        }
      }
      const didFit = visibleSamples.length === 0 || policy === "allow-crop" || fits(measured);
      const autoFitted = policy === "auto-fit" && appliedFontSize < requestedFontSize && didFit;
      const firstRequested = requestedFontSizes.get(first) ?? 0, firstApplied = Number.parseFloat(getComputedStyle(first).fontSize) || 0;
      const textRuns = styledRunEvidence(first, firstRequested > 0 ? firstApplied / firstRequested : 1);
      return {
        layerId, policy, safeAreaId,
        status: policy === "allow-crop" ? "allowed-crop" as const : didFit ? autoFitted ? "auto-fitted" as const : "passed" as const : "failed" as const,
        requestedFontSize: round(requestedFontSize), appliedFontSize: round(appliedFontSize), minFontSize: minFontSize === null ? null : round(minFontSize), sampleCount: samples.length, visibleSampleCount: visibleSamples.length,
        internalOverflowPx: { horizontal: measured.internalHorizontal, vertical: measured.internalVertical }, safeAreaOverflowPx: measured.safe,
        ...(textRuns ? { textRuns } : {})
      };
    });
    return { policy: "rendered-glyph-bounds" as const, atMs, visibilityThreshold: 0.5 as const, checkedLayerCount: layers.length, uncheckedLayerIds, allowedCropLayerIds: layers.filter((layer) => layer.status === "allowed-crop").map((layer) => layer.layerId), autoFittedLayerIds: layers.filter((layer) => layer.status === "auto-fitted").map((layer) => layer.layerId), failedLayerIds: layers.filter((layer) => layer.status === "failed").map((layer) => layer.layerId), layers };
  }, { safeAreas, atMs });
}
