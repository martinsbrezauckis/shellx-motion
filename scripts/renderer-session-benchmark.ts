import { performance } from "node:perf_hooks";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { loadMotionPackage } from "../packages/core/src/index";
import { createMotionBrowserRenderSession } from "../packages/renderer-browser/src/index";

interface BrowserBenchmarkBaseline {
  schema: "shellx-motion/browser-render-baseline@1";
  fixture: string;
  width: number;
  height: number;
  frameCount: number;
  maxElapsedMs: number;
  minFramesPerSecond: number;
  maxBrowserLaunches: number;
  maxContextsCreated: number;
  minUniqueFrames: number;
  minFrameCacheHits: number;
  maxProcessTreePeakRssBytes: number;
}

const execFileAsync = promisify(execFile);

const baselinePath = resolve("fixtures/benchmarks/renderer-browser-baseline.json");
const baseline = JSON.parse(await readFile(baselinePath, "utf8")) as BrowserBenchmarkBaseline;
const loadedPackage = await loadMotionPackage(resolve(baseline.fixture));
const pkg = {
  ...loadedPackage,
  motion: { ...loadedPackage.motion, width: baseline.width, height: baseline.height }
};
const outDir = await mkdtemp(join(tmpdir(), "shellx-motion-renderer-benchmark-"));
let nodePeakRssBytes = process.memoryUsage().rss;
let processTreePeakRssBytes = nodePeakRssBytes;
let sampling = false;
const sampleRss = async () => {
  if (sampling) return;
  sampling = true;
  nodePeakRssBytes = Math.max(nodePeakRssBytes, process.memoryUsage().rss);
  processTreePeakRssBytes = Math.max(processTreePeakRssBytes, await processTreeRssBytes(process.pid));
  sampling = false;
};
await sampleRss();
const rssSampler = setInterval(() => void sampleRss(), process.platform === "win32" ? 250 : 50);

try {
  const session = await createMotionBrowserRenderSession(pkg);
  try {
    const requests = Array.from({ length: baseline.frameCount }, (_, index) => ({
      atMs: Math.min(
        pkg.motion.durationMs - 1,
        Math.floor(index * pkg.motion.durationMs / Math.max(1, baseline.frameCount))
      ),
      outDir,
      outputPath: join(outDir, `${String(index).padStart(6, "0")}.png`)
    }));
    const startedAt = performance.now();
    const frames = await session.renderFrames(requests, { maxConcurrency: 2 });
    const repeated = await session.renderFrame({
      ...requests[0],
      outputPath: join(outDir, "repeat.png")
    });
    const elapsedMs = performance.now() - startedAt;
    const framesPerSecond = baseline.frameCount / (elapsedMs / 1_000);
    const uniqueFrames = new Set(frames.map((frame) => frame.output.sha256)).size;
    const deterministicReuse = repeated.output.sha256 === frames[0].output.sha256;
    const result = {
      schema: "shellx-motion/browser-render-benchmark@1",
      fixture: baseline.fixture,
      width: pkg.motion.width,
      height: pkg.motion.height,
      frameCount: baseline.frameCount,
      elapsedMs: Number(elapsedMs.toFixed(2)),
      framesPerSecond: Number(framesPerSecond.toFixed(3)),
      nodePeakRssBytes,
      processTreePeakRssBytes,
      memoryScope: "Node host plus descendant Chromium/helper processes.",
      uniqueFrames,
      deterministicReuse,
      metrics: session.metrics
    };
    const failures = [
      ...(elapsedMs > baseline.maxElapsedMs ? [`elapsed ${elapsedMs.toFixed(2)}ms > ${baseline.maxElapsedMs}ms`] : []),
      ...(framesPerSecond < baseline.minFramesPerSecond
        ? [`throughput ${framesPerSecond.toFixed(3)}fps < ${baseline.minFramesPerSecond}fps`]
        : []),
      ...(session.metrics.browserLaunches > baseline.maxBrowserLaunches
        ? [`browser launches ${session.metrics.browserLaunches} > ${baseline.maxBrowserLaunches}`]
        : []),
      ...(session.metrics.contextsCreated > baseline.maxContextsCreated
        ? [`contexts ${session.metrics.contextsCreated} > ${baseline.maxContextsCreated}`]
        : []),
      ...(uniqueFrames < baseline.minUniqueFrames ? [`unique frames ${uniqueFrames} < ${baseline.minUniqueFrames}`] : []),
      ...(session.metrics.frameCacheHits < baseline.minFrameCacheHits
        ? [`frame cache hits ${session.metrics.frameCacheHits} < ${baseline.minFrameCacheHits}`]
        : []),
      ...(!deterministicReuse ? ["repeated frame hash changed"] : []),
      ...(processTreePeakRssBytes > baseline.maxProcessTreePeakRssBytes
        ? [`process-tree RSS ${processTreePeakRssBytes} > ${baseline.maxProcessTreePeakRssBytes}`]
        : [])
    ];
    process.stdout.write(`${JSON.stringify({ ...result, ok: failures.length === 0, failures }, null, 2)}\n`);
    if (failures.length > 0) process.exitCode = 1;
  } finally {
    await session.close();
  }
} finally {
  clearInterval(rssSampler);
  await sampleRss();
  await rm(outDir, { recursive: true, force: true });
}

async function processTreeRssBytes(rootPid: number): Promise<number> {
  if (process.platform === "linux") return linuxProcessTreeRssBytes(rootPid);
  if (process.platform === "win32") return windowsProcessTreeRssBytes(rootPid);
  return posixProcessTreeRssBytes(rootPid);
}

async function linuxProcessTreeRssBytes(rootPid: number): Promise<number> {
  const pending = [rootPid];
  const visited = new Set<number>();
  let total = 0;
  while (pending.length > 0) {
    const pid = pending.pop()!;
    if (visited.has(pid)) continue;
    visited.add(pid);
    try {
      const status = await readFile(`/proc/${pid}/status`, "utf8");
      total += Number(status.match(/^VmRSS:\s+(\d+)\s+kB$/m)?.[1] ?? 0) * 1_024;
      const children = await readFile(`/proc/${pid}/task/${pid}/children`, "utf8");
      pending.push(...children.trim().split(/\s+/).filter(Boolean).map(Number));
    } catch {
      // A short-lived helper may exit between discovery and measurement.
    }
  }
  return total || process.memoryUsage().rss;
}

async function posixProcessTreeRssBytes(rootPid: number): Promise<number> {
  try {
    const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,rss="]);
    return rssFromProcessRows(rootPid, stdout.trim().split("\n").map((line) => {
      const [pid, parentPid, rssKb] = line.trim().split(/\s+/).map(Number);
      return { pid, parentPid, rssBytes: rssKb * 1_024 };
    }));
  } catch {
    return process.memoryUsage().rss;
  }
}

async function windowsProcessTreeRssBytes(rootPid: number): Promise<number> {
  try {
    const command = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize | ConvertTo-Json -Compress";
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command]);
    const parsed = JSON.parse(stdout) as Array<Record<string, number>> | Record<string, number>;
    const rows = (Array.isArray(parsed) ? parsed : [parsed]).map((row) => ({
      pid: Number(row.ProcessId),
      parentPid: Number(row.ParentProcessId),
      rssBytes: Number(row.WorkingSetSize)
    }));
    return rssFromProcessRows(rootPid, rows);
  } catch {
    return process.memoryUsage().rss;
  }
}

function rssFromProcessRows(
  rootPid: number,
  rows: Array<{ pid: number; parentPid: number; rssBytes: number }>
): number {
  const descendants = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (descendants.has(row.parentPid) && !descendants.has(row.pid)) {
        descendants.add(row.pid);
        changed = true;
      }
    }
  }
  const total = rows
    .filter((row) => descendants.has(row.pid))
    .reduce((sum, row) => sum + row.rssBytes, 0);
  return total || process.memoryUsage().rss;
}
