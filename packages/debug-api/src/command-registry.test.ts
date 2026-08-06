import { describe, expect, it } from "vitest";
import {
  buildDebugCommandContracts,
  debugCommandDefinition,
  debugCommandsByDomain,
  DEBUG_COMMANDS,
  type MotionDebugCommandMetadata,
  type MotionDebugDomain
} from "./command-registry.js";

const DOMAINS: MotionDebugDomain[] = ["surface", "agent", "render", "timeline", "authoring", "integration", "workspace"];

describe("Motion debug command registry", () => {
  it("is the unique, immutable source for every command contract", () => {
    // Motion is always the callee, so commands that call outward into a host are not registered.
    expect(DEBUG_COMMANDS).toHaveLength(169);
    expect(new Set(DEBUG_COMMANDS).size).toBe(DEBUG_COMMANDS.length);
    expect(Object.isFrozen(DEBUG_COMMANDS)).toBe(true);

    const contracts = buildDebugCommandContracts({});
    expect(contracts.map((contract) => contract.command)).toEqual(DEBUG_COMMANDS);
    for (const contract of contracts) {
      expect(debugCommandDefinition(contract.command)).toMatchObject(contract);
      expect(DOMAINS).toContain(contract.domain);
      expect(contract.permission).toMatch(/^(read|draft|render|edit)_motion$|^(write_local|push_remote)$/);
      expect(typeof contract.mutates).toBe("boolean");
    }
  });

  it("partitions commands into explicit review domains without overlap", () => {
    const partition = DOMAINS.flatMap((domain) => debugCommandsByDomain(domain));
    expect(new Set(partition).size).toBe(DEBUG_COMMANDS.length);
    expect(new Set(partition)).toEqual(new Set(DEBUG_COMMANDS));
    for (const domain of DOMAINS) expect(debugCommandsByDomain(domain).length).toBeGreaterThan(0);
  });

  it("does not let metadata override permission, mutation, command, or domain authority", () => {
    const hostileMetadata = {
      "motion.package.patch": {
        command: "motion.state",
        domain: "surface",
        permission: "read_motion",
        mutates: false,
        argsSchema: { type: "object", properties: {}, additionalProperties: false }
      }
    } as unknown as MotionDebugCommandMetadata;
    const contract = buildDebugCommandContracts(hostileMetadata).find((candidate) => candidate.command === "motion.package.patch");
    expect(contract).toMatchObject({
      command: "motion.package.patch",
      domain: "workspace",
      permission: "edit_motion",
      mutates: true,
      argsSchema: { type: "object", properties: {}, additionalProperties: false }
    });
  });

  it("fails closed for arbitrary and prototype-shaped command input", () => {
    const unknown = [null, undefined, 0, {}, [], "", "motion.future.unregistered", "__proto__", "constructor"];
    for (const candidate of unknown) expect(debugCommandDefinition(candidate)).toBeNull();
  });

  it("classifies source authoring that writes artifacts as mutating", () => {
    expect(debugCommandDefinition("motion.source.import")).toMatchObject({ permission: "write_local", mutates: true });
    expect(debugCommandDefinition("motion.source.to_scripted_video")).toMatchObject({ permission: "write_local", mutates: true });
  });
});
