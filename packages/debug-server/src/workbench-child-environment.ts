import { childEnvironment } from "@shellx-motion/core";

/**
 * Environment for a Workbench-owned process that has no need for a capability-bearing parent
 * value.  Provider configuration, ACL helpers, and all non-visual helpers use this default.
 */
export function workbenchChildEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return childEnvironment({ source });
}

/**
 * Environment for a human-initiated desktop helper.
 *
 * X11's `XAUTHORITY` is deliberately withheld from generic and model-adjacent children.  A native
 * chooser, reveal operation, or browser opener must sometimes present a window in that already
 * selected desktop session, so this is the sole explicit exception.  Keep the exception here rather
 * than weakening the shared child environment; every caller remains auditable as a desktop action.
 */
export function workbenchDesktopChildEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return childEnvironment({
    source,
    extra: source.XAUTHORITY === undefined ? undefined : { XAUTHORITY: source.XAUTHORITY }
  });
}
