import { describe, expect, it } from "vitest";

import { npmPackDryRun, npmPackDryRunCommand } from "./packed-files-gate.mjs";

const npmArgs = ["pack", "--dry-run", "--json"];
const windowsNode = "C:\\Program Files\\nodejs\\node.exe";
const windowsNpmCli = "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js";

describe("packed-files npm command", () => {
  it.each(["linux", "darwin"] as const)("keeps the POSIX npm executable invocation on %s", (platform) => {
    expect(npmPackDryRunCommand(platform, "/usr/local/bin/node")).toEqual({
      executable: "npm",
      args: npmArgs
    });
  });

  it("runs the Windows npm CLI through the trusted Node executable", () => {
    expect(npmPackDryRunCommand("win32", windowsNode, () => true)).toEqual({
      executable: windowsNode,
      args: [windowsNpmCli, ...npmArgs]
    });
  });

  it("reports a missing bundled Windows npm CLI before spawning", () => {
    expect(() => npmPackDryRunCommand("win32", windowsNode, () => false)).toThrow(
      "packed-files: could not resolve npm's JavaScript entrypoint beside C:\\Program Files\\nodejs\\node.exe."
    );
  });

  it("uses the direct Windows command without a shell", () => {
    const calls: Array<{ executable: string; args: string[]; options: Record<string, unknown> }> = [];

    expect(npmPackDryRun("C:\\workspace\\package", {
      platform: "win32",
      nodeExecutable: windowsNode,
      pathExists: () => true,
      execFile: (executable, args, options) => {
        calls.push({ executable, args, options });
        return JSON.stringify([{ files: [{ path: "package.json" }] }]);
      }
    })).toEqual(["package.json"]);

    expect(calls).toEqual([{
      executable: windowsNode,
      args: [windowsNpmCli, ...npmArgs],
      options: {
        cwd: "C:\\workspace\\package",
        encoding: "utf8",
        shell: false,
        stdio: ["ignore", "pipe", "pipe"]
      }
    }]);
  });
});
