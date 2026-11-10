# Workflows

Many teams run a task through steps with their own [skills](skills): a workflow skill takes the task from step to step and stops where a person has to decide, and the step skills keep the task's status in a file in the worktree. {{app}} reads that status, shows it, tells you when the skills wait for you, and continues when you say so. It never decides the next step itself.

## The status file

The status lives in the front matter of a Markdown file in the workspace's worktree: the block between two `---` lines at the top. It's read as leniently as Claude Code reads it: a value with a `: ` in it, like `title: Login: remember me`, is fine without quotes.

```markdown
---
branch: feat-login-timeout
status: spec-review
---
# Fix the login timeout
```

{{app}} reads the file again whenever it changes, whoever changes it: a skill, you in an editor, or a shell.

## Set up from my skills

The quickest way to a workflow: let this profile's Claude read your skills. At the top of **Edit profile › Workflow** (or a project's **Workflow** tab), **Set up from my skills** is open while the profile has no workflow; once it has one, click **Set up from my skills…** to open it. It asks for:

- **Skill source:** the one with your workflow skill.
- **A task in progress:** a workspace whose worktree already has a status file. Only those are offered; if there's none, start one task with your skills first, until the file exists.
- **Model:** optional, like `haiku` for a quicker answer; empty uses the profile's default.

**Propose a workflow** runs Claude in the background. It reads the skill source and that worktree and nothing else: it can't change files, run commands, reach the web or use your connectors (it only looks up which of them could read an issue, for a task lookup). It takes a minute or two; **Stop** ends it.

The proposal fills in the form below, and the preview switches to that task. Nothing is saved until you save. The note above the form lists what saving would change, and under **Couldn't determine** what Claude couldn't work out from the files, such as which status is final, or a pattern that matches every task's file; fill those in yourself. If it found a task lookup, **Also set up the task lookup** saves it with the workflow: ticked when the profile has no task lookup yet, unticked when it would replace yours. In a project's Workflow tab it only names the tool, since the task lookup belongs to the profile.

## Setting it up

In **Edit profile › Workflow**, tick **Read a workflow status in this profile's workspaces** and fill in the status file, the statuses and the prompts, then **Save workflow**. The fields you rarely change wait under **Advanced**, which says what they are set to while it's closed: which file is the workspace's, the status, id and title fields, and the document label.

| Field | What it means |
| --- | --- |
| Status file | Where the file is, relative to the worktree. `*` matches one folder name, as in `docs/specs/*/specification.md` |
| The workspace's file has the field … equal to the workspace's … (Advanced) | Which of the matching files belongs to the workspace: the one whose field (say `branch`) equals its branch, or its task id |
| Document label (Advanced) | Optional. The name of the workspace tab that shows the status file; without one it's the file's name |
| Status field (Advanced) | The field holding the status, usually `status` |
| Task id field, Title field (Advanced) | Optional. Used when you [adopt a worktree](adopting-worktrees) a skill created. Without a title field, the file's first `#` heading is the title |
| Statuses, in order | Every status in order (**+ Add status**, and arrows to move one), with the value in the file, the label {{app}} shows, and its kind. Under each, an optional **hint**, shown next to the stepper at that status, and for a gate an optional **answer button**: its label and the text it types into Claude |
| Continue prompt | What **Continue** types into Claude at a step |

Each status has a kind:

- **Step:** the skills are working on it.
- **Gate · waits for you:** the skills stop here and wait for your decision, for example to approve a spec, confirm the end-to-end tests are done, or give the go for the pull request.
- **Final:** the task is through the workflow.

Prompts can use `{id}`, `{title}`, `{branch}` and `{status}` (the status value in the file).

## The preview

Under the fields, **Preview** reads one workspace's worktree with the settings as you type them, before you save. It lists the files that match the pattern, marks the one it chose, shows its front matter, and says what status it found. If it found none, it says why: no file for this branch yet, several files for the same branch, or a file without front matter. A status that isn't in your list gets **Add to list**.

The **title field** names the task. A workspace you created with a key alone, without a title, takes its title from it once the skill writes one; so does an [adopted](adopting-worktrees) worktree whose title was only guessed from its branch. That happens once: later edits to the field don't rename the workspace.

## In the workspace

- The header shows the statuses as a stepper, every one by name and in order: finished ones greyed with ✓, upcoming ones greyed, the current one highlighted. Gates have a small diamond ◆ next to their name, so you can see where Claude will stop. When the names don't fit the window, the others shrink to ✓ or their number while the current one keeps its name; hover one to see its name.
- The sidebar row shows the status's label, and so do the details behind the **ⓘ** on the workspace's card on the Board.
- Next to the stepper: the status's hint, if it has one, like "Review and approve the spec".
- At a step, **Continue** <kbd>{{key:continueWorkflow}}</kbd> types the Continue prompt into Claude and presses Enter. It shows only while Claude is idle.
- At a gate there's no Continue: the skill waits for your own decision. **Review** opens the status file, and the gate's answer button, like **Approve spec**, types its text into Claude, like "I approve the spec." Without an answer button, answer in Claude's tab: <kbd>{{key:continueWorkflow}}</kbd> at a gate takes you there, with the terminal in focus.

![A workspace's header at a gate: the stepper from Draft to Done with Spec review highlighted, the gate's hint, and Review and Approve spec on the right.](images/workflow-gate.webp)

## The status file in the workspace

A workspace with a status file gets a tab for it after its terminals, named with the **Document label**. It shows the file as formatted text, read-only, and follows it as the skill writes it.

- The line above it shows the status, the task id, and every field holding a web address as a link that opens in your browser.
- Images with a path relative to the file, like `![flow](flow.png)`, are shown from the worktree. Nothing is loaded from the internet: other images show as their description.
- Scripts and other active content in the file are removed; links open in your browser.
- **Open in editor** opens the file in your default app for Markdown; **{{reveal}}** shows it in its folder.

In a [linked workspace](tasks-across-repositories) it shows the file in the primary repository.

## When the skills wait for you

When the status is a gate and Claude isn't working, the workspace shows **Awaiting approval**, the purple diamond, with the gate's label. It counts as needing you: the profile tab and the app's badge count it, Home lists it under **Needs you**, and <kbd>{{key:nextNeedingYou}}</kbd> jumps to it.

You also get one notification, "ABC-123 waits for you: Review and approve the spec": the gate's hint, or its label without one. When Claude stops at a gate, that is the only notification: no separate "is done".

It ends when the status moves on, or when Claude starts working again, for example after you answer.

## Per project

A project's **Workflow** tab chooses **Use <profile>'s workflow**, **Override for this project** (its own settings, starting from the profile's) or **None**. It's kept in {{app}}'s settings, not in the repository.

## Task lookup

With a task lookup, New workspace finds a task's title from its id: type `ABC-123` alone and the title fills in (see [New workspace](new-workspace#looking-up-the-title)). Set it up in **Edit profile › Task lookup**, and save it there with **Save task lookup**. It belongs to the profile, so it works in every project of the profile, with or without a workflow. Choose **None**, or:

- **Ask Claude** runs a prompt with this profile's Claude in the background, with the profile's account, settings, skills and model. To use a faster one for the lookup, type it under **Model**, like `haiku`; left empty, it's the profile's default. `{id}` is the task id. Claude gets no tools except the ones under **Tools it may use**: list your tracker connector's tool that reads a ticket, like `mcp__tracker__get_issue`, or `mcp__tracker` for the whole connector. Claude Code loads connector tools on demand through its ToolSearch tool, which the lookup keeps: it only finds tools. Tools that read or change files, run commands, reach the web or start other agents (Bash, Read, Edit, WebFetch, Skill and the like) are denied unless you list them; anything else Claude tries is refused without asking. The lookup reads tickets other people write, so list read tools only; the settings warn about a name that looks like it changes things.
- **Run a command** runs a command with the profile's environment that prints the title, like a tracker's command line tool: `tracker issue view {id} --field title`.

**Timeout** is how long it may take: 60 seconds to begin with for Ask Claude, 20 for a command. Type an id next to **Test** to try it. If Claude wasn't allowed a tool it needed, the result names it, with **Allow this tool** to add it to the list (**Allow anyway** when the tool looks like it changes things). If it found no title for another reason, its own explanation shows under the error. For **Bash** that would allow every command: edit the entry down to the one command the lookup runs, like `Bash(tracker issue view:*)`. The first line of the output is the title; a lookup that takes longer than its timeout, fails or prints nothing leaves the title for you to type.

## Sharing a workflow

Once your workflow works, share it so others don't type it in again. **Export…**, on the Workflow tab of Edit profile or of a project, saves the form as it is to a file, `{{workflowFile}}` unless you name it otherwise. It's available once every field is filled in. The file holds the workflow only: the statuses with their hints and answer buttons, the prompts and the fields. Nothing of your profile goes in it, not your task lookup, account or environment.

**Import…** reads such a file into the form. Nothing is saved yet: a note above the form says where it came from and lists what saving would change compared with your saved workflow. Review it, then **Save workflow**, or close the dialog to keep yours. In a project's Workflow tab, Import… switches it to **Override for this project**.

The easiest way to hand it to the team is in your skills: put `{{workflowFile}}` at the root of the skill source, next to the skills. Whoever adds the source is offered the workflow. See [Skills](skills#skill-sources).

## The Start prompt

**Edit profile › Workflow** has an optional **Start prompt**, next to the Continue prompt: Claude's first message when it first starts in a workspace you create with New workspace, for example `/team-skills:plan-task {id} {title}`. A project that works differently sets its own in its Workflow tab, which then replaces the profile's.

It's sent only for a task with an id, like `ABC-123 Fix the login`: a workspace without one starts Claude plainly, with no first message. It's sent once. Resuming, restarting Claude and adopted worktrees never send it.

Claude is also told, at every start, that its folder is the task's worktree and which branch it's on, so a workflow skill works there instead of creating another worktree.
