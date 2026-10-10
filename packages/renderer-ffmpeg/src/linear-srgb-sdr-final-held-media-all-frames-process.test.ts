import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OwnedUnixProcessGroup } from "@shellx-motion/core";

const childProcess = vi.hoisted(() => ({ spawn: vi.fn() }));
const ownedGroup = vi.hoisted(() => ({ current: undefined as OwnedUnixProcessGroup | undefined, error: undefined as unknown }));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: childProcess.spawn,
}));
vi.mock("@shellx-motion/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@shellx-motion/core")>()),
  createOwnedUnixProcessGroup: () => {
    if (ownedGroup.error !== undefined) throw ownedGroup.error;
    return ownedGroup.current;
  },
}));

import {
  runLinearSrgbSdrHeldAllFramesChild,
  strictSdrHeldAllFramesTerminalEstablished,
  type StrictSdrHeldAllFramesTerminalObservation,
} from "./linear-srgb-sdr-final-held-media-all-frames-process.js";

beforeEach(() => {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  childProcess.spawn.mockReset();
  ownedGroup.current = retiredGroup();
  ownedGroup.error = undefined;
});
afterEach(() => vi.restoreAllMocks());

describe("strict SDR all-delivered-frame binary process", () => {
  it("accepts raw bytes only after EOF, close, group settlement, and callback drain", async () => {
    const child = fakeChild(), observed: StrictSdrHeldAllFramesTerminalObservation[] = [], chunks: Buffer[] = [];
    childProcess.spawn.mockReturnValue(child);
    const pending = run(observed, async (chunk) => { chunks.push(Buffer.from(chunk)); });
    child.stdout.write(Buffer.from([1, 2, 3]));
    await endStdout(child.stdout);
    child.emit("close", 0);

    await expect(pending).resolves.toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(Buffer.concat(chunks)).toEqual(Buffer.from([1, 2, 3]));
    expect(observed).toEqual([{
      childCloseObserved: true, settlementStartedByClose: true, ownedUnixProcessGroupCreated: true,
      groupGoneAfterSettlement: true, stdoutEofObserved: true, stdoutErrorFree: true, streamCallbacksSettled: true, streamCallbacksSucceeded: true,
    }]);
    expect(strictSdrHeldAllFramesTerminalEstablished(observed[0])).toBe(true);
  });

  it("refuses a close before natural stdout EOF", async () => {
    const child = fakeChild(), observed: StrictSdrHeldAllFramesTerminalObservation[] = [];
    childProcess.spawn.mockReturnValue(child);
    const pending = run(observed, () => undefined);
    child.emit("close", 0);

    await expect(pending).resolves.toMatchObject({ exitCode: 1 });
    expect(observed[0]).toMatchObject({ childCloseObserved: true, stdoutEofObserved: false, streamCallbacksSettled: true });
    expect(strictSdrHeldAllFramesTerminalEstablished(observed[0])).toBe(false);
  });

  it("does not resolve an error path before child close and group settlement", async () => {
    const child = fakeChild(), observed: StrictSdrHeldAllFramesTerminalObservation[] = [];
    childProcess.spawn.mockReturnValue(child);
    const pending = run(observed, () => undefined);
    let settled = false;
    void pending.then(() => { settled = true; });
    child.emit("error", Object.assign(new Error("descriptor launch failed"), { code: "ENOENT" }));
    await Promise.resolve();
    expect(settled).toBe(false);
    child.emit("close", 1);

    await expect(pending).resolves.toMatchObject({ exitCode: 1 });
    expect(observed[0]).toMatchObject({ childCloseObserved: true, settlementStartedByClose: true, groupGoneAfterSettlement: true });
  });

  it("does not resolve an abort path before child close and group settlement", async () => {
    const child = fakeChild(), observed: StrictSdrHeldAllFramesTerminalObservation[] = [], controller = new AbortController();
    childProcess.spawn.mockReturnValue(child);
    const pending = run(observed, () => undefined, 1_048_576, undefined, controller.signal);
    let settled = false;
    void pending.then(() => { settled = true; });
    controller.abort(new Error("cancelled"));
    await Promise.resolve();
    expect(settled).toBe(false);
    child.emit("close", 1);

    await expect(pending).resolves.toMatchObject({ exitCode: 1 });
    expect(observed[0]).toMatchObject({ childCloseObserved: true, groupGoneAfterSettlement: true });
  });

  it("turns missing pipes and post-spawn observer failures into bounded close-time refusals", async () => {
    const missing = fakeChild(), watched = fakeChild();
    missing.stdout = undefined as unknown as PassThrough;
    childProcess.spawn.mockReturnValueOnce(missing).mockReturnValueOnce(watched);
    const first = run([], () => undefined);
    let firstSettled = false;
    void first.then(() => { firstSettled = true; });
    await Promise.resolve();
    expect(firstSettled).toBe(false);
    missing.emit("close", 1);
    await expect(first).resolves.toMatchObject({ exitCode: 1 });

    const second = run([], () => { throw new Error("watcher refused"); }, 1_048_576, undefined, new AbortController().signal, () => { throw new Error("watcher refused"); });
    let secondSettled = false;
    void second.then(() => { secondSettled = true; });
    await Promise.resolve();
    expect(secondSettled).toBe(false);
    watched.emit("close", 1);
    await expect(second).resolves.toMatchObject({ exitCode: 1 });
  });

  it("refuses an oversize binary chunk and does not treat its terminal state as established", async () => {
    const child = fakeChild(), observed: StrictSdrHeldAllFramesTerminalObservation[] = [];
    childProcess.spawn.mockReturnValue(child);
    const pending = run(observed, () => undefined, 1);
    child.stdout.write(Buffer.alloc(2));
    await new Promise<void>((resolve) => setImmediate(resolve));
    child.emit("close", 1);

    await expect(pending).resolves.toMatchObject({ exitCode: 1 });
    expect(observed[0]).toMatchObject({ childCloseObserved: true, stdoutEofObserved: false });
    expect(strictSdrHeldAllFramesTerminalEstablished(observed[0])).toBe(false);
  });

  it("does not establish a natural-EOF terminal after the final chunk callback rejects", async () => {
    const child = fakeChild(), observed: StrictSdrHeldAllFramesTerminalObservation[] = [];
    childProcess.spawn.mockReturnValue(child);
    const pending = run(observed, async () => { throw new Error("final frame observer refused"); });
    child.stdout.write(Buffer.from([1, 2, 3]));
    await endStdout(child.stdout);
    child.emit("close", 0);

    await expect(pending).resolves.toMatchObject({ exitCode: 1 });
    expect(observed[0]).toMatchObject({
      childCloseObserved: true,
      stdoutEofObserved: true,
      stdoutErrorFree: true,
      streamCallbacksSettled: true,
      streamCallbacksSucceeded: false,
    });
    expect(strictSdrHeldAllFramesTerminalEstablished(observed[0])).toBe(false);
  });

  it("refuses if the private terminal observer throws after contained child settlement", async () => {
    const child = fakeChild(), observed: StrictSdrHeldAllFramesTerminalObservation[] = [];
    childProcess.spawn.mockReturnValue(child);
    const pending = run(observed, () => undefined, 1_048_576, () => { throw new Error("observer refused"); });
    await endStdout(child.stdout);
    child.emit("close", 0);

    await expect(pending).resolves.toMatchObject({ exitCode: 1, stderr: expect.stringMatching(/terminal observation failed/i) });
    expect(observed[0]).toMatchObject({ childCloseObserved: true, stdoutEofObserved: true, groupGoneAfterSettlement: true });
  });
});

function run(
  observed: StrictSdrHeldAllFramesTerminalObservation[],
  consumeChunk: (chunk: Buffer) => Promise<void> | void,
  maximumChunkBytes = 1_048_576,
  afterObservation?: () => void,
  signal = new AbortController().signal,
  watchProcess: (pid: number) => void = () => undefined,
) {
  return runLinearSrgbSdrHeldAllFramesChild({
    ffmpegFd: 3, sourceFd: 4, signal,
    watchProcess, terminationMode: () => "unix-process-group", maximumChunkBytes, consumeChunk,
    observeTerminal: (observation) => { observed.push(observation); afterObservation?.(); },
  });
}
function retiredGroup(): OwnedUnixProcessGroup { return { pid: 4321, presence: () => "gone", signal: () => false, waitForExit: async () => true }; }
async function endStdout(stdout: PassThrough): Promise<void> {
  const ended = once(stdout, "end");
  stdout.end();
  await ended;
}
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & { pid: number; stdout: PassThrough; stderr: PassThrough; kill(signal?: NodeJS.Signals | number): boolean };
  child.pid = 4321;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  return child;
}
