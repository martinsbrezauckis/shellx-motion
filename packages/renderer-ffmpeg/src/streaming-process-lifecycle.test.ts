import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FfmpegCommand } from "./index";
import { startStreamingFfmpegProcess } from "./streaming-process";

describe("streaming FFmpeg process lifecycle", () => {
  it.skipIf(process.platform === "win32")("does not resolve a terminal result while a leader-first signal-resistant descendant remains", async () => {
    const directory = await mkdtemp(join(tmpdir(), "shellx-motion-stream-leader-first-"));
    try {
      const descendantPidPath = join(directory, "descendant.pid");
      const leader = [
        "const { spawn } = require('node:child_process')",
        "const { writeFileSync } = require('node:fs')",
        "const descendant = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"], { stdio: 'ignore' })",
        "writeFileSync(process.argv[1], String(descendant.pid))",
        "setTimeout(() => process.exit(0), 50)"
      ].join("; ");
      const command: FfmpegCommand = { executable: process.execPath, args: ["-e", leader, descendantPidPath], shell: false };
      const stream = await startStreamingFfmpegProcess({
        command,
        signal: new AbortController().signal,
        watchProcess: () => undefined,
        reportProcessContainment: () => undefined
      });

      await expect(stream.closed).resolves.toMatchObject({ exitCode: 0 });
      const descendantPid = Number(await readFile(descendantPidPath, "utf8"));
      expect(Number.isSafeInteger(descendantPid)).toBe(true);
      await expectProcessToExit(descendantPid);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 45_000);
});

async function expectProcessToExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  throw new Error(`Streaming descendant ${pid} remained alive after contained termination.`);
}
