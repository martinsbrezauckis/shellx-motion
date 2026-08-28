import { chromium, type Browser } from "playwright-core";

export async function launchConfiguredTestBrowser(): Promise<Browser> {
  const configuredExecutable = process.env.SHELLX_MOTION_BROWSER?.trim();
  return await chromium.launch({
    headless: true,
    ...(configuredExecutable ? { executablePath: configuredExecutable } : {})
  });
}
