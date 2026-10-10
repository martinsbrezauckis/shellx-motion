/** Read-only liveness classification for claim inspection; never a recovery decision. */
export function inspectSystemClaimLiveness(pid: number): "live" | "dead" | "unknown" {
  try {
    process.kill(pid, 0);
    return "live";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return code === "EPERM" ? "live" : code === "ESRCH" ? "dead" : "unknown";
  }
}

export function inspectInjectedClaimLiveness(check: (pid: number) => boolean, pid: number): "live" | "dead" | "unknown" {
  try {
    const result: unknown = check(pid);
    return result === true ? "live" : result === false ? "dead" : "unknown";
  } catch {
    return "unknown";
  }
}
