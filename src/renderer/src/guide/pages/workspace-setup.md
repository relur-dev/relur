# Setup for new workspaces

A worktree is a fresh checkout: no installed dependencies and none of your untracked files. {{app}} prepares each new one before Claude starts.

## Copied files

Gitignored files listed in `.worktreeinclude` at the repository root are copied from the main checkout into each new worktree, like `.env`. It's the same file Claude Code uses for its own worktrees.

```
# .worktreeinclude
.env
.env.local
config/secrets.json
```

It uses `.gitignore` syntax. Only files that git ignores are copied, and they are copied, never linked. A name without a slash, like `.env`, doesn't reach into ignored folders such as `node_modules`; name the folder to reach into it, as in `vendor/**/config.json`.

## Setup and teardown commands

Set them in the project view's **Setup** tab, one command per line, under **Setup commands** and **Teardown commands**, then **Save**. The same tab has **Ports per workspace** (10 if empty) and **Claude starts**: **after setup succeeds** or **together with setup**. They are kept in {{app}}'s settings, so nothing is added to the repository, and apply to new workspaces.

- Setup runs in the new worktree, in the workspace's **Setup** tab, with the workspace's environment. The commands run in order, and the first that fails stops the rest. A setup still running after 15 minutes fails.
- Claude starts when setup succeeds, or at the same time if **Claude starts** says **together with setup**. To skip setup for one workspace, untick **Run setup, then start Claude with the task brief** in [New workspace](new-workspace).
- A new worktree's **submodules** are empty: git doesn't check them out when it creates a worktree. If your repository has submodules, add `git submodule update --init --recursive` to the setup commands.
- Teardown runs when you delete the workspace, for up to two minutes. If it fails, you're told, but the workspace is still deleted.
- In a workspace across several repositories, each repository runs its own setup and teardown, in its own worktree. See [Tasks across repositories](tasks-across-repositories#setup-in-each-repository).

:::warning Each line runs on its own
Every line runs separately, so a `cd` or `export` on one line doesn't carry over to the next. Put steps that belong together on one line: `cd app && npm install`.
:::

## When setup fails

The workspace shows **Error** with **Setup failed (exit n)**, on a red bar, and offers **Retry** <kbd>{{key:checkAgain}}</kbd> (setup again, then Claude; on Linux not while a terminal has the focus, where the key is the terminal's), **Start Claude anyway** and **Delete…**. The Setup tab keeps the output.

## The repository's own file

A repository can carry its own `{{repoDir}}/config.json`. When it exists, it's used instead of the Setup tab, which then shows its commands read-only:

```json
{
  "setup": ["npm ci"],
  "teardown": ["docker compose down"],
  "ports": 10,
  "setupTimeoutSec": 900,
  "startClaude": "after-setup"
}
```

A repository set up for {{oldApp}} has `{{oldRepoDir}}/config.json` instead. It's still read when there's no `{{repoDir}}/config.json`, and the Setup tab suggests renaming the folder to `{{repoDir}}`. Scripts it runs get `{{env:PORT}}` and the other variables below under the new name only, so rename any `{{oldApp}}`-prefixed variables in them too.

## A port per workspace

Each workspace gets its own block of ports, 10 by default, from 20000–29999, shown in its header. Dev servers started in different workspaces then don't collide:

| Variable | Value |
| --- | --- |
| `{{env:PORT}}` | The first port of the block |
| `{{env:PORT_BASE}}` | The same, as the start of the block |
| `{{env:PORT_COUNT}}` | How many ports the block has |

Claude is told the block too: when its session starts, it reads "Use ports 20040–20049 for anything you start (dev servers, tests); `${{env:PORT}}` is the first.", with the workspace's own numbers.

The ports are released when the workspace is deleted.

## The project's editor

The **Setup** tab also has the project's **Editor**: **Use the profile's editor**, or one for this project alone, used by **Open in editor** for its checkout and worktrees. See [Open in editor](open-in-editor#choosing-the-editor).
