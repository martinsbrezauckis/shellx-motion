import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { DEBUG_COMMAND_CONTRACTS } from "@shellx-motion/debug-api";
import { planMotionDebugServerCli, workbenchBootstrapUrl, writeEphemeralCapabilityFile } from "./cli";
import { userLaunchArgs } from "./user-launcher";
import {
  clearMotionServerPort,
  motionUserAccessPaths,
  readOrCreatePersistentCapabilityFile,
  writeMotionServerPort
} from "./user-access";

const execFileAsync = promisify(execFile);

describe("motion debug server CLI", () => {
  it("plans a dry-run startup manifest for host agents", () => {
    const plan = planMotionDebugServerCli([
      "--dry-run",
      "--host",
      "127.0.0.1",
      "--port",
      "7310",
      "--tier",
      "edit_motion",
      "--trusted-local-tier"
    ]);

    expect(plan).toEqual({
      ok: true,
      command: "debug-server",
      dryRun: true,
      host: "127.0.0.1",
      port: 7310,
      grantedTier: "edit_motion",
      allowNonLoopback: false,
      allowedHosts: [],
      allowedOrigins: [],
      artifactRoots: [],
      templateRoots: [],
      persistentAccess: false,
      openWorkbench: false,
      transport: {
        auth: {
          http: "authorization-bearer",
          webSocket: "authenticated-subprotocol",
          tokenEnv: "SHELLX_MOTION_DEBUG_TOKEN"
        },
        rest: {
          health: "/health",
          contracts: "/debug/contracts",
          dispatch: "/debug",
          sdk: "/sdk"
        },
        workbench: {
          ui: "/workbench",
          connections: "/workbench/connections",
          bootstrap: "/workbench/bootstrap",
          artifact: "/workbench/artifact",
          poster: "/workbench/poster",
          updateState: "/workbench/update-state",
          selectPath: "/workbench/select-path",
          auth: "one-use-launch-or-session-token-entry"
        },
        jsonRpc: {
          endpoint: "/rpc",
          methods: ["rpc.discover", "motion.debug.contracts", "motion.debug.dispatch", "server/discover", "initialize", "tools/list", "tools/call"]
        },
        mcp: {
          endpoint: "/rpc",
          methods: ["server/discover", "initialize", "tools/list", "tools/call"],
          toolNamePattern: "motion_<debug_command_with_dots_as_underscores>"
        },
        webSocket: {
          endpoint: "/ws",
          transport: "websocket-json-rpc",
          methods: ["rpc.discover", "motion.debug.contracts", "motion.debug.dispatch", "server/discover", "initialize", "tools/list", "tools/call"]
        }
      },
      contractCount: DEBUG_COMMAND_CONTRACTS.length
    });
  });

  it("collects repeated --artifact-root paths for bounded Workbench artifacts", () => {
    const plan = planMotionDebugServerCli([
      "--dry-run",
      "--artifact-root",
      "/tmp/templates/shellx-product-pack",
      "--artifact-root",
      "/tmp/extra-assets"
    ]);
    expect(plan).toMatchObject({
      ok: true,
      artifactRoots: ["/tmp/templates/shellx-product-pack", "/tmp/extra-assets"]
    });
  });

  it("collects repeated --template-root paths for agent reference discovery", () => {
    const plan = planMotionDebugServerCli([
      "--dry-run",
      "--template-root",
      "/tmp/templates/shellx-product-pack",
      "--template-root",
      "/tmp/team-templates"
    ]);
    expect(plan).toMatchObject({
      ok: true,
      templateRoots: ["/tmp/templates/shellx-product-pack", "/tmp/team-templates"]
    });
  });

  it("rejects invalid CLI ports before binding", () => {
    expect(planMotionDebugServerCli(["--port", "not-a-number"])).toEqual({
      ok: false,
      command: "debug-server",
      error: {
        code: "invalid_args",
        message: "debug-server --port must be an integer from 0 to 65535."
      }
    });
  });

  it("requires an explicit trust flag for grants above read-only", () => {
    expect(planMotionDebugServerCli(["--tier", "write_local"])).toEqual({
      ok: false,
      command: "debug-server",
      error: {
        code: "invalid_args",
        message: "debug-server tiers above read_motion require --trusted-local-tier."
      }
    });
  });

  it("requires a separate push grant and disables direct non-loopback binding", () => {
    expect(planMotionDebugServerCli(["--tier", "push_remote", "--trusted-local-tier"])).toMatchObject({
      ok: false,
      error: { message: "debug-server push_remote requires --allow-push-remote." }
    });
    expect(planMotionDebugServerCli(["--host", "0.0.0.0"])).toMatchObject({
      ok: false,
      error: { message: "debug-server direct non-loopback binding is disabled; bind loopback and use an authenticated HTTPS reverse proxy or SSH tunnel." }
    });
    expect(planMotionDebugServerCli(["--allow-non-loopback", "--allowed-host", "motion.example"])).toMatchObject({
      ok: false,
      error: { message: "debug-server direct non-loopback binding is disabled; bind loopback and use an authenticated HTTPS reverse proxy or SSH tunnel." }
    });
  });

  it("writes generated capabilities only to a private ephemeral file", async () => {
    const capabilityToken = "ephemeral-test-capability-000000000000000000";
    const { tokenRoot, tokenFile } = await writeEphemeralCapabilityFile(capabilityToken);
    try {
      expect(await readFile(tokenFile, "utf8")).toBe(`${capabilityToken}\n`);
      if (process.platform === "win32") {
        await expectWindowsUserOnlyAcl(tokenRoot);
        await expectWindowsUserOnlyAcl(tokenFile);
      } else {
        expect((await stat(tokenRoot)).mode & 0o777).toBe(0o700);
        expect((await stat(tokenFile)).mode & 0o777).toBe(0o600);
      }
    } finally {
      await rm(tokenRoot, { recursive: true, force: true });
    }
  });

  it("reuses one private per-user access key and publishes only the live server port", async () => {
    const parent = await mkdtemp(join(tmpdir(), "motion-user-access-test-"));
    const paths = motionUserAccessPaths(join(parent, "state"));
    try {
      const first = await readOrCreatePersistentCapabilityFile(paths);
      const second = await readOrCreatePersistentCapabilityFile(paths);
      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.token).toBe(first.token);
      expect((await readFile(paths.tokenFile, "utf8")).trim()).toBe(first.token);

      await writeMotionServerPort(paths, 43821);
      expect(await readFile(paths.portFile, "utf8")).toBe("43821\n");
      await clearMotionServerPort(paths, 11111);
      expect(await readFile(paths.portFile, "utf8")).toBe("43821\n");
      await clearMotionServerPort(paths, 43821);
      await expect(readFile(paths.portFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

      if (process.platform !== "win32") {
        const outside = join(parent, "outside-port-target");
        await writeFile(outside, "unchanged\n");
        await symlink(outside, paths.portFile);
        await expect(writeMotionServerPort(paths, 44991)).rejects.toThrow(/regular file/);
        expect(await readFile(outside, "utf8")).toBe("unchanged\n");
        await rm(paths.portFile, { force: true });
      }

      if (process.platform === "win32") {
        await expectWindowsUserOnlyAcl(paths.root);
        await expectWindowsUserOnlyAcl(paths.tokenFile);

        // Red-proof reuse: an explicit foreign ACE survives icacls /grant:r, so seed one
        // on both existing paths and require the next normal access-key read to replace it.
        await grantWindowsForeignReadAcl(paths.root);
        await grantWindowsForeignReadAcl(paths.tokenFile);
        await readOrCreatePersistentCapabilityFile(paths);
        await expectWindowsUserOnlyAcl(paths.root);
        await expectWindowsUserOnlyAcl(paths.tokenFile);
      } else {
        expect((await stat(paths.root)).mode & 0o777).toBe(0o700);
        expect((await stat(paths.tokenFile)).mode & 0o777).toBe(0o600);
      }
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("builds a non-secret startup manifest plus a one-use fragment URL for the human launcher", () => {
    const plan = planMotionDebugServerCli(["--persistent-access", "--open-workbench"]);
    expect(plan).toMatchObject({ ok: true, persistentAccess: true, openWorkbench: true });
    expect(userLaunchArgs([])).toEqual([
      "--tier", "write_local", "--trusted-local-tier", "--persistent-access", "--open-workbench"
    ]);
    const url = workbenchBootstrapUrl(new URL("http://127.0.0.1:43210"), "bootstrap-token-000000000000000000000000");
    expect(url).toBe("http://127.0.0.1:43210/workbench#bootstrap=bootstrap-token-000000000000000000000000");
  });
});

async function expectWindowsUserOnlyAcl(path: string): Promise<void> {
  const script = [
    "$acl = Get-Acl -LiteralPath $env:SHELLX_MOTION_TEST_ACL_PATH",
    "$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "$rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))",
    "$foreign = @($rules | Where-Object { $_.IdentityReference.Value -ne $sid })",
    "[pscustomobject]@{ protected = $acl.AreAccessRulesProtected; ruleCount = $rules.Count; foreignRuleCount = $foreign.Count } | ConvertTo-Json -Compress"
  ].join("; ");
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, SHELLX_MOTION_TEST_ACL_PATH: path }
  });
  const acl = JSON.parse(stdout) as { protected?: boolean; ruleCount?: number; foreignRuleCount?: number };
  expect(acl).toMatchObject({ protected: true, foreignRuleCount: 0 });
  expect(acl.ruleCount).toBeGreaterThan(0);
}

async function grantWindowsForeignReadAcl(path: string): Promise<void> {
  await execFileAsync("icacls.exe", [path, "/grant", "*S-1-5-32-545:(R)", "/q"], {
    encoding: "utf8",
    windowsHide: true
  });
}
