# The command line tool

`{{cli}}` adds projects from a terminal, as Add project does: handy when you're already in a repository's folder, or to add many at once from a script. The app does the work, so the sidebar updates at once.

## Install

Every terminal inside {{app}} already has `{{cli}}`. For other terminals, the install script sets it up, or choose **Install Command Line Tool…** in the {{app}} menu (the **File** menu on Linux). After you confirm, it writes a small launcher to `~/.local/bin/{{cli}}`, never with sudo. If `~/.local/bin` isn't on your PATH, it shows the line to add to your shell's startup file. A launcher installed earlier, for example by a build run from source, is replaced; the confirmation says which. {{oldApp}}'s launcher, `~/.local/bin/{{oldCli}}`, is removed too; nothing else in `~/.local/bin` is touched.

## Examples

Add the current folder to Personal:

```
{{cli}} add . --profile personal
```

Add every repository in `~/Projects` to Work, one level down, with the same rules as the dialog:

```
{{cli}} add ~/Projects --all --profile work
```

Make a new repository and add it, as **New repository** in the dialog does (`--no-readme` and `--no-gitignore` leave those files out of the first commit):

```
{{cli}} add --new ~/code/my-app --profile work
```

Clone a repository into `./app` and add it:

```
{{cli}} add --clone git@example.com:team/app.git --profile work
```

The clone runs right in the terminal you typed it in, with that terminal's own environment, so passphrases and sign-in prompts appear there. A path after the URL clones somewhere else. If git fails, nothing is added.

Without `--all`, a folder that isn't a repository is refused with a hint to use it. `--name` and `--base` set the project's name and base branch for a single repository. `{{cli}} add --help` shows every option.

## Linking a repository to a workspace

In a workspace's terminals, and in its Claude, `{{cli}} link <project>` links another repository to that workspace (by the project's name, id or repository path), and `{{cli}} projects` lists the profile's projects. See [Tasks across repositories](tasks-across-repositories).

## Merging the pull requests

In a workspace's terminals, and in its Claude, `{{cli}} merge` merges every repository's pull request on its host, one after another, as [Merge all PRs](tasks-across-repositories#merging-every-pull-request) does. It waits for you to press Merge in {{app}}'s dialog, which opens by itself (at most 10 minutes); `--yes` only skips the terminal's question. `--order`, `--method` and `--keep-branch` change the rest.

## Which profile

- In a terminal of {{app}}, the profile is that terminal's own, and adding to another profile is refused.
- In other terminals, `--profile <id>` is required, with the profile's id: its name as it was when you created it, in lower case with dashes for spaces, like `my-work` for My Work.

## When it doesn't work

{{app}} has to be running: the tool talks to it and never edits the settings itself. Exit codes: `0` added (or linked), `1` refused (with the reason) or the clone failed, `2` the app isn't running.
