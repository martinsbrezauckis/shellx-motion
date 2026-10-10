import { describe, expect, it } from "vitest";
import { parseMotionJobCoordinatorEvents, serializeMotionJobCoordinatorEvents, type MotionJobCoordinatorEvent } from "./job-event-serialization";

function event(type: MotionJobCoordinatorEvent["type"], data?: Record<string, unknown>): MotionJobCoordinatorEvent {
  return { schema: "shellx-motion/job-event@1", seq: 1, atMs: 1, type, ...(data ? { data } : {}) };
}

describe("durable coordinator event marker codec", () => {
  it("reserves committed for literal failed terminal data only", () => {
    const accepted = [event("failed", { code: "invalid_args", retryable: false, committed: true })];
    expect(parseMotionJobCoordinatorEvents(accepted)).toEqual(accepted);
    expect(serializeMotionJobCoordinatorEvents(accepted)).toContain('"committed":true');

    const hostile: Array<MotionJobCoordinatorEvent[]> = [
      [event("submitted", { committed: true })],
      [event("succeeded", { committed: true })],
      [event("failed", { committed: false })],
      [event("failed", { committed: "possibly" })]
    ];
    for (const events of hostile) {
      expect(parseMotionJobCoordinatorEvents(events)).toBeNull();
      expect(() => serializeMotionJobCoordinatorEvents(events)).toThrow("invalid");
    }
  });
});
