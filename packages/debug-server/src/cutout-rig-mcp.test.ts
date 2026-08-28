/** Published MCP policy for a bounded cutout-rig bake. */
import { describe, expect, it } from "vitest";
import { DEBUG_COMMAND_CONTRACTS } from "@shellx-motion/debug-api";
import { mcpToolForDebugContract, tierAllows } from "./mcp-tool-shape.js";

describe("cutout rig MCP contract", () => {
  it("publishes one edit-tier data-only bake without exposing the CLI rig-file transport", () => {
    const contract = DEBUG_COMMAND_CONTRACTS.find((entry) => entry.command === "motion.timeline.cutout.rig.bake");
    expect(contract).toMatchObject({ permission: "edit_motion", mutates: true });
    if (!contract) throw new Error("cutout rig contract missing");

    const tool = mcpToolForDebugContract(contract) as {
      name: string;
      annotations: Record<string, unknown>;
      inputSchema: { properties: { args: { required?: string[]; properties?: Record<string, unknown>; additionalProperties?: boolean } } };
    };
    expect(tool.name).toBe("motion_timeline_cutout_rig_bake");
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false });
    expect(tool.inputSchema.properties.args).toMatchObject({
      required: ["packageRoot", "outDir", "sourceLayerId", "rig"],
      additionalProperties: false,
    });
    expect(tool.inputSchema.properties.args.properties).toEqual(expect.objectContaining({
      packageRoot: expect.objectContaining({ type: "string" }),
      outDir: expect.objectContaining({ type: "string" }),
      sourceLayerId: expect.objectContaining({ type: "string" }),
      rig: expect.objectContaining({ type: "object" }),
    }));
    expect(tool.inputSchema.properties.args.properties).not.toHaveProperty("rigFilePath");
    expect(tierAllows("render_motion", contract.permission)).toBe(false);
    expect(tierAllows("edit_motion", contract.permission)).toBe(true);
  });
});
