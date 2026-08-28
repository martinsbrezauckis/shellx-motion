import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { hashPackageFile, loadMotionPackage, readMotionDocument, readPackageManifest, readTemplateDocument, resolvePackageAsset } from "./package";

describe("motion package loader", () => {
  const fixtureRoot = resolve("../../fixtures/packages/lower-third");

  it("loads manifest and motion document", async () => {
    const pkg = await loadMotionPackage(fixtureRoot);

    expect(pkg.root.replace(/\\/g, "/")).toMatch(/fixtures\/packages\/lower-third$/);
    expect(pkg.manifest.id).toBe("pkg_lower_third");
    expect(pkg.motion.id).toBe("motion_lower_third");
  });

  it("preserves JSON-absent optional fields as absent on parsed package documents", () => {
    const manifest = readPackageManifest({
      schema: "shellx-motion/package-manifest@1", id: "pkg_json_optional", name: "JSON optional", motion: "motion.json",
      assets: [], sourceApp: "shellx-motion", compatibility: { lanes: ["browser"], hosts: ["motion"] },
    });
    const motion = readMotionDocument(minimalMotionDocument());
    const template = readTemplateDocument({
      schema: "shellx-motion/template@1", id: "template_json_optional", name: "JSON optional", motion: "motion.json",
      compatibleLanes: ["browser"], params: [], controls: [], bindings: [],
    });

    expect(Object.hasOwn(manifest, "template")).toBe(false);
    expect(Object.hasOwn(motion, "background")).toBe(false);
    expect(Object.hasOwn(template, "compatibleHosts")).toBe(false);
    expect(Object.hasOwn(template, "groups")).toBe(false);
  });

  it("refuses a manifest leaf symlink even when its target is otherwise valid", async () => {
    const packageRoot = await mkdtemp(join(tmpdir(), "shellx-motion-package-manifest-link-"));
    const outsideRoot = await mkdtemp(join(tmpdir(), "shellx-motion-package-manifest-target-"));
    const manifest = {
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_link_refusal",
      name: "Manifest link refusal",
      motion: "motion.json",
      assets: [],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["browser"], hosts: ["motion"] }
    };
    await writeFile(join(outsideRoot, "manifest.json"), `${JSON.stringify(manifest)}\n`);
    await writeFile(join(packageRoot, "motion.json"), `${JSON.stringify(minimalMotionDocument())}\n`);
    try {
      await symlink(join(outsideRoot, "manifest.json"), join(packageRoot, "manifest.json"), "file");
    } catch {
      return;
    }

    await expect(loadMotionPackage(packageRoot)).rejects.toThrow(/Package manifest must be a bounded regular non-symlink file/);
  });

  it("rejects asset path escapes", async () => {
    const pkg = await loadMotionPackage(fixtureRoot);

    expect(() => resolvePackageAsset(pkg, "../secret.txt")).toThrow(/escapes package root/);
  });

  it("rejects existing package asset symlinks that resolve outside the package root", async () => {
    const packageRoot = await mkdtemp(join(tmpdir(), "shellx-motion-package-symlink-root-"));
    const outsideRoot = await mkdtemp(join(tmpdir(), "shellx-motion-package-symlink-outside-"));
    const outsideFile = join(outsideRoot, "secret.txt");
    const assetDir = join(packageRoot, "assets");
    const assetLink = join(assetDir, "secret.txt");
    await mkdir(assetDir, { recursive: true });
    await writeFile(outsideFile, "secret", "utf8");
    try {
      await symlink(outsideFile, assetLink, "file");
    } catch {
      return;
    }

    expect(() => resolvePackageAsset({ root: packageRoot }, "assets/secret.txt")).toThrow(/escapes package root/);
  });

  it("computes stable sha256 hashes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shellx-motion-hash-"));
    const file = join(dir, "asset.txt");
    await writeFile(file, "motion\n", "utf8");

    await expect(hashPackageFile(file)).resolves.toBe("13d453bdb82f04880edd159c806b6020794cdeff911b47eab7e5b3a1b84ed5cd");
  });

  it("preserves keyframes when loading motion packages", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shellx-motion-keyframes-"));
    await writeFile(
      join(dir, "manifest.json"),
      `${JSON.stringify({
        schema: "shellx-motion/package-manifest@1",
        id: "pkg_keyframed",
        name: "Keyframed",
        motion: "motion.json",
        assets: [],
        sourceApp: "shellx-motion",
        compatibility: { lanes: ["browser"], hosts: ["motion"] }
      }, null, 2)}\n`
    );
    await writeFile(
      join(dir, "motion.json"),
      `${JSON.stringify({
        schema: "shellx-motion/motion@1",
        id: "motion_keyframed",
        name: "Keyframed",
        durationMs: 1000,
        fps: 30,
        width: 1920,
        height: 1080,
        background: "#101820",
        layers: [
          {
            id: "title",
            type: "text",
            text: "Anna",
            startMs: 0,
            durationMs: 1000,
            keyframes: {
              "transform.x": [
                { atMs: 0, value: 0, easing: "linear" },
                { atMs: 1000, value: 200 }
              ],
              opacity: [
                { atMs: 0, value: 0, easing: "linear" },
                { atMs: 1000, value: 1 }
              ]
            }
          }
        ],
        assets: [],
        provenance: { sourceApp: "shellx-motion", createdBy: "test" }
      }, null, 2)}\n`
    );

    const pkg = await loadMotionPackage(dir);

    expect(pkg.motion.layers[0].keyframes).toEqual({
      "transform.x": [
        { atMs: 0, value: 0, easing: "linear" },
        { atMs: 1000, value: 200 }
      ],
      opacity: [
        { atMs: 0, value: 0, easing: "linear" },
        { atMs: 1000, value: 1 }
      ]
    });
  });

  it("loads optional template sidecars for host-editable controls", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shellx-motion-template-sidecar-"));
    await writeFile(
      join(dir, "manifest.json"),
      `${JSON.stringify({
        schema: "shellx-motion/package-manifest@1",
        id: "pkg_template",
        name: "Template",
        motion: "motion.json",
        template: "template.json",
        assets: [],
        sourceApp: "shellx-motion",
        compatibility: { lanes: ["browser"], hosts: ["motion", "cut", "canvas"] }
      }, null, 2)}\n`
    );
    await writeFile(join(dir, "motion.json"), `${JSON.stringify(minimalMotionDocument(), null, 2)}\n`);
    await writeFile(
      join(dir, "template.json"),
      `${JSON.stringify({
        schema: "shellx-motion/template@1",
        id: "template_lower_third",
        name: "Editable Lower Third",
        motion: "motion.json",
        compatibleLanes: ["browser", "ffmpeg"],
        metadata: {
          inputExamples: [
            {
              title: "Anna",
              accentColor: "#13d3ff"
            }
          ],
          preview: {
            poster: "preview/poster.png",
            loop: "preview/loop.mp4",
            thumbnail: "preview/thumb.webp"
          },
          assetsAttribution: [
            {
              name: "Inter font",
              license: "SIL-OFL-1.1",
              author: "Rasmus Andersson",
              url: "https://rsms.me/inter/",
              path: "assets/fonts/inter.woff2"
            }
          ]
        },
        params: [
          { id: "title", label: "Title", type: "text", defaultValue: "Anna" }
        ],
        controls: [
          { paramId: "title", widget: "text", label: "Title" }
        ],
        bindings: [
          { paramId: "title", target: { kind: "motion_path", path: "/layers/0/text" } }
        ]
      }, null, 2)}\n`
    );

    const pkg = await loadMotionPackage(dir);

    expect(pkg.manifest.template).toBe("template.json");
    expect(pkg.template).toMatchObject({
      schema: "shellx-motion/template@1",
      id: "template_lower_third",
      metadata: {
        inputExamples: [
          {
            title: "Anna",
            accentColor: "#13d3ff"
          }
        ],
        preview: {
          poster: "preview/poster.png",
          loop: "preview/loop.mp4",
          thumbnail: "preview/thumb.webp"
        },
        assetsAttribution: [
          {
            name: "Inter font",
            license: "SIL-OFL-1.1",
            author: "Rasmus Andersson",
            url: "https://rsms.me/inter/",
            path: "assets/fonts/inter.woff2"
          }
        ]
      },
      params: [{ id: "title", type: "text", defaultValue: "Anna" }]
    });
  });

  it("loads the editable lower-third template fixture", async () => {
    const pkg = await loadMotionPackage(resolve("../../fixtures/packages/editable-lower-third"));

    expect(pkg.manifest.template).toBe("template.json");
    expect(pkg.manifest.assets).toEqual([
      "assets/fonts/inter-latin-400-normal.woff2",
      "assets/fonts/inter-latin-700-normal.woff2"
    ]);
    expect(pkg.motion.assets).toEqual([
      expect.objectContaining({ id: "font_inter_400", type: "font", family: "Inter", weight: 400 }),
      expect.objectContaining({ id: "font_inter_700", type: "font", family: "Inter", weight: 700 })
    ]);
    expect(pkg.template).toMatchObject({
      id: "template_editable_lower_third",
      compatibleHosts: ["shellx-motion", "shellx-canvas", "shellx-cut"],
      metadata: {
        assetsAttribution: expect.arrayContaining([
          expect.objectContaining({ name: "Inter font", license: "SIL-OFL-1.1" })
        ])
      },
      params: expect.arrayContaining([
        expect.objectContaining({ id: "title", type: "text" }),
        expect.objectContaining({ id: "accentColor", type: "color" })
      ]),
      bindings: expect.arrayContaining([
        expect.objectContaining({ paramId: "title", target: { kind: "motion_path", path: "/layers/0/text", layerId: "title" } })
      ])
    });
  });

  it("rejects template story, media-slot, and review-frame metadata that does not match its package", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shellx-motion-template-semantics-"));
    await mkdir(join(dir, "quality"), { recursive: true });
    await writeFile(
      join(dir, "manifest.json"),
      `${JSON.stringify({
        schema: "shellx-motion/package-manifest@1",
        id: "pkg_template_semantics",
        name: "Template semantics",
        motion: "motion.json",
        template: "template.json",
        assets: [],
        sourceApp: "shellx-motion",
        compatibility: { lanes: ["browser"], hosts: ["shellx-motion"] }
      }, null, 2)}\n`
    );
    await writeFile(join(dir, "motion.json"), `${JSON.stringify(minimalMotionDocument(), null, 2)}\n`);
    await writeFile(join(dir, "quality", "frames.json"), `${JSON.stringify({ schema: "shellx-motion/quality-manifest@1", samples: [] }, null, 2)}\n`);

    const validTemplate = semanticTemplateDocument();
    await writeFile(join(dir, "template.json"), `${JSON.stringify(validTemplate, null, 2)}\n`);
    await expect(loadMotionPackage(dir)).resolves.toMatchObject({ template: { id: "template_semantics" } });

    const invalidCases: Array<{ template: Record<string, unknown>; error: RegExp }> = [
      {
        template: semanticTemplateDocument({ mediaSlots: [{ paramId: "headline", role: "hero", acceptedKinds: ["image"] }] }),
        error: /must reference a media param/
      },
      {
        template: semanticTemplateDocument({ storyLayerId: "missing-layer" }),
        error: /references unknown layer missing-layer/
      },
      {
        template: semanticTemplateDocument({ storyDurationMs: 1001 }),
        error: /must fit within the motion duration/
      },
      {
        template: semanticTemplateDocument({ representativeFramesMs: [1000] }),
        error: /representative frames must occur before the motion end/
      },
      {
        template: semanticTemplateDocument({ qualityManifest: "quality/missing.json" }),
        error: /qualityTargets\.manifest does not exist/
      }
    ];
    for (const invalid of invalidCases) {
      await writeFile(join(dir, "template.json"), `${JSON.stringify(invalid.template, null, 2)}\n`);
      await expect(loadMotionPackage(dir)).rejects.toThrow(invalid.error);
    }
  });

  it("rejects template sidecars that escape the package root", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shellx-motion-template-escape-"));
    await writeFile(
      join(dir, "manifest.json"),
      `${JSON.stringify({
        schema: "shellx-motion/package-manifest@1",
        id: "pkg_template_escape",
        name: "Template escape",
        motion: "motion.json",
        template: "../template.json",
        assets: [],
        sourceApp: "shellx-motion",
        compatibility: { lanes: ["browser"], hosts: ["motion"] }
      }, null, 2)}\n`
    );
    await writeFile(join(dir, "motion.json"), `${JSON.stringify(minimalMotionDocument(), null, 2)}\n`);

    await expect(loadMotionPackage(dir)).rejects.toThrow(/escapes package root/);
  });
});

function semanticTemplateDocument(overrides: {
  mediaSlots?: Array<Record<string, unknown>>;
  storyLayerId?: string;
  storyDurationMs?: number;
  representativeFramesMs?: number[];
  qualityManifest?: string;
} = {}): Record<string, unknown> {
  return {
    schema: "shellx-motion/template@1",
    id: "template_semantics",
    name: "Template semantics",
    motion: "motion.json",
    compatibleLanes: ["browser"],
    compatibleHosts: ["shellx-motion"],
    metadata: {
      story: {
        beats: [{
          id: "intro",
          intent: "Introduce the title over user media.",
          startMs: 0,
          durationMs: overrides.storyDurationMs ?? 1000,
          layerIds: [overrides.storyLayerId ?? "title"],
          mediaParamIds: ["heroMedia"]
        }]
      },
      mediaSlots: overrides.mediaSlots ?? [{ paramId: "heroMedia", role: "hero", acceptedKinds: ["image"] }],
      qualityTargets: {
        manifest: overrides.qualityManifest ?? "quality/frames.json",
        representativeFramesMs: overrides.representativeFramesMs ?? [0, 500]
      }
    },
    params: [
      { id: "headline", label: "Headline", type: "text", defaultValue: "Anna" },
      { id: "heroMedia", label: "Hero media", type: "media", defaultValue: "assets/hero.png" }
    ],
    controls: [
      { paramId: "headline", widget: "text", label: "Headline" },
      { paramId: "heroMedia", widget: "media", label: "Hero media" }
    ],
    bindings: [
      { paramId: "headline", target: { kind: "motion_path", path: "/layers/0/text", layerId: "title" } },
      { paramId: "heroMedia", target: { kind: "motion_path", path: "/layers/0/source", layerId: "title" } }
    ]
  };
}

function minimalMotionDocument(): Record<string, unknown> {
  return {
    schema: "shellx-motion/motion@1",
    id: "motion_template",
    name: "Template",
    durationMs: 1000,
    fps: 30,
    width: 640,
    height: 360,
    layers: [
      {
        id: "title",
        type: "text",
        text: "Anna",
        startMs: 0,
        durationMs: 1000
      }
    ],
    assets: [],
    provenance: { sourceApp: "shellx-motion", createdBy: "test" }
  };
}
