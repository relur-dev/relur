# New workspace

Click the **+** at the right of a project's row in the sidebar (or of its band's header, when Home's Board is [grouped by project](home#board)), or **New workspace** in the project view or on Home. <kbd>{{key:newWorkspace}}</kbd> uses the project you're looking at, or the project of the workspace you're in; from Home the dialog has a **Project** field to pick one, when the profile has more than one.

## The Task field

There is one **Task** field. A leading key like `ABC-123` or `#42` becomes the task id, the rest the title; a preview under the field shows the split. Anything you type gives a workspace: an id alone, a title alone, one word or lowercase text like `abc-12` (that's a title; an id starts with capitals).

| You type | Task id | Title | Branch |
| --- | --- | --- | --- |
| `ENG-1423 Fix login timeout` | ENG-1423 | Fix login timeout | `ENG-1423-fix-login-timeout` |
| `#42 Dark mode` | #42 | Dark mode | `42-dark-mode` |
| `Update README` | none | Update README | `update-readme` |
| `shop-landing` | none | shop-landing | `shop-landing` |
| `Fix: a..b ~ x.lock` | none | Fix: a..b ~ x.lock | `fix-a-b-x-lock` |

The slug part of the branch is at most 50 characters, cut between words. Characters git doesn't allow in branch names are replaced with `-`, and text with no letters it can use (another script, only punctuation) gives `task`. When your profile's branch template has only `{id}`, text without an id fills it instead.

The **Branch name** comes from the task until you edit it, and it can't already exist, locally or on the remote. When the one from the task is taken, the dialog uses the next free name and says so under the field ("A branch named landing already exists; using landing-2"). A name you typed that exists, or that git doesn't allow, shows why with **Use <name>** for a free one. The **Base branch** is the project's; you can type or pick another.

## Looking up the title

If your profile has a **Task lookup** (Edit profile › Task lookup), type the key alone, like `ABC-123`. The lookup starts as soon as you pause typing, and the title shows under the field when it's found. Press <kbd>↵</kbd>: the dialog fills in the title, makes the branch from it (`ABC-123-<title>`) and creates the workspace, without another click. If the lookup is still running, the dialog shows **Looking up ABC-123…** and waits for it. **Create now** doesn't wait: it creates the workspace right away, without a title, with the branch named after the key. **Stop** ends the lookup and leaves the dialog open. Typing another key, or anything else, cancels a lookup that is still running. A title that was found is remembered until you quit {{app}}, so the same key gives it at once the next time.

![New workspace in api-service with ABC-160 typed in the Task field: the title says "looking up…", and Create now and Stop show next to "Looking up ABC-160".](images/new-workspace-lookup.webp)

If the lookup doesn't find the task (the command printed nothing, or Claude found no title), the workspace is created anyway, without a title, with the branch named after what you typed; a note at the top of the window says "ABC-99999 wasn't found; the branch is named after what you typed".

If the lookup fails, because it took too long or ran into an error, the dialog stays open and says why (with Claude's own explanation when it gives one). Press <kbd>↵</kbd> for **Create anyway**, which creates the workspace without a title, or type the title after the key first; **Cancel** (<kbd>Esc</kbd>) closes the dialog. Nothing is created until you choose. Text without a key, or a key with a title, never looks anything up. Without a task lookup, a key alone creates the workspace without a title; if your workflow's status file has a title field, the title comes from there once the skill writes it.

The lookup asks this profile's Claude in the background, allowed only the tools you list, or runs a command you give. See [Workflows](workflows#task-lookup).

## Also in

When the profile has other projects, **Also in** lists them. Tick the ones the task changes too: each gets its own worktree on the same branch, and one Claude works in all of them. Only tick repositories you trust: Claude loads their `CLAUDE.md` and skills without asking. See [Tasks across repositories](tasks-across-repositories).

## What Create does

Clicking **Create workspace** (<kbd>{{key:confirm}}</kbd>):

1. Fetches the base branch from the remote, then adds the worktree on a new branch from it. The dialog already asks the remote as it opens, so by the time you press Create this is usually done. Each call to the remote gives up after 30 seconds. When the base branch isn't on the remote yet (say a new, empty GitHub repository you haven't pushed to), or the fetch fails (offline, signed out, no answer within 30 seconds), the worktree starts from your local base branch instead, and a note at the top of the window says so, with git's reason when the fetch failed. Changes then compares with your local base branch until the remote has it. Create only fails when the base branch is neither on the remote nor local.
2. Copies the `.worktreeinclude` files, writes the task's id and title to `{{repoDir}}/task.md` in the worktree (git ignores it there), and gives the workspace its ports. See [Setup for new workspaces](workspace-setup).
3. Runs setup, if the project has any, then starts Claude, with the [Start prompt](workflows#the-start-prompt) as its first message when there is one and the task has an id. When the project has setup, the dialog shows **Run setup, then start Claude with the task brief**; untick it to skip setup and start Claude at once.

With **Also in** ticked, steps 1 and 2 happen in every repository, setup runs in each, and Claude starts once all of them have passed.
