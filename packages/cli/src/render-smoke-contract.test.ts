/**
 * The required render smokes must speak the canonical job/receipt vocabulary.
 *
 * Role: `scripts/render-*-smoke.ts` are the host gates that decide whether Motion can deliver media
 * on a platform. They are shell scripts in spirit — nothing type-checks their *expectations* against
 * `schemas/job-status.json`, and nothing runs them except a human typing `pnpm run …:smoke`. That is
 * Four of them once demanded `receipt.status === "passed"`
 * from renders that correctly returned a warned success, and one demanded a job state `"queued"`
 * that the contract has never defined. Real media was produced; the gates called it failure.
 *
 * The lesson is that a gate's vocabulary rots exactly like any other code, and rots silently because
 * a red smoke looks like a broken engine rather than a broken assertion. So this file is the gate on
 * the gates. It runs inside `packages/cli`'s vitest suite — therefore inside `pnpm test` — and holds
 * two lines of defence:
 *
 *   1. **Behaviour.** `scripts/render-smoke-status.ts` is executed and probed directly. The critical
 *      property is not that it accepts `warning`; it is that it REFUSES a `warning` that names no
 *      expected advisory. Widening the accepted status set without that refusal is precisely the
 *      "fix" that would make the render-smoke contract look closed while removing the gate's teeth.
 *   2. **Vocabulary.** Every smoke's source is read and checked for the obsolete words, for the
 *      hard-coded `"passed"` comparisons that were the defect, and for the presence of the shared
 *      assertions. One test per smoke, named after it, so a failure says which gate rotted.
 *
 * Why a source read rather than an import: the smokes live outside this package's `rootDir` on
 * purpose — they are build-time scaffolding, not shipped CLI code — so they cannot be imported under
 * `tsc -p packages/cli`. The helper module IS loaded, at runtime, through a file URL that TypeScript
 * does not resolve statically. That keeps the behaviour tested without dragging repo scripts into
 * the shipped program.
 *
 * Dependencies: `@shellx-motion/core` for the generated contract. Primary caller: vitest.
 */
import { readFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { JOB_STATES, jobOutcomeForReceiptStatus } from "@shellx-motion/core";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const scriptsRoot = join(repoRoot, "scripts");

/** Every smoke this contract covers, with the npm script a maintainer would run to reproduce it. */
const SMOKES = {
  lifecycle: { file: "render-job-lifecycle-smoke.ts", command: "pnpm run render-job-lifecycle:smoke" },
  mp4: { file: "render-mp4-smoke.ts", command: "pnpm run render-mp4:smoke" },
  webm: { file: "render-webm-smoke.ts", command: "pnpm run render-webm:smoke" },
  caption: { file: "render-caption-smoke.ts", command: "pnpm run render-caption:smoke" },
  gif: { file: "render-gif-smoke.ts", command: "pnpm run render-gif:smoke" }
} as const;

/** The smokes that render real media and therefore share the warned-success acceptance rule. */
const MEDIA_SMOKES = ["mp4", "webm", "caption", "gif"] as const;

async function smokeSource(key: keyof typeof SMOKES): Promise<string> {
  return await readFile(join(scriptsRoot, SMOKES[key].file), "utf8");
}

/**
 * The shared assertions, loaded at runtime.
 *
 * The specifier is a computed file URL so TypeScript never pulls `scripts/` into this package's
 * program (it sits outside `rootDir`), while vitest still loads and transforms the real module.
 */
const helperUrl = pathToFileURL(join(scriptsRoot, "render-smoke-status.ts")).href;
const helper = await import(/* @vite-ignore */ helperUrl) as {
  assertReceiptSucceeded(receipt: unknown, options: { label: string; expectedAdvisories: readonly RegExp[] }): {
    status: string;
    outcome: string;
    warnings: string[];
    matchedAdvisories: string[];
  };
  assertWarningFreeSuccess(receipt: unknown, label: string): { status: string; warnings: string[] };
  assertContractJobState(state: string, label: string): void;
  readDeliveredMedia(path: string, label: string, minBytes?: number): Promise<Buffer>;
  smokeJobIdentity(smoke: string): { jobId: string; callerId: string };
  FONT_FALLBACK_ADVISORY: RegExp;
  MOTION_DENSITY_ADVISORY: RegExp;
};

const FONT_FALLBACK = "Browser renderer used a font fallback for text layer title.";
const MOTION_DENSITY = "Rendered motion is static for 74.4% of its duration (2.233s of 3.000s across 1 frozen run, longest 2.233s).";

describe("canonical receipt-status to job-outcome mapping", () => {
  it("maps a warned success onto a succeeded job, and refuses words outside the contract", () => {
    expect(jobOutcomeForReceiptStatus("passed")).toBe("succeeded");
    expect(jobOutcomeForReceiptStatus("warning")).toBe("succeeded");
    expect(jobOutcomeForReceiptStatus("failed")).toBe("failed");
    expect(jobOutcomeForReceiptStatus("not_run")).toBe("skipped");
    // The word the smokes must never expect again, from either axis.
    expect(jobOutcomeForReceiptStatus("queued")).toBeUndefined();
    expect(JOB_STATES).toContain("pending");
    expect(JOB_STATES).not.toContain("queued");
  });
});

describe("scripts/render-smoke-status.ts acceptance rule", () => {
  const advisories = [helper.FONT_FALLBACK_ADVISORY, helper.MOTION_DENSITY_ADVISORY] as const;
  const accept = (receipt: unknown) => helper.assertReceiptSucceeded(receipt, { label: "probe", expectedAdvisories: advisories });

  it("accepts an unwarned pass", () => {
    const evidence = accept({ status: "passed", warnings: [] });
    expect(evidence).toMatchObject({ status: "passed", outcome: "succeeded", matchedAdvisories: [] });
  });

  it("accepts a warned success and names the advisory it accepted it for", () => {
    const evidence = accept({ status: "warning", warnings: [FONT_FALLBACK, MOTION_DENSITY] });
    expect(evidence).toMatchObject({ status: "warning", outcome: "succeeded" });
    expect(evidence.matchedAdvisories).toEqual([FONT_FALLBACK, MOTION_DENSITY]);
  });

  it("REFUSES a warned success whose warning is not one this gate predicted", () => {
    // The whole point of the rule. Accepting `warning` unconditionally would let any future
    // regression that emits any warning at all ride straight through a required platform gate.
    expect(() => accept({ status: "warning", warnings: ["Encoder produced 41 corrupt macroblocks."] }))
      .toThrow(/none of its warnings match an advisory this smoke expects/);
  });

  it("refuses a warning status with no warning behind it", () => {
    expect(() => accept({ status: "warning", warnings: [] })).toThrow(/must carry its warning/);
  });

  it("refuses every status the contract does not map onto a succeeded job", () => {
    for (const status of ["failed", "not_run", "queued", "ok", "succeeded"]) {
      expect(() => accept({ status, warnings: [] }), `status ${status} must not be accepted`)
        .toThrow(/does not map to a succeeded job/);
    }
  });

  it("keeps the exact-passed assertion exact", () => {
    expect(helper.assertWarningFreeSuccess({ status: "passed", warnings: [] }, "probe")).toMatchObject({ status: "passed" });
    expect(() => helper.assertWarningFreeSuccess({ status: "warning", warnings: [FONT_FALLBACK] }, "probe"))
      .toThrow(/must be an unwarned success/);
  });

  it("refuses a job state the contract does not define", () => {
    expect(() => helper.assertContractJobState("pending", "probe")).not.toThrow();
    expect(() => helper.assertContractJobState("succeeded", "probe")).not.toThrow();
    expect(() => helper.assertContractJobState("queued", "probe")).toThrow(/not a job state in schemas\/job-status\.json/);
  });

  it("refuses an output that is not real media on disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "motion-smoke-media-"));
    const truncated = join(dir, "truncated.mp4");
    const real = join(dir, "real.mp4");
    await writeFile(truncated, Buffer.alloc(12));
    await writeFile(real, Buffer.alloc(4096, 7));
    await expect(helper.readDeliveredMedia(truncated, "probe")).rejects.toThrow(/below the 1024-byte floor/);
    await expect(helper.readDeliveredMedia(join(dir, "absent.mp4"), "probe")).rejects.toThrow();
    expect((await helper.readDeliveredMedia(real, "probe")).length).toBe(4096);
  });

  it("mints job ids the CLI will accept", () => {
    const { jobId, callerId } = helper.smokeJobIdentity("render-mp4");
    expect(jobId).toMatch(/^[A-Za-z0-9._:-]{1,128}$/);
    expect(callerId).toMatch(/^[A-Za-z0-9._:-]+$/);
    expect(helper.smokeJobIdentity("render-mp4").jobId).not.toBe(jobId);
  });
});

describe("render-job-lifecycle:smoke vocabulary", () => {
  it("expects a retried job to be pending, and never reintroduces 'queued' as a state", async () => {
    const source = await smokeSource("lifecycle");
    expect(source).toContain('=== "pending"');
    // `render-final-queued-smoke` is a receipt ID, not a state; the state word itself must be gone.
    const stateLiterals = [...source.matchAll(/State\s*===\s*"(\w+)"/g)].map((match) => match[1]);
    expect(stateLiterals.length).toBeGreaterThan(0);
    for (const state of stateLiterals) expect(JOB_STATES).toContain(state);
    // Every state it reads is checked against the contract at runtime too, not just here.
    expect(source).toContain("assertContractJobState");
  });
});

describe.each(MEDIA_SMOKES)("render-%s:smoke acceptance", (key) => {
  it(`judges success through the canonical contract, not a hard-coded "passed"`, async () => {
    const source = await smokeSource(key);
    // The exact defect: comparing a receipt status to a literal instead of mapping it.
    expect(source).not.toMatch(/receipt\.status["'\s,)]*\)?\s*===\s*"passed"/);
    expect(source).not.toMatch(/"render\.receipt\.status"\)\s*===\s*"passed"/);
    expect(source).toContain("assertReceiptSucceeded");
  });

  it("only accepts a warned success alongside a succeeded job and real media", async () => {
    const source = await smokeSource(key);
    // Widening the status set is allowed ONLY in company with these two independent proofs.
    expect(source).toContain("assertJobSucceeded");
    expect(source).toContain("readDeliveredMedia");
    expect(source).toContain("--job-id");
    expect(source).toContain("--caller-id");
  });

  it("names the advisories it is willing to accept a warning for", async () => {
    const source = await smokeSource(key);
    expect(source).toMatch(/expectedAdvisories:\s*\[[^\]]*ADVISORY/);
  });
});

describe("render-gif:smoke frame lanes", () => {
  it("renders the text fixture on the browser lane, which is the only lane that can deliver text", async () => {
    const source = await smokeSource("gif");
    // The native lane has no font rasterizer and a fixed uppercase block-glyph set, so the engine
    // refuses a text package with `native_text_not_deliverable`. The smoke must use the browser lane.
    expect(source).toMatch(/const packageRoot = join\(repoRoot, "fixtures\/packages\/keyframed-lower-third"\)/);
    const deliveryRender = source.slice(source.indexOf("const render = await runCli"), source.indexOf("const nativeRender"));
    expect(deliveryRender).toContain("packageRoot");
    expect(deliveryRender).toContain('"browser"');
    expect(deliveryRender).not.toContain('"native"');
  });

  it("keeps the native lane under gate, pointed at a text-free fixture", async () => {
    const source = await smokeSource("gif");
    expect(source).toContain("procedural-relationships");
    expect(source).toMatch(/nativePackageRoot[\s\S]*?"--frame-lane",\s*\n?\s*"native"/);
    // The native proof is where the suite keeps an exact `passed`.
    expect(source).toContain("assertWarningFreeSuccess");
  });

  it("does not render text through the native lane", async () => {
    const motion = JSON.parse(await readFile(join(repoRoot, "fixtures/packages/procedural-relationships/motion.json"), "utf8")) as {
      layers: Array<{ type: string; text?: string }>;
    };
    // If this fixture ever gains a text layer, the native GIF proof silently becomes the old defect.
    expect(motion.layers.every((layer) => layer.type !== "text" && layer.text === undefined)).toBe(true);
  });
});

describe("every required render smoke", () => {
  it.each(Object.entries(SMOKES))("%s keeps the obsolete state vocabulary out", async (_key, smoke) => {
    const source = await readFile(join(scriptsRoot, smoke.file), "utf8");
    // A word that no Motion surface has ever returned.
    expect(source, `${smoke.command} must not expect a "queued" state`).not.toMatch(/===\s*"queued"/);
  });
});
