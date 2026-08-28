/**
 * Reviewed purposes for the remaining default-purpose timeline Debug/MCP commands.
 *
 * This is deliberately a small, auditable source slice: every key was a timeline
 * command still returning the catalog fallback at the R3 M2-14 audit base. The
 * catalog owns composition with the other reviewed purpose maps.
 */
export const TIMELINE_REMAINING_PURPOSES = Object.freeze({
  "motion.timeline.spatial.position.upsert": "Insert or replace one aligned transform.x/transform.y spatial keyframe at a non-negative millisecond time, with optional closed path handles, in one copy-on-write revision.",
  "motion.timeline.spatial.position.move": "Move one aligned transform.x/transform.y spatial keyframe pair to a non-negative millisecond time in one copy-on-write revision, preserving its value, easing, and path geometry.",
  "motion.timeline.spatial.position.delete": "Delete one aligned transform.x/transform.y spatial keyframe pair at a non-negative millisecond time in one copy-on-write revision.",

  "motion.timeline.relations.inspect": "Inspect the bounded root-owned-shape attach or aim relation store and, when requested, its whole-millisecond frame plan without mutation or a receipt.",
  "motion.timeline.relations.upsert": "Insert or replace one bounded attach (follow or similarity) or aim relation between root-owned shape endpoints in a copy-on-write revision, within 32 bindings and a one-hour relation duration.",
  "motion.timeline.relations.enabled.set": "Set one persisted relation's enabled state in a copy-on-write revision while retaining its validated transform-authority reservation.",
  "motion.timeline.relations.remove": "Remove one persisted relation definition in a copy-on-write revision without baking ordinary keyframes.",
  "motion.timeline.relations.detach": "Remove one persisted relation in a copy-on-write revision while leaving the target's current ordinary transform unchanged; it never writes a synthetic final hold.",
  "motion.timeline.relations.bake": "Bake one full-document relation into ordinary transform keyframes in a copy-on-write revision, using a whole-millisecond inclusive grid of at most 3,600 samples; the sampled result is not equivalent between samples.",

  "motion.timeline.relation-actions.inspect": "Inspect persisted closed relation-action definitions and their render truth without mutating a package or materializing an instance.",
  "motion.timeline.relation-actions.upsert": "Insert or replace one closed persisted relation-action definition in a copy-on-write revision, within 16 definitions, 32 template layers, 16 roles/parameters/relations, and 32 sequence steps.",
  "motion.timeline.relation-actions.remove": "Remove one persisted relation-action definition in a copy-on-write revision without searching for or changing already materialized output.",
  "motion.timeline.relation-actions.apply": "Materialize one exact-package-base relation action into ordinary data in a copy-on-write revision, capped at 32 created layers, 16 relations, and 128 generated keyframe writes; the request is not persisted as an instance.",

  "motion.timeline.scene3d-animation.inspect": "Inspect the persisted closed Scene3D animation store, stable track ids, and route-specific render refusal without mutating a package or rendering a frame.",
  "motion.timeline.scene3d-animation.track.upsert": "Insert or replace one complete locator-typed Scene3D track in a copy-on-write revision; it allows one track per immutable locator, at most 64 tracks, 64 exact-microsecond keyframes per track, and 2,048 total keyframes, never a generic property path.",
  "motion.timeline.scene3d-animation.track.remove": "Remove one persisted Scene3D animation track in a host-receipted copy-on-write revision without changing static scene topology or assets.",
  "motion.timeline.scene3d-animation.keyframe.upsert": "Insert or replace one locator-typed Scene3D keyframe at an exact safe-integer microsecond timestamp in a host-receipted copy-on-write revision.",
  "motion.timeline.scene3d-animation.keyframe.delete": "Delete one exact-microsecond Scene3D keyframe in a host-receipted copy-on-write revision while retaining the track's required keyframe.",
  "motion.timeline.scene3d-animation.keyframe.move": "Move one Scene3D keyframe between distinct exact safe-integer microsecond timestamps in a host-receipted copy-on-write revision, preserving its typed value and easing.",

  "motion.timeline.layout-gap-animation.inspect": "Inspect the persisted C2 gap-only track for an existing static layout application without mutation, receipt creation, or a renderer route.",
  "motion.timeline.layout-gap-animation.track.upsert": "Insert or replace the single permitted application-bound row or column gap track in a host-receipted copy-on-write revision, with exact application fingerprint, ordered child ids, and at most 64 keyframes.",
  "motion.timeline.layout-gap-animation.track.remove": "Remove one C2 gap track in a host-receipted copy-on-write revision; removing the final track restores static-layout removal authority and still creates no renderer route.",
  "motion.timeline.layout-gap-animation.keyframe.upsert": "Insert or replace one gap-only C2 keyframe at an exact safe-integer microsecond timestamp in a host-receipted copy-on-write revision; its value is 0 through 1,000,000 layout units.",
  "motion.timeline.layout-gap-animation.keyframe.delete": "Delete one exact-microsecond C2 gap keyframe in a host-receipted copy-on-write revision while retaining the track's required keyframe.",
  "motion.timeline.layout-gap-animation.keyframe.move": "Move one C2 gap keyframe between distinct exact safe-integer microsecond timestamps in a host-receipted copy-on-write revision, preserving its non-overshooting easing.",

  "motion.timeline.behaviors.inspect": "Inspect bounded analytic behavior bindings, transform authority, and static plan facts without mutation or a receipt.",
  "motion.timeline.behaviors.upsert": "Insert or replace one closed path-follow or analytic transform behavior binding for an eligible root-owned shape in a copy-on-write revision, within 32 bindings and a one-hour physical duration.",
  "motion.timeline.behaviors.remove": "Remove one target layer's persisted analytic behavior binding in a copy-on-write revision without baking synthetic transform keyframes.",

  "motion.timeline.layer.text-runs.inspect": "Inspect one text or caption layer's manifest-bound styled text-runs record and immutable font-asset authority without mutation or a receipt.",
  "motion.timeline.layer.text-runs.replace": "Replace one layer's complete text-runs@1 record in a copy-on-write revision, capped at 32 runs, 16 distinct font assets, and 16 KiB concatenated UTF-8 text.",
  "motion.timeline.layer.text-runs.remove": "Remove one layer's text-runs styling in a copy-on-write revision only when the supplied plain text exactly matches the concatenated runs, preserving that content.",

  "motion.timeline.group.create": "Create one complete bounded group layer at a root or direct group position in a copy-on-write revision; Core validates the full hierarchy, timing, and placement.",
  "motion.timeline.group.child.add": "Add one existing layer as a direct child of a group in a copy-on-write revision, optionally at a bounded insertion index.",
  "motion.timeline.group.child.remove": "Remove one direct child membership from a group in a copy-on-write revision without deleting the child layer itself.",
  "motion.timeline.group.child.move": "Move one direct child from its explicitly named source owner, including root, into a destination group in a copy-on-write revision.",
  "motion.timeline.group.child.reorder": "Reorder one direct child within its group at a zero-based index in a copy-on-write revision.",
  "motion.timeline.group.wrap": "Wrap one contiguous range of 1 through 256 direct siblings in a group in a copy-on-write revision, normalizing the supplied order to the owner order.",
  "motion.timeline.group.unwrap": "Remove one group container in a copy-on-write revision and promote its direct children through Core's validated hierarchy operation.",
  "motion.timeline.group.delete": "Delete one group in a copy-on-write revision by cascading its subtree or, only for an exactly neutral group, unwrapping its children.",
  "motion.timeline.group.duplicate": "Duplicate one group subtree in a copy-on-write revision, optionally with a deterministic new root id and a non-negative timeline offset.",
  "motion.timeline.group.trim": "Retiming one group in its direct owner's timeline in a copy-on-write revision, only when every direct child still fits its positive duration.",
  "motion.timeline.group.root.reorder": "Reorder one root group at a zero-based index in a copy-on-write revision without treating it as a nested-child reorder.",
  "motion.timeline.group.split": "Split one group at a timestamp strictly inside its direct-owner timeline into head and tail groups in a copy-on-write revision.",

  "motion.timeline.layout.inspect": "Inspect deterministic layout ownership, slots, overflow facts, budgets, and fingerprint for a proposed closed layout and repeaters without a receipt.",
  "motion.timeline.layout.compile": "Compile deterministic slots, repeater expansion, overflow facts, budgets, and fingerprint for a proposed closed layout without mutating a package or writing a receipt.",
  "motion.timeline.layout.apply": "Apply one closed deterministic row, column, stack, grid, or radial layout with up to 16 repeaters of 128 instances in a host-receipted copy-on-write revision and return its application fingerprint.",
  "motion.timeline.layout.remove": "Remove one exact fingerprint-bound layout application in a host-receipted copy-on-write revision through trusted authority, restoring its owned layout changes; an active C2 gap track refuses removal.",

  "motion.timeline.adjustment.fixed.inspect": "Inspect one root fixed adjustment layer and its closed full-frame effects without mutation or a receipt.",
  "motion.timeline.adjustment.fixed.set": "Create or replace one complete root fixed adjustment in a copy-on-write revision using only vignette and/or deterministic film grain, evaluated in canonical vignette-then-filmGrain order.",
  "motion.timeline.adjustment.fixed.remove": "Remove one root fixed adjustment layer in a copy-on-write revision without accepting transform, track, module, or extension fields.",

  "motion.timeline.gradient.color-keyframes.inspect": "Inspect one gradient layer's fixed-topology stop-color snapshot store and evaluation without mutation or a receipt.",
  "motion.timeline.gradient.color-keyframes.upsert": "Insert or replace one complete exact-microsecond stop-color snapshot in a copy-on-write revision, preserving the existing stop order and count; each gradient holds at most 32 snapshots of at most 16 colors.",
  "motion.timeline.gradient.color-keyframes.delete": "Delete one exact-microsecond gradient color snapshot in a copy-on-write revision while retaining the required one-snapshot floor and fixed stop topology.",
  "motion.timeline.gradient.color-keyframes.move": "Move one gradient color snapshot between exact safe-integer microsecond timestamps in a copy-on-write revision, then keep the fixed-topology snapshots sorted by time.",

  "motion.timeline.points.range.inspect": "Inspect one exact half-open range of authored point identities and sample slices without mutation, interpolation, or history; the response is capped at 256 points and 12 samples.",
  "motion.timeline.points.trajectory.inspect": "Inspect one stable point's authored base value and up to 12 exact sample positions without mutation; it reports no retained particle or point history.",
  "motion.timeline.points.point.upsert": "Explicitly insert or replace one stable indexed point in a copy-on-write revision, supplying one aligned position for every authored sample when the point order or sampled value changes.",
  "motion.timeline.points.point.move": "Move one stable point index and every parallel authored sample position in lockstep in a copy-on-write revision.",
  "motion.timeline.points.point.delete": "Delete one stable point identity and its matching positions from every authored sample in a copy-on-write revision while leaving at least one base point.",
  "motion.timeline.points.point.range.delete": "Delete one exact half-open stable-point range and its matching positions from every authored sample in a copy-on-write revision while leaving at least one base point.",
} as const);
