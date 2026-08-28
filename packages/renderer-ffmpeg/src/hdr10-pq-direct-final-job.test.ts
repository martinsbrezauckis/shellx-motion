import { describe, expect, it, vi } from "vitest";
import { createHdr10PqDirectFinalDeadline, isHdr10PqDirectFinalJob } from "./hdr10-pq-direct-final-job.js";

function job(signal = new AbortController().signal) { return { admission: "pre-acquired" as const, signal, scratchRoot: "/tmp/hdr10-job", maxProcessTreeRssBytes: 64 * 1024 * 1024, watchProcess: () => {}, reportProcessContainment: () => {} }; }
describe("HDR10 C2 pre-acquired job boundary", () => {
  it("rejects invalid or above-ceiling jobs", () => { expect(isHdr10PqDirectFinalJob(job())).toBe(true); expect(isHdr10PqDirectFinalJob({ ...job(), maxProcessTreeRssBytes: 2 * 1024 * 1024 * 1024 + 1 })).toBe(false); expect(isHdr10PqDirectFinalJob({ ...job(), scratchRoot: "" })).toBe(false); });
  it("propagates cancellation and the fixed 180000ms deadline", () => { vi.useFakeTimers(); try { const parent = new AbortController(), deadline = createHdr10PqDirectFinalDeadline(parent.signal); parent.abort(new Error("cancel")); expect(deadline.signal.aborted).toBe(true); deadline.close(); const timed = createHdr10PqDirectFinalDeadline(new AbortController().signal); vi.advanceTimersByTime(180_000); expect(timed.signal.aborted).toBe(true); timed.close(); } finally { vi.useRealTimers(); } });
});
