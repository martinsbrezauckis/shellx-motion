import { chromium, type Browser } from "playwright-core";
import {
  childEnvironment,
  motionBrowserExecutableVerificationProblem,
  motionBrowserOverrideProblem,
  MOTION_BROWSER_OVERRIDE_ENV_VAR,
  resolveMotionBrowserExecutable,
  type LocalMotionRuntimeSandboxEvidence,
  type MotionDocument,
} from "@shellx-motion/core";
import {
  assertEnforcedUntrustedBrowserDefaultLaunch,
  prepareEnforcedUntrustedBrowserLaunch,
  promoteEnforcedUntrustedBrowserLaunchEvidence,
} from "./enforced-untrusted-browser";

export async function launchOwnedBrowserSession(input: {
  readonly motion: MotionDocument;
  readonly packageRoot: string;
  readonly chromiumArgs: readonly string[];
  readonly networkAccessRequested: boolean;
  readonly enforcedUntrustedExecution: boolean;
  readonly launchBrowser?: (options: { executablePath: string; headless: true; args: string[]; env: Record<string, string> }) => Promise<Browser>;
}): Promise<{ browser: Browser; sandboxEvidence: LocalMotionRuntimeSandboxEvidence }> {
  if (input.enforcedUntrustedExecution) await assertEnforcedUntrustedBrowserDefaultLaunch(input.launchBrowser);
  const location = findBrowserExecutable();
  const untrustedLaunch = input.enforcedUntrustedExecution
    ? await prepareEnforcedUntrustedBrowserLaunch({ motion: input.motion, packageRoot: input.packageRoot, browserExecutable: location.executable, chromiumArgs: [...input.chromiumArgs], networkAccessRequested: input.networkAccessRequested })
    : undefined;
  assertBrowserExecutableStillTrusted(location);
  const options = {
    executablePath: untrustedLaunch?.executablePath ?? location.executable,
    headless: true as const,
    ...(input.enforcedUntrustedExecution ? { chromiumSandbox: true } : {}),
    handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
    args: untrustedLaunch?.args ?? [...input.chromiumArgs], env: untrustedLaunch?.env ?? childEnvironment()
  };
  const browser = untrustedLaunch ? await chromium.launch(options) : input.launchBrowser ? await input.launchBrowser(options) : await chromium.launch(options);
  return {
    browser,
    sandboxEvidence: untrustedLaunch
      ? promoteEnforcedUntrustedBrowserLaunchEvidence(untrustedLaunch.evidence)
      : chromiumRuntimeSandboxEvidence(options.args, options.chromiumSandbox === true)
  };
}

function findBrowserExecutable() {
  const location = resolveMotionBrowserExecutable();
  if (motionBrowserExecutableVerificationProblem(location)) throw new Error(motionBrowserOverrideProblem() ?? `No Chrome/Chromium executable found for browser renderer. Set ${MOTION_BROWSER_OVERRIDE_ENV_VAR}.`);
  return location;
}
function assertBrowserExecutableStillTrusted(location: ReturnType<typeof resolveMotionBrowserExecutable>): void {
  const problem = motionBrowserExecutableVerificationProblem(location);
  if (problem) throw new Error(`Motion refused the browser executable before launch: ${problem}.`);
}
export function chromiumRuntimeSandboxEvidence(args: readonly string[], chromiumSandbox = false): LocalMotionRuntimeSandboxEvidence {
  const optedOut = args.includes("--no-sandbox"); const disabled = optedOut || !chromiumSandbox;
  return { schema: "shellx-motion/runtime-sandbox@1", provider: "chromium", status: disabled ? "disabled" : "requested", scope: "browser-process", ...(disabled ? { reasonCode: optedOut ? "trusted_host_opt_out" : "playwright_default_no_sandbox" } : {}) };
}
