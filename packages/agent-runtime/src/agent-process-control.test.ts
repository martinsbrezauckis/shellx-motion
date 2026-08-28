import { afterEach, describe, expect, it, vi } from "vitest";
import { terminateAgentProcessTree } from "./agent-process-control";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("agent process-group termination", () => {
  it("never negates an unsafe Unix process-group id", () => {
    const processKill = vi.spyOn(process, "kill").mockImplementation(() => true);
    for (const pid of [undefined, 0, 1, 1.5, Number.NaN]) {
      const child = { pid, kill: vi.fn(() => true) };
      terminateAgentProcessTree(child, false, "unix-process-group");
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    }
    expect(processKill).not.toHaveBeenCalled();

    const groupSignal = vi.fn(() => true);
    const groupedChild = { pid: 4567, kill: vi.fn(() => true) };
    terminateAgentProcessTree(groupedChild, true, "unix-process-group", {
      pid: 4567,
      presence: () => "present",
      signal: groupSignal,
      waitForExit: async () => true
    });
    expect(processKill).not.toHaveBeenCalled();
    expect(groupSignal).toHaveBeenCalledWith("SIGKILL");
    expect(groupedChild.kill).not.toHaveBeenCalled();
  });
});
