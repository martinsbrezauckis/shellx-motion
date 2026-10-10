import { describe, expect, it, vi } from "vitest";
import { createOwnedUnixProcessGroup, isSafeUnixProcessGroupId } from "./owned-unix-process-group";

describe("owned Unix process groups", () => {
  it("rejects sentinel or malformed group ids before they can be negated", () => {
    for (const pid of [undefined, 0, 1, 1.5, Number.NaN]) {
      expect(createOwnedUnixProcessGroup(pid)).toBeUndefined();
      expect(isSafeUnixProcessGroupId(pid)).toBe(false);
    }
  });

  it("retires a missing group and never signals a later recycled pid", () => {
    const missing = Object.assign(new Error("gone"), { code: "ESRCH" });
    const kill = vi.fn((_pid: number, signal: NodeJS.Signals | 0) => {
      if (signal === 0) throw missing;
      return true;
    });
    const group = createOwnedUnixProcessGroup(4567, kill);

    expect(group).toBeUndefined();
    expect(kill).toHaveBeenCalledExactlyOnceWith(-4567, 0);

    kill.mockImplementation(() => true);
    expect(group?.signal("SIGKILL")).toBeUndefined();
    expect(kill).toHaveBeenCalledExactlyOnceWith(-4567, 0);
  });

  it("retains an indeterminate group so callers cannot mistake unknown cleanup for absence", async () => {
    const group = createOwnedUnixProcessGroup(2468, () => {
      const error = new Error("permission denied") as NodeJS.ErrnoException;
      error.code = "EPERM";
      throw error;
    });

    expect(group).toBeDefined();
    expect(group?.presence()).toBe("unknown");
    expect(group?.signal("SIGKILL")).toBe(false);
    await expect(group?.waitForExit(0)).resolves.toBe(false);
  });

  it("waits through transient EPERM but requires ESRCH before confirming cleanup", async () => {
    let probes = 0;
    const group = createOwnedUnixProcessGroup(2469, (_pid, signal) => {
      if (signal !== 0) return true;
      probes += 1;
      if (probes < 4) {
        const error = new Error("permission denied") as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      }
      const error = new Error("gone") as NodeJS.ErrnoException;
      error.code = "ESRCH";
      throw error;
    });

    await expect(group?.waitForExit(100, 1)).resolves.toBe(true);
    expect(probes).toBe(4);
  });

  it("fails closed when EPERM persists until the cleanup deadline", async () => {
    let probes = 0;
    const group = createOwnedUnixProcessGroup(2470, () => {
      probes += 1;
      const error = new Error("permission denied") as NodeJS.ErrnoException;
      error.code = "EPERM";
      throw error;
    });

    await expect(group?.waitForExit(20, 1)).resolves.toBe(false);
    expect(probes).toBeGreaterThan(2);
    expect(group?.presence()).toBe("unknown");
  });

  it("signals a retained launch handle without a separate probe-to-signal race", () => {
    const kill = vi.fn(() => true);
    const group = createOwnedUnixProcessGroup(4567, kill);

    expect(group?.signal("SIGTERM")).toBe(true);
    expect(kill.mock.calls).toEqual([[-4567, 0], [-4567, "SIGTERM"]]);
  });
});
