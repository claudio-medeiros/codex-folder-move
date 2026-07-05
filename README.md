# codex-folder-move

Moves OpenAI Codex desktop-app state when your project folders move, so Codex
keeps its threads, trust settings, and sandbox permissions instead of treating
the moved folder as a brand-new project.

Single file, no dependencies beyond Node 18+ and the `sqlite3` CLI. Built and
tested on macOS (where the Codex desktop app lives in `~/.codex`).

Moving to a **new machine** rather than moving folders on the same one? The
(unrelated) [Codex Migrate](https://github.com/ChenglongLi777/codex-migrate)
project imports and merges sessions across devices. This tool solves the
in-place case: your folders moved locally, and every Codex reference — trust
blocks, sidebar state, sandbox permissions, thread and session paths — should
follow them.

## Usage

Close Codex.app fully, then:

```
node codex-folder-move.mjs
```

The menu walks you through it: pick the origin parent folder (discovered from
Codex state, or type your own), pick the destination parent, tick the projects
you want from a checklist (with reference counts and blockers per project),
review the plan, type `migrate` to confirm.

If a project folder hasn't been moved yet, the tool offers to **copy** it to
the destination. It never deletes the source — you trash the original yourself
once you're satisfied.

Non-interactive equivalents (`--scan`, `--plan`, `--apply`, `--restore`) are
described in `node codex-folder-move.mjs --help`.

## What gets patched

Every store in `~/.codex` that holds absolute project paths: `config.toml`
trust blocks, `.codex-global-state.json` (workspace roots, project order,
sidebar state, per-thread writable roots and hints), the `state_5.sqlite`
threads table (cwd + sandbox policy), `sessions/` and `archived_sessions/`
transcripts (path fields only), and ambient-suggestion project roots. Nested
paths (worktrees, subfolders) migrate via prefix matching. Your typed prompt
text is never rewritten.

## Safety model

- One batch backup of every file to be touched (sha256 manifest) is taken
  before any write, under `~/codex-folder-move-backups/`.
- Any error mid-apply triggers an automatic, checksum-verified restore.
- Each backup contains a standalone `rollback.mjs`; the menu also has
  "Restore from backup" (newest first).
- Restores remove stray SQLite `-wal`/`-shm` files so a rolled-back database
  can't replay bad changes.

## Tests

```
node test/run-tests.mjs
```

Builds disposable fake `CODEX_HOME` fixtures in a temp dir (never touches the
real `~/.codex`) and covers: paths with spaces/apostrophes, NULL sandbox
policies, corrupt session lines, nested worktree cwds, collision blocking,
duplicate config blocks, menu navigation (toggles, paging, cancels, declined
confirms), and injected mid-apply failures proving byte-identical restore.

```
node test/tty-smoke.mjs
```

Runs the interactive migrate and restore flows inside a **real pseudo-terminal**
(via macOS's built-in `expect`), answering each prompt only after it appears —
the same code path a human at a keyboard exercises. `node test/run-tests.mjs
--make-fixture` builds a standalone fixture if you want a safe playground to
poke at the tool by hand.

## Status and disclaimer

This is an unofficial tool, not affiliated with or endorsed by OpenAI. It
patches undocumented internals of the Codex desktop app; any Codex update may
change how state is stored. The designed failure mode is safe — preflight and
postflight checks catch mismatches and the automatic restore returns your
state to its pre-migration bytes — but treat every migration as what it is:
a write to app internals. The full test suite passes, and the tool has been
used for real migrations (and a real restore) on the author's machine.

MIT licensed. Issues and PRs welcome.
