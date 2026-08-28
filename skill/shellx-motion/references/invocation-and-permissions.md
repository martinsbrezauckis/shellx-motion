# Invoking the CLI, and which permission tier a command needs

Two questions that look trivial, both of which have cost real sessions. Extracted from `SKILL.md`
and `references/cli.md` so a single statement of each is the one both of them point at.

## How to invoke the CLI

The `@shellx-motion/cli` package publishes exactly **one** `bin`: `shellx-motion`. Every shell
command in this skill is written in that form. There are two ways to run it and one that does not
exist:

| where you are | how to run `<command>` |
|---|---|
| **Installed build** — the packed `@shellx-motion/cli` package, installed into a project | `shellx-motion <command>` |
| **A ShellX Motion source checkout** — the pnpm workspace | `pnpm --filter @shellx-motion/cli run cli -- <command>` |
| `motion <command>` | **does not exist, in either mode** |

Inside a source checkout nothing puts `shellx-motion` on `PATH`, and running
`node packages/cli/dist/main.js` does not work either: the workspace `exports` deliberately point at
TypeScript source so the tests and smoke scripts run with no build step, so the built output resolves
back to `.ts` files and Node refuses them. `scripts/verify-install.mjs` is the authoritative account,
and `pnpm run build:verify` is the only check that exercises the installed form — it packs every
package, installs the CLI tarball into a throwaway project, and runs `shellx-motion` there through
both the npm and pnpm bin shims.

**Dotted names are not shell commands.** Every `motion.*` name is a Debug API / MCP command id,
and MCP accepts the full registry. The CLI accepts only the direct `debug` mapping or one of the
semantic equivalents in the surface matrix below; a named no-route command requires a Debug/MCP
host. Never type a dotted id at a shell on its own, and never "correct" one to
`shellx-motion.render.final`.

## Surface matrix

The Debug/MCP registry is not a promise of universal CLI or SDK parity:

| Surface | Current callable inventory |
|---|---|
| Debug API / HTTP / WebSocket / MCP | **300** typed commands; MCP publishes the full registry. |
| CLI | **234 direct** `debug` routes and **7 semantic equivalents**: `connector catalog`, `package-create`, `validate`, `doctor`, `doctor --probe-gpu`, `job get`, and `job list`. The **59 named no-route** Debug/MCP commands are `motion.agent.snapshot`, `motion.connector.submit`, `motion.job.submit/events/cancel/retry`, `motion.keying.inspect/apply/remove`, `motion.roto.upsert/tracking.detach/remove`, `motion.package.script.author`, `motion.timeline.checkpoint-storyboard.create/inspect/revise/remove/archive/materialize/detach/behavior.resolve/behavior.detach/relation.resolve/relation.detach/relation-action.resolve/relation-action.detach/lifecycle.resolve/lifecycle.detach/geometry-morph.resolve/geometry-morph.detach/retained-trace.resolve/retained-trace.detach/retained-trace.preview/retained-trace.review.bind/preview/creative-review.bind/preview-quality.review`, `motion.timeline.relations.inspect/upsert/enabled.set/remove/detach/bake`, `motion.timeline.relation-actions.inspect/upsert/remove/apply`, `motion.timeline.scene3d-animation.inspect/track.upsert/track.remove/keyframe.upsert/keyframe.delete/keyframe.move`, and `motion.timeline.layout-gap-animation.inspect/track.upsert/track.remove/keyframe.upsert/keyframe.delete/keyframe.move`. |
| Local SDK | **35 dedicated local-SDK operations**, not a generic command proxy. |
| Action discovery | **174 discoverable actions**. |

Use the listed CLI equivalent where one exists. A no-route command needs a Debug/MCP host; do not
invent a terminal spelling for it.

### Human-only local effect registry

Governed effect-module installation, confirmation, inspection, and revocation are intentionally
absent from Debug, MCP, CLI, SDK, package, and receipt authority. A person manages the private
registry from Workbench **Effects** in a `write_local` operator session. Do not invent an agent
route or pass a manifest path through a package/command argument; the host-owned native picker is
the only selection path. Packages may reference an already installed exact module id/version, but
that reference cannot install, replace, enable, or revoke it.

## Permission tiers

Six tiers. The server grant is a ceiling — a request may ask for a lower or equal tier, never a
higher one, and packages and prompts cannot grant themselves anything.

```text
read_motion < draft_motion < render_motion < edit_motion < write_local < push_remote
```

- `read_motion` — inspect state, timelines, panels, receipts. Cannot render.
- `draft_motion` — prompt runs plus playhead, range and viewport changes. Navigation reads as
  harmless, so this is the tier an agent most often guesses wrong; a `read_motion` caller that tries
  to set the playhead is refused.
- `render_motion` — preview or render local outputs.
- `edit_motion` — mutate a Motion package **that already exists**, into a new revision.
- `write_local` — create files **outside an existing package**: `motion.package.create`, every
  importer and exporter, the connectors, archive/extract, support bundles.
- `push_remote` — reserved and never automatic. Requires a separate `--allow-push-remote` opt-in on
  top of a `push_remote` grant. Motion keeps all execution local; a remote push is refused by design.

Any grant above the `read_motion` default requires `--trusted-local-tier`.

### `write_local` ranks ABOVE `edit_motion`

This is the trap, and the intuitive reading is the wrong one: creating a package feels smaller than
editing one, so `edit_motion` looks like the higher authority. It is not. Creating writes a new
directory the host has not yet approved anything inside, which is the greater power.

The consequence in practice: a host started at `--tier edit_motion` **refuses**
`motion.package.create`. An agent that has to author a package from nothing needs a `write_local`
grant. Ask for it. Never work around the refusal by hand-writing a package directory — the result
skips validation, manifest generation and the receipt, and is not a Motion package.

Editing an existing package's timeline (`motion.timeline.layer.create`,
`motion.timeline.keyframe.upsert`, `motion.timeline.layer.rich.set`) genuinely is `edit_motion`.

### The per-command tier is contract data

`schemas/debug.json` carries the `permission` of every command, and `docs/public/DEBUG_API_COMMANDS.md` is
generated from it. When the answer has to be exact, read those rather than any prose list —
including this one.
