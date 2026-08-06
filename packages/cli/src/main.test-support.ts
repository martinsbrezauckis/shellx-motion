/**
 * Shared support for the ShellX Motion CLI test suite: the temp-dir registry, an env-var wrapper, the
 * scene/scripted/frame-selection fixtures, and the receipt + PNG fixture builders.
 *
 * Role: pure test scaffolding extracted verbatim from `main.test.ts` so the CLI test file stays under the
 * module-size gate. No assertions live here — behavior is unchanged.
 *
 * Shared state: `tempDirs` is the single registry the fixture builders (here and in the sibling
 * `main.fixtures-*` modules) push freshly created temp directories into; `main.test.ts`'s `afterEach`
 * splices and removes them. ES modules are singletons, so every importer shares the same array instance.
 * `execFile` is the promisified child-process runner shared by the platform-verifier fixture and the tests.
 *
 * Dependencies: node fs/path/util/zlib/child_process built-ins, `@shellx-motion/core`
 * (buildSourceImportDocument / OperationReceipt), and the `AgentReceipt` type from the agent runtime.
 *
 * Primary callers: `packages/cli/src/main.test.ts`, `main.fixtures-packages.ts`, `main.fixtures-batch.ts`.
 */
import { execFile as execFileCallback } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { deflateSync } from "node:zlib";
import { buildAgentRuntime, type AgentAdapter, type AgentReceipt, type AgentRuntime } from "@shellx-motion/agent-runtime";
import { buildSourceImportDocument, type OperationReceipt } from "@shellx-motion/core";

export { createFakePromptRuntime } from "@shellx-motion/prompt/test-support";

/**
 * An agent runtime whose single adapter is a scripted stub, for `RunCliOptions.agentRuntime`.
 *
 * This is the former `fakeAgentRuntime()`/`fakeAdapter()` pair from `main.ts`, where `--adapter
 * fake` could reach it: the shipped binary reported a ready `shellx-motion-fake-agent` that no user
 * could install, in the same JSON a real probe produces. It lives here so
 * only a caller that imports test scaffolding on purpose can build one — `scripts/build.mjs` never
 * emits `*.test-support.ts`, and `scripts/shipping-imports-gate.mjs` fails if shipping code
 * imports it.
 *
 * The probe answers for `shellx-motion-fake-agent` and reports exit 127 ("unavailable") for
 * anything else, so a suite sees exactly one available agent regardless of what is installed on the
 * machine running the tests.
 */
export function scriptedAgentRuntime(): AgentRuntime {
  const adapter: AgentAdapter = {
    id: "fake",
    label: "Fake Agent",
    transport: "local-cli",
    billing: "cli-subscription",
    probeCommand: () => ({ executable: "shellx-motion-fake-agent", args: ["--version"], shell: false }),
    promptCommand: (input) => ({ executable: "shellx-motion-fake-agent", args: ["run"], stdin: input.prompt, shell: false })
  };
  return buildAgentRuntime({
    adapters: [adapter],
    runner: async (command) => command.executable === "shellx-motion-fake-agent"
      ? { exitCode: 0, stdout: "shellx-motion-fake-agent 0.0.0", stderr: "" }
      : { exitCode: 127, stdout: "", stderr: "unavailable" }
  });
}

/** Temp directories created by fixture builders; the test file's afterEach removes them. */
export const tempDirs: string[] = [];

/** Promisified execFile shared by the platform-verifier fixture and the CLI tests. */
export const execFile = promisify(execFileCallback);

export async function withEnv(name: "SHELLX_MOTION_FFMPEG", value: string, run: () => Promise<void>): Promise<void> {
  const previous = process.env[name];
  process.env[name] = value;
  try {
    await run();
  } finally {
    if (previous === undefined) {
      delete process.env[name];
      return;
    }
    process.env[name] = previous;
  }
}

export function shapeTextFrameSelection(): unknown {
  return {
    schema: "shellx-canvas/frame-selection@1",
    selectedFrameId: "frame_intro",
    project: { id: "canvas_motion_real", name: "Motion Real" },
    brand: { tokens: { color: { accent: "#2563eb", ink: "#101828" } } },
    frames: [
      {
        id: "frame_intro",
        name: "Intro",
        durationMs: 1000,
        fps: 2,
        width: 640,
        height: 360,
        background: "#f8fafc",
        layers: [
          {
            id: "panel",
            kind: "shape",
            shape: "rectangle",
            startMs: 0,
            durationMs: 1000,
            transform: { x: 48, y: 44, width: 250, height: 150, opacity: 1 },
            style: { fill: "#2563eb" },
            ...revealMotion()
          },
          {
            id: "title",
            kind: "text",
            text: "Real render",
            startMs: 0,
            durationMs: 1000,
            transform: { x: 64, y: 240, width: 420, height: 60, opacity: 1 },
            style: { fontSize: 36, color: "#101828" },
            ...revealMotion()
          }
        ]
      }
    ],
    imageEditorOutputs: []
  };
}

export function staticShapeTextFrameSelection(): unknown {
  const selection = shapeTextFrameSelection() as Record<string, any>;
  selection.frames[0].layers = selection.frames[0].layers.map((layer: Record<string, any>) => {
    const copy: Record<string, any> = { ...layer, transform: { ...layer.transform } };
    delete copy.transitions;
    delete copy.keyframes;
    if (copy.kind === "text") {
      delete copy.transform.width;
      delete copy.transform.height;
    }
    return copy;
  });
  return selection;
}

export function revealMotion(): Record<string, unknown> {
  return {
    transitions: {
      in: { type: "slide", direction: "down", distance: 24, durationMs: 320, easing: "ease-out" },
      out: { type: "fade", durationMs: 260, easing: "ease-in" }
    },
    keyframes: {
      opacity: [
        { atMs: 0, value: 0, easing: "ease-out" },
        { atMs: 320, value: 1 },
        { atMs: 740, value: 1, easing: "ease-in" },
        { atMs: 1000, value: 0 }
      ]
    }
  };
}

export function scriptedVideo(): unknown {
  return {
    schema: "shellx-motion/scripted-video@1",
    id: "launch-demo",
    name: "Launch Demo",
    sourceApp: "shellx-cut",
    workflow: "generate",
    width: 640,
    height: 360,
    fps: 2,
    frames: [
      {
        id: "hook",
        title: "Hook",
        body: "Show the new workflow",
        durationMs: 500,
        background: "#0f172a",
        accent: "#38bdf8"
      },
      {
        id: "cta",
        title: "Cut edits it",
        caption: "Rendered by Motion",
        durationMs: 500,
        background: "#111827",
        accent: "#22c55e"
      }
    ]
  };
}

export function storyboardPanelScriptedVideo(): unknown {
  return {
    schema: "shellx-motion/scripted-video@1",
    id: "source-storyboard-demo",
    name: "Source Storyboard Demo",
    sourceApp: "shellx-motion",
    workflow: "source-to-scripted-video",
    intent: "source_to_storyboard",
    synopsis: "Review source-backed launch notes before compile.",
    review: { status: "needs-review", required: true },
    width: 1280,
    height: 720,
    fps: 30,
    frames: [
      {
        id: "problem",
        title: "Problem",
        body: "Teams need deterministic video exports.",
        caption: "Source: example.com",
        durationMs: 2000,
        background: "#0f172a",
        accent: "#38bdf8",
        reviewStatus: "needs-review",
        agentNote: "Check source claim wording before compile.",
        assetRefs: ["assets/problem.png"],
        sourceRefs: [
          { type: "article", title: "Launch notes", url: "https://example.com/articles/motion#problem" }
        ],
        tags: ["problem"],
        template: { id: "lower-third-source", engine: "native", variables: { emphasis: "problem" } },
        engine: { id: "native-text", mode: "text-card", capability: "native" }
      },
      {
        id: "handoff",
        title: "Cut handoff",
        body: "Scripted-video JSON can go directly to Cut.",
        durationMs: 2200,
        sourceRefs: [
          { type: "article", title: "Launch notes", url: "https://example.com/articles/motion#handoff" }
        ]
      }
    ]
  };
}

export function importedSourceMarkdown(): string {
  return buildSourceImportDocument({
    url: "https://github.com/nexu-io/html-video",
    title: "html-video reference workflow",
    kind: "repo",
    markdown: [
      "## HTML video workflows",
      "The reference project demonstrates source-driven HTML composition into video output.",
      "",
      "## Agent inputs",
      "Prompt, link, and repository inputs should become reviewable storyboard frames before timeline mutation.",
      "",
      "## ShellX placement",
      "Motion keeps package, receipt, source refs, and Cut handoff state separate from Canvas."
    ].join("\n")
  }).markdown;
}

export function cliDebugReceipt(input: {
  id: string;
  operation: string;
  status: "passed" | "failed" | "warning" | "not_run";
  packageId: string;
  lane: string;
  output: unknown;
  artifacts?: Array<{ role: string; path: string; status: "available" | "planned" | "not_required" | "failed"; mediaType?: string; primary?: boolean }>;
  warnings?: string[];
}): OperationReceipt {
  return {
    schema: "shellx-motion/receipt@1",
    id: input.id,
    operation: input.operation,
    status: input.status,
    packageId: input.packageId,
    inputHashes: { motion: "a".repeat(64) },
    createdAt: "2026-07-01T00:00:00.000Z",
    lane: input.lane,
    output: input.output,
    ...(input.artifacts ? { artifacts: input.artifacts } : {}),
    warnings: input.warnings ?? []
  };
}

export function cliAgentReceipt(input: {
  id: string;
  status: "passed" | "failed";
  packageId: string;
  output: AgentReceipt["output"];
  warnings?: string[];
}): AgentReceipt {
  return {
    schema: "shellx-motion/receipt@1",
    id: input.id,
    operation: "agent.prompt",
    status: input.status,
    packageId: input.packageId,
    inputHashes: { prompt: "a".repeat(64), context: "b".repeat(64) },
    createdAt: "2026-07-01T00:00:00.000Z",
    lane: "agent",
    output: input.output,
    warnings: input.warnings ?? []
  };
}

/**
 * The required host-gate command ids, read from the runner's OWN plan.
 *
 * This used to be a hand-maintained copy of `COMMANDS` from `scripts/platform-verify.mjs`. Adding
 * two commands to the ladder during cross-host verification broke five tests and needed the same list edited by hand
 * in two files, which is the definition of a mirror that will go stale again — and a stale mirror
 * here is not cosmetic: `writePlatformReceipt` builds the fake host evidence the aggregate verifier
 * grades, so a copy missing a required id would synthesize a receipt the real verifier must reject,
 * and the tests would be asserting against a ladder that no longer exists.
 *
 * `--dry-run --json` with no `--include-extended` is exactly the set the aggregate verifier demands
 * (`requiredPlatformCommandIds` -> `selectCommands(null, options)`, core tier only), so the fixture
 * and the verifier read the same list from the same place.
 *
 * Spawned once per test process and memoized; the plan is deterministic and does not touch the
 * network or the filesystem.
 */
let requiredPlatformCommandIdsPromise: Promise<string[]> | null = null;

export function requiredPlatformCommandIds(): Promise<string[]> {
  requiredPlatformCommandIdsPromise ??= (async () => {
    const { stdout } = await execFile(process.execPath, [
      resolve("../../scripts/platform-verify.mjs"), "--dry-run", "--json"
    ], { cwd: resolve("../.."), maxBuffer: 32 * 1024 * 1024 });
    const plan = JSON.parse(stdout) as { commands?: Array<{ id?: unknown; required?: unknown }> };
    const ids = (plan.commands ?? [])
      .filter((command) => command.required === true)
      .map((command) => command.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    if (ids.length === 0) {
      throw new Error("platform-verify planned no required commands; the host-receipt fixture would be meaningless.");
    }
    return ids;
  })();
  return requiredPlatformCommandIdsPromise;
}

export async function writePlatformReceipt(
  root: string,
  hostId: string,
  options: { dryRun?: boolean; status?: string; failedCommandId?: string; platform?: string; suffix?: string; exactToolchain?: boolean; bundledCodecs?: boolean; workspaceIdentityInvalid?: boolean; workspaceCommit?: string; workspaceLockfileSha256?: string } = {}
): Promise<string> {
  const path = join(root, `${hostId}${options.suffix ? `-${options.suffix}` : ""}.platform.json`);
  const commands = (await requiredPlatformCommandIds()).map((id) => ({
    id,
    command: ["pnpm", id],
    required: true,
    status: id === options.failedCommandId ? "failed" : "passed"
  }));
  const receipt = {
    schema: "shellx-motion/platform-verification@1",
    status: options.status ?? (options.failedCommandId ? "failed" : "passed"),
    dryRun: options.dryRun ?? false,
    host: {
      id: hostId,
      hostname: `${hostId}.example.test`,
      platform: options.platform ?? (hostId === "macos" ? "darwin" : hostId === "windows" ? "win32" : "linux"),
      arch: "x64",
      release: "test",
      node: process.version
    },
    toolchain: options.exactToolchain ? {
      status: "passed",
      exact: true,
      bundledCodecs: options.bundledCodecs === true,
      workspace: options.workspaceIdentityInvalid ? {
        status: "passed",
        exact: true,
        commit: null,
        trackedDirty: false,
        lockfileSha256: null
      } : {
        status: "passed",
        exact: true,
        commit: options.workspaceCommit ?? "d".repeat(40),
        trackedDirty: false,
        lockfileSha256: options.workspaceLockfileSha256 ?? "e".repeat(64)
      },
      node: { sha256: "a".repeat(64) },
      ffmpeg: { sha256: "b".repeat(64) },
      ffprobe: { sha256: "c".repeat(64) },
      encoders: { capabilities: { h264: true, vp9: true, prores: true, hevc: true, av1: true } }
    } : { status: "missing", exact: false, bundledCodecs: false },
    hostMatrix: {
      required: ["linux", "windows", "macos"],
      current: hostId,
      currentRequired: true,
      satisfied: [hostId],
      missing: ["linux", "windows", "macos"].filter((id) => id !== hostId),
      complete: false,
      status: "partial"
    },
    repoRoot: resolve("../.."),
    startedAt: "2026-07-01T00:00:00.000Z",
    finishedAt: "2026-07-01T00:01:00.000Z",
    commands
  };
  await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  return path;
}

export async function execPlatformVerifierFailure(
  args: string[],
  options: { env?: NodeJS.ProcessEnv } = {}
): Promise<Record<string, any>> {
  try {
    await execFile(process.execPath, args, { cwd: resolve("../.."), ...options });
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout ?? "";
    return JSON.parse(stdout) as Record<string, any>;
  }
  throw new Error("Expected platform verifier to fail.");
}

export const CONTRAST_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGYktHRAD/AP8A/6C9p5MAAAAHdElNRQfqBh4KOQqnS6Y6AAAAEGNhTnYAAAABAAAAAQAAAAAAAAAAmdvqagAAABFJREFUCNdjZGBg+P///38GAA4EA/75rp4uAAAAAElFTkSuQmCC",
  "base64"
);

export const BLACK_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGYktHRAD/AP8A/6C9p5MAAAAHdElNRQfqBh4KOQqnS6Y6AAAAFElEQVQI12NkYGD4z8DAwMDEAAUADigBA29NMG0AAAAASUVORK5CYII=",
  "base64"
);

export const BLACK_2X1_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGNgYGD4D8IABgMB/8+HxnAAAAAASUVORK5CYII=",
  "base64"
);

export const STRUCTURED_4X2_PNG = rgbaPng(4, 2, [
  [0, 0, 0, 255], [0, 0, 0, 255], [0, 0, 0, 255], [255, 255, 255, 255],
  [0, 0, 0, 255], [0, 0, 0, 255], [0, 0, 0, 255], [255, 255, 255, 255]
]);

export const ALPHA_2X2_PNG = rgbaPng(2, 2, [
  [0, 0, 0, 0], [255, 255, 255, 255],
  [0, 0, 0, 128], [0, 0, 0, 0]
]);

export function rgbaPng(width: number, height: number, pixels: Array<[number, number, number, number]>): Buffer {
  const raw = Buffer.alloc(height * (1 + width * 4));
  let rawOffset = 0;
  let pixelOffset = 0;
  for (let y = 0; y < height; y += 1) {
    raw[rawOffset] = 0;
    rawOffset += 1;
    for (let x = 0; x < width; x += 1) {
      const pixel = pixels[pixelOffset];
      pixelOffset += 1;
      raw[rawOffset] = pixel[0];
      raw[rawOffset + 1] = pixel[1];
      raw[rawOffset + 2] = pixel[2];
      raw[rawOffset + 3] = pixel[3];
      rawOffset += 4;
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

export function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

export function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
