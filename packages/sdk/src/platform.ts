/**
 * platform.ts — the SDK's view of "can this machine render?".
 *
 * Role: a host embedding Motion through the SDK has to answer this before it offers a render
 * button, and it must get the SAME answer the CLI's `shellx-motion doctor` and the MCP
 * `motion.platform.requirements` command give. Before the readiness-parity invariant there was no shared type
 * at all, so each surface — and each host — decided for itself, and they disagreed.
 *
 * This module deliberately adds no logic. It re-exports the single shared result and its probe so
 * an SDK consumer has one import site and cannot accidentally build a second, differently-shaped
 * readiness model:
 *
 * ```ts
 * import { checkMotionPlatformRequirements, motionOperationReadiness } from "@shellx-motion/sdk";
 *
 * const requirements = await checkMotionPlatformRequirements();
 * const render = motionOperationReadiness(requirements, "render.final");
 * if (!render.satisfied) {
 *   // requirements.tools carries per-platform install commands to offer as a button.
 *   // `render.possible` with an `alternative` means the DEFAULT route is blocked and the flag
 *   // named there runs anyway; `possible: false` means something must be installed first.
 * }
 * ```
 *
 * The probe runs in-process and shells out to `ffmpeg -version`, `ffprobe -version` and the
 * resolved Chrome/Chromium's `--version`, so it suits a host that runs Motion locally. A host
 * driving Motion over the debug transport should call `motion.platform.requirements` instead and
 * read `result.platform`, which is this same object.
 *
 * Dependencies: `@shellx-motion/renderer-ffmpeg`. Primary callers: SDK/host integrations.
 */
export {
  checkMotionPlatformRequirements,
  motionOperationReadiness,
  motionRequirementsReport,
  MOTION_PLATFORM_REQUIREMENTS_SCHEMA,
  MOTION_REQUIREMENT_OPERATIONS,
  probeMotionTool,
  type MotionOperationAlternative,
  type MotionOperationReadiness,
  type MotionPlatformRequirements,
  type MotionRequirementOperation,
  type MotionToolIdentity,
  type MotionToolName,
  type MotionToolReport,
  type MotionToolSource,
  type MotionToolStatus
} from "@shellx-motion/renderer-ffmpeg";
