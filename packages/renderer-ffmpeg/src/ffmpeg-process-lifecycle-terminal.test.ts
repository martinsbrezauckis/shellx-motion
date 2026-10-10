import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OwnedUnixProcessGroup } from "@shellx-motion/core";
import type { FfmpegCommand } from "./index.js";

const childProcess = vi.hoisted(() => ({ spawn: vi.fn() }));
const ownedGroup = vi.hoisted(() => ({ current: undefined as unknown }));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: childProcess.spawn,
}));
vi.mock("@shellx-motion/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@shellx-motion/core")>()),
  createOwnedUnixProcessGroup: () => ownedGroup.current as OwnedUnixProcessGroup | undefined,
}));

import {
  runLinearSrgbSdrHeldInverseChild,
  strictSdrHeldInverseTerminalContainmentEstablished,
  type StrictSdrHeldInverseTerminalObservation,
} from "./ffmpeg-process-lifecycle.js";

beforeEach(() => {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  childProcess.spawn.mockReset();
  ownedGroup.current = undefined;
});

afterEach(() => vi.restoreAllMocks());

describe("strict SDR held inverse terminal observer", () => {
  it("withholds enforcement after a retained owned group", async () => {
    const child = fakeChild();
    childProcess.spawn.mockReturnValue(child);
    ownedGroup.current = retainedGroup();
    const observations: StrictSdrHeldInverseTerminalObservation[] = [];
    const pending = run(observations);
    child.emit("close", 0);

    await expect(pending).resolves.toMatchObject({ exitCode: 1 });
    expect(observations).toEqual([{ childCloseObserved: true, settlementStartedByClose: true, ownedUnixProcessGroupCreated: true, groupGoneAfterSettlement: false }]);
    expect(strictSdrHeldInverseTerminalContainmentEstablished(observations[0])).toBe(false);
  });

  it("withholds enforcement when child error settles before a close event", async () => {
    const child = fakeChild();
    childProcess.spawn.mockReturnValue(child);
    ownedGroup.current = retiredGroup();
    const observations: StrictSdrHeldInverseTerminalObservation[] = [];
    const pending = run(observations);
    child.emit("error", Object.assign(new Error("descriptor launch failed"), { code: "ENOENT" }));
    child.emit("close", 1);

    await expect(pending).resolves.toMatchObject({ exitCode: 127 });
    expect(observations).toEqual([{ childCloseObserved: true, settlementStartedByClose: false, ownedUnixProcessGroupCreated: true, groupGoneAfterSettlement: true }]);
    expect(strictSdrHeldInverseTerminalContainmentEstablished(observations[0])).toBe(false);
  });

  it("withholds enforcement when descriptor launch has no owned group", async () => {
    const child = fakeChild();
    childProcess.spawn.mockReturnValue(child);
    const observations: StrictSdrHeldInverseTerminalObservation[] = [];
    const pending = run(observations);
    child.emit("close", 0);

    await expect(pending).resolves.toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(observations).toEqual([{ childCloseObserved: true, settlementStartedByClose: true, ownedUnixProcessGroupCreated: false, groupGoneAfterSettlement: false }]);
    expect(strictSdrHeldInverseTerminalContainmentEstablished(observations[0])).toBe(false);
  });

  it("settles the launched child even when its private terminal observer rejects", async () => {
    const child = fakeChild();
    childProcess.spawn.mockReturnValue(child);
    ownedGroup.current = retiredGroup();
    const observations: StrictSdrHeldInverseTerminalObservation[] = [];
    const pending = run(observations, () => { throw new Error("fresh containment reporter refused"); });
    child.emit("close", 0);

    await expect(pending).resolves.toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "\nMotion strict-SDR held inverse terminal observation failed.",
    });
    expect(observations).toEqual([{ childCloseObserved: true, settlementStartedByClose: true, ownedUnixProcessGroupCreated: true, groupGoneAfterSettlement: true }]);
  });

  it("settles as a refusal when post-launch group inspection itself fails", async () => {
    const child = fakeChild();
    childProcess.spawn.mockReturnValue(child);
    ownedGroup.current = brokenGroup();
    const observations: StrictSdrHeldInverseTerminalObservation[] = [];
    const pending = run(observations);
    child.emit("close", 0);

    await expect(pending).resolves.toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "\nMotion could not settle contained Unix process-group cleanup.",
    });
    expect(observations).toEqual([{ childCloseObserved: true, settlementStartedByClose: true, ownedUnixProcessGroupCreated: true, groupGoneAfterSettlement: false }]);
  });
});

function run(
  observations: StrictSdrHeldInverseTerminalObservation[],
  afterObservation?: (observation: StrictSdrHeldInverseTerminalObservation) => void,
) {
  return runLinearSrgbSdrHeldInverseChild(
    command(), 3, 4, 5, new AbortController().signal, () => undefined, () => "unix-process-group", {},
    (observation) => { observations.push(observation); afterObservation?.(observation); },
  );
}

function command(): FfmpegCommand {
  return { executable: "/proc/self/fd/3", shell: false, args: ["-i", "/proc/self/fd/4", "/proc/self/fd/5"] };
}

function retainedGroup(): OwnedUnixProcessGroup {
  return { pid: 4321, presence: () => "present", signal: () => true, waitForExit: async () => false };
}

function retiredGroup(): OwnedUnixProcessGroup {
  return { pid: 4321, presence: () => "gone", signal: () => false, waitForExit: async () => true };
}

function brokenGroup(): OwnedUnixProcessGroup {
  return {
    pid: 4321,
    presence: () => { throw new Error("group inspection failed"); },
    signal: () => false,
    waitForExit: async () => false,
  };
}

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdout: PassThrough;
    stderr: PassThrough;
    kill(signal?: NodeJS.Signals | number): boolean;
  };
  child.pid = 4321;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  return child;
}
