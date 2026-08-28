/**
 * Creating a Motion package from nothing.
 *
 * Role: this was the single biggest hole in the agent surface. Every authoring command in Motion
 * edits a package that already exists — `layer.create`, `keyframe.upsert`, `template apply` — and
 * every route that *makes* one was an importer (Lottie, glTF, HTML snippet, Canvas, script compile).
 * An agent asked to build something original had no first step.
 *
 * Found by giving an independent agent only the skill doc and the MCP tools and asking it to build
 * a chart: it searched for a create command, found none, and only recovered because an unrelated
 * fixture package happened to be left in the machine's temp directory, whose shape it copied.
 * Without that accident it would have had nowhere to start. `motion.actions.find("create new empty
 * motion package")` answered with the glTF importer.
 *
 * What "minimal" means here: a package that **validates and renders** as-is. Not a stub that needs
 * repair before the next command will accept it — the whole point is that the agent's second call
 * can be a real edit. It therefore ships a background and one visible layer, because a document
 * with an empty `layers` array renders a blank frame and an agent cannot tell that from a failure.
 *
 * INPUTS ARE BOUNDED BY WHAT THE RENDERERS ENFORCE. The first version accepted any positive
 * width/height/fps/durationMs, so `create` reported success for a 100000x100000 document and the
 * agent's very next call — `motion.preview.frame` — died inside `assertLocalMotionFrameBudget` with
 * an unhandled `LocalMotionJobError` and a stack trace instead of a result. The bounds are read from
 * `MOTION_DOCUMENT_LIMITS`, which is assembled in `job-governor.ts` out of the guards that do the
 * refusing later, so this command cannot promise a size the renderers will not serve.
 *
 * THE BACKGROUND IS A COLOUR THIS ENGINE KNOWS. It used to be copied through as any string. Motion
 * resolves 22 CSS colour names, not the 148 CSS defines, so `midnightblue` authored fine and then
 * failed the first native preview with "Unsupported color format" (and renders as TRANSPARENT in the
 * browser lane, which is worse: a wrong picture with no error at all).
 *
 * IDS ARE UNIQUE PER PACKAGE, NOT PER NAME. They used to be a fold of the human name, so every
 * unnamed package on the machine was `pkg_untitled_motion`, and `Launch Hero` and `LAUNCH-HERO`
 * were the same package as far as receipts, caches and host lineage were concerned. A 64-bit random
 * suffix now identifies the package itself. The alphabet is `[a-z0-9_]` only — no uppercase, ever —
 * because `job-id-file.ts` paid for that lesson during cross-host verification: ids that differ only in case are one id on
 * Windows and macOS, where the filesystem folds case, and one id means one caller's evidence
 * silently overwrites another's.
 *
 * PUBLICATION IS ATOMIC. The first version checked that the target directory was empty and then
 * wrote into it directly. That violated the command-and-creation contract in two ways: two
 * concurrent creators could each pass the check and then write over each other, and an interruption
 * between the two `writeFile` calls left a directory holding half a package — which is worse than
 * no package, because `motion.package.validate` reads it as a broken package rather than a missing
 * one. The package is now built in a staging directory beside the target and published with a single
 * `rename`, the same temp-then-rename discipline `writeJsonAtomic` uses in `job-registry.ts` and
 * `job-lease.ts`. A caller therefore observes the target as absent or complete, never in between,
 * and a crash leaves an inert dot-prefixed staging directory rather than a corrupt package.
 *
 * Dependencies: node:fs and the package types. Primary callers: `motion.package.create` in the
 * Debug API and `package-create` in the CLI.
 */
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isSupportedMotionColorString, supportedMotionColorAdvice } from "./color";
import { motionDocumentBudgetError } from "./job-governor";
import { OutputDirectoryTransaction } from "./output-directory-transaction";

export interface MotionPackageCreateInput {
  /** Directory to create the package in. Created if absent; must be empty if it exists. */
  packageRoot: string;
  /** Human-readable name, at most 128 characters. Also seeds the readable half of the ids. */
  name?: string;
  /** Frame width in pixels: 1..7680, and width x height at most 33,177,600. */
  width?: number;
  /** Frame height in pixels: 1..7680, and width x height at most 33,177,600. */
  height?: number;
  /** Frames per second: 1..120. */
  fps?: number;
  /**
   * Duration in milliseconds.
   *
   * Bounded jointly with `fps` rather than alone: what the renderers actually limit is the number of
   * frames (36,000) and pixel-frames (80e9) a delivery render materialises.
   */
  durationMs?: number;
  /** Document background. Must be a colour Motion's renderers resolve — see `color.ts`. */
  background?: string;
  /**
   * Start with no layers.
   *
   * Off by default: an empty document renders a blank frame, and a blank frame is indistinguishable
   * from a broken render, so the default gives the agent something it can see and then replace.
   */
  empty?: boolean;
}

export interface MotionPackageCreateResult {
  packageRoot: string;
  packageId: string;
  motionId: string;
  name: string;
  width: number;
  height: number;
  fps: number;
  durationMs: number;
  layerCount: number;
  files: string[];
  /** What to do next, so a cold-start agent is not left guessing at the second step. */
  nextSteps: string[];
}

/**
 * Injection seam, for tests only.
 *
 * The rollback guarantee is only real if something can be made to fail partway through, and a
 * genuine mid-write failure (a full disk, a killed process) cannot be produced deterministically in
 * a suite. Same shape and purpose as `MotionJobRegistryServices` in `job-registry.ts`: production
 * callers pass nothing and get the node:fs implementation.
 */
export interface MotionPackageCreateServices {
  /** Writes one staged file. Defaults to `node:fs/promises` `writeFile` with utf8 encoding. */
  writeFile?: (path: string, contents: string) => Promise<void>;
  /**
   * Mints the identity suffix. Defaults to 64 random bits as 16 lowercase hex characters.
   *
   * Only a suite needs this: an id that is unique by construction cannot be asserted literally, and
   * a test that wants to prove two same-named packages stay distinct has to be able to say what
   * "distinct" was. Whatever it returns is still held to the id alphabet, so a test cannot smuggle
   * in an id shape production would refuse.
   */
  uniqueSuffix?: () => string;
  /** Runs after the complete package is written to the private stage, immediately before commit. */
  beforeCommit?: (stagingPath: string) => Promise<void>;
}

const DEFAULTS = { width: 1920, height: 1080, fps: 30, durationMs: 5000, background: "#0b1020" };

/**
 * Longest accepted human name.
 *
 * The name is written into two documents and folded into two ids, so it is an input like any other.
 * 128 is the bound this repo already uses for a caller-supplied identifier (`assertMotionJobId`,
 * `boundedOperation`), reused rather than re-argued.
 */
const MAX_NAME_LENGTH = 128;

/** Hex characters of randomness in an id: 64 bits, the width `job-id-file.ts` chose for the same job. */
const IDENTITY_SUFFIX_HEX = 16;

/**
 * The whole alphabet an id may use.
 *
 * Lowercase only, deliberately. A package id ends up in receipts, cache keys and lineage, and some
 * of those become file names on filesystems that fold case — so if two ids may differ only by case,
 * two packages can share one file. `job-id-file.ts` documents the collision risk. Excluding
 * uppercase from the alphabet makes the hazard unreachable instead of survivable.
 */
const ID_ALPHABET = /^[a-z0-9_]{1,96}$/;

/** Fold a name into an id-safe token. Ids are matched and hashed, so they cannot carry spaces. */
function idToken(name: string): string {
  const token = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return token.length > 0 ? token.slice(0, 48) : "untitled";
}

/**
 * Build one package's identity: readable stem from the name, uniqueness from the suffix.
 *
 * The token alone is NOT an identity — it is a fold, so it is deliberately not injective
 * (`Launch Hero`, `LAUNCH-HERO` and `launch...hero` all produce `launch_hero`, and any name past 48
 * characters is truncated). The suffix is what makes two packages two packages; the token only
 * makes the id readable in a receipt listing.
 *
 * @param token folded name stem
 * @param services optional test seam for the suffix
 * @returns matching package and motion ids, checked against the id alphabet
 * @throws when a supplied suffix would produce an id outside the alphabet
 */
function packageIdentity(token: string, services: MotionPackageCreateServices): { packageId: string; motionId: string } {
  const suffix = services.uniqueSuffix?.() ?? randomBytes(IDENTITY_SUFFIX_HEX / 2).toString("hex");
  const identity = { packageId: `pkg_${token}_${suffix}`, motionId: `motion_${token}_${suffix}` };
  for (const id of [identity.packageId, identity.motionId]) {
    if (!ID_ALPHABET.test(id)) {
      throw new Error(`Motion package id must be 1..96 characters of lowercase letters, digits or underscore; produced ${id}.`);
    }
  }
  return identity;
}

/**
 * Refuse a document this machine cannot render, naming the accepted range.
 *
 * The bounds come from `MOTION_DOCUMENT_LIMITS`, which is built from the renderers' own guards —
 * see the module header for why a create-time bound that disagrees with them would be worse than
 * none at all.
 *
 * @param document the requested width/height/fps/durationMs
 * @throws when any field, or the frame budget they imply together, is outside what the lanes serve
 */
function assertRenderableDocument(document: { width: number; height: number; fps: number; durationMs: number }): void {
  const error = motionDocumentBudgetError(document);
  if (error) throw new Error(`Motion package ${error}`);
}

/**
 * Write a new, valid, renderable Motion package.
 *
 * Refuses a non-empty directory rather than merging into it: an agent that points this at an
 * existing package would otherwise half-overwrite it, and the damage is silent until a later render
 * produces something unexpected.
 *
 * Concurrency and interruption: the package is assembled in a staging directory beside the target
 * and published by one `rename`, so two creators racing on the same path produce exactly one
 * complete package and one refusal — never a mix of both packages' files — and a failure at any
 * point leaves the target untouched. See the module header for why.
 *
 * @param input target directory and document parameters
 * @param services test-only injection seam; production callers omit it
 * @returns the published package's identity and suggested next commands
 * @throws when a document parameter is outside what this machine renders (the message names the
 *   accepted range), when the background is not a colour Motion resolves, when the target exists and
 *   is not an empty directory, or when another creator published to the same path first
 */
export async function createMotionPackage(
  input: MotionPackageCreateInput,
  services: MotionPackageCreateServices = {}
): Promise<MotionPackageCreateResult> {
  const packageRoot = resolve(input.packageRoot);
  const name = (input.name ?? "Untitled Motion").trim() || "Untitled Motion";
  if (name.length > MAX_NAME_LENGTH) {
    throw new Error(`Motion package name must be at most ${MAX_NAME_LENGTH} characters; received ${name.length}.`);
  }
  const width = input.width ?? DEFAULTS.width;
  const height = input.height ?? DEFAULTS.height;
  const fps = input.fps ?? DEFAULTS.fps;
  const durationMs = input.durationMs ?? DEFAULTS.durationMs;
  assertRenderableDocument({ width, height, fps, durationMs });
  const requested = input.background ?? DEFAULTS.background;
  const background = typeof requested === "string" ? requested.trim() : "";
  if (!isSupportedMotionColorString(background)) {
    // Refused here rather than at render time on purpose: this command's promise is a package that
    // validates AND renders, and a colour no lane resolves breaks the second half of that while
    // passing the first. The advice lists the accepted forms because the wrong guess is usually a
    // real CSS colour name Motion happens not to resolve.
    throw new Error(`Motion package background must be a colour Motion renders: ${supportedMotionColorAdvice()}; received ${JSON.stringify(input.background)}.`);
  }
  const { packageId, motionId } = packageIdentity(idToken(name), services);

  // One centred, visible layer. An empty document renders a blank frame, which an agent cannot
  // distinguish from a failed render — so the default start is something it can see, then replace.
  const layers = input.empty ? [] : [{
    id: "layer1",
    type: "shape",
    shape: "rect",
    startMs: 0,
    durationMs,
    transform: {
      x: Math.round(width / 2 - width / 8),
      y: Math.round(height / 2 - height / 8),
      width: Math.round(width / 4),
      height: Math.round(height / 4),
      // PIXELS from the layer's top-left, never 0..1 — centred here so a rotation spins in place.
      originX: Math.round(width / 8),
      originY: Math.round(height / 8)
    },
    style: { fill: "#5b8def", radius: 12 },
    opacity: 1
  }];

  const motion = {
    schema: "shellx-motion/motion@1",
    id: motionId,
    name,
    durationMs,
    fps,
    width,
    height,
    background,
    layers,
    assets: [],
    provenance: { sourceApp: "shellx-motion", createdBy: "package.create" }
  };

  const manifest = {
    schema: "shellx-motion/package-manifest@1",
    id: packageId,
    name,
    motion: "motion.json",
    assets: [],
    sourceApp: "shellx-motion",
    compatibility: { lanes: ["browser", "ffmpeg"], hosts: ["motion"] }
  };

  const write = services.writeFile ?? ((path: string, contents: string) => writeFile(path, contents, "utf8"));
  const transaction = await OutputDirectoryTransaction.create(packageRoot);
  try {
    await mkdir(join(transaction.stagingPath, "assets"), { recursive: true });
    await write(join(transaction.stagingPath, "motion.json"), `${JSON.stringify(motion, null, 2)}\n`);
    await write(join(transaction.stagingPath, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await services.beforeCommit?.(transaction.stagingPath);
    await transaction.commit();
  } catch (error) {
    // The transaction removes only its identity-bound private stage. A retargeted path is preserved
    // for recovery instead of recursively deleting a caller-controlled replacement.
    await transaction.abort();
    throw error;
  }

  return {
    packageRoot,
    packageId: manifest.id,
    motionId: motion.id,
    name,
    width,
    height,
    fps,
    durationMs,
    layerCount: layers.length,
    files: ["motion.json", "manifest.json", "assets/"],
    // Commands only. This list is read by an agent at its least-informed moment — it has just
    // created a package and has no other context — so every entry has to be an instruction it can
    // follow without judgement. "or edit motion.json directly" used to sit on the layer step and
    // was removed because it contradicts the standing operating rule "do not
    // hand-edit package JSON when a command owns the operation" (skill/shellx-motion/SKILL.md), and
    // a hand-written layer skips id allocation, schema validation and the receipt trail that
    // motion.timeline.layer.create provides — producing exactly the package motion.package.validate
    // then rejects. Do not restore it here: a terse next-step list cannot carry the conditions an
    // escape hatch would need, and anything listed here reads as the sanctioned path. If direct
    // file editing ever needs documenting, it belongs in prose with its limits stated.
    nextSteps: [
      "motion.package.validate — confirm it is well-formed before editing",
      "motion.timeline.layer.create — add layers",
      "motion.timeline.keyframe.upsert — animate transform.x/y/width/height/rotation/opacity/fill",
      "motion.preview.frame — render one frame and LOOK at it before committing to a full render",
      "motion.render.final — encode the video"
    ]
  };
}
