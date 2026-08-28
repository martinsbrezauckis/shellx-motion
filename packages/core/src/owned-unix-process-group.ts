export type UnixProcessGroupPresence = "present" | "gone" | "unknown";

export interface OwnedUnixProcessGroup {
  readonly pid: number;
  /** Checks the owned process group without delivering a signal. */
  presence(): UnixProcessGroupPresence;
  /** Delivers a signal through the retained negative-PGID handle unless ESRCH retired it. */
  signal(signal: NodeJS.Signals): boolean;
  /** Waits for the owned group to disappear, without treating a timeout as cleanup. */
  waitForExit(timeoutMs: number, pollMs?: number): Promise<boolean>;
}

export type UnixProcessGroupKiller = (pid: number, signal: NodeJS.Signals | 0) => boolean | void;

/**
 * Holds one detached launch's POSIX process-group lifecycle. Callers create the handle immediately
 * after spawn and retain it through cleanup; they must never reconstruct it after leader exit.
 * Once `ESRCH` proves the group gone, the handle is permanently retired.
 */
export function createOwnedUnixProcessGroup(
  pid: number | undefined,
  kill: UnixProcessGroupKiller = process.kill
): OwnedUnixProcessGroup | undefined {
  if (!isSafeUnixProcessGroupId(pid)) return undefined;
  let retired = false;

  const presence = (): UnixProcessGroupPresence => {
    if (retired) return "gone";
    try {
      kill(-pid, 0);
      return "present";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        retired = true;
        return "gone";
      }
      return "unknown";
    }
  };

  const group: OwnedUnixProcessGroup = {
    pid,
    presence,
    signal(signal) {
      if (retired) return false;
      try {
        kill(-pid, signal);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") retired = true;
        return false;
      }
    },
    async waitForExit(timeoutMs, pollMs = 20) {
      const boundedTimeoutMs = Number.isSafeInteger(timeoutMs) && timeoutMs >= 0 ? timeoutMs : 0;
      const boundedPollMs = Number.isSafeInteger(pollMs) && pollMs > 0 ? pollMs : 20;
      const deadline = Date.now() + boundedTimeoutMs;
      while (presence() === "present") {
        if (Date.now() >= deadline) return false;
        await delay(Math.min(boundedPollMs, Math.max(1, deadline - Date.now())));
      }
      return presence() === "gone";
    }
  };
  // Preserve an indeterminate handle so cleanup can still attempt a direct group signal and then
  // fail closed when disappearance cannot be confirmed. Only ESRCH proves that no group remains.
  return group.presence() === "gone" ? undefined : group;
}

export function isSafeUnixProcessGroupId(pid: number | undefined): pid is number {
  return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 1;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
