# Deleting a workspace

The trash icon after the workspace's title, **Delete workspace…** in its **⋯** menu, or the sidebar's context menu removes its worktree and stops its terminals. A merged workspace and a failed setup also offer **Delete…**. The dialog says what goes and what stays, Cancel has the focus, and it warns you first when the workspace has:

- uncommitted changes, listed;
- commits that aren't pushed;
- changes or commits inside a submodule, named per submodule;
- a pull request that isn't merged yet;
- terminals still running.

With warnings the button reads **Delete anyway**, otherwise **Delete**. While there are uncommitted changes or unpushed commits, **Commit and push first** (**Commit first** without a remote) closes the dialog and opens the [Changes panel](finishing-work).

## Submodules

A submodule checked out in the worktree keeps its own history inside the worktree, so deleting the worktree loses whatever only that submodule has: changes you haven't committed there, and commits that aren't on its remote. Each such submodule gets its own warning, for example **Submodule lib: 1 commit not pushed**, and the button reads **Delete anyway**. To keep that work, commit and push it from inside the submodule (`cd lib && git push`) first.

When the worktree and its submodules are clean, **Delete** removes it as git requires for submodules. If anything can't be removed, nothing is deleted: the dialog says why and what to do, the workspace stays as it was, and **Delete anyway** removes it regardless. **Unlink** and **Remove project** check and remove a worktree with submodules the same way.

{{app}} doesn't check submodules out when it creates a workspace; your setup commands can. See [Setup for new workspaces](workspace-setup#setup-and-teardown-commands).

## Merged branches

If you merge the branch yourself, for example with `git merge --ff-only` in your main checkout, its commits are safe in the base branch, so the dialog doesn't warn that they aren't pushed. It says **✓ Merged into main** instead, or **✓ Merged into your local main (not pushed yet)** when only your local main has them. A branch counts as merged when it has commits of its own and they're all in the base branch, on your machine or on the remote: merged, fast-forwarded, or rebased onto it. Squash merges aren't recognised this way; a merged pull request covers them. A new workspace without commits is never merged, and neither is one whose branch only caught up with the base, for example when Claude rebased it onto a newer main before starting: those commits came from main, they aren't the branch's own. The other warnings, such as uncommitted changes, still show.

## The branch

The local branch is deleted with the workspace, unless it has unpushed commits (commits in a merged branch don't count): then it's kept unless you tick **Also delete the local branch**. The branch on the remote is never touched.

For a workspace made from [an existing branch](new-workspace#from-an-existing-branch), the dialog says the branch on the remote stays. When that branch has commits by someone else, such as a colleague's pull request, an amber block names them and shows **Also delete the local branch**, ticked: your local copy goes, their branch and pull request stay. A local branch that was there before the workspace is kept unless you tick the box.

## Several repositories

A workspace across several repositories shows one card per repository, each with its warnings, or a ✓ when it's clean or merged, and its own **Also delete the local branch**. Every worktree goes. To remove just one repository, use **Unlink <repo>…** in the **⋯** menu instead; see [Tasks across repositories](tasks-across-repositories#linking-and-unlinking).

## Teardown

If the project has teardown commands, they run before the worktree goes, in each repository. If one fails, you're told afterwards, but the workspace is still deleted. See [Setup for new workspaces](workspace-setup#setup-and-teardown-commands).

The workspace's ports are released.
