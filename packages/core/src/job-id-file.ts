/**
 * Injective filename encoding for job ids.
 *
 * Role: both the live lease store (`job-lease.ts`) and the terminal record store (`job-registry.ts`)
 * name files after a job id. A job id is caller-supplied and may legally contain characters a
 * filename may not, so it has to be transformed — and the transform is the whole problem.
 *
 * WHY A HASH AND NOT A SUBSTITUTION. The previous encoding folded every disallowed character to
 * `-`, which is not injective: `cut:render-42` and `cut-render-42` produced one filename. That is
 * not a theoretical id — `cut:render-42` is the form `shellx-motion job` documents to Cut. Two callers
 * using both spellings shared one lease file and one record prefix, so the second caller's write
 * silently destroyed the first caller's live lease AND its terminal record, leaving a job that had
 * actually succeeded answering `job_unknown` forever. An adversarial regression reproduced this with two
 * concurrent renders and no authentication of any kind.
 *
 * Case folding is the same defect with a different cause: job ids are case-sensitive
 * (`assertMotionJobId` accepts both), but Windows and macOS filesystems are case-insensitive by
 * default, so `Render-1` and `render-1` collide there and not on Linux. Motion ships on all three.
 *
 * Appending a hash of the EXACT id fixes both at once: the readable part stays readable for a human
 * listing the directory, and the digest disambiguates any two ids the readable part cannot. The
 * readable part is lowercased deliberately, so the digest is the only thing distinguishing ids that
 * differ by case — which means the disambiguation survives on a case-insensitive filesystem.
 *
 * Dependencies: none. Primary callers: `job-lease.ts`, `job-registry.ts`.
 */
import { createHash } from "node:crypto";

/** Readable prefix length. Long enough to identify a job by eye, short enough for path limits. */
const READABLE_LIMIT = 40;

/** 64 bits of digest: collision-resistant for job ids, and short enough to keep names scannable. */
const DIGEST_LENGTH = 16;

/**
 * Map a job id to a filename component that no other job id can produce.
 *
 * Lowercase, `[a-z0-9._-]` only, always ending in `-<16 hex>`. Callers append their own suffix
 * (`.lease.json`, `--<endedAtMs>.job.json`).
 *
 * @param jobId a job id that has already passed `assertMotionJobId`
 * @returns a filename-safe component, injective over job ids up to digest collision
 */
export function motionJobFileKey(jobId: string): string {
  const readable = jobId.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(0, READABLE_LIMIT);
  const digest = createHash("sha256").update(jobId, "utf8").digest("hex").slice(0, DIGEST_LENGTH);
  return `${readable}-${digest}`;
}

/**
 * Opaque filesystem key for the authenticated job identity.
 *
 * `jobId` is a caller-facing handle, not a global primary key: two authenticated callers may
 * independently choose the same value.  Durable owner-scoped state therefore names the tuple
 * `(callerId, jobId)`.  The full SHA-256 digest keeps both inputs out of filenames and makes the
 * tuple collision-resistant on case-insensitive filesystems too.
 *
 * JSON's escaping and array boundaries make the preimage unambiguous even when either string
 * contains a delimiter-like character.  The schema-like domain prefix prevents an unrelated
 * digest consumer from accidentally sharing this namespace.
 */
export function motionJobOwnerKey(callerId: string, jobId: string): string {
  return createHash("sha256")
    .update("shellx-motion/job-owner-key@1\u0000", "utf8")
    .update(JSON.stringify([callerId, jobId]), "utf8")
    .digest("hex");
}
