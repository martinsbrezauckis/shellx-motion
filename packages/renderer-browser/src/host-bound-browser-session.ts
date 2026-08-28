/** Host-only authority binding kept outside the cap-bound renderer entry module. */
import {
  APPROVED_AGENT_SCRIPT_MODE,
  AgentScriptProvenanceRefusal,
  type AgentScriptExecutionEvidence,
  type AgentScriptProvenanceAuthority,
  type MotionPackage
} from "@shellx-motion/core";
import type {
  BrowserFrameOptions,
  BrowserFrameResult,
  BrowserRenderSessionOptions,
  MotionBrowserRenderSession
} from "./index";
import { assertNoStructuralPrivatePublication } from "./private-output-publication";

export type MotionBrowserRenderSessionFactory = (
  pkg: MotionPackage,
  options?: BrowserRenderSessionOptions
) => Promise<MotionBrowserRenderSession>;

export function bindHostBrowserSessionFactory(
  createSession: MotionBrowserRenderSessionFactory,
  authority: AgentScriptProvenanceAuthority | undefined
): MotionBrowserRenderSessionFactory {
  return async (pkg, options = {}) => {
    if (authority) options.agentScriptAuthority = authority;
    else delete options.agentScriptAuthority;
    return await createSession(pkg, options);
  };
}

export function browserFrameRendererForSessionFactory(
  sessionFactory: MotionBrowserRenderSessionFactory
): (pkg: MotionPackage, options: BrowserFrameOptions) => Promise<BrowserFrameResult> {
  return async (pkg, options) => {
    // This wrapper otherwise opens the host session before `renderFrame` reaches the
    // public-entry rejection. Refuse forged legacy output authority before any browser
    // launch, package load, or host-side session allocation.
    assertNoStructuralPrivatePublication(options);
    const session = await sessionFactory(pkg, { networkAccess: options.networkAccess });
    try { return await session.renderFrame(options); } finally { await session.close(); }
  };
}

export function assertEnforcedBrowserDataOnly(evidence: AgentScriptExecutionEvidence): void {
  if (evidence.activeMode !== APPROVED_AGENT_SCRIPT_MODE) return;
  throw new AgentScriptProvenanceRefusal(
    "Enforced-untrusted browser execution remains data-only; approved-agent-entry scripts require the trusted host session path."
  );
}
