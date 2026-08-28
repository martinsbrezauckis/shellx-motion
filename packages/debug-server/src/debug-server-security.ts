/** Server-owned state shared by authenticated transports and the human-only Workbench. */
import type { RetainedDirectoryAuthority } from "@shellx-motion/core";
import type { MotionDebugContext } from "@shellx-motion/debug-api";
import type { MotionSdkTransport } from "@shellx-motion/sdk";
import type { MotionAgentSnapshotResourceSource } from "./mcp-resources.js";
import type { OperatorReceiptGrants, OperatorRenderGrants } from "./operator-receipt-grants.js";
import type { MotionAgentConfigurator } from "./workbench-connections.js";
import type { RevealOpener } from "./workbench-reveal.js";
import type { WorkbenchUpdateController } from "./workbench-update-controller.js";
import type { UpdateFetch } from "./workbench-update.js";
import type { EffectModuleWorkbenchSecurity } from "./workbench-effect-modules.js";

export type MotionPermissionTier = MotionDebugContext["tier"];

export interface MotionDebugServerSecurityContext extends EffectModuleWorkbenchSecurity {
  capabilityToken: string;
  /** Cleared synchronously after the first successful Workbench bootstrap exchange. */
  workbenchBootstrapToken: string | null;
  /** Removes the private bootstrap handoff after its one successful exchange. */
  onWorkbenchBootstrapClaim?: () => void | Promise<void>;
  /**
   * Stable identity for this authenticated server instance, stamped as the receipt actor
   * `sessionId` on every request that lacks a longer-lived per-connection id. Random per process
   * start — it names "this debug-server session" without leaking the capability token.
   */
  sessionId: string;
  /** Opaque principal reserved for the server-created in-process SDK transport. */
  jobOwnerPrincipal: string;
  context: Partial<Omit<MotionDebugContext, "tier">>;
  allowedOrigins: Set<string>;
  allowedHosts: Set<string>;
  sdkTransport: MotionSdkTransport;
  artifactRoots: string[];
  /** Exact startup identities behind artifactRoots; every later filesystem use revalidates them. */
  artifactRootAuthorities: readonly RetainedDirectoryAuthority[];
  /** Agent reference collections authorized for bounded poster reads. */
  templateRoots: string[];
  agentSnapshotSource?: MotionAgentSnapshotResourceSource;
  /** Absolute docs/public root served by the workbench documentation viewer. */
  docsRoot: string;
  /** `owner/repo` slug for the explicit update channel, or null when unconfigured. */
  updateRepo: string | null;
  /** GitHub API base for the update channel. */
  updateApiBaseUrl: string;
  /** Packaged-install root marker, or null when running from a source checkout. */
  installRoot: string | null;
  /** Upstream timeout for the update feed request, in milliseconds. */
  updateTimeoutMs: number;
  /** Unsafe development override allowing a non-GitHub base / private addresses for the update feed. */
  updateAllowUnsafeBase: boolean;
  /** Fetch implementation used by the update channel (undefined => pinned node transport default). */
  updateFetch: UpdateFetch | undefined;
  /** One cached update result shared by the UI and every discovery transport. */
  updateController: WorkbenchUpdateController;
  /** OS opener used by reveal-in-file-manager. */
  revealOpener: RevealOpener;
  /** Receipt folders a person chose in the native chooser this session; see operator-receipt-grants.ts. */
  operatorReceiptRoots: OperatorReceiptGrants;
  /** Render roots a person chose in the native chooser this session. */
  operatorRenderGrants: OperatorRenderGrants;
  /** Allowlisted provider-CLI configuration action used by the Connections page. */
  connectionConfigurator: MotionAgentConfigurator;
}
