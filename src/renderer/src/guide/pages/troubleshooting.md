# Troubleshooting

Common problems and what to do about them: the app or Claude not found or not starting, the wrong account, missing notifications, slow workspaces and more.

{{mac}}## macOS won't open the app

That happens when the app was downloaded with a browser: {{app}} isn't notarized by Apple, and macOS checks that for browser downloads. Open **System Settings › Privacy & Security**, click **Open Anyway** next to the message about {{app}}, and confirm; macOS asks only once. The install script and builds from source don't need this.
{{/mac}}{{other}}## Linux: the app doesn't start, keys or badges

See [{{app}} on Linux](linux): FUSE for the AppImage, the sandbox on Ubuntu 23.10 and later (and the **Running without Chromium's sandbox** bar), keys an input method takes, Wayland, and the Changes count.
{{/other}}
## "claude not found" after installing

The installer changes your shell's startup files. Click **Check again** in the [setup check](setup-check); it reads your login shell again. If it still fails, open a new terminal and run `claude --version`.

## A warning in the status bar

- **git not found on PATH:** {{app}} needs git for worktrees. Install it, check that `git --version` works in a new terminal, then restart {{app}}.
- **Couldn't read your login shell's environment:** {{app}} starts your login shell once to read your PATH and other variables, and that shell failed or took longer than ten seconds. Hover the warning for the reason. Until it's fixed, terminals and Claude get {{app}}'s own environment, so commands from your startup files may be missing. Check that a new terminal opens without errors or prompts, then restart {{app}}.

## Signed in to the wrong account

The browser picked the account. Sign out on claude.ai, open the login link in a private window, and **Sign in** again. See [Which account signs in](create-profile#which-account-signs-in).

## The alias doesn't work

Open a new terminal, or run `source ~/.zshrc` (`source ~/.bashrc` in bash). See [The terminal shortcut](terminal-shortcut).

## No notifications

{{mac}}Allow them in System Settings › Notifications{{/mac}}{{other}}Check your desktop's notification settings{{/other}}, and check that **Do Not Disturb** is off in [Edit profile](edit-profile). None appear while you look at that Claude tab.

## Claude asks whether you trust the folder

Choose **Yes, I trust this folder**; the default answer is **No, exit**. Trust the repository once in its main checkout (**Start Claude here**), and its workspaces won't ask again.

## Usage shows n/a or Stale

Usage comes from Claude's status line, so it updates while Claude runs and answers. See [Plan usage](plan-usage).

## Workspaces marked Unfinished after a restart

{{app}} stopped Claude there while it worked, or stopped the commands it had left running. Open the workspace and choose **Continue** or **Dismiss** in the bar under the tabs. See [Work that was cut off](resume#work-that-was-cut-off).

## Couldn't check for updates

**Check for Updates…** says why, for example when GitHub can't be reached. The daily check stays quiet when it fails and tries again later. If an update can't replace {{app}}, the old version stays and the bar says why, with **Update in terminal**. See [Updates and privacy](updates#updating).

## Setup can't find a folder

Each setup line runs on its own. Write `cd app && npm install` on one line. See [Setup for new workspaces](workspace-setup#setup-and-teardown-commands).

## Push asks for credentials

{{app}} can't ask for a password. Set up git's credentials once in a Shell tab, then push again. See [Commit, Push, Create PR](finishing-work#commit-push-create-pr).

## A remote's host key or passphrase

{{app}} runs git without a terminal, so ssh can't ask anything: a host key you haven't accepted yet (the first connection to a new host, such as `ssh.bitbucket.org`, where Bitbucket moves Git over SSH) or a key that needs its passphrase fails at once. The reason says so, where you started the call and in `{{configDir}}/app.log` for the fetches {{app}} runs in the background. Run `git fetch` once in a terminal in the project's folder and accept the host key, or add the key to ssh-agent with `ssh-add`. A call to a remote gives up after 30 seconds (Push after 2 minutes), and quitting {{app}} stops every git it started.

## Creating a workspace takes long

{{app}} times each step of Create and of the task lookup in `app.log` in its settings folder, `{{configDir}}/app.log`. Each line names the step and its milliseconds, for example `git fetch origin main 1914 ms` or `lookup ABC-123 (work): claude -p 18450 ms`, and a Claude lookup adds how many turns Claude took. The lines end with `Claude's session started` and `total since Create`. A call to a remote that failed, in the background too, has a line of its own with git's reason, for example `git fetch --quiet --prune origin in ~/code/shop: timed out after 30 s`.

## Where are my worktrees?

In the project view's **Worktrees** line. See [Where worktrees go](worktrees).

## Editing config.json by hand

Profiles, projects and their settings are kept in `config.json`. Most of it has a field in the app; a few settings, such as the [PR commands](finishing-work#pr-commands), only live in the file. **File › Open Config File** opens it in your default editor. After saving, choose **File › Reload Config**: {{app}} doesn't read the file again by itself. If the file can't be used, a red bar at the top of the window says why, with **Open file** and **Reload**; until it's fixed, the app shows the last settings it could read and refuses to change them. Changes the app makes keep fields it doesn't know about.

## Coming from {{oldApp}}

{{app}} was called {{oldApp}} before. Installing {{app}} quits and removes {{oldApp}}, after asking, and replaces its `{{oldCli}}` command with `{{cli}}`; run the installer from Terminal, not from a terminal inside {{oldApp}}. Its first start copies {{oldApp}}'s settings folder (profiles, projects, workspaces, skill sources and the window's preferences) and says once where the old folder is: it stays as it was, as a backup, and you can delete it once everything works. If {{oldApp}} is still running, {{app}} asks you to quit it first and copies on its next start. macOS asks again whether {{app}} may send notifications, as it's a new app to macOS.

Workspaces made by {{oldApp}} stay where they are, in `~/{{oldHomeDir}}/worktrees` with their task file in `{{oldRepoDir}}/task.md`: git records a worktree's full path, so moving them would break them. Their Claude conversations, terminals and editors carry on. New workspaces go to `~/{{homeDir}}/worktrees`, with `{{repoDir}}/task.md`.

## Report a bug or request a feature

Something not listed here, or something missing? **Help › Report a Bug…** and **Help › Request a Feature…** open the form on GitHub in your browser; so do these links:

- [Report a Bug…](app:report-bug): the form comes filled in with {{app}}'s version, your operating system and its version, and the Claude Code version from the [setup check](setup-check).
- [Request a Feature…](app:request-feature)

Nothing is sent: you see the whole form in your browser, can change anything, and decide whether to submit it.
