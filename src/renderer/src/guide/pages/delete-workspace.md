# Deleting a workspace

The trash icon after the workspace's title, **Delete workspace…** in its **⋯** menu, or the sidebar's context menu removes its worktree and stops its terminals. A merged workspace and a failed setup also offer **Delete…**. The dialog says what goes and what stays, Cancel has the focus, and it warns you first when the workspace has:

- uncommitted changes, listed;
- commits that aren't pushed;
- a pull request that isn't merged yet;
- terminals still running.

With warnings the button reads **Delete anyway**, otherwise **Delete**. While there are uncommitted changes or unpushed commits, **Commit and push first** (**Commit first** without a remote) closes the dialog and opens the [Changes panel](finishing-work).

## Merged branches

If you merge the branch yourself, for example with `git merge --ff-only` in your main checkout, its commits are safe in the base branch, so the dialog doesn't warn that they aren't pushed. It says **✓ Merged into main** instead, or **✓ Merged into your local main (not pushed yet)** when only your local main has them. A branch counts as merged when it has commits of its own and they're all in the base branch, on your machine or on the remote: merged, fast-forwarded, or rebased onto it. Squash merges aren't recognised this way; a merged pull request covers them. A new workspace without commits is never merged, and neither is one whose branch only caught up with the base, for example when Claude rebased it onto a newer main before starting: those commits came from main, they aren't the branch's own. The other warnings, such as uncommitted changes, still show.

## The branch

The local branch is deleted with the workspace, unless it has unpushed commits (commits in a merged branch don't count): then it's kept unless you tick **Also delete the local branch**. The branch on the remote is never touched.

## Several repositories

A workspace across several repositories shows one card per repository, each with its warnings, or a ✓ when it's clean or merged, and its own **Also delete the local branch**. Every worktree goes. To remove just one repository, use **Unlink <repo>…** in the **⋯** menu instead; see [Tasks across repositories](tasks-across-repositories#linking-and-unlinking).

## Teardown

If the project has teardown commands, they run before the worktree goes, in each repository. If one fails, you're told afterwards, but the workspace is still deleted. See [Setup for new workspaces](workspace-setup#setup-and-teardown-commands).

The workspace's ports are released.
