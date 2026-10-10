import { describe, expect, it, vi } from "vitest";
import { runCoordinatorExecution, type ActiveJob, type MotionCoordinatorExecutionContext } from "./job-coordinator-execution";
import type { MotionHostJob } from "./host-job";

describe("MotionJobCoordinator execution cancellation fence", () => {
  it("sets terminal selection before a cancellation queued at the absent-fence read can run", async () => {
    const controller = new AbortController();
    let executeRan = false;
    const active: ActiveJob = {
      job: { endAcknowledged: vi.fn(async () => true) } as unknown as MotionHostJob,
      controller,
      execute: async () => { executeRan = true; return { ok: true }; },
      callerId: "cut:execution-fence",
      events: [],
      retryAttempt: 0,
      lane: "ffmpeg",
      operation: "render.final",
      eventWrites: Promise.resolve()
    };
    let cancellationOperation: Promise<void> | undefined;
    let queued = false;
    Object.defineProperty(active, "cancellationOperation", {
      configurable: true,
      get: () => {
        if (executeRan && !queued) {
          queued = true;
          queueMicrotask(() => {
            active.cancellation = { requestedBy: active.callerId };
            controller.abort(new Error("late cancellation"));
          });
        }
        return cancellationOperation;
      },
      set: (value: Promise<void> | undefined) => { cancellationOperation = value; }
    });
    const terminalEvents: string[] = [];
    const context: MotionCoordinatorExecutionContext = {
      append: async (_job, type) => { terminalEvents.push(type); },
      claimHeld: async () => true,
      advanceClaim: async () => true,
      releaseCapacityWithoutRecord: async () => { throw new Error("terminal settlement should retain the record"); },
      releaseTerminalClaim: async () => true,
      terminalEvidenceDetail: () => ({}),
      publishReplay: () => {}
    };

    await runCoordinatorExecution(context, "cut:execution-fence", active);

    // The legacy unconditional `await active.cancellationOperation?.catch(...)` yielded here,
    // allowing this queued cancellation to change a completed success into cancellation.
    expect(terminalEvents).toEqual(["succeeded"]);
    expect(active.settling).toBe(true);
    expect(controller.signal.aborted).toBe(true);
  });
});
