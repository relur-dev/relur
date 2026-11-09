# Finishing work

{{app}} doesn't merge. It helps you commit, push and open a pull request, then shows when it's merged.

## The Changes panel

**Changes** at the right of the tab bar, or <kbd>{{key:changes}}</kbd>, shows what the workspace changed against its base branch, in two groups:

- **Committed**: commits since the branch left the base.
- **Uncommitted**: staged, unstaged and new files.

Pick a file to see its diff, read-only. **Unified** and **Side by side** above the diff choose how it's shown; the choice stays for every workspace, also after a restart. Side by side needs room: in a narrow panel the diff stays unified and says so, until you widen the panel or use Full view. <kbd>↑</kbd> <kbd>↓</kbd> move between files; <kbd>Esc</kbd> goes back to the terminal.

![The Changes panel beside the Claude terminal: three uncommitted files, the diff of src/routes/login.ts with its added and removed lines, and the commit message with Commit 3 files below.](images/changes-panel.webp)

Drag the panel's left edge to make it wider or narrower; double-click the edge for the default width. The width stays after a restart. **Full view** in the panel's header, or <kbd>{{key:changesFullView}}</kbd>, gives it the whole workspace area, with the terminal hidden for the moment; **Side panel**, <kbd>{{key:changesFullView}}</kbd> or <kbd>Esc</kbd> puts it back.

### More room for the diff

The file list is as tall as its files, up to about five rows, and scrolls beyond that, so the diff gets the rest of the panel. Drag the line between the list and the diff to make the list taller or shorter; double-click it to go back to the default. Click the list's header, such as **Uncommitted · 3**, to collapse the list to one line: it then shows the file you're looking at, with **‹** and **›** for the previous and next file. Click the line to bring the list back. With the focus in the diff, <kbd>{{keys:changesFileStep}}</kbd> go to the previous and next file, collapsed or not.

In Full view the list is a column on the left and the diff fills the right; drag the line between them to change the column's width. The list's height, the column's width and whether the list is collapsed all stay after a restart.

To change a file, open it in your editor: **Open**, on a file's row when you hover or focus it, opens it at its first change; **Open in editor** above the diff opens it at the line you clicked in the diff, or at the first change. It uses the editor of the file's project. See [Open in editor](open-in-editor).

## Behind and conflicts

When the base branch has commits your branch doesn't, the panel says so above Commit: **↓12 behind origin/main**. If merging them would conflict, it adds **conflicts in 3 files** in amber (hover it for the files), and the workspace's header shows **Conflicts with main** until it's resolved; click it to open the Changes panel. This is common for a branch that has been open a while, such as a colleague's pull request.

**Ask Claude to merge main** asks Claude in the Claude tab to fetch the base, merge it into the branch, resolve the conflicts so both sides' changes keep working, run the project's checks and commit the merge. Claude is told not to rebase or force-push: others may have the branch, and its pull request would lose its history. {{app}} fetches the base by itself about once a minute while you look at the panel. Seeing the conflicts needs git 2.38 or newer; with an older git, only how far behind the branch is shows.

## Commit, Push, Create PR

The panel's bottom shows one step at a time:

1. **Commit**, while there are uncommitted files: the message starts as `ID: title` (the title alone without an id). **Commit n files** commits everything. **Ask Claude to write it** asks Claude in the Claude tab to write the message and commit.
2. **Push**, while there are unpushed commits: **Push n commits to <remote>** sends the branch to the remote; a branch that tracks one on the remote, like one from [an existing branch](new-workspace#from-an-existing-branch), goes to that one. If the remote's branch has commits yours doesn't (someone else pushed), the push is refused and the panel offers **Ask Claude to merge origin/<branch>**: Claude merges them in and pushes. If git has no credentials for the remote, you get an explanation instead of a password prompt: set up a credential helper, an SSH key or a CLI login like `gh auth login`, and push once from a Shell tab.
3. **Create PR**, once the branch is pushed and no pull request is known: **Create PR** runs your [PR create command](#pr-commands); without one, **Create PR with Claude** asks Claude in the Claude tab to open the pull request. For a branch that was there before the workspace, Claude is told it may have a pull request already, and to tell you its URL rather than open another.

Then the panel shows the PR badge. Projects without a remote show only Commit, with a note on adding one: `git remote add origin <url>` in a Shell tab, which {{app}} picks up by itself. See [A new repository](add-project#a-new-repository).

A workspace across several repositories has a section per repository, each with its own commit message, **Ask Claude to write it** (for that repository only), **Commit → Push → Create PR** row and PR badge; see [Tasks across repositories](tasks-across-repositories#finishing).

## The PR badge

{{app}} checks the pull request after a push, every five minutes, when you come back to the app, and when you click **Check again**. Without a PR status command it uses git alone:

| Badge | Meaning |
| --- | --- |
| PR open, PR draft, PR closed | From the PR status command |
| Merged | From the PR status command, or: the branch's own commits are in the base branch (see [Merged branches](delete-workspace#merged-branches)) |
| Likely merged | The pushed branch was deleted on the remote, which most hosts do after a merge |

When it's merged, the workspace offers **Delete…**. Across several repositories, that's once every repository with commits is merged.

## PR commands

By default {{app}} needs no setup for pull requests: Claude opens them, and git tells when they're merged. To use your own commands instead, set them in [Edit profile](edit-profile) › General under **Pull request commands**. A project's own commands go in {{app}}'s `config.json` (in `{{configDir}}`), in the same shape:

```json
"pr": {
  "createCommand": "gh pr create --fill --base \"${{env:BASE_BRANCH}}\"",
  "statusCommand": "gh pr view \"${{env:BRANCH}}\" --json state,isDraft,url | jq '{state: (if .isDraft then \"draft\" else (.state | ascii_downcase) end), url}'"
}
```

- `createCommand` runs in the worktree with the workspace's environment, and the panel shows its output.
- `statusCommand` prints one JSON object, `{ "state": "open", "url": "…" }`, with `open`, `draft`, `merged` or `closed`, or nothing when the branch has no pull request. It may add `"title"`: New workspace then names the task after the pull request when you pick an [existing branch](new-workspace#from-an-existing-branch). With `gh`, add `title` to `--json` and to the `jq` object.

A project's `pr` fields override the profile's.

## Commit identity

The commit name and email in [Edit profile](edit-profile) are used for commits in that profile's terminals and Claude, and for the commits {{app}} makes. Leave them empty to use your git config.
