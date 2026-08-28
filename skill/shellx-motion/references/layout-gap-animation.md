# Persisted layout-gap animation

C2-L1 is a closed Core and trusted Debug host lifecycle for changing only `gap` on one existing
static layout application. It is an authoring checkpoint, not a renderer feature.

## Admission

1. First create the static layout with `motion.timeline.layout.apply` and retain its returned
   application marker.
2. Call `motion.timeline.layout-gap-animation.inspect` on the copied package.
3. Add or replace the one permitted `track.upsert` record with its stable `id`, exact
   `applicationId`, exact `applicationFingerprint`, exact ordered `childLayerIds`, and safe
   integer microsecond keyframes.
4. Use the keyframe upsert/delete/move commands for later revisions. Every mutation creates one
   absent-or-empty output package and one outer receipt.

The stored track is admitted only for a still-exact static row or column layout with
`distribution: "start"`, fixed direct children, no repeaters/materialization, no fill sizing, no
locks, no ordinary/spatial transform keyframes, and no behavior/relation/procedural authority.
Grid, radial, stack, stale fingerprints, changed child order, duplicate authority, no-op edits,
and hostile data refuse without changing the source.

C2-L1a admits exactly one application-bound track and at most 64 keyframes. Each gap is a finite
layout dimension from 0 through 1,000,000; application and child identifiers use the same
1–128 UTF-16-code-unit bound as the static layout authority they attach to.

## Authority and teardown

The first attach verifies the original trusted static-apply authority. Each C2 copy-on-write
revision persists a host-only successor bound to the new package lineage and its outer receipt.
Its static application, inverse patches, and direct-child transform/timing evidence must remain
exact. `motion.timeline.layout.remove` refuses `remove layout gap track first` while a C2 root is
present. Removing the final C2 track proves that exact static evidence again and writes a trusted
restored remove authority for the resulting lineage; only then may ordinary layout removal run.

Core sampling uses the stored application `patches.before`, not current post-layout transforms, so
the projection cannot double-translate direct children. Values hold before the first keyframe and
after the last; between keyframes they use canonical Motion easing.

## Intentional no-route boundary

There is no C2-L1 renderer lowerer. Browser, Native, GPU, FFmpeg, Cut, CLI, SDK, Action, provider,
and Unreal routes refuse before resource/session/output work. Do not claim a preview, frame, or
final render from this store. The generated [Debug command reference](../../../docs/public/DEBUG_API_COMMANDS.md#motiontimelinelayout-gap-animationinspect) is the exact transport contract.
