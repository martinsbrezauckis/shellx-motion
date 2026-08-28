import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJson } from "../../canonical-json";
import { renderDeliveryAnchorDeliveryBindingSha256, renderDeliveryFrameSequenceSha256, renderDeliveryScheduleSha256 } from "./render-delivery-identity";
import { syntheticGeRenderDelivery } from "./render-delivery-ge.fixture";
import { createTrustedWorkspaceAnchor, type TrustedWorkspaceAnchor } from "../../output-path-trusted-workspace";
import {
  admitMotionRenderDeliverySources,
  MAX_RENDER_DELIVERY_ANCHOR_BYTES,
  MAX_RENDER_DELIVERY_BEAUTY_FRAME_BYTES,
  MAX_RENDER_DELIVERY_SEQUENCE_BYTES,
  renderDeliveryEphemeralSourceLocations,
  RenderDeliverySourceAdmissionError,
  revalidateMotionRenderDeliverySources,
} from "./render-delivery-source-manifest";

const lstatProbe = vi.hoisted(() => ({ path: "", calls: 0 }));
const readProbe = vi.hoisted(() => ({ path: "", calls: 0 }));
const anchorScopeProbe = vi.hoisted(() => ({ calls: 0, sawUndefined: false }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      if (String(args[0]) === lstatProbe.path) lstatProbe.calls += 1;
      return await actual.lstat(...args);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (String(args[0]) !== readProbe.path) return handle;
      return new Proxy(handle, {
        get(target, property) {
          if (property === "read") {
            return async (...readArgs: Parameters<typeof handle.read>) => {
              readProbe.calls += 1;
              return await handle.read(...readArgs);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as typeof handle;
    },
  };
});

vi.mock("../../output-path-trusted-workspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../output-path-trusted-workspace")>();
  return {
    ...actual,
    withTrustedWorkspaceAnchor: async (...args: Parameters<typeof actual.withTrustedWorkspaceAnchor>) => {
      anchorScopeProbe.calls += 1;
      if (args[0] === undefined) anchorScopeProbe.sawUndefined = true;
      return await actual.withTrustedWorkspaceAnchor(...args);
    },
  };
});

const roots: string[] = [];
const ONE_PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64");

afterEach(async () => {
  lstatProbe.path = "";
  lstatProbe.calls = 0;
  readProbe.path = "";
  readProbe.calls = 0;
  anchorScopeProbe.calls = 0;
  anchorScopeProbe.sawUndefined = false;
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

describe("private provider-delivery source admission", () => {
  it("reads a bounded, hash-verified beauty sequence into immutable path-free facts without writing", async () => {
    const fixture = await sourceFixture();
    const before = await Promise.all(fixture.paths.map(async (path) => await readFile(path)));

    const manifest = await admitMotionRenderDeliverySources({ delivery: fixture.delivery, sources: fixture.sources }, { providerInputRoot: fixture.root, providerInputRootAuthority: fixture.authority });
    expect(manifest.sources.beauty).toHaveLength(3);
    expect(manifest.sources.beauty.every((entry) => entry.byteLength === ONE_PIXEL_PNG.byteLength)).toBe(true);
    expect(manifest.sources.beauty.map((entry) => entry.packagePath)).toEqual([
      `assets/provider-delivery/${manifest.deliveryFingerprint}/beauty/000000.png`,
      `assets/provider-delivery/${manifest.deliveryFingerprint}/beauty/000001.png`,
      `assets/provider-delivery/${manifest.deliveryFingerprint}/beauty/000002.png`,
    ]);
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(JSON.stringify(manifest)).not.toContain(fixture.root);
    expect(JSON.stringify(manifest)).not.toContain(fixture.paths[0]!);
    expect(JSON.stringify(manifest)).not.toContain("provider-private");
    expect(renderDeliveryEphemeralSourceLocations(manifest).beauty.map((source) => source.providerLocalPath)).toEqual(fixture.paths);
    expect(renderDeliveryEphemeralSourceLocations(manifest).beauty.every((source) => source.identity.nlink === 1)).toBe(true);
    expect(JSON.stringify(manifest)).not.toContain('"ino"');
    await expect(revalidateMotionRenderDeliverySources(manifest)).resolves.toBe(manifest);
    await expect(Promise.all(fixture.paths.map(async (path) => await readFile(path)))).resolves.toEqual(before);
  });

  it.skipIf(process.platform === "win32")("refuses omitted POSIX authority before descriptor or source metadata", async () => {
    const fixture = await sourceFixture();
    lstatProbe.path = fixture.paths[0]!;
    await expect(admitMotionRenderDeliverySources({ delivery: fixture.delivery, sources: fixture.sources }, {
      providerInputRoot: fixture.root,
    })).rejects.toMatchObject({ code: "source_identity" });
    expect(anchorScopeProbe.calls).toBe(0);
    expect(anchorScopeProbe.sawUndefined).toBe(false);
    expect(lstatProbe.calls).toBe(0);
  });

  it("preflights, binds, and revalidates one canonical anchor payload without persisting its source path", async () => {
    const fixture = await anchoredSourceFixture();
    const before = await Promise.all([...fixture.paths, fixture.anchorPath].map(async (path) => await readFile(path)));
    const manifest = await admitMotionRenderDeliverySources({ delivery: fixture.delivery, sources: fixture.sources }, {
      providerInputRoot: fixture.root,
      providerInputRootAuthority: fixture.authority,
    });

    expect(manifest.sources.anchors).toMatchObject({
      role: "anchors",
      packagePath: `assets/provider-delivery/${manifest.deliveryFingerprint}/anchors.json`,
      sha256: sha(fixture.anchorBytes),
      byteLength: fixture.anchorBytes.byteLength,
      schema: "motion.render-provider-anchor-payload/v1",
      frameCount: fixture.delivery.schedule.length,
      convention: "screen-pixel-top-left-q1024",
    });
    expect(manifest.sourceByteLength).toBe((ONE_PIXEL_PNG.byteLength * fixture.paths.length) + fixture.anchorBytes.byteLength);
    expect(JSON.stringify(manifest)).not.toContain(fixture.anchorPath);
    expect(renderDeliveryEphemeralSourceLocations(manifest).anchors).toMatchObject({ providerLocalPath: fixture.anchorPath, identity: { nlink: 1 } });
    await expect(revalidateMotionRenderDeliverySources(manifest)).resolves.toBe(manifest);
    await expect(Promise.all([...fixture.paths, fixture.anchorPath].map(async (path) => await readFile(path)))).resolves.toEqual(before);
  });

  it("rejects a malformed anchor payload without exposing its location", async () => {
    const malformed = await anchoredSourceFixture();
    await writeFile(malformed.anchorPath, Buffer.from(`${malformed.anchorBytes.toString("utf8")}\n`, "utf8"));
    malformed.delivery.anchors!.sha256 = sha(await readFile(malformed.anchorPath));
    await expectAdmissionCode({ delivery: malformed.delivery, sources: malformed.sources }, malformed.root, "source_anchor_payload");
  });

  it("rejects a replaced anchor payload during manifest revalidation", async () => {
    const stale = await anchoredSourceFixture();
    const manifest = await admitMotionRenderDeliverySources({ delivery: stale.delivery, sources: stale.sources }, { providerInputRoot: stale.root, providerInputRootAuthority: stale.authority });
    await rm(stale.anchorPath);
    await writeFile(stale.anchorPath, stale.anchorBytes);
    await expect(revalidateMotionRenderDeliverySources(manifest)).rejects.toMatchObject({ code: "source_identity" });
  });

  it("rejects symlinked and hardlinked anchor payloads without exposing locations", async () => {
    if (process.platform !== "win32") {
      const symlinked = await anchoredSourceFixture();
      const outside = join(symlinked.root, "outside-anchor.json");
      await writeFile(outside, symlinked.anchorBytes);
      await rm(symlinked.anchorPath);
      await symlink(outside, symlinked.anchorPath);
      await expectAdmissionCode({ delivery: symlinked.delivery, sources: symlinked.sources }, symlinked.root, "source_identity");
    }

    const hardlinked = await anchoredSourceFixture();
    await link(hardlinked.anchorPath, join(hardlinked.root, "second-anchor.json"));
    await expectAdmissionCode({ delivery: hardlinked.delivery, sources: hardlinked.sources }, hardlinked.root, "source_identity");
  });

  it("keeps the contract's 8K descriptor but explicitly narrows C5A byte admission to the existing bounded 4K decoder", async () => {
    const fixture = await sourceFixture();
    fixture.delivery.passes[0]!.width = 4_000;
    await expect(admitMotionRenderDeliverySources({ delivery: fixture.delivery, sources: fixture.sources }, { providerInputRoot: fixture.root, providerInputRootAuthority: fixture.authority }))
      .rejects.toMatchObject({ code: "source_png" });
  });

  it("rejects symlink and hardlink provider inputs without exposing their locations", async () => {
    if (process.platform !== "win32") {
      const symlinkFixture = await sourceFixture();
      const replacement = join(symlinkFixture.root, "outside.png");
      await writeFile(replacement, ONE_PIXEL_PNG);
      await rm(symlinkFixture.paths[0]!);
      await symlink(replacement, symlinkFixture.paths[0]!);
      await expectAdmissionCode({ delivery: symlinkFixture.delivery, sources: symlinkFixture.sources }, symlinkFixture.root, "source_identity");
    }

    const hardlinkFixture = await sourceFixture();
    await link(hardlinkFixture.paths[0]!, join(hardlinkFixture.root, "second-name.png"));
    await expectAdmissionCode({ delivery: hardlinkFixture.delivery, sources: hardlinkFixture.sources }, hardlinkFixture.root, "source_identity");
  });

  it("rejects hash tampering, malformed PNG bytes, and a replacement after full preflight", async () => {
    const hashFixture = await sourceFixture();
    await writeFile(hashFixture.paths[1]!, Buffer.from(ONE_PIXEL_PNG));
    hashFixture.delivery.passes[0]!.frames[1]!.sha256 = "a".repeat(64);
    hashFixture.delivery.passes[0]!.frameSequenceSha256 = renderDeliveryFrameSequenceSha256(hashFixture.delivery.passes[0]!.frames);
    await expectAdmissionCode({ delivery: hashFixture.delivery, sources: hashFixture.sources }, hashFixture.root, "source_hash");

    const pngFixture = await sourceFixture();
    const malformed = Buffer.from("not-a-png");
    await writeFile(pngFixture.paths[0]!, malformed);
    replaceFrameHash(pngFixture.delivery, 0, sha(malformed));
    await expectAdmissionCode({ delivery: pngFixture.delivery, sources: pngFixture.sources }, pngFixture.root, "source_png");

    const raceFixture = await sourceFixture();
    await expectAdmissionCode({ delivery: raceFixture.delivery, sources: raceFixture.sources }, raceFixture.root, "source_identity", {
      afterPreflight: async () => await writeFile(raceFixture.paths[2]!, Buffer.from("changed after all caps were reserved")),
    });
  });

  it("rejects a same-byte source rewrite during manifest revalidation", async () => {
    const fixture = await sourceFixture();
    const manifest = await admitMotionRenderDeliverySources({ delivery: fixture.delivery, sources: fixture.sources }, { providerInputRoot: fixture.root, providerInputRootAuthority: fixture.authority });
    await writeFile(fixture.paths[0]!, ONE_PIXEL_PNG);
    await expect(revalidateMotionRenderDeliverySources(manifest)).rejects.toMatchObject({ code: "source_identity" });
  });

  it("refuses a lexical provider-root escape before source metadata or the preflight hook", async () => {
    const fixture = await sourceFixture();
    const outside = resolve(fixture.root, "..", "outside-provider-frame.png");
    const sources = { beauty: fixture.sources.beauty.map((source, index) => index === 0 ? { ...source, providerLocalPath: outside } : source) };
    lstatProbe.path = outside;
    let afterPreflight = false;

    await expect(admitMotionRenderDeliverySources({ delivery: fixture.delivery, sources }, {
      providerInputRoot: fixture.root,
      providerInputRootAuthority: fixture.authority,
    }, { afterPreflight: async () => { afterPreflight = true; } })).rejects.toMatchObject({ code: "source_identity" });
    expect(lstatProbe.calls).toBe(0);
    expect(afterPreflight).toBe(false);
  });

  it("refuses a symlinked provider parent and mismatched host authority before outside leaf metadata", async () => {
    const symlinkFixture = await sourceFixture();
    const outsideRoot = await scratch();
    const outsideLeaf = join(outsideRoot, "outside-frame.png");
    await writeFile(outsideLeaf, ONE_PIXEL_PNG);
    const linkedParent = join(symlinkFixture.root, "provider-link");
    await symlink(outsideRoot, linkedParent, process.platform === "win32" ? "junction" : "dir");
    const linkedLeaf = join(linkedParent, "outside-frame.png");
    const linkedSources = { beauty: symlinkFixture.sources.beauty.map((source, index) => index === 0 ? { ...source, providerLocalPath: linkedLeaf } : source) };
    lstatProbe.path = linkedLeaf;

    await expect(admitMotionRenderDeliverySources({ delivery: symlinkFixture.delivery, sources: linkedSources }, {
      providerInputRoot: symlinkFixture.root,
      providerInputRootAuthority: symlinkFixture.authority,
    })).rejects.toMatchObject({ code: "source_identity" });
    expect(lstatProbe.calls).toBe(0);

    if (process.platform !== "win32") {
      const authorityFixture = await sourceFixture();
      const wrongRoot = await scratch();
      lstatProbe.path = authorityFixture.paths[0]!;
      await expect(admitMotionRenderDeliverySources({ delivery: authorityFixture.delivery, sources: authorityFixture.sources }, {
        providerInputRoot: authorityFixture.root,
        providerInputRootAuthority: await createTrustedWorkspaceAnchor(wrongRoot),
      })).rejects.toMatchObject({ code: "source_identity" });
      expect(lstatProbe.calls).toBe(0);
    }
  });

  it.skipIf(process.platform === "win32")("requires a supplied trusted anchor to name the exact provider root before source metadata", async () => {
    const fixture = await sourceFixture();
    lstatProbe.path = fixture.paths[0]!;
    await expect(admitMotionRenderDeliverySources({ delivery: fixture.delivery, sources: fixture.sources }, {
      providerInputRoot: fixture.root,
      providerInputRootAuthority: await createTrustedWorkspaceAnchor(dirname(fixture.root)),
    })).rejects.toMatchObject({ code: "source_identity" });
    expect(lstatProbe.calls).toBe(0);
  });

  it.skipIf(process.platform === "win32")("reserves per-file and aggregate sparse-byte bounds before the first read or decode", async () => {
    const perFile = await sourceFixture();
    await truncate(perFile.paths[0]!, MAX_RENDER_DELIVERY_BEAUTY_FRAME_BYTES + 1);
    let perFileHook = false;
    await expect(admitMotionRenderDeliverySources({ delivery: perFile.delivery, sources: perFile.sources }, {
      providerInputRoot: perFile.root,
      providerInputRootAuthority: perFile.authority,
    }, { afterPreflight: async () => { perFileHook = true; } })).rejects.toMatchObject({ code: "source_bounds" });
    expect(perFileHook).toBe(false);

    const aggregate = await sparseAggregateFixture();
    let aggregateHook = false;
    await expect(admitMotionRenderDeliverySources({ delivery: aggregate.delivery, sources: aggregate.sources }, {
      providerInputRoot: aggregate.root,
      providerInputRootAuthority: aggregate.authority,
    }, { afterPreflight: async () => { aggregateHook = true; } })).rejects.toMatchObject({ code: "source_bounds" });
    expect(aggregateHook).toBe(false);
  });

  it.skipIf(process.platform === "win32")("includes the optional anchor reservation in the shared 2 GiB aggregate before any source read", async () => {
    const anchorBytes = MAX_RENDER_DELIVERY_ANCHOR_BYTES;
    const perBeautyBytes = Math.floor((MAX_RENDER_DELIVERY_SEQUENCE_BYTES - anchorBytes) / 600) + 1;
    const aggregate = await sparseAggregateFixture(34, Math.floor((MAX_RENDER_DELIVERY_SEQUENCE_BYTES - anchorBytes) / 34) + 1);
    const anchorPath = join(aggregate.root, "provider-private", "anchors.json");
    await writeFile(anchorPath, Buffer.alloc(0));
    await truncate(anchorPath, anchorBytes);
    const delivery = aggregate.delivery as any;
    delivery.anchors = {
      schema: "motion.render-provider-anchor-payload/v1",
      sha256: "0".repeat(64),
      frameCount: delivery.schedule.length,
      convention: "screen-pixel-top-left-q1024",
    };
    let afterPreflight = false;
    const allocation = vi.spyOn(Buffer, "allocUnsafe");
    try {
      await expect(admitMotionRenderDeliverySources({
        delivery,
        sources: { ...aggregate.sources, anchors: { providerLocalPath: anchorPath } },
      }, { providerInputRoot: aggregate.root, providerInputRootAuthority: aggregate.authority }, {
        afterPreflight: async () => { afterPreflight = true; },
      })).rejects.toMatchObject({ code: "source_bounds" });
      expect(afterPreflight).toBe(false);
      expect(allocation).not.toHaveBeenCalled();
    } finally {
      allocation.mockRestore();
    }
  });

  it.skipIf(process.platform === "win32")("rejects post-preflight aggregate growth before allocating or reading a changed frame", async () => {
    const aggregate = await sparseAggregateFixture(34, 60 * 1024 * 1024);
    const allocation = vi.spyOn(Buffer, "allocUnsafe");
    readProbe.path = aggregate.sources.beauty[0]!.providerLocalPath;
    try {
      await expect(admitMotionRenderDeliverySources({ delivery: aggregate.delivery, sources: aggregate.sources }, {
        providerInputRoot: aggregate.root,
        providerInputRootAuthority: aggregate.authority,
      }, {
        afterPreflight: async () => {
          await Promise.all(aggregate.sources.beauty.map(async ({ providerLocalPath }) => await truncate(providerLocalPath, MAX_RENDER_DELIVERY_BEAUTY_FRAME_BYTES)));
        },
      })).rejects.toMatchObject({ code: "source_identity" });
      expect(readProbe.calls).toBe(0);
      expect(allocation).not.toHaveBeenCalled();
    } finally {
      allocation.mockRestore();
    }
  });

  it("keeps fixed C5A encoded byte ceilings separate from decoded PNG bounds", () => {
    expect(MAX_RENDER_DELIVERY_BEAUTY_FRAME_BYTES).toBe(64 * 1024 * 1024);
    expect(MAX_RENDER_DELIVERY_ANCHOR_BYTES).toBe(4 * 1024 * 1024);
    expect(MAX_RENDER_DELIVERY_SEQUENCE_BYTES).toBe(2 * 1024 * 1024 * 1024);
  });
});

async function sourceFixture(): Promise<{
  root: string;
  authority?: TrustedWorkspaceAnchor;
  paths: readonly string[];
  delivery: ReturnType<typeof syntheticGeRenderDelivery> & { passes: [{ frames: Array<{ index: number; sha256: string }>; width: number; height: number; frameSequenceSha256: string }]; anchors?: undefined };
  sources: { beauty: Array<{ index: number; providerLocalPath: string }> };
}> {
  const root = await scratch();
  const authority = process.platform === "win32" ? undefined : await createTrustedWorkspaceAnchor(root);
  const beautyRoot = join(root, "provider-private", "beauty");
  await mkdir(beautyRoot, { recursive: true, mode: 0o700 });
  const paths = await Promise.all([0, 1, 2].map(async (index) => {
    const path = join(beautyRoot, `${String(index).padStart(6, "0")}.png`);
    await writeFile(path, ONE_PIXEL_PNG);
    return path;
  }));
  const delivery = structuredClone(syntheticGeRenderDelivery()) as ReturnType<typeof syntheticGeRenderDelivery> & { passes: [{ frames: Array<{ index: number; sha256: string }>; width: number; height: number; frameSequenceSha256: string }]; anchors?: undefined };
  delete delivery.anchors;
  delivery.passes[0]!.width = 1;
  delivery.passes[0]!.height = 1;
  for (const frame of delivery.passes[0]!.frames) frame.sha256 = sha(ONE_PIXEL_PNG);
  delivery.passes[0]!.frameSequenceSha256 = renderDeliveryFrameSequenceSha256(delivery.passes[0]!.frames);
  return { root, authority, paths, delivery, sources: { beauty: paths.map((providerLocalPath, index) => ({ index, providerLocalPath })) } };
}

async function anchoredSourceFixture(): Promise<{
  root: string;
  authority?: TrustedWorkspaceAnchor;
  paths: readonly string[];
  anchorPath: string;
  anchorBytes: Buffer;
  delivery: any;
  sources: { beauty: Array<{ index: number; providerLocalPath: string }>; anchors: { providerLocalPath: string } };
}> {
  const base = await sourceFixture();
  const delivery = structuredClone(base.delivery) as any;
  delivery.anchors = {
    schema: "motion.render-provider-anchor-payload/v1",
    sha256: "0".repeat(64),
    frameCount: delivery.schedule.length,
    convention: "screen-pixel-top-left-q1024",
  };
  const payload = {
    schema: "motion.render-provider-anchor-payload/v1",
    deliveryBindingSha256: renderDeliveryAnchorDeliveryBindingSha256(delivery),
    coordinateConvention: "screen-pixel-top-left-q1024",
    anchors: [{ id: 12, samples: delivery.schedule.map((frame: { index: number }) => frame.index === 1
      ? { frameIndex: frame.index, state: "not-visible" }
      : { frameIndex: frame.index, state: "visible", xQ1024: frame.index * 1_024, yQ1024: 0 }) }],
  };
  const anchorBytes = Buffer.from(canonicalJson(payload), "utf8");
  delivery.anchors.sha256 = sha(anchorBytes);
  const anchorPath = join(base.root, "provider-private", "anchors.json");
  await writeFile(anchorPath, anchorBytes);
  return {
    ...base,
    anchorPath,
    anchorBytes,
    delivery,
    sources: { beauty: base.sources.beauty, anchors: { providerLocalPath: anchorPath } },
  };
}

async function sparseAggregateFixture(frameCount = 600, byteLength = 4 * 1024 * 1024): Promise<{
  root: string;
  authority?: TrustedWorkspaceAnchor;
  delivery: ReturnType<typeof denseBeautyDelivery>;
  sources: { beauty: Array<{ index: number; providerLocalPath: string }> };
}> {
  const root = await scratch();
  const authority = process.platform === "win32" ? undefined : await createTrustedWorkspaceAnchor(root);
  const beautyRoot = join(root, "provider-private", "beauty");
  await mkdir(beautyRoot, { recursive: true, mode: 0o700 });
  const delivery = denseBeautyDelivery(frameCount);
  const sources = { beauty: [] as Array<{ index: number; providerLocalPath: string }> };
  for (let index = 0; index < frameCount; index += 1) {
    const providerLocalPath = join(beautyRoot, `${String(index).padStart(6, "0")}.png`);
    await writeFile(providerLocalPath, Buffer.alloc(0));
    await truncate(providerLocalPath, byteLength);
    sources.beauty.push({ index, providerLocalPath });
  }
  return { root, authority, delivery, sources };
}

function denseBeautyDelivery(frameCount: number) {
  const delivery = structuredClone(syntheticGeRenderDelivery()) as any;
  delete delivery.anchors;
  const rate = { numerator: 30, denominator: 1 };
  const schedule = Array.from({ length: frameCount }, (_, index) => ({ index, presentationTime: reduced(index, rate.numerator) }));
  const frames = Array.from({ length: frameCount }, (_, index) => ({ index, sha256: "1".repeat(64) }));
  delivery.rate = rate;
  delivery.schedule = schedule;
  delivery.identity.scheduleSha256 = renderDeliveryScheduleSha256(rate, schedule);
  delivery.passes = [{ kind: "beauty", id: "beauty", format: "png", alphaMode: "straight", width: 1, height: 1, frames, frameSequenceSha256: renderDeliveryFrameSequenceSha256(frames) }];
  return delivery;
}

function reduced(numerator: number, denominator: number): { numerator: number; denominator: number } {
  let left = numerator;
  let right = denominator;
  while (right !== 0) [left, right] = [right, left % right];
  const divisor = left || 1;
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}

async function expectAdmissionCode(
  value: unknown,
  providerInputRoot: string,
  code: RenderDeliverySourceAdmissionError["code"],
  services: { afterPreflight?: () => Promise<void> } = {},
): Promise<void> {
  try {
    await admitMotionRenderDeliverySources(value, {
      providerInputRoot,
      providerInputRootAuthority: process.platform === "win32" ? undefined : await createTrustedWorkspaceAnchor(providerInputRoot),
    }, services);
    throw new Error("Expected provider source admission to refuse.");
  } catch (error) {
    expect(error).toBeInstanceOf(RenderDeliverySourceAdmissionError);
    expect(error).toMatchObject({ code });
    expect(String(error)).not.toContain(providerInputRoot);
  }
}

function replaceFrameHash(delivery: { passes: [{ frames: Array<{ index: number; sha256: string }>; frameSequenceSha256: string }] }, index: number, hash: string): void {
  delivery.passes[0]!.frames[index]!.sha256 = hash;
  delivery.passes[0]!.frameSequenceSha256 = renderDeliveryFrameSequenceSha256(delivery.passes[0]!.frames);
}

function sha(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function scratch(): Promise<string> {
  const projectScratch = resolve("../../.scratch");
  await mkdir(projectScratch, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(projectScratch, "render-delivery-source-"));
  roots.push(root);
  return root;
}
