/**
 * platform-operations.ts — which operations Motion can perform on this machine, and by which route.
 *
 * ROLE
 * ----
 * `platform-requirements.ts` answers "which external tools does this machine have?". This module
 * answers the question a caller actually asks: "can I run the thing I am about to run?" — and it
 * owns the table that turns tool status into that answer.
 *
 * WHY A REQUIREMENT CAN BE LANE-DEPENDENT
 * ---------------------------------------
 * `render.final` broke the flat "operation -> tools" model this file replaced, and the break was a
 * false green on the one command the product exists for. `render` defaults to
 * `--frame-lane browser`, which rasterizes every frame in a real Chrome/Chromium that Motion does
 * not ship — the dependency is `playwright-core`, which (unlike `playwright`) downloads no browser.
 * But `--frame-lane native` renders the same package with no browser at all. Modelling Chromium
 * either way alone is wrong:
 *
 *   - omit it (what the flat table did) and `doctor --operation render.final` reports a clean
 *     machine that then fails with "No Chrome/Chromium executable found for browser renderer";
 *   - make it an unconditional requirement of `render.final` and the same report says "cannot
 *     render" to a user whose machine renders perfectly well with one extra flag.
 *
 * So an operation declares tools needed by EVERY route and, separately, tools its DEFAULT route
 * needs plus the argument that takes the other one:
 *
 *   `satisfied`   — runs the way you are about to invoke it. Never silently true because some other
 *                   route exists; this is what a pre-flight is being asked.
 *   `possible`    — runs at all, by some supported route. False means something must be installed.
 *   `alternative` — the route that rescues a blocked default, with the flag and its cost.
 *
 * The conservative direction is deliberate. A host that reads only `satisfied` — the documented
 * one-boolean contract — must never be told green for a command that will fail; being told amber
 * with the fix printed beside it costs one flag, and costs nothing at all to a host that reads
 * `alternative` and offers it.
 *
 * DEPENDENCIES / CALLERS
 * ----------------------
 * `@shellx-motion/core` for the tool vocabulary, nothing else — this module makes no decision that
 * needs to observe the machine. Primary caller: `platform-requirements.ts`, which projects these
 * answers into the shared result every Motion surface returns.
 */
import type { MotionToolName } from "@shellx-motion/core";

/** Operations a caller can ask about before committing effort. */
export type MotionRequirementOperation = "preview.frame" | "render.final" | "quality.check";

export const MOTION_REQUIREMENT_OPERATIONS: readonly MotionRequirementOperation[] = [
  "preview.frame",
  "render.final",
  "quality.check"
];

/**
 * A supported non-default route through an operation, and what taking it costs.
 *
 * Emitted only when the default route is blocked AND this route clears every blocker — an
 * alternative that still leaves the operation impossible is noise on a report a user is reading to
 * find out what to do next.
 */
export interface MotionOperationAlternative {
  /** The exact argument to add. Pasteable, not a description of one. */
  flag: string;
  /** Tools this route does not need. What makes it an escape from `blockedBy`, not a retry. */
  avoids: MotionToolName[];
  /**
   * Does this route depend on the PACKAGE as well as the machine?
   *
   * True means the flag is available on this machine but a given document may still be refused by
   * it — so a host must offer it as something to try, never as a guaranteed one-click fix, and an
   * agent must be ready for the render to fail for a reason this answer could not know. Readiness
   * is machine-scoped by construction: it is handed no package, so it cannot promise more.
   */
  packageDependent: boolean;
  /** What changes by taking it. Never presented as a free win. */
  tradeoff: string;
}

/**
 * Whether one named operation can run on this machine right now.
 *
 * Three facts, not one boolean — see the module header. `satisfied` is about the DEFAULT
 * invocation; `possible` is about the machine. They differ exactly when a flag routes around a
 * missing tool.
 */
export interface MotionOperationReadiness {
  operation: MotionRequirementOperation;
  /**
   * Can this operation run AS IT WILL BE INVOKED — the default route, no extra arguments? This is
   * the boolean a pre-flight is really asking about, so it stays false while the default route is
   * blocked even when {@link possible} is true.
   */
  satisfied: boolean;
  /** Tools the default route needs that are not ready. Empty when satisfied. */
  blockedBy: MotionToolName[];
  /**
   * Can this operation run AT ALL on this machine, by any supported route? False means no flag
   * helps and something must be installed. Equal to `satisfied` for every operation that has only
   * one route.
   */
  possible: boolean;
  /** The route that rescues a blocked default. Present only when `!satisfied && possible`. */
  alternative?: MotionOperationAlternative;
}

/** What one operation needs, split by whether every route needs it or only the default one. */
interface MotionOperationRequirement {
  /** Needed whichever route is taken. Absent, the operation is impossible on this machine. */
  everyRoute: MotionToolName[];
  /**
   * Needed only by the route taken with no extra arguments, plus the argument that takes the other
   * route. Kept as one field rather than two tables so the invariant "the alternative avoids
   * exactly these tools" is visible where both are written.
   */
  defaultRoute?: { tools: MotionToolName[]; alternative: MotionOperationAlternative };
}

/** Which tools each operation needs, by route. The single table every readiness answer derives from. */
const OPERATION_REQUIREMENTS: Record<MotionRequirementOperation, MotionOperationRequirement> = {
  // `preview` defaults to `--lane native`, which shells out to nothing. `--lane browser` is an
  // opt-in that needs Chromium, but a flag a caller must type cannot make the DEFAULT unready —
  // so this operation has no default-route tool of its own.
  "preview.frame": { everyRoute: [] },
  "render.final": {
    everyRoute: ["ffmpeg"],
    defaultRoute: {
      // `render` defaults to `--frame-lane browser`: frames are rasterized in a real Chrome that
      // the `playwright-core` dependency deliberately does not download.
      tools: ["chromium"],
      alternative: {
        flag: "--frame-lane native",
        avoids: ["chromium"],
        // Verified on a machine with no browser: `render --frame-lane native` delivers an MP4 for a
        // package the native lane can draw, and refuses `native_text_not_deliverable` for one it
        // cannot. Both are real, and which one a caller gets depends on their document — so the
        // route is offered, and the condition is stated rather than discovered at render time.
        packageDependent: true,
        tradeoff: "The native rasterizer draws the frames instead of a browser. It is a narrow lane:"
          + " a fixed uppercase block-glyph set and no font rasterizer, so a DELIVERY render refuses"
          + " (`native_text_not_deliverable`) any package whose text is lowercase or names a font"
          + " family, and it cannot draw browser-only layers (HTML/web sources, capture workflows)."
          + " It is also CLI-only — `motion.render.final` accepts frameLane \"browser\" alone, so an"
          + " agent on the debug transport needs Chromium installed."
      }
    }
  },
  // Reading back what was encoded — container facts, stream inventory, durations. FFmpeg alone can
  // produce a file; it takes FFprobe to prove what the file actually is.
  "quality.check": { everyRoute: ["ffprobe"] }
};

/**
 * Operations one tool blocks when it is not ready.
 *
 * Default-route tools count: without Chromium, `render.final` does not run as invoked, and a host
 * filtering tools by `requiredForOperations` to decide what to warn about has to see it.
 */
export function motionToolRequiredForOperations(tool: MotionToolName): MotionRequirementOperation[] {
  return MOTION_REQUIREMENT_OPERATIONS.filter((operation) => defaultRouteTools(operation).includes(tool));
}

/** Every tool the no-extra-arguments invocation of an operation needs. */
function defaultRouteTools(operation: MotionRequirementOperation): MotionToolName[] {
  const requirement = OPERATION_REQUIREMENTS[operation];
  return [...requirement.everyRoute, ...(requirement.defaultRoute?.tools ?? [])];
}

/**
 * Readiness for every operation, given which tools answered their probe.
 *
 * @param readyTools Tools whose status is `ready`. Anything absent from the set blocks.
 * @returns One entry per operation, in {@link MOTION_REQUIREMENT_OPERATIONS} order.
 */
export function motionOperationReadinessList(readyTools: ReadonlySet<MotionToolName>): MotionOperationReadiness[] {
  return MOTION_REQUIREMENT_OPERATIONS.map((operation) => {
    const blockedBy = defaultRouteTools(operation).filter((tool) => !readyTools.has(tool));
    const satisfied = blockedBy.length === 0;
    // An alternative counts only when it clears EVERY blocker. With FFmpeg also absent, telling a
    // user to add `--frame-lane native` would be an instruction that still does not render.
    const candidate = OPERATION_REQUIREMENTS[operation].defaultRoute?.alternative;
    const alternative = !satisfied && candidate && blockedBy.every((tool) => candidate.avoids.includes(tool))
      ? candidate
      : undefined;
    return {
      operation,
      satisfied,
      blockedBy,
      possible: satisfied || alternative !== undefined,
      ...(alternative ? { alternative } : {})
    };
  });
}
