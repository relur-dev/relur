# Tasks across repositories

Some tasks change more than one repository: an API and the app that calls it, a service and a shared library. A workspace can span several projects of the same profile. Each repository gets its own worktree, all on the same branch, and one Claude works across all of them.

## Creating one

In [New workspace](new-workspace), tick the other projects under **Also in**. Each shows the base branch it starts from: its own project's base. The project you started from is the **primary**: the workspace lives under it, and Claude starts in its worktree.

- The branch name must be free in every repository, locally and on each remote.
- Each worktree goes where its project's worktree setting says. See [Where worktrees go](worktrees).
- {{app}} remembers which projects you ticked, per project, and ticks them again next time ("Last used with …").

Only projects of the same profile can be linked, so one task never mixes accounts.

Only link repositories you trust. Claude asks whether you trust the folder it starts in, the primary's worktree, but not the linked ones: their `CLAUDE.md`, rules and skills load without that question. New workspace and **Link another repository…** say so under the list.

## Setup in each repository

Every repository runs its own `.worktreeinclude` copy and its own setup, in its own worktree, each in a **Setup · <repo>** tab. They run at the same time, and Claude starts once all of them have passed.

If one fails, the workspace shows **Setup failed in <repo>**, opens that Setup tab, and marks the repository's chip with **✕**:

- **Retry** runs setup again only where it failed, then starts Claude.
- **Start Claude anyway** starts Claude with every repository.
- **Delete…** deletes the workspace.

The workspace has one block of ports, shared by all its repositories. Teardown runs in each repository when the workspace is deleted.

## One Claude for all of them

Claude starts in the primary's worktree and is given each other worktree as an additional folder (`--add-dir`), so it can read and edit all of them. Their `CLAUDE.md` files and `.claude/rules` load too, and so do their skills.

Every terminal of the workspace gets the workspace's variables, describing the primary, plus one more:

| Variable | Value |
| --- | --- |
| `{{env:WORKTREE_PATH}}` | The primary's worktree |
| `{{env:LINKED_WORKTREES}}` | The other worktrees, separated by `:` |

## The workspace view

The header shows the primary repository's chip in full: its name, **primary**, `branch ← base`, unpushed commits and a failed setup; hover it for its worktree path. The branch is shown only there, since every repository of the workspace is on it. Each linked repository follows on the same line as a chip with just its name, and a mark for anything that needs you: **✕** when its setup failed, **◌** while its setup runs, **PR** (coloured by its state) when it has a pull request. If they don't all fit, the rest go under **+n more**, which lists them.

![A workspace across three repositories: web-app's chip in full, marked primary, with its branch and base, then the linked api-service and shared-ui by name.](images/linked-workspace.webp)

- **Hover a linked chip**, or move to it with <kbd>Tab</kbd>, to see its branch and base branch (each repository has its own base, for example `master` in one and `dev` in another), its worktree folder, its setup and its pull request.
- **Click it**, or press <kbd>↵</kbd>, for its menu: **Open in editor** (that repository, in its project's editor), **New shell in <repo>**, **{{reveal}}**, **Show in Changes** (the Changes panel, at that repository's section) and **Unlink <repo>…**. The sidebar shows a **+n** after the workspace's title, and every linked project lists the workspace too, as a muted `↗` row that opens it, and counts it as `↗ n` on its row ([The sidebar](sidebar#the-counts-on-a-project)).

**Open in editor** in the tab bar opens the primary repository; the **▾** next to it has **Open all…**, which lists every repository with the editor it will use. Untick the ones you don't need. Repositories on VS Code (or Cursor) open together in one window; each repository on another editor gets its own, and more than three windows ask first. See [Open in editor](open-in-editor#open-all).

The **+** after the terminal tabs asks which repository the new shell is for; <kbd>{{key:newShell}}</kbd> opens one in the primary.

## Linking and unlinking

The workspace's **⋯** menu has:

- **Link another repository…**: pick one of the profile's other projects. {{app}} adds its worktree on the workspace's branch, copies its `.worktreeinclude` files and runs its setup. Then either **Link and restart Claude** (once its setup has passed, Claude restarts with every folder and the conversation continues), or **Link only** (Claude keeps running; paste the `/add-dir …` line the dialog shows into Claude).
- **Unlink <repo>…**: deletes that repository's worktree, with the same checks as deleting a workspace, and closes its Setup and Shell tabs. A running Claude restarts without it; the conversation continues. The primary can't be unlinked.

## When Claude links one itself

Mid-task, Claude may find that another repository needs a change too. With **Let Claude add others when needed**, ticked in [New workspace](new-workspace#also-in) (it is unless you untick it), Claude can link it itself. At start, Claude is told which other projects of the profile it could link, with their folders and base branches, and to run `{{cli}} link <name>` only when the task requires changes there, rather than create worktrees or edit their main checkouts. The workspace's own repository stays Claude's main one and its working folder. The result is the same as **Link another repository…**: the worktree on the workspace's branch, its `.worktreeinclude` files, the task file and its setup.

The repository shows up like any other linked one: a chip in the header, **+n** in the sidebar and on the Board, a section in the Changes panel and a card in Delete workspace. Its chip's tooltip says **Added by Claude**. If you're looking at the workspace, a line in its header says **Claude added <repo>** with its folder, until you close it with **×**; anywhere else, a notice at the top of the window says **Claude linked <repo> to <task>**. You can unlink it as any other.

To change your mind for one workspace, use **Let Claude Add Repositories** in its **⋯** menu; Claude follows it from its next start or `/clear`. With it off, Claude isn't told about the other projects, and if it runs `{{cli}} link` anyway, it's refused and told to ask you.

- Claude asks you first: **Do you want to proceed?** before it runs `{{cli}} link` (or calls the app's helper to link directly), in every permission mode, auto mode included. Choose **Yes** to link, **No** to keep the workspace as it is. To let Claude link without asking, turn off **Ask before Claude links a repository** in [Edit profile](edit-profile); it applies the next time Claude starts in a workspace.
- `{{cli}} link` answers once the repository's setup has finished, so Claude starts working there only when it's ready. If the setup fails, the repository stays linked, Claude is told the setup failed, its **Setup · <repo>** tab shows why, and the workspace offers **Retry** once you have fixed the cause.
- Claude keeps running and can edit the new worktree right away. If Claude asks before every edit, the first edit there asks once; choose **Yes, and always allow access to …** to allow the folder for the rest of the session. The next time Claude starts, the folder is added as for any linked repository.
- Claude can link only projects of this profile, nothing outside them. When you run `{{cli}} link` yourself, `<name>` can also be a path to a repository: if it isn't a project yet, it's added to this profile first. A repository of another profile is refused.
- You can run the same command in any of the workspace's terminals; `{{cli}} projects` lists the profile's projects and which are already in the workspace. Outside a workspace, `{{cli}} link` is refused.

## Finishing

The [Changes panel](finishing-work) has a section per repository, each with its own commit message (it starts as `ID: title`; edit it as you like), its own **Commit → Push → Create PR** and its own PR badge. **Ask Claude to write it** in a section asks Claude to write the message and commit in that repository only. When Claude opens a pull request, it's told about the other repositories and their PRs, so each PR mentions the others.

The workspace counts as merged once every repository with commits is merged; then it offers to delete itself.

## Deleting

[Deleting the workspace](delete-workspace) removes every worktree, with one card per repository and its own **Also delete the local branch**. [Removing a project](remove-project) that is linked into another project's workspace deletes only its worktree there; the workspace stays.
