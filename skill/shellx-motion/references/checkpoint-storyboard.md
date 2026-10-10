# Checkpoint storyboard record authoring

`motion.timeline.checkpoint-storyboard.*` is a closed Debug API/MCP record lifecycle. It
does not create or edit a Motion package, and it has no CLI, local-SDK, Action, Cut, or
final-render route. Use it only through an authenticated Motion Debug/MCP host.

## Admission and discovery

The host needs a configured private checkpoint-storyboard record store. `create` requires the
`write_local` tier; `inspect` requires `read_motion`. There is no caller-supplied package root,
output root, receipt root, renderer, or store path: those are host-only authorities. A request
cannot create any of them.

Use MCP `tools/list` to find `motion_timeline_checkpoint_storyboard_create` and
`motion_timeline_checkpoint_storyboard_inspect`, or use authenticated `GET /debug/contracts` and
filter for `motion.timeline.checkpoint-storyboard.`. The command names are MCP/Debug identifiers,
not shell commands.

## Smallest closed create and inspect loop

Call `motion.timeline.checkpoint-storyboard.create` with these **arguments**. This is the smallest
accepted data-recipe checkpoint profile: one rect target, two present checkpoints, and two retained
trace samples. It has the fixed B7 limits; do not remove or invent nested fields.

```json timeline-command=motion.timeline.checkpoint-storyboard.create
{
  "descriptor": {
    "schema": "shellx-motion/data-recipe-checkpoint@1",
    "storyboardSeed": 1,
    "requiredCapability": "renderer.gpu",
    "target": { "objectId": "trace", "rootShapeKind": "rect" },
    "checkpoints": [
      { "atUs": 0, "state": "present", "opacity": 1 },
      { "atUs": 1000, "state": "present", "opacity": 1 }
    ],
    "recipe": {
      "seed": 2,
      "formulaId": "formula.lissajous-2d@1",
      "actionId": "trace.full-clip-line@1",
      "parameters": {
        "centerX": 0,
        "centerY": 0,
        "amplitudeX": 1,
        "amplitudeY": 1,
        "frequencyX": 1,
        "frequencyY": 1,
        "phaseTurnsQ1024": 0,
        "sampleCount": 2,
        "strokeWidth": 1,
        "strokeOpacity": 1,
        "luma": 0,
        "speedLimit": 1
      },
      "limits": { "maxSamples": 64, "maxVertices": 64, "maxWorkUnits": 16384, "maxBytes": 131072 }
    }
  }
}
```

On success, retain `result.record.identity` as one opaque three-field value. Do not reconstruct an
id, hash, or revision. Pass that exact returned value to `inspect` (the specimen below is
schema-shaped only; replace all three values with the create result).

```json timeline-command=motion.timeline.checkpoint-storyboard.inspect
{
  "identity": {
    "id": "checkpoint_storyboard_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "revision": 1
  }
}
```

Check `result.record.identity` equals the chained identity, `result.record.target.state` is
`"active"`, `result.record.admission.staticProfileAdmitted` is true, and retain the returned
`result.evidence` identity when present. A replay can return `result.replay: "same-input"`; it is
not a new record or a new rendering result.

## Boundaries

This minimal data-recipe profile seals as retained-trace B7, so
`motion.timeline.checkpoint-storyboard.preview` refuses it before Browser work. No ordinary
Motion package, generic preview/frame, renderer output, PNG/MP4, artifact, Action, CLI, SDK, Cut,
or acceptance claim follows from create or inspect. Its operation evidence is record-store evidence,
not a package mutation receipt or delivery receipt.

For the complete generated transport shapes, read
[DEBUG_API_COMMANDS.md](../../../docs/public/DEBUG_API_COMMANDS.md#motiontimelinecheckpoint-storyboardcreate).
