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

**Dotted names are not shell commands.** `motion.render.final`, `motion.job.get`,
`motion.package.create` and every other `motion.*` id is a Debug API / MCP command. Call one over
MCP, or through the CLI as `shellx-motion debug <name>`. Never type one at a shell on its own, and
never "correct" one to `shellx-motion.render.final`.

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
