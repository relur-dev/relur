# Edit profile

Right-click a profile tab and choose **Edit profile…**. It has four tabs: **General**, with the settings below, **Skills**, with the profile's [skill sources](skills#skill-sources), **Workflow**, with its [workflow](workflows#setting-it-up) and its [Start prompt](workflows#the-start-prompt), and **Task lookup**, with its [task lookup](workflows#task-lookup). General saves with **Save**; Workflow and Task lookup have their own save buttons.

![Edit profile's General tab, further down: the sounds for each event, Do Not Disturb, continuing interrupted work at start with its prompt, and Suspend idle sessions at its default, After 10 minutes](images/edit-profile.webp)

| Setting | What it does |
| --- | --- |
| Name | Shown on the tab |
| Color | One of twelve, in one row that scrolls sideways when it doesn't fit; hover a color for its name and which profiles use it. Colors other profiles use are dimmed, and you can still pick them. Use the arrow keys to move through the colors. It marks the tab, the sidebar and the status bar |
| Claude account folder | Read-only, with whether it's signed in and as whom. **Check setup** runs the [setup check](setup-check) |
| Terminal shortcut | For a profile with its own account folder: an `alias claude-<id>` line that runs Claude Code with this profile's account in any terminal, with Copy and **Add to <file>…**, the same as at the end of New profile |
| Commit identity | Optional name and email for commits made in this profile. See [Commit identity](finishing-work#commit-identity) |
| Pull request commands | Optional **Create PR** and **PR status** commands; left empty, Claude opens pull requests and git tells when they're merged. See [PR commands](finishing-work#pr-commands) |
| Sounds | A checkbox per event: Needs permission, Waiting for input (also when Claude asks a question), Awaiting approval, Done, Error. All off to begin with; ticking one plays it. See [Sounds](notifications#sounds) |
| Alerts | **Do Not Disturb**: no notifications and no sounds for this profile |
| When {{app}} starts | **Continue interrupted work when {{app}} starts**, off at first, and the continue prompt it sends. See [Continuing it](resume#continuing-it) |
| Suspend idle sessions | After 10 minutes at first, or after 5 or 30 minutes, or Off: stops Claude in workspaces you aren't looking at once it has waited that long, to save memory, and resumes it when you open them. See [Suspending idle sessions](suspend) |
| Editor | The editor **Open in editor** uses for this profile's projects; a project can choose its own. See [Open in editor](open-in-editor) |
| Linking repositories | **Ask before Claude links a repository**, on by default: Claude asks you before it runs `{{cli}} link`, even in auto mode. See [Tasks across repositories](tasks-across-repositories#when-claude-links-one-itself) |
| Your status line command | Only if you customized Claude Code's status line. See [The status line](status-line) |

The account folder can't be changed. To use a different Claude account, create a new profile.

Light or dark isn't a profile setting: it applies to the whole app, in **View › Appearance**. See [Appearance](first-steps#appearance).

The tab's menu also has **Check setup**, which opens the profile's setup check and runs it.

## Removing a profile

**Remove profile…**, at the bottom of General, takes the profile out of {{app}}. It's available only once the profile has no projects; until then it says how many are left. It asks first, with **Keep profile** focused; **Remove from {{app}}** removes it and stops its Home terminal. The profile tab's menu has **Remove profile…** too, which asks the same right away. Nothing on disk is deleted: the folder and its login stay.

## Reordering the tabs

Drag a profile tab left or right in the tab bar to move it; a bar shows where it will land. The **Guide** tab stays first. Without the mouse, the tab's menu has **Move Left** and **Move Right**: press <kbd>{{mac}}⇧F10{{/mac}}{{other}}Shift+F10{{/other}}</kbd> on the focused tab (or right-click it).

The order is saved and kept after a restart, and <kbd>{{keys:profile}}</kbd> follow it, counting from the first profile tab on the left. Dropping a tab outside the bar does nothing.
