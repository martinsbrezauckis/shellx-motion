/**
 * Generated text-layer fixture builders for the ShellX Motion browser renderer test suite.
 *
 * Role: builders that write on-disk motion packages exercising the browser renderer's generated text
 * paths — text box, letter spacing, horizontal/vertical align, alignment keyframes, background, padding,
 * and border. Extracted verbatim from `index.test.ts` for the module-size gate; pure move, no
 * behavior change.
 *
 * Dependencies: node fs/os/path built-ins only. Each builder returns the created package root; the calling
 * test registers it in its own temp-dir registry for afterEach cleanup.
 *
 * Primary callers: `packages/renderer-browser/src/index.test.ts`.
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function writeGeneratedTextBoxPackage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-generated-text-box-package-"));
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_generated_text_box",
      name: "Generated Text Box",
      motion: "motion.json",
      assets: [],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["browser"], hosts: ["motion"] }
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: "motion_generated_text_box",
      name: "Generated Text Box",
      durationMs: 1000,
      fps: 24,
      width: 640,
      height: 360,
      background: "#0f172a",
      layers: [
        {
          id: "title",
          type: "text",
          text: "Cut Generate Title",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 48, y: 80, scale: 1 },
          style: { width: 520, height: 90, fontSize: 52, color: "#ffffff", fontWeight: 800 }
        }
      ],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    }, null, 2)}\n`
  );
  return root;
}

export async function writeGeneratedTextLetterSpacingPackage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-generated-text-letter-spacing-package-"));
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_generated_text_letter_spacing",
      name: "Generated Text Letter Spacing",
      motion: "motion.json",
      assets: [],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["browser"], hosts: ["motion"] }
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: "motion_generated_text_letter_spacing",
      name: "Generated Text Letter Spacing",
      durationMs: 1100,
      fps: 24,
      width: 220,
      height: 100,
      background: "#000000",
      layers: [
        {
          id: "title",
          type: "text",
          text: "WW",
          startMs: 0,
          durationMs: 1100,
          transform: { x: 20, y: 20, width: 190, height: 60, opacity: 1 },
          style: { fontSize: 32, color: "#ffffff", fontWeight: 800, letterSpacing: 0 },
          keyframes: {
            "style.letterSpacing": [
              { atMs: 0, value: 0, easing: "linear" },
              { atMs: 1000, value: 60 }
            ]
          }
        }
      ],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    }, null, 2)}\n`
  );
  return root;
}

export async function writeGeneratedTextAlignPackage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-generated-text-align-package-"));
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_generated_text_align",
      name: "Generated Text Align",
      motion: "motion.json",
      assets: [],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["browser"], hosts: ["motion"] }
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: "motion_generated_text_align",
      name: "Generated Text Align",
      durationMs: 1000,
      fps: 24,
      width: 240,
      height: 90,
      background: "#000000",
      layers: [
        {
          id: "title",
          type: "text",
          text: "II",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 20, y: 20, width: 200, height: 50, opacity: 1 },
          style: { fontSize: 32, color: "#ffffff", fontWeight: 800, textAlign: "right" }
        }
      ],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    }, null, 2)}\n`
  );
  return root;
}

export async function writeGeneratedTextVerticalAlignPackage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-generated-text-vertical-align-package-"));
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_generated_text_vertical_align",
      name: "Generated Text Vertical Align",
      motion: "motion.json",
      assets: [],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["browser"], hosts: ["motion"] }
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: "motion_generated_text_vertical_align",
      name: "Generated Text Vertical Align",
      durationMs: 1000,
      fps: 24,
      width: 240,
      height: 120,
      background: "#000000",
      layers: [
        {
          id: "title",
          type: "text",
          text: "II",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 20, y: 20, width: 200, height: 88, opacity: 1 },
          style: { fontSize: 32, color: "#ffffff", fontWeight: 800, verticalAlign: "bottom" }
        }
      ],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    }, null, 2)}\n`
  );
  return root;
}

export async function writeGeneratedTextAlignmentKeyframePackage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-generated-text-alignment-keyframes-package-"));
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_generated_text_alignment_keyframes",
      name: "Generated Text Alignment Keyframes",
      motion: "motion.json",
      assets: [],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["browser"], hosts: ["motion"] }
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: "motion_generated_text_alignment_keyframes",
      name: "Generated Text Alignment Keyframes",
      durationMs: 1100,
      fps: 24,
      width: 240,
      height: 120,
      background: "#000000",
      layers: [
        {
          id: "title",
          type: "text",
          text: "II",
          startMs: 0,
          durationMs: 1100,
          transform: { x: 20, y: 20, width: 200, height: 88, opacity: 1 },
          style: { fontSize: 32, color: "#ffffff", fontWeight: 800, textAlign: "left", verticalAlign: "top" },
          keyframes: {
            "style.textAlign": [
              { atMs: 0, value: "left", easing: "hold" },
              { atMs: 1000, value: "right" }
            ],
            "style.verticalAlign": [
              { atMs: 0, value: "top", easing: "hold" },
              { atMs: 1000, value: "bottom" }
            ]
          }
        }
      ],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    }, null, 2)}\n`
  );
  return root;
}

export async function writeGeneratedTextBackgroundPackage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-generated-text-background-package-"));
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_generated_text_background",
      name: "Generated Text Background",
      motion: "motion.json",
      assets: [],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["browser"], hosts: ["motion"] }
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: "motion_generated_text_background",
      name: "Generated Text Background",
      durationMs: 1000,
      fps: 24,
      width: 220,
      height: 110,
      background: "#000000",
      layers: [
        {
          id: "title",
          type: "text",
          text: "II",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 20, y: 20, width: 180, height: 60, opacity: 1 },
          style: { backgroundColor: "#ffffff", color: "#000000", fontSize: 32, fontWeight: 800 }
        }
      ],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    }, null, 2)}\n`
  );
  return root;
}

export async function writeGeneratedTextPaddingPackage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-generated-text-padding-package-"));
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_generated_text_padding",
      name: "Generated Text Padding",
      motion: "motion.json",
      assets: [],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["browser"], hosts: ["motion"] }
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: "motion_generated_text_padding",
      name: "Generated Text Padding",
      durationMs: 1000,
      fps: 24,
      width: 240,
      height: 120,
      background: "#000000",
      layers: [
        {
          id: "title",
          type: "text",
          text: "II",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 20, y: 20, width: 180, height: 74, opacity: 1 },
          style: { backgroundColor: "#ffffff", color: "#000000", fontSize: 32, fontWeight: 800, padding: 22 }
        }
      ],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    }, null, 2)}\n`
  );
  return root;
}

export async function writeGeneratedTextBorderPackage(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "shellx-motion-generated-text-border-package-"));
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schema: "shellx-motion/package-manifest@1",
      id: "pkg_generated_text_border",
      name: "Generated Text Border",
      motion: "motion.json",
      assets: [],
      sourceApp: "shellx-motion",
      compatibility: { lanes: ["browser"], hosts: ["motion"] }
    }, null, 2)}\n`
  );
  await writeFile(
    join(root, "motion.json"),
    `${JSON.stringify({
      schema: "shellx-motion/motion@1",
      id: "motion_generated_text_border",
      name: "Generated Text Border",
      durationMs: 1000,
      fps: 24,
      width: 240,
      height: 130,
      background: "#000000",
      layers: [
        {
          id: "title",
          type: "text",
          text: "II",
          startMs: 0,
          durationMs: 1000,
          transform: { x: 20, y: 20, width: 170, height: 76, opacity: 1 },
          style: {
            backgroundColor: "#ffffff",
            color: "#000000",
            fontSize: 32,
            fontWeight: 800,
            padding: 18,
            borderColor: "#ff0000",
            borderWidth: 6,
            radius: 18
          }
        }
      ],
      assets: [],
      provenance: { sourceApp: "shellx-motion", createdBy: "test" }
    }, null, 2)}\n`
  );
  return root;
}
