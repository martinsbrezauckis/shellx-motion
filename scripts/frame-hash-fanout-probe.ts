/**
 * Fan-out probe for the frame-sequence hashing pass (the bounded-frame-hash invariant).
 *
 * Role: measure, on a real large frame sequence, how many files the frame-hash pass holds open at
 * once and how much resident memory it costs. The unbounded `Promise.all(framePaths.map(hashFile))`
 * shape opens one descriptor and one 64 KiB read stream per frame simultaneously; the render guard
 * allows up to 36,000 frames, so the peak is a property of the render, not of the machine.
 *
 * Measured by sampling `/proc/self/fd` (Linux) on a timer while the pass runs — the descriptors are
 * really open, not inferred. `--mode unbounded` reproduces the pre-fix shape verbatim so a
 * before/after comparison uses the same harness, the same files and the same sampler.
 *
 * Usage: tsx scripts/frame-hash-fanout-probe.ts [--frames N] [--mode unbounded|bounded] [--bytes N]
 *
 * Dependencies: `@shellx-motion/core` (`hashFile`, `hashFramePaths`). Not part of the shipped
 * packages — a measurement tool for the availability bound, kept so the number can be re-measured.
 */
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { hashFile, hashFramePaths } from "../packages/core/src/receipts";

const frames = Number(optionValue("--frames") ?? 12_000);
const mode = optionValue("--mode") ?? "bounded";
const frameBytes = Number(optionValue("--bytes") ?? 4096);
const root = resolve(optionValue("--out") ?? join(".scratch", "frame-hash-fanout"));

function optionValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

/** Open descriptors held by this process right now. Linux-only; the probe is a Linux measurement. */
function openDescriptors(): number {
  try {
    return readdirSync("/proc/self/fd").length;
  } catch {
    return -1;
  }
}

async function main(): Promise<void> {
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  // Deterministic per-frame content so each file hashes differently; size is irrelevant to the
  // fan-out (one descriptor per frame either way) and kept small so the probe is cheap to run.
  const filler = Buffer.alloc(frameBytes, 0x7a);
  for (let index = 0; index < frames; index += 1) {
    const bytes = Buffer.concat([Buffer.from(`frame-${index}\n`, "utf8"), filler]);
    await writeFile(join(root, `frame-${String(index).padStart(6, "0")}.bin`), bytes);
  }
  const paths = (await readdir(root)).sort().map((name) => join(root, name));

  const baselineDescriptors = openDescriptors();
  let peakDescriptors = baselineDescriptors;
  let peakRssBytes = process.memoryUsage().rss;
  const sampler = setInterval(() => {
    peakDescriptors = Math.max(peakDescriptors, openDescriptors());
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  }, 2);

  const startedAt = process.hrtime.bigint();
  const hashes = mode === "unbounded"
    // The exact pre-fix line from renderer-ffmpeg's hashFrameSequence.
    ? await Promise.all(paths.map(hashFile))
    : await hashFramePaths(paths);
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  clearInterval(sampler);

  console.log(JSON.stringify({
    mode,
    frames: paths.length,
    frameBytes,
    baselineDescriptors,
    peakDescriptors,
    peakConcurrentFrameDescriptors: peakDescriptors - baselineDescriptors,
    peakRssMb: Number((peakRssBytes / (1024 * 1024)).toFixed(1)),
    elapsedMs: Number(elapsedMs.toFixed(1)),
    hashCount: hashes.length,
    firstHash: hashes[0]
  }, null, 2));
  await rm(root, { recursive: true, force: true });
}

await main();
