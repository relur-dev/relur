# Changelog

All notable changes to Relur. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). A release's section here is its GitHub release notes.

## [Unreleased]

## [0.6.0] - 2026-11-08

### Highlights

A new, softer **light theme**, and **View › Appearance** to choose **System**, **Light** or **Dark**. The Board's **columns can be reordered and hidden**, for each profile, and the Board can be **grouped by project**. Profiles have **twelve colors** to choose from instead of six. And Relur **reopens exactly where you left off**: the same profile, view, tab and panels.

### Added

- **View › Appearance**: **System** (the default) follows your system's light or dark appearance, **Light** and **Dark** keep that theme whatever the system uses. The choice applies at once to the whole window, every terminal and the Guide's screenshots, and is remembered across restarts (`"appearance"` in `config.json`).
- **Arrange the Board's columns**, for each profile: drag a column's header to move it, or use the **⋯** in its header (or a right click) for **Move Left**, **Move Right** and **Hide Column**. **Columns**, next to **List | Board**, lists every column with a checkbox to show or hide it, and **Reset to default**. One column always stays shown, and the layout is kept across restarts. A hidden column's workspaces are still in the List and the sidebar; if **Needs you** is hidden while something needs you, **Columns** shows a small dot in its color.
- **Group the Board by project**: **Group**, next to **List | Board**, puts each project's workspaces in a band of their own under the Board's columns. A band's header shows the project, its workspaces and how many other projects' workspaces are linked into it; click it to collapse the band to a count per column (the Needs you count in color), or use **Expand all** and **Collapse all**. The column headers and project names stay in view while the Board scrolls, the arrow keys move through the bands, and the grouping and collapsed bands are remembered for each profile, with your column order and hidden columns applied to every band.
- **Twelve profile colors**: six more to choose from, **Indigo**, **Slate**, **Petrol**, **Pine**, **Plum** and **Charcoal**, in one row with the first six in New profile and Edit profile, scrolling sideways when the dialog is narrow. Hover a color for its name and which profiles use it, or move through them with the arrow keys. The new colors stay clear of the amber and pink that mean a session needs you, and read well in both themes. Existing profiles keep their colors. New profile's preview shows the new tab next to your other profiles' tabs.
- **Relur reopens where you left off**: the profile you were in (or the Guide, if it was open), and in it Home on its Overview or Terminal tab, a project on its tab, or a workspace on its tab with its Changes and Responses panels open or closed as they were. A shell tab comes back as a new shell in the same folder. If something is gone by then, it steps back: a deleted workspace opens its project, a removed project the profile's Home. This holds after every kind of quit, after **Restart now** for an update, and when interrupted work is continued at start.

### Changed

- **A new light theme.** Light is now dim rather than bright: warm putty grays, about as bright as a paper notebook under room light, with the cards and dialogs as the brightest surface. All text, status and diff colors read at 4.5:1 or more on every surface. The light terminal has its own ANSI colors, so colored output (and "white" text from command line tools) stays readable on its background, and the diff viewer's syntax colors are darkened to match. While **Needs you** on the Board has cards, its column also gets a top edge in the color of its most urgent card. The dark theme is unchanged.

### Fixed

- A branch that only caught up with main no longer counts as merged. A new workspace whose branch was fast-forwarded or rebased onto a newer main before it had commits of its own, for example by Claude at the start of a task, showed as **Merged** on Home and in Delete workspace. Only the branch's own commits count now, so it stays where it belongs until its own work is merged.

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

[Unreleased]: https://github.com/relur-dev/relur/compare/v0.6.0...HEAD
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
