/** Shared, host-controlled Chromium launch arguments for Browser-owned sessions. */
export function resolveChromiumLaunchArgs(env: Record<string, string | undefined> = process.env): string[] {
  const args = ["--disable-gpu"];
  const noSandbox = env.SHELLX_MOTION_CHROMIUM_NO_SANDBOX?.trim().toLowerCase();
  if (noSandbox === "1" || noSandbox === "true" || noSandbox === "yes") {
    args.push("--no-sandbox");
  }
  return args;
}
