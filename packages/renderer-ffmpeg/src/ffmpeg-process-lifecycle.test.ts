import { open, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FfmpegCommand } from "./index.js";
import {
  runLinearSrgbSdrHeldInverseChild,
  strictSdrHeldInverseTerminalContainmentEstablished,
  type StrictSdrHeldInverseTerminalObservation,
} from "./ffmpeg-process-lifecycle.js";

describe("strict SDR held inverse terminal containment", () => {
  it.skipIf(process.platform !== "linux")("observes a real descriptor-bound child close and retired owned process group", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-held-inverse-terminal-"));
    const executable = await open(process.execPath, "r");
    const source = await open(join(root, "source.mp4"), "w+");
    const decoded = await open(join(root, "decoded.rgba"), "w+");
    try {
      let observed: StrictSdrHeldInverseTerminalObservation | undefined;
      const result = await runLinearSrgbSdrHeldInverseChild(
        nodeDescriptorCommand(), executable.fd, source.fd, decoded.fd,
        new AbortController().signal, () => undefined, () => "unix-process-group", {},
        (observation) => { observed = observation; },
      );
      expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
      expect(observed).toEqual({
        childCloseObserved: true,
        settlementStartedByClose: true,
        ownedUnixProcessGroupCreated: true,
        groupGoneAfterSettlement: true,
      });
      expect(strictSdrHeldInverseTerminalContainmentEstablished(observed)).toBe(true);
    } finally {
      await Promise.allSettled([executable.close(), source.close(), decoded.close()]);
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "linux")("records a real direct child as insufficient for held containment", async () => {
    const root = await mkdtemp(join(tmpdir(), "shellx-motion-held-inverse-direct-"));
    const executable = await open(process.execPath, "r");
    const source = await open(join(root, "source.mp4"), "w+");
    const decoded = await open(join(root, "decoded.rgba"), "w+");
    try {
      let observed: StrictSdrHeldInverseTerminalObservation | undefined;
      const result = await runLinearSrgbSdrHeldInverseChild(
        nodeDescriptorCommand(), executable.fd, source.fd, decoded.fd,
        new AbortController().signal, () => undefined, () => "direct-child", {},
        (observation) => { observed = observation; },
      );
      expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
      expect(observed).toEqual({
        childCloseObserved: true,
        settlementStartedByClose: true,
        ownedUnixProcessGroupCreated: false,
        groupGoneAfterSettlement: false,
      });
      expect(strictSdrHeldInverseTerminalContainmentEstablished(observed)).toBe(false);
    } finally {
      await Promise.allSettled([executable.close(), source.close(), decoded.close()]);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not treat retained groups, pre-close errors, or direct children as enforced containment", () => {
    expect(strictSdrHeldInverseTerminalContainmentEstablished({
      childCloseObserved: true, settlementStartedByClose: true, ownedUnixProcessGroupCreated: true, groupGoneAfterSettlement: false,
    })).toBe(false);
    expect(strictSdrHeldInverseTerminalContainmentEstablished({
      childCloseObserved: false, settlementStartedByClose: false, ownedUnixProcessGroupCreated: true, groupGoneAfterSettlement: true,
    })).toBe(false);
    expect(strictSdrHeldInverseTerminalContainmentEstablished({
      childCloseObserved: true, settlementStartedByClose: true, ownedUnixProcessGroupCreated: false, groupGoneAfterSettlement: false,
    })).toBe(false);
  });
});

function nodeDescriptorCommand(): FfmpegCommand {
  return {
    executable: "/proc/self/fd/3",
    shell: false,
    args: ["-e", "setTimeout(() => process.exit(0), 50)", "/proc/self/fd/4", "/proc/self/fd/5"],
  };
}
