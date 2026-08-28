import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { createBoundedAsyncQueue } from "./bounded-async-queue.js";

describe("createBoundedAsyncQueue", () => {
  it("is the WebSocket dispatch authority instead of an unbounded promise chain", async () => {
    const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");
    expect(source).toContain("createBoundedAsyncQueue(MAX_OUTSTANDING_WEBSOCKET_FRAMES");
    expect(source).toContain("WebSocket outstanding-frame limit reached.");
    expect(source).not.toMatch(/processing\s*=\s*processing\s*\.then/);
  });

  it("abandons queued work when producers cross the outstanding-work ceiling", async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const calls: number[] = [];
    const errors = vi.fn();
    const queue = createBoundedAsyncQueue(2, errors);

    expect(queue.enqueue(async () => {
      calls.push(1);
      await firstBlocked;
    })).toBe(true);
    await Promise.resolve();
    expect(queue.enqueue(async () => {
      calls.push(2);
    })).toBe(true);
    expect(queue.enqueue(async () => {
      calls.push(3);
    })).toBe(false);
    releaseFirst();
    await new Promise((resolve) => setImmediate(resolve));

    expect(calls).toEqual([1]);
    expect(errors).not.toHaveBeenCalled();
    expect(queue.enqueue(async () => {
      calls.push(4);
    })).toBe(false);
  });

  it("reports task failures and keeps later accepted work serial", async () => {
    const calls: number[] = [];
    const errors = vi.fn();
    const queue = createBoundedAsyncQueue(2, errors);
    expect(queue.enqueue(async () => {
      calls.push(1);
      throw new Error("expected");
    })).toBe(true);
    await Promise.resolve();
    expect(queue.enqueue(async () => {
      calls.push(2);
    })).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toEqual([1, 2]);
    expect(errors).toHaveBeenCalledTimes(1);
  });
});
