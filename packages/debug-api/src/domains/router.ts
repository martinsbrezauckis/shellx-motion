import type { MotionDebugCommand, MotionDebugDomain, MotionDebugResult } from "../command-registry.js";
import { dispatchAuthoringCommand, type AuthoringDomainServices } from "./authoring.js";
import { dispatchAgentCommand, type AgentDomainServices } from "./agent.js";
import { dispatchCapabilitiesCommand } from "./capabilities.js";
import { dispatchIntegrationCommand, type IntegrationDomainServices } from "./integration.js";
import { dispatchRenderCommand, type RenderDomainServices } from "./render.js";
import { dispatchSurfaceCommand, type SurfaceDomainServices } from "./surface.js";
import { dispatchWorkspaceCommand, type WorkspaceDomainServices } from "./workspace.js";
import { dispatchTimelineCommand, type TimelineDomainServices } from "./timeline.js";

export async function dispatchDomainCommand(
  domain: MotionDebugDomain,
  command: MotionDebugCommand,
  args: unknown,
  services: AgentDomainServices & IntegrationDomainServices & WorkspaceDomainServices & AuthoringDomainServices & TimelineDomainServices & SurfaceDomainServices & RenderDomainServices = {}
): Promise<MotionDebugResult | null> {
  if (domain === "surface") return await dispatchSurfaceCommand(command, args, services) ?? await dispatchCapabilitiesCommand(command, args);
  if (domain === "agent") return dispatchAgentCommand(command, args, services);
  if (domain === "render") return dispatchRenderCommand(command, args, services);
  if (domain === "integration") return dispatchIntegrationCommand(command, args, services);
  if (domain === "workspace") return dispatchWorkspaceCommand(command, args, services);
  if (domain === "authoring") return dispatchAuthoringCommand(command, args, services);
  if (domain === "timeline") return dispatchTimelineCommand(command, args, services);
  return null;
}
