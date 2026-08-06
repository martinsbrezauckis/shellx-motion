/**
 * Shared update state for the Workbench and connected agents.
 *
 * The controller owns one cached release-channel result. The CLI starts it at
 * launch and refreshes it every thirty minutes; the About page's "Check now"
 * action uses the same refresh operation, so humans and agents never receive
 * conflicting update answers from separate checks.
 */
import type { UpdateCheckResult } from "./workbench-update.js";

export type WorkbenchUpdateCheckStatus = "not_checked" | "checking" | "checked";

export interface WorkbenchUpdateSnapshot {
  status: WorkbenchUpdateCheckStatus;
  checkedAt: string | null;
  nextCheckAt: string | null;
  result: UpdateCheckResult | null;
}

export interface WorkbenchUpdateSummary {
  status: WorkbenchUpdateCheckStatus;
  currentVersion: string;
  checkedAt: string | null;
  nextCheckAt: string | null;
  configured?: boolean;
  latestVersion?: string;
  updateAvailable?: boolean;
  errorCode?: string;
}

export interface WorkbenchUpdateController {
  start: () => void;
  refresh: () => Promise<UpdateCheckResult>;
  snapshot: () => WorkbenchUpdateSnapshot;
  summary: () => WorkbenchUpdateSummary;
  close: () => void;
}

export interface WorkbenchUpdateControllerOptions {
  currentVersion: string;
  intervalMs: number;
  check: () => Promise<UpdateCheckResult>;
  now?: () => number;
}

export function createWorkbenchUpdateController(
  options: WorkbenchUpdateControllerOptions
): WorkbenchUpdateController {
  if (!Number.isFinite(options.intervalMs) || options.intervalMs < 1) {
    throw new Error("Motion update check interval must be a positive number of milliseconds.");
  }
  const now = options.now ?? Date.now;
  let active = false;
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<UpdateCheckResult> | null = null;
  let status: WorkbenchUpdateCheckStatus = "not_checked";
  let checkedAt: string | null = null;
  let nextCheckAt: string | null = null;
  let result: UpdateCheckResult | null = null;

  const scheduleNext = (): void => {
    if (!active) return;
    if (timer) clearTimeout(timer);
    const dueAt = now() + options.intervalMs;
    nextCheckAt = new Date(dueAt).toISOString();
    timer = setTimeout(() => {
      timer = null;
      void refresh().finally(scheduleNext);
    }, options.intervalMs);
    timer.unref?.();
  };

  const refresh = (): Promise<UpdateCheckResult> => {
    if (inFlight) return inFlight;
    status = "checking";
    inFlight = options.check()
      .catch((error): UpdateCheckResult => ({
        ok: false,
        configured: true,
        currentVersion: options.currentVersion,
        error: {
          code: "update_check_failed",
          message: error instanceof Error ? error.message : String(error)
        },
        unsafeNetworkOverride: false
      }))
      .then((answer) => {
        result = answer;
        checkedAt = new Date(now()).toISOString();
        status = "checked";
        return answer;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  const snapshot = (): WorkbenchUpdateSnapshot => ({
    status,
    checkedAt,
    nextCheckAt,
    result
  });

  const summary = (): WorkbenchUpdateSummary => {
    const base: WorkbenchUpdateSummary = {
      status,
      currentVersion: options.currentVersion,
      checkedAt,
      nextCheckAt
    };
    if (!result) return base;
    base.configured = result.configured;
    if (result.ok && result.configured) {
      base.latestVersion = result.latestVersion;
      base.updateAvailable = !result.upToDate;
    } else if (!result.ok) {
      base.errorCode = result.error.code;
    }
    return base;
  };

  return {
    start: () => {
      if (active) return;
      active = true;
      void refresh();
      scheduleNext();
    },
    refresh,
    snapshot,
    summary,
    close: () => {
      active = false;
      nextCheckAt = null;
      if (timer) clearTimeout(timer);
      timer = null;
    }
  };
}
