# First steps

From a fresh install to Claude at work on a task in five steps.

1. **Create a profile.** On first launch {{app}} shows a welcome screen with **Create your first profile**. The wizard asks for a name, a color and which Claude account to use, then checks that Claude Code is ready. See [Creating a profile](create-profile).
2. **Add a project.** The new profile opens on its [Home](home), with **Add your first project**; later, use **Add project** at the bottom of the sidebar <kbd>{{key:addProject}}</kbd>. Choose a git repository you have or a folder that holds several, or let {{app}} create a new repository or clone one from a URL. See [Adding a project](add-project).
3. **Create a workspace.** Type the task, for example `ENG-1423 Fix login timeout`. <kbd>{{key:newWorkspace}}</kbd> See [New workspace](new-workspace).
4. **Work with Claude.** Claude starts in the new worktree, on the new branch. Type your request in its tab. See [The workspace view](workspace-view).
5. **Finish the task.** **Changes** <kbd>{{key:changes}}</kbd> shows what Claude changed, and takes you through Commit, Push and Create PR. See [Finishing work](finishing-work).

When Claude needs you, the workspace shows a status glyph, the profile tab gets a badge, and you get a notification; clicking it opens the workspace. See [Status glyphs](status-glyphs) and [Notifications and sounds](notifications).

## Home

Each profile has a Home <kbd>{{key:home}}</kbd>, where you go back to between tasks. Its **Overview** shows what needs you, what is working, what is ready to ship and what is merged, as a **Board** with a column for each state; each project's view shows its own workspaces on the same Board. On the Board you can answer Claude from a workspace's card without opening it. Its **Terminal** is a shell in your home folder that uses the profile's account, for anything that isn't a task. See [Home](home).

## Appearance

{{app}} follows your system's light or dark appearance. To keep one whatever the system uses, choose **View › Appearance › Light** or **Dark**; **System** follows it again. The change applies at once to the whole window, every terminal and this Guide, and {{app}} remembers it the next time it starts. The light theme is a dim one, about as bright as a paper notebook under room light.

## Updates and quitting

On the first start a bar under the tabs also asks whether {{app}} may check GitHub for new versions; until you answer, it sends nothing. When a new version is out, **Update** downloads it, and {{app}} replaces itself when you restart or quit it. See [Updates and privacy](updates).

You can quit at any time: Claude continues the same conversations when {{app}} starts again, and work it hadn't finished is marked **Unfinished**. See [Quitting and resuming](resume).

## Your team's skills and workflow

If your team has its own Claude Code skills and a workflow for tasks, [Set up your team's skills and workflow](team-setup) walks through setting them up.
