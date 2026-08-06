/**
 * The no-match answer for `motion.actions.find`.
 *
 * Role: `findAction` returns `MotionAction | null`, and the debug command returned that null
 * verbatim. `motion.actions.find("permission elevation")` therefore answered `result: null` — true,
 * but it teaches an agent nothing: no statement that the catalog was searched, no near misses, no
 * next call. A blind agent reads that as "the tool is broken" or retries the same query.
 *
 * Mechanism: keep `findAction`'s exact match semantics (a wrong action is worse than none), and add
 * a second, deliberately looser pass that only runs when the strict pass found nothing. The loose
 * pass never returns null: the catalog always has a nearest neighbour, and "here is the closest
 * thing plus how to search properly" is strictly more useful than a bare null.
 *
 * Dependencies: types only, from `./catalog.js` (type-only, erased at runtime — no module cycle).
 *
 * Primary caller: `findActionMatch` in `./catalog.ts`, surfaced by `domains/agent.ts`.
 */
import type { MotionAction } from "./catalog.js";
import { normalizeRequest } from "./catalog-workflows.js";

/** Compact action card: enough for an agent to decide, without repeating every alias. */
export interface MotionActionSummary {
  id: string;
  primaryAlias: string;
  permission: string;
  mutates: boolean;
  calls: string[];
  /** Why this action is in the list, when it was returned as a near miss. */
  matchedOn?: string;
}

/** The result of a catalog lookup, matched or not. */
export interface MotionActionMatch {
  matched: boolean;
  action: MotionAction | null;
  /** Present only when nothing matched: a plain statement of that fact. */
  message?: string;
  /** Never empty. The closest actions the catalog does hold. */
  nearest: MotionActionSummary[];
}

const NEAREST_LIMIT = 5;

/** Words too common to carry meaning in a catalog query. */
const STOP_WORDS = new Set([
  "the", "and", "for", "with", "this", "that", "from", "into", "how", "can", "does", "did", "you",
  "your", "our", "its", "all", "any", "get", "got", "use", "using", "motion", "please", "want", "need"
]);

function tokens(value: string): string[] {
  return [...new Set(normalizeRequest(value).split(" ").filter((word) => word.length > 2 && !STOP_WORDS.has(word)))];
}

function summarize(action: MotionAction, matchedOn?: string): MotionActionSummary {
  return {
    id: action.id,
    primaryAlias: action.aliases[0] ?? action.id,
    permission: action.permission,
    mutates: action.mutates,
    calls: [...action.calls],
    ...(matchedOn ? { matchedOn } : {})
  };
}

/**
 * Rank the catalog against a request that the strict matcher rejected.
 *
 * @returns at most {@link NEAREST_LIMIT} actions, best first, never empty.
 *
 * Scoring is intentionally weaker than `aliasScore`: a single shared token counts, and the action
 * id counts as well as the aliases. That is exactly what makes it unsafe as a match — a one-word
 * overlap must never be presented as "this is your action" — and exactly what makes it a usable
 * suggestion list.
 */
export function nearestActions(request: string, actions: MotionAction[], limit = NEAREST_LIMIT): MotionActionSummary[] {
  const requestTokens = tokens(request);
  const scored = actions.map((action) => {
    let best = { score: 0, on: "" };
    for (const candidate of [...action.aliases, action.id.replace(/[.]/g, " ")]) {
      const candidateTokens = tokens(candidate);
      const shared = candidateTokens.filter((token) => requestTokens.includes(token));
      // Normalize by candidate length so a 12-word alias sharing one token does not outrank a
      // 2-word alias sharing the same one.
      const score = shared.length === 0 ? 0 : shared.length + shared.length / candidateTokens.length;
      if (score > best.score) best = { score, on: candidate };
    }
    return { action, ...best };
  });
  const overlapping = scored.filter((entry) => entry.score > 0).sort((left, right) => right.score - left.score || compare(left.action.id, right.action.id));
  if (overlapping.length > 0) {
    return overlapping.slice(0, limit).map((entry) => summarize(entry.action, entry.on));
  }
  // Nothing shares a word at all. Returning [] here would reintroduce the bare-null dead end, so
  // fall back to the discovery entry points, which are what an agent with no vocabulary needs.
  const fallbackIds = ["motion.actions.panel", "motion.capabilities.panel", "motion.package.create", "motion.state", "motion.render.final"];
  return fallbackIds
    .map((id) => actions.find((action) => action.id === id))
    .filter((action): action is MotionAction => Boolean(action))
    .slice(0, limit)
    .map((action) => summarize(action, "catalog entry point"));
}

/** Deterministic, locale-independent ordering for equal scores. */
function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Wrap a strict lookup result in an answer that is useful either way.
 *
 * @param action - whatever `findAction` returned, including null.
 */
export function buildActionMatch(request: string, action: MotionAction | null, actions: MotionAction[]): MotionActionMatch {
  if (action) {
    return { matched: true, action, nearest: nearestActions(request, actions.filter((candidate) => candidate.id !== action.id), 3) };
  }
  return {
    matched: false,
    action: null,
    message: `No Motion action matches ${JSON.stringify(request)}. The nearest catalog entries are listed; motion.actions.panel returns the full catalog with permission tiers.`,
    nearest: nearestActions(request, actions)
  };
}
