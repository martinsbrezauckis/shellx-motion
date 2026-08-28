import { execFile } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { qualifyV25c4Native } from "./qualify-v25c4-native";

const runnerPath = fileURLToPath(new URL("./qualify-v25c4-native.ts", import.meta.url));
const runFile = promisify(execFile);

describe("V25-C4 native qualification runner structure", () => {
  it("requires an explicit fresh root and exact expected commit before host work", async () => {
    await expect(qualifyV25c4Native([])).rejects.toThrow(/--expected-commit/);
  });

  it("does not write failure evidence into a root it did not create", async () => {
    const root = join(tmpdir(), `shellx-motion-v25c4-existing-${process.pid}-${Date.now()}`);
    await mkdir(root, { mode: 0o700 });
    try {
      const { stdout } = await runFile("git", ["rev-parse", "HEAD"], { cwd: fileURLToPath(new URL("..", import.meta.url)) });
      await expect(qualifyV25c4Native(["--", "--scratch-root", root, "--expected-commit", stdout.trim()])).rejects.toThrow(/clean tracked working tree|already exists/);
      await expect(readFile(join(root, "evidence", "v25-c4-native-qualification.json"))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps real-runtime requirements and internal-only registry setup in the host runner", async () => {
    const source = await readFile(runnerPath, "utf8");
    expect(source).toContain('"../packages/renderer-browser/src/effect-module-registry"');
    expect(source).toContain("renderStreamingFinal({");
    expect(source).toContain('frameLane: "gpu"');
    expect(source).toContain("ffprobe");
    expect(source).toContain("compareDecodedFrames");
    expect(source).toContain("Cold replay identity differs");
    expect(source).toContain('loadMotionPackage(paths.moduleOnPackage)');
    expect(source).not.toContain('renderCase("cold-replay", await loadMotionPackage(fixtureRoot)');
    expect(source).toContain('args[0] === "--" ? args.slice(1) : args');
    expect(source).toContain('normalized[2] === "--expected-commit"');
    expect(source).toContain('git("status", "--porcelain", "--untracked-files=no")');
    expect(source).not.toContain("openRuntime:");
    expect(source).not.toContain("processFactory:");
    expect(source).not.toContain("forceSoftwareEncode:");
    expect(source).not.toContain("rm(");
  });
});
