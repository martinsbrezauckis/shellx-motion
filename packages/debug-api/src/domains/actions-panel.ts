import { ACTIONS, type MotionPermissionTier } from "@shellx-motion/actions";
import { compareCodeUnits } from "@shellx-motion/core";
import { promptPanelCandidates, promptProviderSelection, type AgentPanelRuntime, type PromptProviderSelection } from "./agent-panels.js";

const TIER_ORDER: MotionPermissionTier[] = ["read_motion", "draft_motion", "render_motion", "edit_motion", "write_local", "push_remote"];

interface ActionsPanelCard {
  id: string;
  primaryAlias: string;
  aliasCount: number;
  permission: MotionPermissionTier;
  mutates: boolean;
  calls: string[];
  callCount: number;
  verify: string[];
  surfaces: string[];
  primarySurface: string;
}

interface ActionsPanelSurface {
  id: string;
  label: string;
  actionCount: number;
  mutatingActionCount: number;
  actionIds: string[];
}

interface ActionsPanelPermission {
  tier: MotionPermissionTier;
  actionCount: number;
  mutatingActionCount: number;
  actionIds: string[];
}

interface ActionsPanelCommand {
  id: "find" | "guide" | "plan" | "agentPanel" | "agentHealth";
  command: "motion.actions.find" | "motion.actions.guide" | "motion.actions.plan" | "motion.agent.panel" | "motion.agent.health";
  args: { request: string } | Record<string, never>;
}

export interface ActionsPanel {
  actionCount: number;
  promptActionCount: number;
  readOnlyActionCount: number;
  mutatingActionCount: number;
  surfaceCount: number;
  actions: ActionsPanelCard[];
  surfaces: ActionsPanelSurface[];
  permissions: ActionsPanelPermission[];
  promptCommands: ActionsPanelCommand[];
  promptProviderSelection: PromptProviderSelection;
  suggestedActions: Array<{
    id: "plan" | "agentPanel" | "agentHealth";
    command: "motion.actions.plan" | "motion.agent.panel" | "motion.agent.health";
    args: { request: string } | Record<string, never>;
  }>;
}

export function buildActionsPanel(agentRuntime?: AgentPanelRuntime): ActionsPanel {
  const actions = ACTIONS.map((action): ActionsPanelCard => ({
    id: action.id,
    primaryAlias: action.aliases[0] ?? action.id,
    aliasCount: action.aliases.length,
    permission: action.permission,
    mutates: action.mutates,
    calls: action.calls,
    callCount: action.calls.length,
    verify: action.verify,
    surfaces: action.surfaces,
    primarySurface: action.surfaces[0] ?? "prompt"
  }));
  const surfaceIds = [...new Set(actions.flatMap((action) => action.surfaces))]
    .sort((left, right) => surfaceSortRank(left) - surfaceSortRank(right) || compareCodeUnits(left, right));
  const surfaces = surfaceIds.map((surfaceId): ActionsPanelSurface => {
    const surfaceActions = actions.filter((action) => action.surfaces.includes(surfaceId));
    return {
      id: surfaceId,
      label: actionSurfaceLabel(surfaceId),
      actionCount: surfaceActions.length,
      mutatingActionCount: surfaceActions.filter((action) => action.mutates).length,
      actionIds: surfaceActions.map((action) => action.id)
    };
  });
  const permissions = TIER_ORDER
    .map((tier): ActionsPanelPermission => {
      const tierActions = actions.filter((action) => action.permission === tier);
      return {
        tier,
        actionCount: tierActions.length,
        mutatingActionCount: tierActions.filter((action) => action.mutates).length,
        actionIds: tierActions.map((action) => action.id)
      };
    })
    .filter((permission) => permission.actionCount > 0);
  const mutatingActionCount = actions.filter((action) => action.mutates).length;
  const candidates = promptPanelCandidates(agentRuntime);
  return {
    actionCount: actions.length,
    promptActionCount: actions.filter((action) => action.surfaces.includes("prompt")).length,
    readOnlyActionCount: actions.length - mutatingActionCount,
    mutatingActionCount,
    surfaceCount: surfaces.length,
    actions,
    surfaces,
    permissions,
    promptCommands: [
      { id: "find", command: "motion.actions.find", args: { request: "" } },
      { id: "guide", command: "motion.actions.guide", args: { request: "" } },
      { id: "plan", command: "motion.actions.plan", args: { request: "" } },
      { id: "agentPanel", command: "motion.agent.panel", args: {} },
      { id: "agentHealth", command: "motion.agent.health", args: {} }
    ],
    promptProviderSelection: promptProviderSelection(candidates),
    suggestedActions: [
      { id: "plan", command: "motion.actions.plan", args: { request: "describe the Motion task" } },
      { id: "agentPanel", command: "motion.agent.panel", args: {} },
      { id: "agentHealth", command: "motion.agent.health", args: {} }
    ]
  };
}

function surfaceSortRank(surfaceId: string): number {
  const order = ["prompt", "packages", "timeline", "templateInspector", "preview", "receipts", "assets", "brand"];
  const index = order.indexOf(surfaceId);
  return index === -1 ? order.length : index;
}

function actionSurfaceLabel(surfaceId: string): string {
  const labels: Record<string, string> = {
    prompt: "Prompt",
    packages: "Packages",
    timeline: "Timeline",
    templateInspector: "Template Inspector",
    preview: "Preview",
    receipts: "Receipts",
    assets: "Assets",
    brand: "Brand"
  };
  return labels[surfaceId] ?? surfaceId;
}
