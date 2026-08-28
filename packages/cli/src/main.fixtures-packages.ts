/**
 * Single-package fixture builders for the ShellX Motion CLI test suite.
 *
 * Role: builders that write a small on-disk motion package (native, brand/asset, timeline, template-media,
 * audio/video/media-layer variants) plus the OTIO/HTML import fixture data used by the CLI tests.
 * Extracted verbatim from `main.test.ts` for the module-size gate; pure move, no behavior change.
 *
 * Dependencies: node fs/os/path built-ins only. Each builder returns the created package root; the calling
 * test registers it in the shared `tempDirs` registry (in `main.test-support`) for afterEach cleanup.
 *
 * Primary callers: `packages/cli/src/main.test.ts`.
 */
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function writeTinyNativePackage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-cli-package-"));
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_cli_ffmpeg_sequence",
      name: "CLI FFmpeg Sequence",
      motion: "motion.json",
      assets: [],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["native", "ffmpeg"], hosts: ["motion"] }
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: "motion_cli_ffmpeg_sequence",
      name: "CLI FFmpeg Sequence",
      durationMs: 300,
      fps: 10,
      width: 64,
      height: 36,
      background: "#102030",
      layers: [
        {
          id: "title",
          type: "text",
          text: "A",
          startMs: 0,
          durationMs: 300,
          transform: { x: 4, y: 4, scale: 1 },
          style: { color: "#ffffff", fontSize: 14 }
        }
      ],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    }, null, 2)}\n`
  );
  return root;
}

export async function rewriteTinyNativePackageTitle(root: string, text: string): Promise<void> {
  const motionPath = join(root, "motion.json");
  const motion = JSON.parse(await readFile(motionPath, "utf8")) as Record<string, any>;
  motion.layers[0].text = text;
  await writeFile(motionPath, `${JSON.stringify(motion, null, 2)}\n`, "utf8");
}

export async function writeTinyPackageWithAssetsAndBrand(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-cli-assets-package-"));
  await mkdir(join(root, "assets"), { recursive: true, mode: 0o700 });
  await writeFile(join(root, "assets", "logo.png"), "pngbytes", "utf8");
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_cli_assets",
      name: "CLI Assets",
      motion: "motion.json",
      assets: ["assets/logo.png", "assets/missing.png"],
      sourceApp: "shellx-canvas",
      compatibility: { lanes: ["native", "ffmpeg"], hosts: ["shellx-motion", "shellx-canvas"] },
      selectedFrameId: "frame_hero"
    }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: "motion_cli_assets",
      name: "CLI Assets",
      durationMs: 1000,
      fps: 10,
      width: 64,
      height: 36,
      layers: [
        { id: "logo", type: "image", assetRef: "assets/logo.png", startMs: 0, durationMs: 1000 },
        { id: "remote", type: "image", src: "https://cdn.example.com/remote.png", startMs: 0, durationMs: 1000 }
      ],
      assets: [{ id: "logo", ref: "assets/logo.png" }],
      designTokens: {
        color: { accent: "#ff006e" },
        typography: { heading: { fontFamily: "Inter", fontWeight: 800 } }
      },
      provenance: {
        sourceApp: "shellx-canvas",
        createdBy: "test",
        projectId: "canvas_project",
        selectedFrameId: "frame_hero"
      }
    }, null, 2)}\n`,
    "utf8"
  );
  return root;
}

export async function writeTinyPackageWithTimeline(): Promise<string> {
  const root = await writeTinyNativePackage();
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: "motion_cli_ffmpeg_sequence",
      name: "CLI FFmpeg Sequence",
      durationMs: 300,
      fps: 10,
      width: 64,
      height: 36,
      background: "#102030",
      tracks: [
        { id: "overlay", type: "overlay", name: "Overlay", order: 1, layerIds: ["title"] }
      ],
      scenes: [
        { id: "intro", name: "Intro", startMs: 0, durationMs: 300, trackIds: ["overlay"], markerIds: ["start", "outro"] }
      ],
      markers: [
        { id: "start", atMs: 0, label: "Start", type: "cue" },
        { id: "outro", atMs: 240, durationMs: 60, label: "Outro", type: "cue" }
      ],
      layers: [
        {
          id: "title",
          type: "text",
          text: "A",
          trackId: "overlay",
          startMs: 0,
          durationMs: 300,
          transform: { x: 4, y: 4, scale: 1 },
          style: { color: "#ffffff", fontSize: 14 }
        }
      ],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    }, null, 2)}\n`
  );
  return root;
}

export function tinyOtioTimelineFixture(): Record<string, unknown> {
  return {
    OTIO_SCHEMA: "Timeline.1",
    name: "CLI OTIO",
    metadata: {
      shellx_motion: {
        width: 640,
        height: 360,
        fps: 24
      }
    },
    tracks: {
      OTIO_SCHEMA: "Stack.1",
      children: [
        {
          OTIO_SCHEMA: "Track.1",
          name: "Video",
          kind: "Video",
          children: [
            {
              OTIO_SCHEMA: "Clip.2",
              name: "Clip 01",
              media_reference: {
                OTIO_SCHEMA: "ExternalReference.1",
                target_url: "media/clip01.mp4"
              },
              source_range: {
                OTIO_SCHEMA: "TimeRange.1",
                start_time: { OTIO_SCHEMA: "RationalTime.1", value: 0, rate: 24 },
                duration: { OTIO_SCHEMA: "RationalTime.1", value: 24, rate: 24 }
              },
              metadata: {
                shellx_motion: {
                  layerId: "clip_01",
                  layerType: "video"
                }
              }
            }
          ]
        }
      ]
    }
  };
}

export function htmlSnippetImportFixture(): string {
  return `<!doctype html>
<html lang="en" data-shellx-motion-schema="shellx-motion/html-snippet@1" data-shellx-motion-package-id="pkg_html_cli">
<head><title>CLI HTML</title></head>
<body>
  <main class="shellx-motion-composition" data-composition-id="motion_html_cli" data-duration="900" data-fps="30" style="width: 640px; height: 360px; background: #101820;">
    <div class="shellx-motion-layer shellx-motion-text" data-layer-id="headline" data-layer-type="text" data-start="100" data-duration="700" style="left: 48px; top: 96px; width: 460px; height: 80px; color: #ffffff; font-size: 42px; font-weight: 700;">Hello from HTML</div>
  </main>
</body>
</html>
`;
}

export async function writeTemplateMediaPackage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-cli-template-media-package-"));
  await mkdir(join(root, "assets"), { recursive: true, mode: 0o700 });
  await writeFile(join(root, "assets", "default-headshot.png"), "default image", "utf8");
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_cli_template_media",
      name: "CLI Template Media",
      motion: "motion.json",
      template: "template.json",
      assets: ["assets/default-headshot.png"],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["native", "browser", "ffmpeg"], hosts: ["shellx-motion", "shellx-canvas", "shellx-cut"] },
      workflow: "template-media"
    }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: "motion_cli_template_media",
      name: "CLI Template Media",
      durationMs: 1000,
      fps: 10,
      width: 640,
      height: 360,
      layers: [
        {
          id: "headshot",
          type: "image",
          source: "assets/default-headshot.png",
          assetRef: "assets/default-headshot.png",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 20, y: 20, scale: 1 }
        }
      ],
      assets: [{ id: "default-headshot", ref: "assets/default-headshot.png" }],
      provenance: { sourceApp: "shellx-motion", createdBy: "test", workflow: "template-media" }
    }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    join(root, "template.json"),
    `${JSON.stringify({
      schema: "shellx-motion/template@1",
      id: "template_cli_template_media",
      name: "CLI Template Media",
      motion: "motion.json",
      compatibleLanes: ["native", "browser", "ffmpeg"],
      compatibleHosts: ["shellx-motion", "shellx-canvas", "shellx-cut"],
      groups: [{ id: "media", label: "Media", order: 1 }],
      params: [{ id: "headshot", label: "Headshot", type: "media", defaultValue: "assets/default-headshot.png", group: "media", order: 1 }],
      controls: [{ paramId: "headshot", widget: "media", label: "Headshot" }],
      bindings: [
        { paramId: "headshot", target: { kind: "motion_path", path: "/layers/0/source", layerId: "headshot" } },
        { paramId: "headshot", target: { kind: "motion_path", path: "/layers/0/assetRef", layerId: "headshot" } }
      ]
    }, null, 2)}\n`,
    "utf8"
  );
  return root;
}

export async function writeTinyPackageWithAudioLayer(audioOverrides: Record<string, unknown> = {}): Promise<string> {
  const root = await writeTinyNativePackage();
  await mkdir(join(root, "assets"), { recursive: true, mode: 0o700 });
  await writeFile(join(root, "assets", "tone.wav"), "fake wav bytes", "utf8");
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_cli_ffmpeg_sequence",
      name: "CLI FFmpeg Sequence",
      motion: "motion.json",
      assets: ["assets/tone.wav"],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["browser", "ffmpeg"], hosts: ["motion"] }
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: "motion_cli_ffmpeg_sequence",
      name: "CLI FFmpeg Sequence",
      durationMs: 300,
      fps: 10,
      width: 64,
      height: 36,
      background: "#102030",
      layers: [
        {
          id: "title",
          type: "text",
          text: "A",
          startMs: 0,
          durationMs: 300,
          transform: { x: 4, y: 4, scale: 1 },
          style: { color: "#ffffff", fontSize: 14 }
        },
        {
          id: "music",
          type: "audio",
          source: "assets/tone.wav",
          startMs: 0,
          durationMs: 300,
          ...audioOverrides
        }
      ],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    }, null, 2)}\n`
  );
  return root;
}

export async function writeTinyPackageWithVideoLayer(videoOverrides: Record<string, unknown> = {}): Promise<string> {
  const root = await writeTinyNativePackage();
  await mkdir(join(root, "assets"), { recursive: true, mode: 0o700 });
  await writeFile(join(root, "assets", "clip.mp4"), "fake mp4 bytes with audio", "utf8");
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_cli_ffmpeg_sequence",
      name: "CLI FFmpeg Sequence",
      motion: "motion.json",
      assets: ["assets/clip.mp4"],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["browser", "ffmpeg"], hosts: ["motion"] }
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: "motion_cli_ffmpeg_sequence",
      name: "CLI FFmpeg Sequence",
      durationMs: 300,
      fps: 10,
      width: 64,
      height: 36,
      background: "#102030",
      layers: [
        {
          id: "clip",
          type: "video",
          source: "assets/clip.mp4",
          startMs: 0,
          durationMs: 300,
          trimStartMs: 50,
          trimDurationMs: 200,
          loop: false,
          transform: { x: 0, y: 0, width: 64, height: 36 },
          ...videoOverrides
        }
      ],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    }, null, 2)}\n`
  );
  return root;
}

export async function writeTinyPackageWithMediaLayers(): Promise<string> {
  const root = await writeTinyNativePackage();
  await mkdir(join(root, "assets"), { recursive: true, mode: 0o700 });
  await writeFile(join(root, "assets", "product.png"), "product bytes", "utf8");
  await writeFile(join(root, "assets", "clip.mp4"), "clip bytes", "utf8");
  await writeFile(join(root, "card.html"), "<!doctype html><main>Media</main>\n", "utf8");
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_cli_media",
      name: "CLI Media",
      motion: "motion.json",
      assets: ["assets/product.png", "assets/clip.mp4", "card.html"],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["browser", "ffmpeg"], hosts: ["motion"] }
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: "motion_cli_media",
      name: "CLI Media",
      durationMs: 500,
      fps: 10,
      width: 64,
      height: 36,
      background: "#102030",
      layers: [
        { id: "product", type: "image", source: "assets/product.png", startMs: 0, durationMs: 300 },
        {
          id: "clip",
          type: "video",
          source: "assets/clip.mp4",
          startMs: 0,
          durationMs: 300,
          trimStartMs: 20,
          trimDurationMs: 180,
          includeAudio: true,
          playbackRate: 1.1
        },
        { id: "music", type: "audio", source: "assets/missing.wav", startMs: 0, durationMs: 500 },
        { id: "card", type: "web", src: "card.html", startMs: 0, durationMs: 500 },
        { id: "placeholder", type: "image", startMs: 300, durationMs: 200 }
      ],
      assets: [{ id: "product", ref: "assets/product.png" }],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    }, null, 2)}\n`
  );
  return root;
}

export async function writeTinyPackageWithTwoAudioLayers(): Promise<string> {
  const root = await writeTinyNativePackage();
  await mkdir(join(root, "assets"), { recursive: true, mode: 0o700 });
  await writeFile(join(root, "assets", "music.wav"), "fake music wav bytes", "utf8");
  await writeFile(join(root, "assets", "voice.wav"), "fake voice wav bytes", "utf8");
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_cli_ffmpeg_sequence",
      name: "CLI FFmpeg Sequence",
      motion: "motion.json",
      assets: ["assets/music.wav", "assets/voice.wav"],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["browser", "ffmpeg"], hosts: ["motion"] }
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: "motion_cli_ffmpeg_sequence",
      name: "CLI FFmpeg Sequence",
      durationMs: 300,
      fps: 10,
      width: 64,
      height: 36,
      background: "#102030",
      layers: [
        {
          id: "title",
          type: "text",
          text: "A",
          startMs: 0,
          durationMs: 300,
          transform: { x: 4, y: 4, scale: 1 },
          style: { color: "#ffffff", fontSize: 14 }
        },
        {
          id: "music",
          type: "audio",
          source: "assets/music.wav",
          startMs: 40,
          durationMs: 300,
          trimStartMs: 100,
          trimDurationMs: 250,
          loop: true,
          volume: 0.4
        },
        {
          id: "voice",
          type: "audio",
          source: "assets/voice.wav",
          startMs: 160,
          durationMs: 300,
          volume: 0.8
        }
      ],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    }, null, 2)}\n`
  );
  return root;
}
