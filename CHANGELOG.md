# Changelog

All notable changes to Relur. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). A release's section here is its GitHub release notes.

## [Unreleased]

### Added

- **Notes for each workspace**: a scratchpad for thoughts while Claude works. **Notes** (⇧⌘K) in a workspace's tab bar opens a panel beside the terminal; **Add note** (⌥⌘N) starts a new item, and each item is saved as you type. Notes read as plain text, with their actions only on the note you're on; Esc leaves a note, a second Esc closes the panel. Notes are private until sent: Relur keeps them in its own database, never where Claude could read them. They stay across restarts and suspension and are deleted with the workspace; the Delete dialog says how many unsent notes would go.
- **Send now** (⌘↵ in a note) types a note into Claude like the Board's quick reply, with the same care: never into a permission request or Claude's question menu, never over a prompt you're typing; a suspended Claude resumes first. When it can't go, **Queue instead** holds it. **When done** (⌥↵) holds it in a **Queued** section until Claude finishes its turn, and sends it then by itself; it waits on when Claude ends by asking you something, with **Send now** to send it anyway. Tick several notes to send them as one prompt, each its own numbered point, from the bar at the bottom; with two or more unsent, the bar offers **All n, as one prompt**.
- Sent notes move to **Sent** with the time they went, grouped when they went as one prompt; the section folds away, and each workspace remembers it. **View response** opens the Responses panel at Claude's answer, whose entry says **from notes** and leads back. A sent note can be copied, deleted or moved back to the open ones.
- On the Board, on Home and in a project's view, a small notes mark shows how many notes a workspace has waiting to be sent.
- **Merge into main, without leaving the app.** For when you merge locally instead of through a pull request. **Merge into main** is in the Changes panel once everything is committed, and on the Board's Ready to ship cards. It fast-forwards your local base branch to the workspace's branch, as `git merge --ff-only` in your main checkout would. It never fetches and never pushes.
  - Your main checkout is only fast-forwarded, and only while the base is checked out there with no changed files. Its branch is never switched. When it's on another branch, the base is moved without touching any files. When the base is checked out in some other worktree, Relur says so and does nothing.
  - When the base has moved on, Claude is asked to rebase the branch onto it, resolve conflicts, run the project's checks and commit. The workspace shows **Rebasing for merge…**, and when Claude's turn ends Relur tries the merge once more: the workspace moves to Merged, or the panel says why it stopped (conflicts left, the checks failed, the base moved again). **Cancel** stops waiting.
  - A branch that's already pushed, or has a pull request, would need a force-push after a rebase, so Relur asks first. The default is to have Claude merge the base into the branch instead.
  - In a workspace across several repositories, each merges into its own base, all at once or one section at a time, with the progress and any partial result shown.

### Changed

- **The Board everywhere.** Home's Overview is the Board, without the List or the List | Board switch, and **New workspace** and **Add project** are always at the top of it. A profile with projects but no workspaces gets **New workspace** in place of empty columns. Everything the List showed is on the cards or in their details, Dismiss included; At a glance is gone (the sidebar has the projects). Each card has a small **ⓘ** with what it doesn't show: its branch, the whole message Claude is waiting with, its workflow status, its memory, how long ago it was last active, and why its Claude isn't suspended yet or when it will be. Point at it to see them, or click it (or Tab to it and press ↵) to keep them open until you click elsewhere or press Esc; it never opens the workspace.
- **A project's Workspaces tab is the same Board**, with your columns from Home (move or hide one in either place and both change) and without grouping. Cards show their branch where Home's show the project, and workspaces of other projects linked into it show too, marked with their project. **Other worktrees** is a strip under the Board; click it to list them. The memory sort of the old table is gone: the status bar's Memory panel lists the largest workspaces.
- A gate's card on the Board has **Review** next to its answer button.
- **The Responses panel is easier to scan.** A collapsed entry shows your prompt on one line and Claude's latest words in two clean lines, in place of the faded preview, with a small bar for each part when there are several. Expanded, each part starts with its place (**2/3**), and the entry's header stays in view while you scroll it. **Copy** shows when you point at an entry. An entry says **Interrupted**, **Asks permission** or **Writing…** where that applies, and **from notes · 2** when several notes went as its prompt. **Expand all** and **Collapse all** are now one button. To show an answer in the terminal, click an expanded entry's text.
- A done workspace with a branch you can still merge stays under **Ready to ship** on Home, instead of going to Idle.

### Fixed

- **Quitting stops background git.** A background `git fetch` (for behind and conflicts, or the PR check) could hang on a dead ssh connection, after the Mac slept, and keep running after Relur quit, so the Dock still showed Relur. Every git call to a remote now gives up after 30 seconds (Push and cloning a skill source after 2 minutes), stopping the ssh it started too, and quitting, by ⌘Q, Restart now, logging out or a signal, stops every git Relur started.
- **git never waits for an answer it can't get.** ssh runs in batch mode, so a host key you haven't accepted yet (a first connection to `ssh.bitbucket.org`, say) or a key that needs its passphrase fails at once, with a reason that says what to do: run `git fetch` once in a terminal. Push, Create and Existing branch show it where you started them; background fetches write it to `app.log`.

## [0.6.2] - 2026-11-09

### Highlights

**Create a workspace from an existing branch**: someone else's pull request, or an older branch of your own. Pick it from the list or paste its URL, and **Push** updates the existing pull request. The Changes panel shows how far each branch is **behind** its base and whether merging it would **conflict**, with **Ask Claude to merge**. In a workspace across several repositories, **Create n PRs** opens a **pull request in every repository** with work of its own. Workspaces whose repositories contain **submodules** can be deleted, with a warning for anything inside them that would be lost. And **squash-merged branches now count as merged**, on Home and in Delete workspace.

### Added

- **A workspace from an existing branch.** New workspace has **New branch** (as before) and **Existing branch** at the top. Existing branch lists the project's branches, local and on its remotes, newest first with the last commit's author and date, after fetching every remote; type to filter, or paste a branch's URL or a pull request's URL from GitHub, GitLab or Bitbucket Server. The worktree checks the branch out and tracks the remote one, so **Push** updates the existing pull request. The task's id and title come from the branch name, or from the pull request's title when your PR status command prints a `title`, and stay editable. Bitbucket Cloud doesn't tell git which branch a pull request comes from: paste the branch name shown on the pull request page, or pick it from the list. A remote on `ssh.bitbucket.org`, where Bitbucket moves Git over SSH from December 10, 2026, counts as `bitbucket.org`, and a remote written with a git `insteadOf` shorthand is compared as git expands it.
- A branch that's already checked out says where: in a workspace (**Open workspace**), in a worktree (**Open as workspace**), or in your main checkout (**Open project**; Relur never switches your main checkout's branch).
- With **Also in**, each other project uses the same branch where it has it, and gets it as a new branch from its own base where it doesn't.
- **Behind and conflicts**: the Changes panel shows how far each workspace's branch is behind its base and whether merging the base would conflict, with **Ask Claude to merge**, which merges and resolves the conflicts without rebasing or force-pushing. While there are conflicts, the workspace's header says **Conflicts with <base>**.
- **Pull requests in every repository of a task.** In a workspace across several repositories, **Create n PRs** at the top of the Changes panel opens a pull request in each repository with commits of its own, skipping the others: it pushes first where needed, runs your PR create command in each repository, or asks Claude once for all of them, linking each pull request to the others. Each repository's PR shows on its chip in the header (the primary's too), and on Home "2 PRs open" with **View PRs**, which lists them by repository.
- **Create PR on Home.** When your profile or project has a PR create or status command, a pushed workspace without a pull request stays under **Ready to ship** with **Create PR** (**Create PRs…** across several repositories). Without the commands it goes to Idle as before, for when you merge locally.

### Changed

- **Push** goes to the branch the workspace's branch tracks, when it tracks one. When the remote refuses because someone else pushed, the Changes panel offers **Ask Claude to merge** that branch.
- **Delete workspace** says the branch on the remote stays for a workspace made from an existing branch, and when that branch has commits by someone else, names them before deleting your local copy. A local branch that was there before the workspace is kept unless you tick **Also delete the local branch**.
- **Squash-merged branches count as merged.** A branch whose pull request was squash-merged has its changes in the base branch but not its commits, so Delete workspace warned about unpushed commits and Home never moved it to **Merged**. Now a branch counts as merged when merging it into its base would change nothing (`git merge-tree`, git 2.38 or later): Delete workspace says **✓ Merged into main (its changes are already there, for example after a squash merge)** and deletes its local branch with it, Home shows it under **Merged**, and **Delete n merged** includes it. With an older git its commits still count as not pushed.

### Fixed

- **PR commands in a linked repository get that repository's base branch.** Your PR create and status commands ran in a linked repository's worktree but with the primary repository's `RELUR_BASE_BRANCH` and `RELUR_WORKTREE_PATH`, so `gh pr create --base "$RELUR_BASE_BRANCH"` could target the wrong base when the repositories' bases differ. They now get the repository's own.
- **The PR badge after Create PR shows the new pull request at once.** A PR check that was still running from the push no longer stands in for the one after Create PR.
- **Delete workspace checks the branch each worktree is on.** If a worktree was switched to another branch than the workspace's, the dialog said "No uncommitted changes or unpushed commits" from the workspace's branch alone. It now says "frontend is on <branch>, not <workspace branch>" and warns about that branch's commits that aren't pushed, in Delete workspace, Unlink, Delete n merged and Remove project. The other branch is kept. Commits on a detached HEAD, which would be lost with the worktree, need **Delete anyway**.
- **Relur's background git checks no longer get in the way of your git commands.** Reading a worktree's state (`git status`, for the Changes panel and Home) could briefly lock the worktree's index, so a commit, rebase or switch of your own at that moment failed with "Unable to create '…/index.lock': File exists". Those checks now run without optional locks.
- **Deleting a workspace whose repository has submodules works.** Delete stopped with git's "working trees containing submodules cannot be moved or removed" although the dialog had said there was nothing to lose. The check now looks inside every checked-out submodule: uncommitted changes there, and commits that aren't on the submodule's remote, get a warning of their own, such as **Submodule lib: 1 commit not pushed**, and need **Delete anyway**. A clean worktree with clean submodules is removed as git requires. The same holds for **Unlink** and for **Remove project**.
- **A worktree that can't be removed leaves the workspace as it was.** Every worktree is checked before anything is stopped, so a refusal no longer leaves a workspace half deleted: the dialog says why and what to do, and **Delete anyway** (or **Unlink anyway**) removes it regardless.
- **Cancelling an update's download no longer shows a JavaScript error.** Cancel, or a connection that dropped, while a piece of the download was being written to disk could end in an error dialog from the main process. The download now stops cleanly and leaves nothing behind.
- **Stop and Create now end a task lookup for good.** When <kbd>↵</kbd> came before the pause that starts a lookup by itself, New workspace looked the key up again a moment after **Stop** or **Create now**: "looking up…" came back after Stop, and a task lookup with Claude started a `claude -p` that was cancelled straight away. Now only the next <kbd>↵</kbd> looks it up again.

## [0.6.1] - 2026-11-09

### Fixed

- **A question from Claude no longer reads as a permission request.** When Claude asks you to choose in its question menu, Claude Code reports it like a permission request, so its workspace said **Needs permission**. It now says **Asked a question**, with a pink **?**, in the sidebar, on Home's list and on the Board, and counts toward **Needs you**'s color as waiting for input. Its notification says "asked a question" and plays the **Waiting for input** sound. A real permission request is unchanged.
- **A Board card at a workflow gate no longer names the gate twice.** When Claude wrote nothing there, the line above the quick reply showed "At Spec review: Review and approve the spec" under a status that already said "At Spec review"; it now shows only the gate's hint.

## [0.6.0] - 2026-11-09

### Highlights

A new, softer **light theme**, and **View › Appearance** to choose **System**, **Light** or **Dark**. The Board's **columns can be reordered and hidden**, for each profile, and the Board can be **grouped by project**. Profiles have **twelve colors** to choose from instead of six. And Relur **reopens exactly where you left off**: the same profile, view, tab and panels. A project's **+** for a new workspace is **always shown** in the sidebar. Claude can **add other repositories** to a workspace when its task needs changes there. And the Board's quick reply **shows what Claude asked**, with its question's options as buttons to answer in one click.

### Added

- **View › Appearance**: **System** (the default) follows your system's light or dark appearance, **Light** and **Dark** keep that theme whatever the system uses. The choice applies at once to the whole window, every terminal and the Guide's screenshots, and is remembered across restarts (`"appearance"` in `config.json`).
- **Arrange the Board's columns**, for each profile: drag a column's header to move it, or use the **⋯** in its header (or a right click) for **Move Left**, **Move Right** and **Hide Column**. **Columns**, next to **List | Board**, lists every column with a checkbox to show or hide it, and **Reset to default**. One column always stays shown, and the layout is kept across restarts. A hidden column's workspaces are still in the List and the sidebar; if **Needs you** is hidden while something needs you, **Columns** shows a small dot in its color.
- **Group the Board by project**: **Group**, next to **List | Board**, puts each project's workspaces in a band of their own under the Board's columns. A band's header shows the project, its workspaces and how many other projects' workspaces are linked into it; click it to collapse the band to a count per column (the Needs you count in color), or use **Expand all** and **Collapse all**. The column headers and project names stay in view while the Board scrolls, the arrow keys move through the bands, and the grouping and collapsed bands are remembered for each profile, with your column order and hidden columns applied to every band.
- **A + on each band of the grouped Board.** With the Board grouped by project, each band's header has the same **+**, for a new workspace in that project.
- **Twelve profile colors**: six more to choose from, **Indigo**, **Slate**, **Petrol**, **Pine**, **Plum** and **Charcoal**, in one row with the first six in New profile and Edit profile, scrolling sideways when the dialog is narrow. Hover a color for its name and which profiles use it, or move through them with the arrow keys. The new colors stay clear of the amber and pink that mean a session needs you, and read well in both themes. Existing profiles keep their colors. New profile's preview shows the new tab next to your other profiles' tabs.
- **Relur reopens where you left off**: the profile you were in (or the Guide, if it was open), and in it Home on its Overview or Terminal tab, a project on its tab, or a workspace on its tab with its Changes and Responses panels open or closed as they were. A shell tab comes back as a new shell in the same folder. If something is gone by then, it steps back: a deleted workspace opens its project, a removed project the profile's Home. This holds after every kind of quit, after **Restart now** for an update, and when interrupted work is continued at start.
- **Let Claude add others when needed**, under **Also in** in New workspace and on unless you untick it (remembered for each project). Claude is told at start which other projects of the profile it could link, with their folders and base branches, and links one with `relur link` only when the task needs changes there; the workspace's own repository stays its main one. Change it for a workspace with **Let Claude Add Repositories** in its **⋯** menu. With it off, Claude isn't told and its `relur link` is refused.
- A repository Claude linked says **Added by Claude** in its chip's tooltip, and a line in the workspace's header says **Claude added <repo>** while you're looking at the workspace; elsewhere the window's notice says so, as before.
- **See what you're replying to** on the Board: above a card's quick reply, a line shows Claude's last words: the question it asked, what it said at a workflow gate (or the gate's hint), or the end of its last message, two lines at most. Click it to open the workspace's **Responses** panel at that answer. It is always shown on **Needs you** cards and unfolds with the field elsewhere.
- **Answer Claude's questions from the Board:** when Claude asks you to choose (its question menu), the card shows the question with its options as buttons; one click answers it. **Other…** opens the workspace for your own answer, and several questions at once, or several options to tick, offer **Open**. The **Responses** panel shows Claude's questions too, with the answer you gave.

### Changed

- **A new light theme.** Light is now dim rather than bright: warm putty grays, about as bright as a paper notebook under room light, with the cards and dialogs as the brightest surface. All text, status and diff colors read at 4.5:1 or more on every surface. The light terminal has its own ANSI colors, so colored output (and "white" text from command line tools) stays readable on its background, and the diff viewer's syntax colors are darkened to match. While **Needs you** on the Board has cards, its column also gets a top edge in the color of its most urgent card. The dark theme is unchanged.
- **New workspace is always one click away.** The **+** on each project's row in the sidebar no longer waits for the pointer: it's always shown, at the row's right end, so every project's **+** lines up. Hover it for "New workspace in <project>" and its shortcut.
- Claude can link only the profile's projects: `relur link <path>` run by Claude no longer adds a repository that isn't a project yet. From a terminal it still does.

### Fixed

- A branch that only caught up with main no longer counts as merged. A new workspace whose branch was fast-forwarded or rebased onto a newer main before it had commits of its own, for example by Claude at the start of a task, showed as **Merged** on Home and in Delete workspace. Only the branch's own commits count now, so it stays where it belongs until its own work is merged.
- A card dragged on the Board no longer carries on behind a dialog. If a dialog opened during the drag, for example the list of unfinished work at start, dropping the card on **Drop to delete** opened Delete workspace on top of it. A dialog that opens now cancels the drag.
- The Board offered its quick reply while Claude waited on its question menu, where the text would have been taken as your answer. It shows the question's options there instead.

## [0.5.0] - 2026-11-06

### Highlights

Home has a new **Board**, now the view Home opens with: your workspaces in five columns, **Working**, **Idle**, **Needs you**, **Ready to ship** and **Merged**, and the cards move between them by themselves as Claude works. Answer a waiting session with a **quick reply** right on its card, without opening it, and drag a card to **Drop to delete** to remove its workspace. The List is still one click away, under **List | Board**.

### Added

- **Board** on Home: **List | Board** at the right of Home's tabs shows the profile's workspaces as five columns, **Working**, **Idle**, **Needs you**, **Ready to ship** and **Merged**, by the same rules as the List. Cards move by themselves as Claude works; on hover or focus a card unfolds its main action and **Delete**. While Needs you has cards, its count takes the color of the most urgent one (a permission request, else a question), as in the sidebar. **Delete n merged** sits at the top of Merged. Drag a card to **Drop to delete** at the bottom to open Delete workspace, where you confirm. Arrow keys move between cards and columns, <kbd>↵</kbd> opens, <kbd>Delete</kbd> or <kbd>⌫</kbd> deletes.
- **Quick reply** on the Board's cards: type a message and press ↵ to send it to that workspace's Claude without opening it; a suspended Claude resumes first. It is never offered on a permission request (Open instead), over a prompt you typed and didn't send, or on Merged workspaces.
- The Guide shows the Board in a screenshot and covers the quick reply, notification clicks and updating inside the app.

### Changed

- Home opens on the **Board** in profiles that never chose a view; a profile where you picked List or Board keeps it.
- **Merged locally counts as merged:** a workspace whose branch is already in its base branch, on your machine or on the remote (merged, fast-forwarded or rebased onto it), counts as merged, also without a pull request. Delete workspace no longer warns that its commits aren't pushed and says **Merged into main**, or **Merged into your local main (not pushed yet)**; Home shows it under **Clean up** and in the Board's **Merged** column, and **Delete n merged** includes it. A new workspace with no commits of its own never counts as merged; squash merges still count through the pull request.
- The **Responses** panel starts with every entry collapsed, the newest one too, and new entries arrive collapsed. **Expand all** and **Collapse all** are there whenever there is an entry, a single one too.

### Fixed

- A workspace whose Claude waits for a long command in the background, such as a 20-minute test run, stays **Working** for as long as the command runs, instead of turning **Done** after 10 minutes and moving to **Ready to ship** while Claude still waits. Relur watches the command's process: once it has ended and Claude hasn't carried on within 2 minutes, the workspace is Done with "1 still running in the background", as before; a command whose process it can't find still gets 10 minutes, and nothing is held longer than 2 hours.
- On Home, a done workspace whose dev server still runs keeps its place and shows a quiet **1 running**, on the Board and in the List.
- The Guide's Linux page no longer says Relur never updates itself: **Update** replaces the AppImage.

## [0.4.3] - 2026-11-06

### Added

- **Update** in the update notice now updates Relur inside the app, without a terminal: it downloads the new version for your Mac or your AppImage from the release, with a progress bar and **Cancel**, checks it against the release's `SHA256SUMS` and that it is Relur at that version, and then offers **Restart now** or **Later** (installed when you next quit). Relur is replaced where it is installed, in `/Applications`, `~/Applications` or your AppImage's folder, never with `sudo`; if that fails, the old version stays, opens again and says why. Nothing is downloaded before you click Update.

### Changed

- **Update in terminal** in the update notice keeps the old way, the install command in your terminal. On macOS it now opens in the terminal you made the default for `.command` files, such as iTerm2, instead of always Terminal.
- A `.deb` install keeps showing the `apt` command; a Relur built from source says it can't update itself; a Relur running from the disk image or from a folder you can't write to offers Update in terminal and says why.

## [0.4.2] - 2026-11-06

### Added

- Screenshots in the Guide: the sidebar, Home, New workspace with a task lookup, the Changes and Responses panels, the memory panel, a suspended workspace, a workflow gate, Edit profile and a workspace across repositories, in dark and light, following the app's theme.
- The Guide for the web: every release has `Relur-guide.tar.gz`, the Guide as plain Markdown for a reader on any platform, with its screenshots and an `index.json` of its sections and pages.

### Changed

- Idle Claude sessions are now suspended after 10 minutes by default, to save memory, also in new profiles; they resume in the same conversation when you open them. Profiles that never changed **Suspend idle sessions** get 10 minutes after the update, and Relur says so once, with **Settings** to change it in **Edit profile › General**. A profile where you chose a time keeps it, and choosing **Off** now stays Off.

## [0.4.1] - 2026-11-05

### Changed

- The Responses panel shows one entry per prompt, with Claude's messages as its parts. **Copy** copies the whole answer, **Copy last part** only Claude's last message, and ⌥C the whole latest answer. A pasted prompt or a skill command gets its own entry, and Claude's paste tags no longer show in a prompt. An answer interrupted with Esc keeps what Claude wrote until then and is marked **Interrupted**.
- **Start Claude**, and ↵ in a Claude tab whose Claude has exited, restart Claude in the same tab instead of opening a new one.

### Fixed

- Clicking a notification opens its workspace, also with the window minimized or closed; before, it only brought Relur to the front.
- Prompt numbers no longer land on lines of Claude's answer that repeat a prompt's words, also after pasting into a prompt or resizing the window. A number goes only on the line where Claude shows the sent prompt. Prompts Relur sends for you (Continue, a workflow's answer buttons, Ask Claude to write it) and short ones such as "ok" are numbered too, and after a restart or a resumed session the numbers and the prompt navigator come back (in classic mode).
- A workspace whose Claude had no conversation yet broke when it was suspended: Claude said "No conversation found with session ID", and every **Start Claude** failed the same way in a new tab. Such sessions are no longer suspended. Where there is no conversation to resume, Claude starts a new one in the same tab and says so above the terminal, so workspaces already in that state recover on the next **Start Claude**.
- Esc closes **Add project** after a clone that failed at once.

## [0.4.0] - 2026-11-05

### Highlights

Relur can now suspend idle Claude sessions: sessions you aren't using are stopped to free memory and resume in the same conversation when you open them. It's off by default and turned on per profile in **Edit profile › General**; sessions that are working, waiting for permission, running background work, holding an unsent prompt or marked **Keep Claude Running** are never suspended. Home gets an Overview of everything that needs you, and Relur now shows how much memory your Claude sessions use.

### Added

- Home has two tabs, like a workspace: **Overview** (⌃1, where Home opens) and **Terminal** (⌃2, the profile's Home terminal). The Overview shows what needs you (with **Open**, **Review** and a gate's answer, **Continue** and **Dismiss**), what is working (for how long, and its memory), what is ready to ship (**Commit…**, **Push**, **View PR**) and merged workspaces to clean up (**Delete**, or **Delete n merged workspaces** in one dialog), with the profile's projects and quick actions beside them. Rows work with ↑↓, ↵ and Tab. **All clear** when there is nothing, **Add your first project** in a profile without projects.
- How much memory Claude sessions use, with every process they started (MCP servers, shells, background commands, dev servers): **Memory** in the status bar, a bar and "2.4 GB of 16 GB" for the sessions and the app relative to the machine's RAM, which opens a panel with the split, the five largest workspaces and what each term means; a sortable **Memory** column in the project's Workspaces table; and the project's total in its view. A Guide page explains what counts and why the numbers run higher than Activity Monitor's. Measured every 10 seconds while the window is visible.
- Suspend idle Claude sessions (**Edit profile › General**: off, or after 5, 10 or 30 minutes). A session that has been idle for the whole delay, not shown, and has no background work or unsent prompt is stopped and marked **Suspended**; opening it resumes it in the same conversation, with its permission mode and model. **Keep Claude Running** (right-click a workspace in the sidebar) keeps a session from being suspended. The Workspaces table's Status tooltip says why a running session isn't suspended, or when it will be, and the memory panel lists the suspended sessions. With the setting on, workspaces start suspended at launch, except the one shown and those continued.
- New workspace asks the remote and fetches the base branch as soon as it opens, so Create is quicker; both give up after 30 seconds.
- New workspace looks a task id up while you type it and shows the title it found, so it is often ready when you press ↵. **Create now**, next to **Stop**, creates the workspace at once without waiting for the lookup. A title found for an id is remembered while the app runs, so the same id doesn't need another lookup.
- `app.log` in the app's config folder records how long each step of Create and of a task lookup takes, and when idle sessions are suspended and resumed, and why a session's idle time started over.

### Changed

- A **Done** notification waits while Claude waits for its background commands: the workspace stays Working, with the number of commands, until they hand back and Claude finishes, or for at most 10 minutes. You get one Done instead of two.
- Dev servers (including `python3 -m http.server`) are recognised: a session that leaves one running is Done at once, with "1 still running in the background".

### Removed

- The panel over the Home terminal and its key ⌘.: what it showed is in Home's Overview.

### Fixed

- **Stop** pressed right after ↵ in a task lookup could be lost, and the lookup ran anyway.
- Moving the mouse over a Claude terminal counted as typed text, so such a session was never suspended.

## [0.3.2] - 2026-11-04

### Added

- In terminals, ⇧↵ starts a new line in Claude's prompt instead of sending it (Relur sends ESC ↵, so `/terminal-setup` isn't needed). On macOS, ⌘⌫ deletes to the start of the line, as in other macOS terminals.

## [0.3.1] - 2026-11-03

### Added

- **Report a Bug…** and **Request a Feature…** in the Help menu (under the Guide, on macOS too) and as links on the Guide's Troubleshooting page. Both open the repository's issue forms in the browser; a bug report comes prefilled with the app version, the OS and its version, and the Claude Code version. Nothing is sent.

### Fixed

- New workspace accepts any task text and always gives a valid branch name: what git refuses is replaced, a template with only `{id}` or `{slug}` fills it from the other, and text that gives no name becomes `task`.
- A branch from the task that's already taken, also only on the remote, becomes the next free name (`-2`, `-3` …). A typed one that's taken says so and offers **Use** with a free name.
- Task lookup no longer blocks: an id it doesn't find creates the workspace without a title, with a note, and a failed lookup offers **Create anyway** (↵) or **Cancel**.
- A base branch that isn't on the remote yet, or a fetch that fails, starts the workspace from the local base branch with a note; Create fails only when the base is on neither.
- Prompt marks, Copy buttons and the prompt navigator could appear on the wrong lines of a full-screen Claude tab after switching back to it. The tab now stays in the alternate screen when it's shown again.

## [0.3.0] - 2026-11-03

### Added

- Add project creates a new repository or clones one: the dialog offers **Existing folder**, **New repository** and **Clone from URL**. A new repository gets `git init` on the profile's base branch and a first commit with the profile's identity; a clone runs in a terminal in the dialog, so git's prompts work, and a failed clone keeps git's output and adds nothing. On the command line: `relur add --new <path>` and `relur add --clone <url> [<path>]`.
- The project view's **Remote** row has **Change…**, and an `origin` added later to a project without a remote is picked up with a notice. The Changes panel explains what Push and Create PR need.

### Changed

- Linux is no longer beta: Relur has been tested on Ubuntu 24.04 with GNOME. The `.deb` stays the recommended install on Ubuntu 23.10 and later.
- Terminals redraw in full when they're shown, resized or re-themed, and after a lost WebGL context, so no content from the terminal shown before can remain.

### Fixed

- On Linux, logging out could end Relur before it saved what the window remembers (sizes, collapsed panels and other preferences). They're now written to disk shortly after every change and first thing when the app is told to end; a hangup (SIGHUP) now quits like SIGTERM.

## [0.2.0] - 2026-11-02

### Added

- New versions: on the first start Relur asks whether to check GitHub for its latest release once a day; nothing about you or your work is sent. A newer version shows a quiet notice with **Update** (opens your terminal with the install command), **Release notes** and **Skip this version**. **Check for Updates…** and **Check for Updates Automatically** are in the app menu (the Help menu on Linux).
- Continue interrupted work: when Relur stops while Claude is working (quit, logout, an update, a crash), the workspace is marked **Unfinished**. A profile setting continues that work at the next start, one workspace after another and never at the plan limit; otherwise Relur asks once at start which workspaces to continue.
- A workspace that was done but still had background commands running (a dev server, a long test run) is marked **Unfinished** too, with "1 background command was stopped". It's never continued by itself: you choose it in the overview or with **Continue**.
- Changes panel: a draggable divider between the file list and the diff; the list is as tall as its files up to about five rows; clicking its header collapses it to one line with previous and next file (⌥⌘↑ / ⌥⌘↓); in Full view the list is a resizable column.

### Changed

- The quit dialog says what happens to Claude's unfinished work at the next start.
- The Guide: First steps goes on to finishing a task, the Resume page is now **Quitting and resuming**, and the pages cover the Unfinished marker, background commands, the update notice and the Linux menu.

### Fixed

- Quitting while typing in a terminal could show "The database connection is not open" in an error dialog. Once a quit goes ahead, Relur takes no more terminal input or hook events, and closes its database last.

## [0.1.0] - 2026-11-02

### Added

- Parallel Claude Code sessions, each in its own git worktree and branch, created from a task with setup commands and a block of ports.
- Status for every session from Claude Code's hooks: working, needs permission, waiting for input, awaiting approval, done; in the sidebar, the Dock badge, notifications and optional sounds.
- Profiles that keep Claude accounts, settings and projects apart, with a setup check that installs and signs in with Claude Code's own commands.
- The Changes panel with a read-only diff, Commit, Push and Create PR, and the PR badge. The panel is resizable, has a Full view (⇧⌘M) and a Unified / Side by side switch; the view buttons are in the tab bar.
- Skills and workflows from a status file, with gates and Continue; linked repositories in one workspace.
- Plan usage in the status bar, from Claude Code's status line.
- The `relur` command line tool (`add`, `link`, `projects`), the in-app Guide, and Open in editor.
- macOS (Apple Silicon and Intel) and Linux beta builds (AppImage and `.deb`), with an install script. Both Linux builds keep Chromium's sandbox, the AppImage on Ubuntu 23.10 and later once it's listed for it, and the window says so when it runs without it.

[Unreleased]: https://github.com/relur-dev/relur/compare/v0.6.2...HEAD
[0.6.2]: https://github.com/relur-dev/relur/compare/v0.6.1...v0.6.2
[0.6.1]: https://github.com/relur-dev/relur/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/relur-dev/relur/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/relur-dev/relur/compare/v0.4.3...v0.5.0
[0.4.3]: https://github.com/relur-dev/relur/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/relur-dev/relur/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/relur-dev/relur/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/relur-dev/relur/compare/v0.3.2...v0.4.0
[0.3.2]: https://github.com/relur-dev/relur/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/relur-dev/relur/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/relur-dev/relur/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/relur-dev/relur/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/relur-dev/relur/releases/tag/v0.1.0
