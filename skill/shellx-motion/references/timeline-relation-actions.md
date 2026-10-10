# Timeline relation-actions authoring

`motion.timeline.relation-actions.*` persists closed `relation-actions@2` definitions and can
materialize one exact-base request into ordinary data. It is Debug/MCP-only: no CLI, local SDK, or
Action route exists. Persistence or materialization is not a preview, render, artifact, Cut, or
delivery claim.

## Admission and discovery

Use an authenticated trusted-local `edit_motion` host. The input package must be under an
`authoringInputRoots` entry and every absent-or-empty COW `outDir` must be outside its source and
under `authoringOutputRoots`. Keep both source and revision under an input root if you will inspect
the revision:

```text
authoringInputRoots:  /absolute/motion-authoring
authoringOutputRoots: /absolute/motion-authoring/revisions
packageRoot:           /absolute/motion-authoring/packages/action-source
outDir:                /absolute/motion-authoring/revisions/action-v1
```

The source is an existing valid package with a root `shape` layer `anchor`, at least 1,000,000
microseconds of duration, and no conflicting unsupported relation authority. Discover the family
through MCP `tools/list` (filter `motion_timeline_relation_actions_`) or authenticated
`GET /debug/contracts` filtered to `motion.timeline.relation-actions.`.

## Smallest definition, inspect, and exact-base apply

Call `motion.timeline.relation-actions.upsert` with this complete minimal definition. Empty arrays
are intentional: one role and one template shape are sufficient; no parameters, relation templates,
or sequence entries are implied.

```json timeline-command=motion.timeline.relation-actions.upsert
{
  "packageRoot": "/absolute/motion-authoring/packages/action-source",
  "outDir": "/absolute/motion-authoring/revisions/action-v1",
  "definition": {
    "id": "accent-action",
    "roles": [{ "id": "anchor", "kind": "layer", "layerTypes": ["shape"] }],
    "parameters": [],
    "templateLayers": [{
      "id": "accent",
      "layer": {
        "schema": "shellx-motion/relation-action-layer-prototype@1",
        "type": "shape",
        "startUs": 0,
        "durationUs": 1000000,
        "shape": "rect",
        "fill": "#abcdef",
        "transform": { "x": 1, "y": 1, "width": 10, "height": 10 }
      }
    }],
    "relationTemplates": [],
    "sequence": []
  }
}
```

Inspect the returned COW package, then use `motion.state` on that same package to obtain its exact
package id and `result.package.inputHashes["manifest.json"]` and
`result.package.inputHashes["motion.json"]` values.

```json timeline-command=motion.timeline.relation-actions.inspect
{
  "packageRoot": "/absolute/motion-authoring/revisions/action-v1"
}
```

The inspection supplies `result.inspection.storeSha256` and the exact
`result.inspection.definitions` entry for `accent-action`, including its `sha256`. Chain those,
together with the `motion.state` identities, into `apply`. The literal identities below are only
schema-shaped specimens: replace every hash and package id with values returned for this exact
`action-v1` revision; never recompute, reuse from the source, or guess them.

Call `motion.state` with that same `packageRoot` at `read_motion`; it is the read-only package
identity check in this chain.

```json timeline-command=motion.state
{
  "packageRoot": "/absolute/motion-authoring/revisions/action-v1"
}
```

```json timeline-command=motion.timeline.relation-actions.apply
{
  "packageRoot": "/absolute/motion-authoring/revisions/action-v1",
  "outDir": "/absolute/motion-authoring/revisions/action-v2",
  "expectedPackageId": "action-package-v1",
  "expectedPackageManifestSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "request": {
    "definitionId": "accent-action",
    "expectedMotionSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "expectedStoreSha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    "expectedDefinitionSha256": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    "instanceId": "accent-instance-1",
    "startAtUs": 0,
    "roleBindings": { "anchor": "anchor" }
  }
}
```

For both mutations, verify `result.packageDir` is the requested revision, `result.receiptPath`
exists with one inline receipt, `receipt.operation` is respectively
`timeline.relation-actions.upsert` or `timeline.relation-actions.apply`, and the source package
hashes in `receipt.inputHashes` match the chained source. After apply, inspect `action-v2` and
check `result.relationActions.requestSha256`, `planFingerprint`, `createdLayerIds`, and
`outputMotionSha256`. Any stale identity is a refusal; reopen and chain values from the latest COW
revision instead of retrying with old hashes.

## Boundaries

`apply` creates ordinary data in a new package, but this authoring loop does not invoke a renderer
or qualify a lane. Do not attach preview/final media, artifact, Cut, Action, CLI, SDK, or delivery
claims to its COW receipt/result. The trusted host alone chooses a receipt mirror; caller-supplied
`receiptsRoot` is rejected.

Read the generated contracts at
[DEBUG_API_COMMANDS.md](../../../docs/public/DEBUG_API_COMMANDS.md#motiontimelinerelation-actionsinspect).
