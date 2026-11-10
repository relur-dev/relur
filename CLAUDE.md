# CLAUDE.md

An Electron desktop app (macOS and Linux) for running parallel Claude Code sessions, each in its own git worktree, with profiles that keep Claude accounts apart. React + Tailwind renderer, tRPC between renderer and main, SQLite for state.

## Where things live

- `src/main`: the main process: config, projects, worktrees, sessions (node-pty), status and hooks bridge, skills and workflows, task lookup, setup check.
- `src/renderer/src`: the UI; `components/`, `ui/` (shared controls), `guide/` (the in-app Guide: Markdown pages in `guide/pages/`, ordered in `guide/content.ts`).
- `src/shared`: types, schemas, shortcuts (`shortcuts.ts` is the only definition of every key), status, and `brand.ts`.
- `src/helper`: the small executable for hooks, the status line and the command line tool (`add`, `link`), compiled with bun.
- `scripts`: build, packaging, installer template, notices (`gen-notices.ts`), e2e tests (`e2e-*.ts`, listed in `e2e-suites.json` and run by `e2e.ts`; driver in `scripts/lib/`) and the Linux checks in Docker.
- `docs/SPEC.md` (the specification), `docs/components.md` (component sizes, states and keyboard behaviour), `docs/images/` (the README's screenshots).
- **Names:** the product name, its old name, the bundle id, env var prefix and folder names come from `src/shared/brand.ts` only. Never write them anywhere else in code; `npm run check:name` fails if you do (docs/ and README are exempt).

## Commands

- `npm run check`: lint (biome), typecheck, unit tests (vitest), check:name, check:notices.
- `npm run verify`: check, then e2e (all suites, both builds). Run once when a branch is done, before it's merged.
- `npm run e2e`: builds, then the e2e tests on the production build and the dev server (several minutes). They use a fake `claude`, never the real one.
- `npm run gen:notices`: regenerates `THIRD_PARTY_NOTICES` after a dependency change.
- `scripts/linux-check.sh`: the Linux check in Docker (`PLATFORM=linux/amd64` for x64).
- `npm run install-app`: build and install the app on this machine.
- `npm run package -- --arch all`: zips and dmgs in `dist/`.
- A new worktree has no `node_modules`: run `npm ci` first.

## Working rules

- **The spec is the source of truth.** Every behaviour change updates `docs/SPEC.md` and the Guide pages in the same commit; e2e covers the new behaviour.
- **Commits:** never after a failing check or test.
  - While working on a branch: run the e2e suites the change touches (`npm run build`, then `tsx --tsconfig tsconfig.node.json scripts/e2e.ts --mode prod <suite>`, production build only) before the commit; the commit follows `npm run check && git commit …` in one command.
  - When the branch is done, before it's merged: `npm run verify` once (all suites, both builds). Fix whatever fails and run it again until it passes; the last commit follows `npm run verify && git commit …`.
  - Never `;` between a check and the commit, never an echo of the status in place of the check's own result, and never a background task's success read as the check's (the task can end with 0 while the check failed inside it).
- **No AI attribution** in commits or pull request descriptions: no `Co-Authored-By` trailers, no "Generated with" lines. `.claude/settings.json` turns Claude Code's own off; keep it committed.
- **Generic only:** no company names, internal hosts, accounts or other company values in code, tests, docs or examples.
- **Live checks** against the real Claude Code: a cheap model (`--model haiku`), scratch folders and a profile you can spare; never real work repositories.
- **Dependencies:** exact versions only, at least 14 days old.
- **Shell:** in `rm` paths write variables as `"${VAR:?}"`.
- Match the surrounding code: its comment density, naming and idioms. Comments cite spec sections (`spec §6.1`) where behaviour comes from the spec.
- Personal rules for your own setup go in `CLAUDE.local.md` (gitignored; `.worktreeinclude` copies it into new worktrees).

## Rebasing and merging

When "Merge into main" asks you to rebase a branch onto main:

- **Conflicts:** resolve them so both sides' changes stay wherever they still apply.
- **Binary files** (e.g. the Guide's screenshots): never merge them. Take main's version, then retake them with `scripts/guide-screenshots.ts`.
- **`CHANGELOG.md`:** keep both sides' entries under Unreleased, no entry twice, no empty heading.
- **Afterwards:** `npm run check` and the e2e suites the branch touches, then commit. End with "Ready to merge." or "Not ready to merge: <reason>".
