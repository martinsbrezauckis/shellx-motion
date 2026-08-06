import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJson, canonicalJsonSha256, compareCodeUnits } from "./canonical-json";
import { proceduralRelationshipGraphFingerprint } from "./procedural-relationship-fingerprint";
import { MOTION_PROCEDURAL_SCHEMA, type MotionProceduralGraph } from "./procedural-relationship-types";
import { LOCAL_MOTION_SANDBOX_CAPABILITY_SCHEMA, createLocalMotionSandboxCapabilityReceipt, type LocalMotionSandboxCapabilityReport } from "./sandbox-capability";
import { parseMotionDataRows } from "./data";
import { trackingSettingsSha256, type TrackingAnalysisSettings } from "./tracking-analysis";

const SETTINGS: TrackingAnalysisSettings = {
  startMs: 0,
  endMs: 200,
  stepMs: 100,
  direction: "forward",
  searchRadiusPx: 14,
  pyramidLevels: 3,
  maxIterations: 40,
  confidenceFloor: 0.7,
  deterministicSeed: 9,
};

describe("canonical JSON", () => {
  it("hashes identical values identically no matter what order the keys were inserted in", () => {
    const forward = { alpha: 1, beta: { one: [1, 2], two: "x" }, gamma: true };
    const reversed = { gamma: true, beta: { two: "x", one: [1, 2] }, alpha: 1 };

    // The defect this replaces: JSON.stringify follows insertion order, so the two objects below
    // have identical values and different bytes.
    expect(JSON.stringify(forward)).not.toBe(JSON.stringify(reversed));

    expect(canonicalJson(forward)).toBe(canonicalJson(reversed));
    expect(canonicalJsonSha256(forward)).toBe(canonicalJsonSha256(reversed));
    expect(canonicalJson(forward)).toBe('{"alpha":1,"beta":{"one":[1,2],"two":"x"},"gamma":true}');
  });

  it("orders keys by code unit, which no ambient locale can move", () => {
    // "a" U+0061, "z" U+007A, "ä" U+00E4. Code-unit order is a, z, ä.
    // A live probe of localeCompare on this machine gave a, ä, z under en-US and a, z, ä under
    // sv-SE, so a localeCompare-sorted canonical form is machine-dependent. Asserting the EXACT
    // code-unit string means this test fails under en-US if the comparator ever regresses to
    // localeCompare — it is not a tautology over whatever the implementation happens to do.
    expect(canonicalJson({ "z": 3, "ä": 2, "a": 1 })).toBe('{"a":1,"z":3,"ä":2}');
    expect(["a", "ä", "z"].sort(compareCodeUnits)).toEqual(["a", "z", "ä"]);

    // Same shape for ASCII case, where localeCompare (en-US) puts "avatar" before "Name" and code
    // units put "Name" first.
    expect(canonicalJson({ avatar: 1, Name: 2 })).toBe('{"Name":2,"avatar":1}');
    expect("avatar".localeCompare("Name", "en-US")).toBeLessThan(0);
    expect(compareCodeUnits("avatar", "Name")).toBeGreaterThan(0);
  });

  it("stays byte-identical when every locale-sensitive global is replaced by a thrower", () => {
    // Enforcement, not documentation. If Intl, toLocaleString, localeCompare, or a Turkish locale
    // (where "I".toLowerCase() is dotless) were reachable from the canonical path, this throws.
    const value = { "ä": 1, "Z": 2, "a": 3, "İ": 4, "10": 5, "2": 6, nested: { "ö": 1, o: 2 } };
    const expected = canonicalJson(value);
    const globals = globalThis as Record<string, unknown>;
    const savedIntl = globals.Intl;
    const savedCompare = String.prototype.localeCompare;
    const savedToLocaleUpper = String.prototype.toLocaleUpperCase;
    const savedToLocaleLower = String.prototype.toLocaleLowerCase;
    const savedNumberToLocale = Number.prototype.toLocaleString;
    const boom = () => { throw new Error("locale-sensitive path reached from canonical JSON"); };
    let actual: string;
    try {
      globals.Intl = new Proxy({}, { get: boom, has: boom, apply: boom });
      String.prototype.localeCompare = boom as typeof String.prototype.localeCompare;
      String.prototype.toLocaleUpperCase = boom as typeof String.prototype.toLocaleUpperCase;
      String.prototype.toLocaleLowerCase = boom as typeof String.prototype.toLocaleLowerCase;
      Number.prototype.toLocaleString = boom as typeof Number.prototype.toLocaleString;
      process.env.LC_ALL = "sv_SE.UTF-8";
      process.env.LANG = "tr_TR.UTF-8";
      actual = canonicalJson(value);
    } finally {
      globals.Intl = savedIntl;
      String.prototype.localeCompare = savedCompare;
      String.prototype.toLocaleUpperCase = savedToLocaleUpper;
      String.prototype.toLocaleLowerCase = savedToLocaleLower;
      Number.prototype.toLocaleString = savedNumberToLocale;
      delete process.env.LC_ALL;
      delete process.env.LANG;
    }
    expect(actual).toBe(expected);
  });

  it("emits integer-like keys in code-unit order instead of the engine's numeric order", () => {
    // Re-inserting sorted keys into an object would emit "2" before "10" because JS stores
    // integer-like keys in ascending numeric order. Building the text directly keeps code-unit order.
    expect(canonicalJson({ "10": "a", "2": "b", x: "c" })).toBe('{"10":"a","2":"b","x":"c"}');
    expect(JSON.stringify({ "10": "a", "2": "b", x: "c" })).toBe('{"2":"b","10":"a","x":"c"}');
  });

  it("keeps array order, drops undefined like JSON, and refuses cycles and bigints", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalJson({ b: undefined, a: 1 })).toBe('{"a":1}');
    expect(canonicalJson([undefined, () => 1, 2])).toBe("[null,null,2]");
    expect(canonicalJson({ n: Number.NaN, i: Number.POSITIVE_INFINITY })).toBe('{"i":null,"n":null}');
    expect(canonicalJson({ at: new Date("2026-08-02T00:00:00.000Z") })).toBe('{"at":"2026-08-02T00:00:00.000Z"}');

    // The same value in two sibling positions is not a cycle.
    const shared = { a: 1 };
    expect(canonicalJson({ left: shared, right: shared })).toBe('{"left":{"a":1},"right":{"a":1}}');

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow("cannot serialize a cycle");
    expect(() => canonicalJson({ big: 1n })).toThrow("cannot serialize a bigint");
  });

  it("is the hash used by tracking settings and motion data rows", () => {
    // Tracking settings: same values, different insertion order, one hash.
    const shuffled = {
      deterministicSeed: SETTINGS.deterministicSeed,
      confidenceFloor: SETTINGS.confidenceFloor,
      maxIterations: SETTINGS.maxIterations,
      pyramidLevels: SETTINGS.pyramidLevels,
      searchRadiusPx: SETTINGS.searchRadiusPx,
      direction: SETTINGS.direction,
      stepMs: SETTINGS.stepMs,
      endMs: SETTINGS.endMs,
      startMs: SETTINGS.startMs,
    } as TrackingAnalysisSettings;
    expect(trackingSettingsSha256(shuffled)).toBe(trackingSettingsSha256(SETTINGS));
    expect(trackingSettingsSha256(SETTINGS)).toBe(canonicalJsonSha256(SETTINGS));
    expect(trackingSettingsSha256(SETTINGS)).not.toBe(createHash("sha256").update(JSON.stringify(SETTINGS)).digest("hex"));

    // Data rows: the row hash and the derived row key must not move with key order either. The
    // mixed-case and non-ASCII keys are the cases localeCompare would order differently.
    const [first] = parseMotionDataRows([{ id: "ada", Name: "Ada", avatar: "a.png", "ätikett": "x" }]);
    const [second] = parseMotionDataRows([{ "ätikett": "x", avatar: "a.png", Name: "Ada", id: "ada" }]);
    expect(first.hash).toBe(second.hash);
    expect(first.key).toBe(second.key);
  });

  it("is the only canonical serializer: converged callers agree byte for byte", () => {
    // Six modules used to carry their own stable-JSON walk, three of them sorting with
    // localeCompare. They now delegate, and the assertion below is the delegation itself rather
    // than a copy of the expected bytes — if a module grows a private serializer again, this stops
    // matching and `scripts/canonical-determinism-gate.mjs` refuses the file outright.
    const graph: MotionProceduralGraph = {
      schema: MOTION_PROCEDURAL_SCHEMA,
      relationships: [{
        id: "r1",
        enabled: true,
        target: { layerId: "a", property: "transform.y" },
        nodes: [
          { id: "n1", type: "property", ref: { layerId: "b", property: "transform.x" } },
          { id: "n2", type: "constant", value: 2 },
          { id: "n3", type: "multiply", left: "n1", right: "n2" }
        ],
        outputNodeId: "n3"
      }]
    };
    expect(proceduralRelationshipGraphFingerprint(graph)).toBe(canonicalJsonSha256(graph));
  });

  it("gives a sandbox capability receipt one id whatever order the probe built its report", () => {
    // The verifier could not construct a live locale divergence here, but the rule violation was
    // real: the receipt hashed `JSON.stringify(report)`, and `report.executable` is a spread of a
    // caller-supplied record, so its key order is the caller's insertion order.
    const executable = { path: "/usr/bin/bwrap", sha256: "a".repeat(64) };
    const report = (order: "forward" | "reverse"): LocalMotionSandboxCapabilityReport => ({
      schema: LOCAL_MOTION_SANDBOX_CAPABILITY_SCHEMA,
      platform: "linux",
      provider: "linux-bubblewrap",
      status: "available",
      required: false,
      appliedToWorkers: false,
      policy: { network: "denied", filesystem: "read-only-host-probe", process: "new-session" },
      executable: order === "forward"
        ? { ...executable, versionStatus: "reported", version: "0.9" }
        : { version: "0.9", versionStatus: "reported", sha256: executable.sha256, path: executable.path },
      probe: { kind: "executed", exitCode: 0, outputSha256: "b".repeat(64) },
      createdAt: "2026-08-02T00:00:00.000Z"
    });
    const forward = createLocalMotionSandboxCapabilityReceipt(report("forward"));
    const reverse = createLocalMotionSandboxCapabilityReceipt(report("reverse"));
    expect(forward.id).toBe(reverse.id);
    expect(forward.inputHashes).toEqual(reverse.inputHashes);
  });

  it("is enforced by a gate that fails on a new localeCompare or a new stable-JSON walk", () => {
    // The rule above lived only in a comment for long enough to produce three reproduced hash
    // divergences and six competing serializers. Enforcement is therefore itself under test: the
    // gate is run against a synthetic tree that contains exactly the patterns it must reject, and
    // one it must accept.
    const root = mkdtempSync(join(tmpdir(), "shellx-motion-determinism-gate-"));
    try {
      const src = join(root, "packages", "probe", "src");
      mkdirSync(src, { recursive: true });
      mkdirSync(join(root, "scripts"), { recursive: true });
      writeFileSync(join(src, "clean.ts"), [
        'import { canonicalJson, compareCodeUnits } from "@shellx-motion/core";',
        "export const ordered = (values: string[]): string[] => [...values].sort(compareCodeUnits);",
        "export const identity = (value: unknown): string => canonicalJson(value);",
        "// A sorted-record builder is not a serializer and must not be reported.",
        "export function record(entries: Array<[string, number]>): Record<string, number> {",
        "  return Object.fromEntries([...entries].sort(([a], [b]) => compareCodeUnits(a, b)));",
        "}",
        "export function forHumans(values: string[]): string[] {",
        "  // locale-order-ok: rendered in a picker, so it follows the reader's locale.",
        "  return [...values].sort((left, right) => left.localeCompare(right));",
        "}"
      ].join("\n"), "utf8");
      expect(runGate(root)).toEqual({ status: 0, findings: [] });

      writeFileSync(join(src, "bad.ts"), [
        "export function ordered(values: string[]): string[] {",
        "  return [...values].sort((left, right) => left.localeCompare(right));",
        "}",
        "export function stableJson(value: unknown): string {",
        "  if (Array.isArray(value)) return `[${value.map(stableJson).join(\",\")}]`;",
        '  if (value && typeof value === "object") {',
        "    return `{${Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1))",
        "      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(\",\")}}`;",
        "  }",
        "  return JSON.stringify(value);",
        "}"
      ].join("\n"), "utf8");
      const failed = runGate(root);
      expect(failed.status).toBe(1);
      expect(failed.findings).toEqual([
        expect.stringContaining("[R1]"),
        expect.stringContaining("[R2a]")
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * Run the determinism gate over a synthetic tree.
 *
 * @param root tree to scan, laid out as `packages/<pkg>/src/**` plus `scripts/`.
 * @returns the exit status and one line per rule finding.
 */
function runGate(root: string): { status: number; findings: string[] } {
  const gate = resolve(__dirname, "..", "..", "..", "scripts", "canonical-determinism-gate.mjs");
  try {
    execFileSync(process.execPath, [gate, "--root", root], { encoding: "utf8", stdio: "pipe" });
    return { status: 0, findings: [] };
  } catch (error) {
    const failure = error as { status?: number; stderr?: string };
    const findings = (failure.stderr ?? "").split("\n").filter((line) => /\[R[123][abc]?\]/.test(line));
    return { status: failure.status ?? 1, findings };
  }
}
