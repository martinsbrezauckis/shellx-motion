import { chmod, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { untrustedExecutableFileReason } from "@shellx-motion/core";
import {
  configureMotionAgent,
  resolveMotionAgentProviderExecutable,
  resolveWindowsPowerShellExecutable
} from "./workbench-connections";

describe("Workbench provider configuration", () => {
  it.skipIf(process.platform !== "win32")(
    "uses the shared OS-owned PowerShell resolver despite poisoned process roots",
    async () => {
      const previous = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR };
      process.env.SystemRoot = "D:\\attacker-windows";
      process.env.WINDIR = "D:\\attacker-windows";
      try {
        const executable = await resolveWindowsPowerShellExecutable();
        expect(executable.toLowerCase()).toMatch(/\\system32\\windowspowershell\\v1\.0\\powershell\.exe$/);
        expect(executable).not.toContain("attacker-windows");
      } finally {
        if (previous.SystemRoot === undefined) delete process.env.SystemRoot;
        else process.env.SystemRoot = previous.SystemRoot;
        if (previous.WINDIR === undefined) delete process.env.WINDIR;
        else process.env.WINDIR = previous.WINDIR;
      }
    }
  );

  it("runs the host-approved canonical provider with a credential-filtered environment", async () => {
    const root = await mkdtemp(join(tmpdir(), "motion-provider-executable-"));
    const posixExecutable = join(root, "codex");
    await writeFile(posixExecutable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await chmod(posixExecutable, 0o700);
    const pathIsHostVerifiable = process.platform === "win32" || untrustedExecutableFileReason(posixExecutable) === null;
    const platform = pathIsHostVerifiable ? process.platform : "win32";
    const executable = platform === "win32" ? join(root, "codex.exe") : posixExecutable;
    if (executable !== posixExecutable) {
      await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      await chmod(executable, 0o700);
    }
    const source = {
      PATH: root,
      HOME: "/home/operator",
      LANG: "C",
      SHELLX_MOTION_DEBUG_TOKEN: "debug-token-do-not-leak",
      SSH_AUTH_SOCK: "/run/user/1000/ssh-agent",
      KRB5CCNAME: "FILE:/tmp/krb5cc",
      GPG_AGENT_INFO: "/run/user/1000/gnupg/S.gpg-agent",
      KUBECONFIG: "/home/operator/.kube/config",
      XAUTHORITY: "/home/operator/.Xauthority",
      DOCKER_CONFIG: "/home/operator/.docker"
    };
    try {
      const launches: Array<{ executable: string; args: string[]; env: Record<string, string> }> = [];
      const result = await configureMotionAgent("codex", { command: "/host/motion-mcp", args: ["--stdio"] }, {
        source,
        platform,
        run: async (launch) => { launches.push(launch); }
      });

      expect(result).toEqual({ provider: "codex", configured: true, alreadyConfigured: false });
      expect(launches).toHaveLength(1);
      expect(launches[0]).toMatchObject({
        executable: await realpath(executable),
        args: ["mcp", "add", "shellx-motion", "--", "/host/motion-mcp", "--stdio"],
        env: { PATH: root, HOME: "/home/operator", LANG: "C" }
      });
      for (const name of ["SHELLX_MOTION_DEBUG_TOKEN", "SSH_AUTH_SOCK", "KRB5CCNAME", "GPG_AGENT_INFO", "KUBECONFIG", "XAUTHORITY", "DOCKER_CONFIG"]) {
        expect(launches[0].env, `${name} must not reach the provider CLI`).not.toHaveProperty(name);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves a provider symlink to its revalidated canonical target", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "motion-provider-link-"));
    const posixTarget = join(root, "provider-target");
    await writeFile(posixTarget, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await chmod(posixTarget, 0o700);
    const platform = untrustedExecutableFileReason(posixTarget) === null ? process.platform : "win32";
    const target = platform === "win32" ? join(root, "provider-target.exe") : posixTarget;
    if (target !== posixTarget) {
      await writeFile(target, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      await chmod(target, 0o700);
    }
    const linked = join(root, platform === "win32" ? "codex.exe" : "codex");
    try {
      await symlink(target, linked);
      await expect(resolveMotionAgentProviderExecutable("codex", { PATH: root }, platform)).resolves.toBe(await realpath(target));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
