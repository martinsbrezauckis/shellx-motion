# Groups and local timelines

Groups are Motion's bounded precomposition and local-timeline primitive. A group
is an ordinary `type: "group"` layer with an ordered `childLayerIds` list; it
is not a loose parent tag that arbitrary flat-layer operations can infer or
rewrite. Use the typed group commands below for structural changes.

## Ownership and timing contract

Each child has at most one direct group owner. A group owns 1–256 direct
children; a document may contain at most 64 groups and nesting may be at most
four levels deep. Ownership must be acyclic, ids must be unique, and a child
must fit entirely within its direct owner's local timeline.

`startMs` is local to the direct owner. A root layer's time is document time;
the absolute time of a nested child is the sum of its own `startMs` and every
group start through its owner chain. Every child has a non-negative local start,
a positive duration, and `startMs + durationMs` no greater than its group's
duration. Ordering is the order of the direct owner's `childLayerIds`, not the
incidental order of the flat layer store.

The ordinary layer trim, split, duplicate, delete, and reorder commands refuse
group containers and group-owned children. That prevents a generic operation
from flattening ownership or treating local time as root time.

## Typed Debug commands

All twelve commands are typed Debug API/MCP mutations. They take the normal
package-edit inputs (`packageRoot` and `outDir`) plus the fields named here.

| Command | Bounded operation |
| --- | --- |
| `motion.timeline.group.create` | Creates one complete group around existing unowned children; an optional direct parent and insertion positions are explicit. |
| `motion.timeline.group.child.add` | Adds an unowned direct child without changing its local time; it must already fit the group. |
| `motion.timeline.group.child.remove` | Removes one direct child to the root and rebases it to preserve absolute document time. |
| `motion.timeline.group.child.move` | Moves an explicitly declared root/direct child to another group, rebasing local time to preserve absolute time. |
| `motion.timeline.group.child.reorder` | Reorders one direct child within its current owner. |
| `motion.timeline.group.wrap` | Creates a group from one contiguous direct-sibling selection; timing and child order are derived, rather than supplied as a partial hierarchy. |
| `motion.timeline.group.unwrap` | Removes one exactly neutral group and exposes its children in the parent/root local timeline. |
| `motion.timeline.group.delete` | Requires `disposition: "cascade"` or `"unwrap"`; there is no inferred child disposition. |
| `motion.timeline.group.duplicate` | Deep-clones one owned subtree, rebinding its internal references and assigning deterministic available ids. |
| `motion.timeline.group.trim` | Changes a group's local start and/or duration only when its direct children and parent containment still fit. |
| `motion.timeline.group.root.reorder` | Reorders an unowned root group among root siblings; it cannot reorder a group-owned child. |
| `motion.timeline.group.split` | Recursively splits a group at an exact direct-owner-local time into distinct head and tail subtrees. |

The generated [Debug API command reference](DEBUG_API_COMMANDS.md) remains the
argument and receipt-field contract.

## Structural behavior and refusals

Create, add, move, and wrap never create a second owner or a cycle. Removing or
moving a group's final direct child refuses; use an explicit unwrap or delete
instead. A move preserves absolute time and refuses if the rebased child does
not fit the destination. Root reordering is deliberately separate from direct
child reordering.

Unwrap is intentionally narrow. The removed group must be visually neutral:
normal blend, visible, opacity 1, identity transform, and no effects, mask,
matte, keyframes, transitions, or other group-level state. Motion will not
silently bake or distribute composition state into children. Cascade delete
removes the full owned subtree; unwrap removes only the neutral container and
rewires its parent child order. Both refuse when an external typed consumer
would be left pointing at a removed layer.

Duplicate creates a complete separate ownership subtree. Its internal group
child ids, matte source, ducking triggers, and environment scene/mask targets
are rebound when they point within the cloned subtree; targets outside it remain
unchanged. A requested new root id must be unused. The optional `offsetMs`
shifts only the clone root in its direct owner's local time and must still fit.

Trim is not media source trimming. It changes only group timing and refuses a
shortened interval that excludes a direct child. Split uses the same bounded
leaf split semantics for intersecting children, including keyframe boundary
values and media-source trims. It recursively creates tail groups/leaves,
rebases their local starts, and rebinds typed internal references. It refuses a
split outside the group, an empty head or tail, a tail reference to a head-only
layer, or an external consumer that would require an ambiguous rewrite.

Locks are structural locks: an operation refuses if any affected group/child or
its assigned track is locked. Track layer-id lists must name existing layers;
structural operations update their relevant entries when adding, removing,
duplicating, or splitting ids. Typed external references (`matte`, `ducking`,
and environment scene/mask inputs) refuse before a delete, unwrap, or split
would make their target unavailable or ambiguous.

## Opaque extension boundary

Motion cannot safely guess whether an open extension contains a layer id. Before
clone/split work, and before split/delete/unwrap affects external consumers,
Core recursively walks the admitted layer shapes. Unknown nested object fields,
including fields inside arrays or conditional branches, refuse before mutation.
Conditionally invalid fields also refuse even if that property is known for a
different layer type. This prevents hidden references from being silently copied,
left dangling, or bound to the wrong split half.

Validated legacy `x-path` fields remain a narrow compatibility exception. They
are checked by Core rather than treated as an opaque extension. There is no
general plugin-data rebinding format.

## Transaction and evidence boundary

An admitted typed Debug mutation validates the final document, then produces one
copy-on-write package result and one normal edit receipt. A refusal occurs before
the package-copy sink is published; it is not converted into a partial hierarchy
edit or a fallback flat-layer operation.

This page describes the source contract and source-level test coverage. It does
not claim that a COW save/reopen was executed in this environment, that an
installed build exposes these commands, or that a particular host UI or renderer
has accepted a grouped composition. Renderer capability matching remains
separate; see [Rendering lanes](rendering.md).
