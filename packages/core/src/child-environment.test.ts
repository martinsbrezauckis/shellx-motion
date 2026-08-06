/**
 * A child process must not inherit the Debug API bearer token, or anything else credential-shaped.
 *
 * Role: pins the rule that `spawn`/`execFile` sites must not inherit the parent's full environment.
 * `SHELLX_MOTION_DEBUG_TOKEN` is the Debug API's documented bearer credential and must not reach
 * FFmpeg, FFprobe, Chromium, `cargo`, or agent CLIs.
 *
 * The sharpest case is the agent lane. Those adapters are the operator's OWN subscription CLIs
 * (codex, claude, grok, antigravity) — not third-party binaries, so this is not a supply-chain
 * exposure. It matters because those CLIs exist to run MODEL-AUTHORED commands: a prompt-injected
 * model that can run a shell command can read its own environment, and the token in there is
 * authenticated Debug API control at the operator's tier. The trust boundary is the model's output,
 * not the vendor.
 *
 * Dependencies: `./child-environment`. Primary caller: `pnpm test` in `packages/core`.
 */
import { describe, expect, it } from "vitest";
import { childEnvironment, isSecretEnvName } from "./child-environment";

describe("child environment", () => {
  it("strips the Debug API token and credential-shaped names", () => {
    const source = {
      PATH: "/usr/bin:/bin",
      HOME: "/home/operator",
      LANG: "en_GB.UTF-8",
      SHELLX_MOTION_DEBUG_TOKEN: "live-bearer-do-not-leak",
      GITHUB_TOKEN: "ghp_do-not-leak",
      AWS_SECRET_ACCESS_KEY: "do-not-leak",
      OPENAI_API_KEY: "sk-do-not-leak",
      ANTHROPIC_KEY: "do-not-leak",
      DB_PASSWORD: "do-not-leak",
      SESSION_ID: "do-not-leak",
      MY_PRIVATE_KEY: "do-not-leak"
    };

    const environment = childEnvironment({ source });

    // What a renderer actually needs survives.
    expect(environment.PATH).toBe("/usr/bin:/bin");
    expect(environment.HOME).toBe("/home/operator");
    expect(environment.LANG).toBe("en_GB.UTF-8");

    // Nothing credential-shaped does.
    for (const name of [
      "SHELLX_MOTION_DEBUG_TOKEN", "GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY",
      "OPENAI_API_KEY", "ANTHROPIC_KEY", "DB_PASSWORD", "SESSION_ID", "MY_PRIVATE_KEY"
    ]) {
      expect(environment, `${name} must not reach a child`).not.toHaveProperty(name);
    }
    // And no value leaks under a different key.
    expect(Object.values(environment).join("\n")).not.toContain("do-not-leak");
  });

  it("never mutates the source environment", () => {
    const source = { PATH: "/bin", SHELLX_MOTION_DEBUG_TOKEN: "secret" };
    childEnvironment({ source });
    expect(source.SHELLX_MOTION_DEBUG_TOKEN).toBe("secret");
  });

  it("lets a caller pass a withheld variable through deliberately", () => {
    // The exception path exists so handing a child a credential is a greppable act at the call site,
    // not the silent default it used to be.
    const environment = childEnvironment({
      source: { PATH: "/bin", SHELLX_MOTION_DEBUG_TOKEN: "stripped" },
      extra: { SHELLX_MOTION_DEBUG_TOKEN: "deliberate" }
    });
    expect(environment.SHELLX_MOTION_DEBUG_TOKEN).toBe("deliberate");
  });

  it("classifies names by shape, not by an enumerated vendor list", () => {
    for (const name of [
      "TOKEN", "API_TOKEN", "SOME_SECRET", "X_PASSWORD", "SERVICE_API_KEY",
      "AWS_ACCESS_KEY_ID", "MY_PRIVATE_KEY", "GCP_CREDENTIALS", "AUTH_HEADER",
      "SESSION_TOKEN", "COOKIE_JAR", "BEARER_TOKEN", "VENDOR_KEY"
    ]) {
      expect(isSecretEnvName(name), `${name} should be withheld`).toBe(true);
    }
    for (const name of [
      "PATH", "HOME", "USERPROFILE", "TMPDIR", "TEMP", "LANG", "LC_ALL",
      "SystemRoot", "WINDIR", "LOCALAPPDATA", "DISPLAY", "WAYLAND_DISPLAY",
      "SHELLX_MOTION_MAX_JOB_RSS_BYTES", "KEYBOARD_LAYOUT", "MONKEY"
    ]) {
      expect(isSecretEnvName(name), `${name} should pass through`).toBe(false);
    }
  });
});
