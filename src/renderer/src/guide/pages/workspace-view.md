# The workspace view

The header shows what the workspace is: the task id and title, `branch ← base`, the workspace's ports and, once known, its pull request. With a [workflow](workflows), it also shows the status stepper, the status's hint, and **Continue** at a step or the gate's buttons. After a change to the profile's skills it says **Skills changed since Claude started**, with **Restart Claude**; see [Skills](skills#when-sources-change). The trash icon after the title opens [Delete workspace](delete-workspace), and **⋯** at the right has **Link another repository…**, **Unlink <repo>…** for each linked repository, and **Delete workspace…**.

A line separates the header from the tabs, whose bar holds the workspace's views at its right: **Notes** <kbd>{{key:notes}}</kbd>, a scratchpad for thoughts you send to Claude when ready ([Notes](notes)), **Responses** <kbd>{{key:responses}}</kbd> on a Claude tab ([Copy responses](copy-response)), **Open in editor** <kbd>{{key:openInEditor}}</kbd>, which opens the worktree in your [editor](open-in-editor), and **Changes** <kbd>{{key:changes}}</kbd>, which opens the [Changes panel](finishing-work). The number on **Changes** counts the changed files and updates within a second or two of a change in the workspace's folders, also one made in a shell or an editor. In a narrow window these show as icons; hover one for its name and shortcut. A workspace across several repositories shows its repositories as chips instead: the primary one with `branch ← base`, the linked ones by name on one line, with **+n more** when they don't fit. Hover a chip for its details, click it for Open in editor, New shell, {{reveal}}, Show in Changes and Unlink; see [Tasks across repositories](tasks-across-repositories#the-workspace-view).

## Tabs

| Tab | What it shows |
| --- | --- |
| Claude | The Claude Code session for this task. Always first |
| Setup | The setup commands' output, when the project has setup |
| Shell | A terminal in the worktree, with the workspace's environment. **+** after the tabs or <kbd>{{key:newShell}}</kbd> opens another. Across several repositories, shells are named after their repository |
| ¶ and the document label, for example ¶ Spec | With a [workflow](workflows#the-status-file-in-the-workspace): the task's status file, read-only, after the terminals |

Switch to the next or previous tab with <kbd>{{keys:cycleTabs}}</kbd>. <kbd>{{key:closeTab}}</kbd> closes a tab; closing a running Claude asks first. When Claude has exited, <kbd>{{key:restartClaude}}</kbd> in its tab starts it again, continuing the same conversation.

## Under the tabs

A bar under the tabs says when something needs doing:

- **Running setup. Claude starts when it finishes.** while setup runs.
- When setup failed, the error with **Retry**, **Start Claude anyway** and **Delete…**; see [Setup for new workspaces](workspace-setup#when-setup-fails).
- **Claude isn't running in this workspace.** with **Start Claude**, once Claude has exited or was never started; Claude starts again in its own tab. When there was no conversation to resume, a note says Claude started a new one; see [Quitting and resuming](resume#when-there-is-nothing-to-resume).
- **Claude didn't finish when {{app}} closed:** and why, with **Continue** and **Dismiss**, when the workspace is unfinished; see [The Unfinished marker](resume#the-unfinished-marker).
- When the branch is merged, **Delete workspace?** with **Delete…**; see [Finishing work](finishing-work#the-pr-badge).

## Moving between workspaces

<kbd>{{keys:workspaceStep}}</kbd> moves to the previous or next workspace **of the profile you're in**, in sidebar order, across its projects. They don't cross into other profiles; switch profiles with <kbd>{{keys:profile}}</kbd>. With only one workspace there's nowhere to go, and the status bar says so.

<kbd>{{key:nextNeedingYou}}</kbd> is different: it jumps to the next workspace that needs you, in any profile.

## The environment

Claude, setup and every shell of a workspace get these variables, besides the profile's account:

| Variable | Value |
| --- | --- |
| `{{env:WORKSPACE_ID}}`, `{{env:WORKSPACE_NAME}}` | The workspace |
| `{{env:ROOT_PATH}}`, `{{env:WORKTREE_PATH}}` | The main checkout and the worktree |
| `{{env:LINKED_WORKTREES}}` | The worktrees of [linked repositories](tasks-across-repositories), separated by `:`; empty without |
| `{{env:BRANCH}}`, `{{env:BASE_BRANCH}}` | The branch and its base |
| `{{env:TASK_ID}}`, `{{env:TASK_TITLE}}` | The task |
| `{{env:PORT}}`, `{{env:PORT_BASE}}`, `{{env:PORT_COUNT}}` | Its ports |
