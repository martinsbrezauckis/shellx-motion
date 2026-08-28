import { chromium } from "playwright-core";

export type MotionBrowserVersionProbeResult =
  | { ok: true; version: string }
  | { ok: false; reason: "timed_out" | "launch_failed" | "no_version" | "cleanup_failed" };

interface BrowserVersionSession {
  version(): string;
  close(): Promise<void>;
}

interface BrowserVersionLaunchOptions {
  executablePath: string;
  headless: true;
  timeout: number;
  args: string[];
}

type BrowserVersionLauncher = (options: BrowserVersionLaunchOptions) => Promise<BrowserVersionSession>;

/** Launch the exact resolved browser invisibly and return its protocol-reported version. */
export async function probeMotionBrowserVersion(
  executablePath: string,
  options: { timeoutMs: number }
): Promise<MotionBrowserVersionProbeResult> {
  return probeMotionBrowserVersionWithLauncher(
    executablePath,
    options.timeoutMs,
    (launchOptions) => chromium.launch(launchOptions)
  );
}

/** Testable implementation; only the wrapper above is re-exported by the renderer package. */
export async function probeMotionBrowserVersionWithLauncher(
  executablePath: string,
  timeoutMs: number,
  launchBrowser: BrowserVersionLauncher
): Promise<MotionBrowserVersionProbeResult> {
  let browser: BrowserVersionSession;
  try {
    browser = await launchBrowser({
      executablePath,
      headless: true,
      timeout: timeoutMs,
      // The probe loads no page or package input. Disable Chrome background traffic while
      // Playwright supplies its normal private temporary profile and Windows launch policy.
      args: ["--disable-background-networking", "--disable-gpu", "--no-first-run"]
    });
  } catch (error) {
    return { ok: false, reason: error instanceof Error && error.name === "TimeoutError" ? "timed_out" : "launch_failed" };
  }

  let version = "";
  let versionFailed = false;
  try {
    version = browser.version().trim();
  } catch {
    versionFailed = true;
  }
  try {
    await browser.close();
  } catch {
    return { ok: false, reason: "cleanup_failed" };
  }
  if (versionFailed) return { ok: false, reason: "launch_failed" };
  return version ? { ok: true, version } : { ok: false, reason: "no_version" };
}
