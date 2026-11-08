# The sidebar

The sidebar shows the profile you're in: its name and number of workspaces, **Home** <kbd>{{key:home}}</kbd>, its projects with their workspaces, and **Add project** <kbd>{{key:addProject}}</kbd> at the bottom. Click a project's name for its [project view](add-project#the-project-view), a workspace for the [workspace view](workspace-view). Hovering a project row shows a **+** that starts a [new workspace](new-workspace) in it.

![The sidebar of a Work profile: Home, then web-app, api-service and shared-ui with their workspaces. One waits at the Spec review gate, one is suspended, one is working, one is done and one needs permission; ↗ Linked rows hold workspaces linked in from other projects.](images/sidebar.webp)

Right-click a project for **Remove from <profile>…**. Right-click a workspace for:

- **Open in editor**: its worktree in your [editor](open-in-editor), the same as the tab bar's button;
- **{{reveal}}**: its worktree folder;
- **Copy path**: the worktree's full path;
- **Copy branch name**;
- **Keep Claude Running**: its Claude is never [suspended](suspend) when idle; a checkmark shows it's on;
- **Delete workspace…**: see [Deleting a workspace](delete-workspace).

## With the keyboard

Tab into the sidebar and it's one stop, on the row you're in. Then:

| Key | Does |
| --- | --- |
| ↑ ↓ | Move between Home, the projects and the rows shown, Linked groups included |
| → | Expands a collapsed project or Linked group, or moves into an expanded one |
| ← | Collapses an expanded project or Linked group, or moves from a row to its project (or group) |
| Home, End | First and last row |
| ↵ or Space | Opens it |

Tab from a project row reaches its **+**. <kbd>{{keys:workspaceStep}}</kbd> still switch workspaces from anywhere.

## Workspace rows

Each workspace shows its [status glyph](status-glyphs), its title (or name), a **+n** when it spans other repositories, and on the right:

- while Claude works, how long it has been working, or **2 in background** while it waits for its background agents;
- when it's done with commands still running, **1 running**, or **Done · 1 running** until you've opened it (see [Work in the background](status-glyphs#work-in-the-background));
- when Claude is [suspended](suspend) to save memory, **Suspended**, next to the state's glyph;
- otherwise, when it has a glyph, a short state in its color: **Permission**, **Input**, **Approve**, **Done**, **Exited**, **Error** or **Unfinished**; at a workflow gate, the gate's label instead of **Approve**;
- with no glyph and a [workflow](workflows), the task's current status.

Hover a row for its task id and title, its state in words (at a gate with the gate's name) and its branch. For an **Unfinished** row it says why; see [The Unfinished marker](resume#the-unfinished-marker).

## Projects open and close by themselves

Projects start collapsed, so a long list stays short. The one holding the workspace you're in is expanded:

- When you open a workspace, from the sidebar, <kbd>{{key:nextNeedingYou}}</kbd>, <kbd>{{keys:workspaceStep}}</kbd>, a notification or Home's **Needs you**, its project expands. The project that was open only for the workspace before collapses again.
- A project you expand yourself with its **▶** stays expanded until you collapse it.
- After a restart, the projects you expanded and the project of the last workspace you opened are expanded again, with that workspace in view. The window itself opens where you were; see [Starting again](resume#starting-again).

## The counts on a project

| Count | Means |
| --- | --- |
| `3` | The project's own workspaces |
| `↗ 2` | Workspaces of other projects that this project is [linked into](tasks-across-repositories) |

Each shows only when it isn't 0; hover one for what it counts. Workspaces of other projects linked into a project are listed under it in a **↗ Linked** group, after its own workspaces. The group starts collapsed: click it (or press <kbd>↵</kbd> or <kbd>→</kbd> on it) to show its muted `↗` rows, each of which opens the workspace and expands its own project. The sidebar remembers which groups you expanded. While collapsed, the group shows the most urgent status glyph of its workspaces, like a collapsed project. Only these rows are grouped: the project's own workspaces stay as they are, even when they span other repositories.

## A collapsed project still tells you

When a workspace of a collapsed project needs you, has failed or is working, its [status glyph](status-glyphs) sits next to the counts: the most urgent among the project's workspaces and the ones linked into it, in this order: Needs permission, Waiting for input, Awaiting approval, Error, then Working. Hover it for the workspace's name; click it to open that workspace.
