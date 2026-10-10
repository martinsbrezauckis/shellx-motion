import type { BrowserContext, Page } from "playwright-core";
import type { BrowserFrameNetworkState } from "./browser-network-state";

/**
 * Refuse scripted new windows before Chromium creates a second target. A context route remains
 * the fallback for other secondary-page requests, but its first popup navigation can race the
 * page event on some browser builds. The binding records an origin-free receipt warning.
 */
export async function installBrowserPopupOpenGuard(
  context: BrowserContext,
  networkState: () => BrowserFrameNetworkState | undefined
): Promise<void> {
  const binding = "__shellxMotionBlockedPopupOpen";
  await context.exposeBinding(binding, () => {
    networkState()?.blockedSecondaryPages.push("scripted-open");
  });
  await context.addInitScript({ content: `(() => {
    const recordBlockedOpen = window.${binding};
    Object.defineProperty(window, "open", {
      configurable: false,
      writable: false,
      value: function open() {
        void recordBlockedOpen();
        return null;
      }
    });
  })();` });
}

/** Refuse a context whose init script did not arm before package content can run. */
export async function assertBrowserPopupOpenGuard(page: Page): Promise<void> {
  const armed = await page.evaluate(() => {
    const descriptor = Object.getOwnPropertyDescriptor(window, "open");
    return descriptor?.configurable === false && descriptor.writable === false;
  });
  if (!armed) throw new Error("Browser popup-open guard did not arm before render content.");
}
