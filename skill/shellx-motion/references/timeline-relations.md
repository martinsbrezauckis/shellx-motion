# Timeline relations authoring

`motion.timeline.relations.*` authors one closed document-root `relations@1` binding through
Debug/MCP. It is not a CLI, local-SDK, or Action workflow. The persisted relation store currently
reports an explicit renderer refusal; it is an authoring result, not a frame or delivery route.

## Admission and discovery

Use an authenticated host with `edit_motion` and its trusted-local opt-in. The source package must
be under a host `authoringInputRoots` entry; the absent-or-empty copy-on-write destination must be
outside that package and under `authoringOutputRoots`. To inspect the returned revision, configure
an input root that also contains the revision, for example:

```text
authoringInputRoots:  /absolute/motion-authoring
authoringOutputRoots: /absolute/motion-authoring/revisions
packageRoot:           /absolute/motion-authoring/packages/relation-source
outDir:                /absolute/motion-authoring/revisions/relation-v1
```

The source must already be a valid package with root-owned `shape` layers named `leader` and
`follower`, and at least one millisecond of duration. MCP discovery is `tools/list` (filter
`motion_timeline_relations_`); Debug discovery is authenticated `GET /debug/contracts` filtered
to `motion.timeline.relations.`. Dotted names are not shell commands.

## Minimal attach/follow revision

First inspect the source package at `read_motion`:

```json timeline-command=motion.timeline.relations.inspect
{
  "packageRoot": "/absolute/motion-authoring/packages/relation-source",
  "atUs": 0
}
```

Then call `motion.timeline.relations.upsert` at `edit_motion`. This complete binding is the
smallest `attach`/`follow` branch; `binding` is closed data, not a generic property path.

```json timeline-command=motion.timeline.relations.upsert
{
  "packageRoot": "/absolute/motion-authoring/packages/relation-source",
  "outDir": "/absolute/motion-authoring/revisions/relation-v1",
  "binding": {
    "id": "leader-follow",
    "enabled": true,
    "kind": "attach",
    "source": { "layerId": "leader", "anchor": { "x": 0, "y": 0 } },
    "target": { "layerId": "follower", "anchor": { "x": 0, "y": 0 } },
    "startUs": 0,
    "durationUs": 1000,
    "mode": "follow",
    "offset": { "space": "world", "x": 0, "y": 0, "rotationDeg": 0, "scale": 1 }
  }
}
```

Re-inspect exactly the returned `result.packageDir` rather than the source:

```json timeline-command=motion.timeline.relations.inspect
{
  "packageRoot": "/absolute/motion-authoring/revisions/relation-v1",
  "atUs": 0
}
```

The source package is never edited in place. Verify the mutation result has the requested
`packageDir`, one inline `receipt` and `receiptPath`, `receipt.operation` equal to
`timeline.relations.upsert`, and matching `outputMotionSha256` and
`relations.afterStaticPlan.relationSourceSha256`. The second inspection must name the same
package/motion identities and the stored binding id. The host, not these arguments, chooses any
extra receipt mirror; do not add a `receiptsRoot` field.

## Boundaries

Read `relations.laneTruth`: a persisted relation store currently reports
`relation_store_refused`, so do not call or claim Browser, Native, GPU, FFmpeg, preview, final
media, artifact, Cut, Action, CLI, or SDK success from this revision. This guide deliberately
stops at the copy-on-write package and its receipt.

The generated command contract is at
[DEBUG_API_COMMANDS.md](../../../docs/public/DEBUG_API_COMMANDS.md#motiontimelinerelationsinspect).
