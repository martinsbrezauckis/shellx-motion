/**
 * Public-surface parity is deliberately a matrix, not a promise that each transport implements
 * every Debug command. Keep counts and named exceptions tied to the live source inventories.
 */
import { readFile, readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { ACTIONS } from "../packages/actions/src/catalog.js";
import { DEBUG_COMMAND_CONTRACTS } from "../packages/debug-api/src/command-metadata.js";
import { DEBUG_COMMANDS } from "../packages/debug-api/src/command-registry.js";
import {
  CLI_DIRECT_DEBUG_COMMANDS,
  CLI_NAMED_DEBUG_NO_ROUTE,
  CLI_SEMANTIC_DEBUG_EQUIVALENTS,
} from "../packages/cli/src/debug-subcommands.js";
import { mcpToolForDebugContract } from "../packages/debug-server/src/mcp-tool-shape.js";
import { LOCAL_MOTION_SDK_OPERATIONS } from "../packages/sdk/src/local-capabilities.js";

const ROOT = new URL("../", import.meta.url);
const semanticCommands = Object.keys(CLI_SEMANTIC_DEBUG_EQUIVALENTS).sort();
const debugCommands = [...DEBUG_COMMANDS].sort();
const directCommandEntries = Object.values(CLI_DIRECT_DEBUG_COMMANDS);
const directCommands = [...new Set(directCommandEntries)].sort();
const noRouteCommandEntries = [...CLI_NAMED_DEBUG_NO_ROUTE];
const noRouteCommands = [...noRouteCommandEntries].sort();
const surfaceCounts = {
  debug: debugCommands.length,
  direct: directCommands.length,
  semantic: semanticCommands.length,
  noRoute: noRouteCommands.length,
  sdk: LOCAL_MOTION_SDK_OPERATIONS.length,
  actions: ACTIONS.length,
};
type McpTool = { name: string; title: string };

describe("published Motion surface matrix", () => {
  it("partitions every Debug/MCP command into direct CLI, named CLI equivalent, or named no-route", () => {
    expect(new Set(debugCommands).size).toBe(surfaceCounts.debug);
    expect(new Set(directCommandEntries).size).toBe(directCommandEntries.length);
    expect(new Set(noRouteCommandEntries).size).toBe(noRouteCommandEntries.length);
    expect(semanticCommands).toEqual([
      "motion.connector.catalog",
      "motion.job.get",
      "motion.job.list",
      "motion.package.create",
      "motion.package.validate",
      "motion.platform.gpu.probe",
      "motion.platform.requirements",
    ]);
    expect(noRouteCommands).toEqual([
      "motion.agent.snapshot",
      "motion.connector.submit",
      "motion.job.cancel",
      "motion.job.events",
      "motion.job.retry",
      "motion.job.submit",
      "motion.keying.apply",
      "motion.keying.inspect",
      "motion.keying.remove",
      "motion.package.script.author",
      "motion.roto.remove",
      "motion.roto.tracking.detach",
      "motion.roto.upsert",
      "motion.timeline.checkpoint-storyboard.archive",
      "motion.timeline.checkpoint-storyboard.behavior.detach",
      "motion.timeline.checkpoint-storyboard.behavior.resolve",
      "motion.timeline.checkpoint-storyboard.create",
      "motion.timeline.checkpoint-storyboard.creative-review.bind",
      "motion.timeline.checkpoint-storyboard.detach",
      "motion.timeline.checkpoint-storyboard.geometry-morph.detach",
      "motion.timeline.checkpoint-storyboard.geometry-morph.resolve",
      "motion.timeline.checkpoint-storyboard.inspect",
      "motion.timeline.checkpoint-storyboard.lifecycle.detach",
      "motion.timeline.checkpoint-storyboard.lifecycle.resolve",
      "motion.timeline.checkpoint-storyboard.materialize",
      "motion.timeline.checkpoint-storyboard.preview",
      "motion.timeline.checkpoint-storyboard.preview-quality.review",
      "motion.timeline.checkpoint-storyboard.relation-action.detach",
      "motion.timeline.checkpoint-storyboard.relation-action.resolve",
      "motion.timeline.checkpoint-storyboard.relation.detach",
      "motion.timeline.checkpoint-storyboard.relation.resolve",
      "motion.timeline.checkpoint-storyboard.remove",
      "motion.timeline.checkpoint-storyboard.retained-trace.detach",
      "motion.timeline.checkpoint-storyboard.retained-trace.preview",
      "motion.timeline.checkpoint-storyboard.retained-trace.resolve",
      "motion.timeline.checkpoint-storyboard.retained-trace.review.bind",
      "motion.timeline.checkpoint-storyboard.revise",
      "motion.timeline.layout-gap-animation.inspect",
      "motion.timeline.layout-gap-animation.keyframe.delete",
      "motion.timeline.layout-gap-animation.keyframe.move",
      "motion.timeline.layout-gap-animation.keyframe.upsert",
      "motion.timeline.layout-gap-animation.track.remove",
      "motion.timeline.layout-gap-animation.track.upsert",
      "motion.timeline.relation-actions.apply",
      "motion.timeline.relation-actions.inspect",
      "motion.timeline.relation-actions.remove",
      "motion.timeline.relation-actions.upsert",
      "motion.timeline.relations.bake",
      "motion.timeline.relations.detach",
      "motion.timeline.relations.enabled.set",
      "motion.timeline.relations.inspect",
      "motion.timeline.relations.remove",
      "motion.timeline.relations.upsert",
      "motion.timeline.scene3d-animation.inspect",
      "motion.timeline.scene3d-animation.keyframe.delete",
      "motion.timeline.scene3d-animation.keyframe.move",
      "motion.timeline.scene3d-animation.keyframe.upsert",
      "motion.timeline.scene3d-animation.track.remove",
      "motion.timeline.scene3d-animation.track.upsert",
    ]);

    const privateResolutionCommands = [
      "motion.timeline.checkpoint-storyboard.lifecycle.resolve",
      "motion.timeline.checkpoint-storyboard.lifecycle.detach",
      "motion.timeline.checkpoint-storyboard.geometry-morph.resolve",
      "motion.timeline.checkpoint-storyboard.geometry-morph.detach",
      "motion.timeline.checkpoint-storyboard.retained-trace.resolve",
      "motion.timeline.checkpoint-storyboard.retained-trace.detach",
      "motion.timeline.checkpoint-storyboard.retained-trace.preview",
      "motion.timeline.checkpoint-storyboard.retained-trace.review.bind",
    ];
    for (const command of privateResolutionCommands) {
      expect(noRouteCommands).toContain(command);
      expect(directCommands).not.toContain(command);
      expect(semanticCommands).not.toContain(command);
      expect(LOCAL_MOTION_SDK_OPERATIONS).not.toContain(command as never);
      expect(ACTIONS.some((action) => action.calls.includes(command as never))).toBe(false);
    }

    const classified = [...directCommands, ...semanticCommands, ...noRouteCommands].sort();
    expect(new Set(classified).size).toBe(classified.length);
    expect(classified).toEqual(debugCommands);
  });

  it("keeps retained-trace Debug commands out of connectors and public renderer entrypoints", async () => {
    const resolverCommands = [
      "checkpoint-storyboard.retained-trace.resolve",
      "checkpoint-storyboard.retained-trace.detach",
      "checkpoint-storyboard.retained-trace.review.bind",
    ];
    for (const relativeRoot of ["packages/connectors/src/", "packages/renderer-browser/src/", "packages/renderer-native/src/", "packages/renderer-ffmpeg/src/"]) {
      const directory = new URL(relativeRoot, ROOT);
      for (const relativePath of await readdir(directory, { recursive: true })) {
        if (!/\.(?:c|m)?(?:j|t)sx?$/u.test(relativePath)) continue;
        const source = await readFile(new URL(relativePath, directory), "utf8");
        for (const command of resolverCommands) expect(source, `${relativeRoot}${relativePath} must not adopt ${command}`).not.toContain(command);
        if (relativeRoot !== "packages/renderer-browser/src/") expect(source, `${relativeRoot}${relativePath} must not adopt checkpoint-storyboard.retained-trace.preview`).not.toContain("checkpoint-storyboard.retained-trace.preview");
      }
    }
    const browserPublicRoot = await readFile(new URL("packages/renderer-browser/src/index.ts", ROOT), "utf8");
    expect(browserPublicRoot).not.toContain("checkpoint-storyboard.retained-trace.preview");
  });

  it("keeps MCP, SDK, and Actions counts tied to their source inventories", () => {
    const mcpTools = DEBUG_COMMAND_CONTRACTS.map((contract) => mcpToolForDebugContract(contract) as McpTool);
    expect(mcpTools).toHaveLength(surfaceCounts.debug);
    expect(new Set(mcpTools.map((tool) => tool.name)).size).toBe(mcpTools.length);
    expect(mcpTools.map((tool) => tool.title).sort()).toEqual(debugCommands);

    expect(new Set(LOCAL_MOTION_SDK_OPERATIONS).size).toBe(surfaceCounts.sdk);
    expect(new Set(ACTIONS.map((action) => action.id)).size).toBe(surfaceCounts.actions);
  });

  it("keeps every action's mutation truth equal to its registered Debug calls", () => {
    const contractsByCommand = new Map(DEBUG_COMMAND_CONTRACTS.map((contract) => [contract.command, contract]));

    for (const action of ACTIONS) {
      const missingCalls = action.calls.filter((call) => !contractsByCommand.has(call));
      expect(missingCalls, `${action.id} references only registered Debug commands`).toEqual([]);

      const anyReferencedCommandMutates = action.calls.some((call) => contractsByCommand.get(call)?.mutates === true);
      expect(action.mutates, `${action.id} mutation metadata must match its Debug command plan`).toBe(anyReferencedCommandMutates);
    }
  });

  it("requires the public matrix and its named no-route boundary in every entry-point document", async () => {
    const required = [
      ["README.md", [`${surfaceCounts.debug}`, `${surfaceCounts.direct} direct CLI`, `${surfaceCounts.semantic} semantic CLI equivalents`, `${surfaceCounts.noRoute} named Debug/MCP commands deliberately have no CLI route`, `${surfaceCounts.sdk} dedicated local-SDK operations`, `${surfaceCounts.actions} discoverable actions`]],
      ["docs/public/DEBUG_API.md", [`${surfaceCounts.debug}`, `${surfaceCounts.direct} direct`, `${surfaceCounts.semantic} semantic equivalents`, `${surfaceCounts.noRoute} named no-route`, `${surfaceCounts.sdk} dedicated local-SDK operations`, `${surfaceCounts.actions} discoverable actions`]],
      ["docs/public/agent-integration.md", [`${surfaceCounts.debug}`, `${surfaceCounts.direct} direct`, `${surfaceCounts.semantic} semantic equivalents`, `${surfaceCounts.noRoute} named no-route`, `${surfaceCounts.sdk} dedicated local-SDK operations`, `${surfaceCounts.actions} discoverable actions`]],
      ["skill/shellx-motion/references/invocation-and-permissions.md", [`${surfaceCounts.debug}`, `${surfaceCounts.direct} direct`, `${surfaceCounts.semantic} semantic equivalents`, `${surfaceCounts.noRoute} named no-route`, `${surfaceCounts.sdk} dedicated local-SDK operations`, `${surfaceCounts.actions} discoverable actions`]],
    ] as const;
    for (const [path, snippets] of required) {
      const source = await readFile(new URL(path, ROOT), "utf8");
      for (const snippet of snippets) expect(source, `${path} must state ${snippet}`).toContain(snippet);
    }
  });

  it("keeps intentional SDK, receipt, and coordinator-principal limits explicit", async () => {
    const required = [
      ["README.md", ["Evidence-producing operations return their declared receipts", "Read-only discovery and state commands emit no receipt", "has no dedicated template catalog, plan, apply, or media-replace API"]],
      ["docs/public/FEATURES.md", ["dedicated interchange operation is bounded glTF/GLB", "has no dedicated ducking operation"]],
      ["docs/public/templates.md", ["dedicated template catalog, plan, apply, or media-replacement API"]],
      ["packages/sdk/README.md", ["createLocalMotionSdk({callerId:'cut:workspace-7'})", "no dedicated template catalog, plan, apply, media-replacement,", "or ducking operation"]],
      ["docs/public/rendering.md", ["Coordinator submission and controls require an authenticated owner principal", "server-minted connection principal"]],
      ["docs/public/host-integration.md", ["Coordinator ownership is authenticated, not supplied by the request", "server-minted connection principal"]],
      ["docs/public/agent-integration.md", ["Job completeness", "server-minted connection principal"]],
      ["docs/public/DEBUG_API_COMMANDS.md", ["Job facts are complete only when the host supplies an authenticated owner principal"]],
      ["skill/shellx-motion/references/invocation-and-permissions.md", ["MCP accepts the full registry", "CLI accepts only the direct `debug` mapping", "a named no-route command requires a Debug/MCP"]],
    ] as const;
    for (const [path, snippets] of required) {
      const source = await readFile(new URL(path, ROOT), "utf8");
      for (const snippet of snippets) expect(source, `${path} must state ${snippet}`).toContain(snippet);
    }
  });
});
