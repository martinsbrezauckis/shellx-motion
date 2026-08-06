/**
 * Keeping the SDK's relationship pre-flight honest about what it actually checked.
 *
 * Role: `procedural-client.ts` validates a single procedural relationship BEFORE a request leaves
 * the SDK, and it has no document to validate it against — `proceduralSet` carries a relationship,
 * not a package. Motion's graph validator needs a document context (layers, and the audio envelopes
 * an `audio-envelope` node names), so the pre-flight synthesizes one: `placeholderLayers` invents
 * the layers a ref points at, and `placeholderEnvelopes` invents an envelope record per envelope id
 * the relationship names. Without that, every relationship driven by audio would be refused locally
 * for the crime of not carrying the document it was never given.
 *
 * The cost is that the validator can then object to the INVENTED half, and those objections used to
 * reach the caller verbatim. Both were reproduced against the shipped code during cross-host verification:
 *
 *   - a relationship naming 17 audio envelopes (the node budget allows 64) was refused with
 *     "/relationships/audioEnvelopes: must contain at most 16 envelopes" — an array the caller never
 *     sent and cannot edit;
 *   - a relationship whose real mistake was an empty `target.layerId` was refused with
 *     "/relationships/audioEnvelopes/0/sourceLayerId: must reference an existing layer", because the
 *     envelope this file invented inherited that empty layer id and envelopes are validated first.
 *     The caller was pointed at synthesized data instead of at its own typo.
 *
 * A refusal that names data the caller never wrote is not a smaller version of a good error message;
 * it is a wrong one, and an agent acting on it edits something that does not exist. So this module
 * re-attributes: issues about the caller's own relationship pass through untouched, issues about the
 * synthesized context are dropped when the caller has a real issue to fix anyway, and when the
 * synthesized context is the ONLY objection the refusal says so in words.
 *
 * What this deliberately does NOT do is make the pre-flight authoritative. It cannot be: whether an
 * envelope named `kick` exists is a fact about a document this code has not seen, so a relationship
 * naming an unknown envelope passes here and is refused by the engine, which has the document. The
 * pre-flight catches malformed relationships early; the engine decides.
 *
 * Dependencies: none. Primary caller: `procedural-client.ts` (`validateStandaloneRelationship`).
 */

/**
 * Path prefix every issue about the synthesized envelope context carries.
 *
 * Fixed by `validateMotionProceduralGraph`, which reports envelope problems under
 * `/relationships/audioEnvelopes`. Matched as a prefix so nested sample and field paths
 * (`/relationships/audioEnvelopes/0/samples/3/atMs`) are covered by the one rule.
 */
const PLACEHOLDER_ENVELOPE_PATH = "/relationships/audioEnvelopes";

/** Where a re-attributed issue points: the nodes are what made the SDK invent envelopes at all. */
const CALLER_NODES_PATH = "/relationships/relationships/0/nodes";

interface PreflightIssue {
  path: string;
  code: string;
  message: string;
}

interface PreflightValidation {
  ok: boolean;
  issues: PreflightIssue[];
}

/**
 * Re-attribute a standalone-relationship validation so every issue names something the caller sent.
 *
 * @param validation the result of validating the relationship inside a synthesized graph
 * @returns the same verdict, with synthesized-context issues removed or restated as such
 */
export function attributePreflightIssues<T extends PreflightValidation>(validation: T): T {
  if (validation.ok) return validation;
  const own = validation.issues.filter((issue) => !issue.path.startsWith(PLACEHOLDER_ENVELOPE_PATH));
  if (own.length === validation.issues.length) return validation;
  // The caller has something real to fix. Report only that: the synthesized context's complaint is
  // usually a knock-on of the same mistake (an empty target layer id becomes an envelope with an
  // empty source layer id), and leading with it hides the line the caller can actually edit.
  if (own.length > 0) return { ...validation, issues: own };
  // Nothing but the invented half objected, so the objection cannot be reported as the caller's
  // without inventing a fault too. Say what happened instead, and name the real authority.
  const first = validation.issues[0];
  return {
    ...validation,
    issues: [{
      path: CALLER_NODES_PATH,
      code: "relationship.placeholder_context",
      message: "names audio envelopes this check had to synthesize, because a relationship is "
        + `validated without a document, and the synthesized set was rejected: ${first.message}. `
        + "Reduce the audio envelopes this relationship names, or send it and let the engine check "
        + "the document's real envelopes",
    }],
  };
}
