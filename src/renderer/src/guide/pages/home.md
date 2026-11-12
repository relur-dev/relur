# Home

Each profile has a Home <kbd>{{key:home}}</kbd>: where a new profile opens, and where you go back to between tasks. It has two tabs, like a workspace: **Overview** and **Terminal**. {{mac}}<kbd>⌃1</kbd> and <kbd>⌃2</kbd> switch between them, as do <kbd>{{keys:cycleTabs}}</kbd>.{{/mac}}{{other}}<kbd>{{keys:cycleTabs}}</kbd> switches between them.{{/other}}

## Overview

The Overview shows the profile's workspaces on a Board: five columns, **Working**, **Idle**, **Needs you**, **Ready to ship** and **Merged**, in that order until you arrange them (see [Columns](#columns)). It changes as Claude works. Each [project's view](add-project#the-project-view) shows its own workspaces on the same Board.

At the top, always, are **New workspace** <kbd>{{key:newWorkspace}}</kbd> and **Add project** <kbd>{{key:addProject}}</kbd>.

![Home's Board: New workspace and Add project at the top. Working holds one workspace with its memory and the notes mark for its 3 unsent notes, Idle an interrupted and a suspended workspace, Needs you, tinted, a Spec review gate with what Claude said there above its quick reply field, and a permission request with Open, Ready to ship two workspaces with a file not committed and a commit not pushed, and Merged two workspaces whose pull requests are merged, with Delete 2 merged. Each card has a small ⓘ at its top right. Columns and Group None are at the top right.](images/home-board.webp)

- **Needs you:** workspaces that need permission (**Open** takes you to the Claude tab), are waiting for input, have asked a question (**Asked a question**, with its options as buttons), or wait at a [workflow gate](workflows#when-the-skills-wait-for-you), with **Review**, which opens the spec, and the gate's answer button, such as **Approve spec**. Workspaces Claude didn't [finish](resume#the-unfinished-marker) are here too, with **Continue** and **Dismiss**. The oldest is first, in the order <kbd>{{key:nextNeedingYou}}</kbd> jumps through them. While something needs you, the column is tinted and its count takes the color of its most urgent card, as in the sidebar.
- **Working:** where Claude is working, for how long, how much of its work runs in the background, and how much [memory](memory) its sessions use.
- **Idle:** everything else: interrupted, suspended or exited, or done with nothing left to ship or merge.
- **Ready to ship:** Done workspaces with something left to [finish](finishing-work). **Commit…** opens the workspace with the Changes panel and its commit message in focus; **Push** pushes the branch (in a workspace with [linked repositories](tasks-across-repositories) it opens the Changes panel, where you push each one); **Create PR** opens the pull request once the branch is pushed, when you use [PR commands](finishing-work#pr-commands) (across several repositories, **Create PRs…** opens the Changes panel, where **Create n PRs** opens one in each); **View PR** opens the pull request in your browser, and with several pull requests, **View PRs** lists them by repository. Once everything is committed, **Merge into main** [merges the branch into your local main](finishing-work#merge-into-your-local-base), beside the other action or on its own as "Ready to merge into main". While Claude rebases for it, the workspace is under Working with **Rebasing for merge…** and **Cancel**.
- **Merged:** workspaces whose pull request is merged, or whose branch is [already in the base branch](delete-workspace#merged-branches), also when you merged it only in your local checkout ("Merged into your local main (not pushed yet)"). **Delete n merged** at the top of the column opens one dialog with all of them, each with what deleting it would lose, and deletes them together.

A workspace is in one column only. While Claude [waits for work in the background](status-glyphs#work-in-the-background), such as a long test run, the workspace stays in **Working** with **1 in background**, however long that takes. A done workspace whose dev server still runs keeps its column, with a quiet **1 running** after its status. A workspace whose Claude is [suspended](suspend) to save memory shows **Suspended** on its card, and one with unsent [notes](notes) a small notes mark.

## Cards

A card shows the workspace's status, task and title, and its project at the top right, next to a small **ⓘ**. Click it to open the workspace. Hover over it, or give it the focus, for its buttons (such as **Open**, **Approve spec** or **Push**) and **Delete**, and for **⋯** after the ⓘ, its menu (also a right-click on the card): **Flag…** and **Delete workspace…**. Cards move between the columns by themselves as Claude works; you can't drag them from one column to another. A card shows only in the column it belongs in: when you switch profiles or start the app, the Board waits a moment until it knows where each card goes, rather than showing it somewhere else first.

The **ⓘ** has what the card doesn't show: a [flag](#flag-a-workspace)'s whole note, its branch, the whole message Claude is waiting with, its [workflow](workflows) status, its [memory](memory), how long ago it was last active, and whether its Claude will be [suspended](suspend#why-one-isn-t-suspended) ("Not suspended: a draft in the prompt", "Suspended in 3 min if it stays idle"). Rest the pointer on it to see them; click it to keep them open until you click elsewhere or press <kbd>Esc</kbd>. Clicking the **ⓘ** doesn't open the workspace.

In a narrow window the Board scrolls sideways, and each column scrolls on its own (grouped by project, the whole Board scrolls instead, as below).

## When there's nothing to show

A profile with projects but no workspaces shows **New workspace** in the Board's place, and a profile without projects **Add your first project**.

## Columns

Each profile keeps its own columns, also after a restart:

- **Move a column** by dragging its header; a line shows where it will land. Or use the **⋯** at the right of its header (it shows when you point at the header, and <kbd>Tab</kbd> reaches it), or right-click the header: **Move Left**, **Move Right** and **Hide Column**.
- **Hide or show columns** with **Columns** at the right of Home's tabs (or of a project's tabs): it lists every column in its order with a checkbox, and **Reset to default** brings back the five columns in their first order. One column always stays shown.

Your columns are the same on Home and in every project's view: a column you move or hide in one moves or hides in all. Hiding a column only changes the Board: its workspaces are still in the sidebar, and the counts and badges stay the same. If you hide **Needs you** and something needs you, **Columns** shows a small dot in the Needs you color, so nothing waiting goes unseen.

## Group by project

**Group** at the right of Home's tabs, next to **Columns**, groups Home's Board by project: choose **Project** in its menu, and **None** to go back. The columns' headers stay at the top, and under them each project with workspaces of its own gets a band, with its cards in the same columns as before. A band's header names the project, how many workspaces it has and how many of other projects' workspaces are [linked into it](tasks-across-repositories), and its **+** starts a [new workspace](new-workspace) in that project; a linked workspace shows once, in its own project's band, with **+1** for the repository it also uses.

Click a band's header to collapse it to one count per column, and click again, or click the counts, to expand it. **Expand all** and **Collapse all** are in the Group menu. While something in a band needs you, its Needs you cell is tinted, and a collapsed band shows its Needs you count in color. Grouping and the collapsed bands are remembered for each profile, and your columns' order and hidden columns apply to every band.

Grouped, the whole Board scrolls, and the column headers and the projects' names stay in view. <kbd>↑</kbd> and <kbd>↓</kbd> move down a column through the bands, <kbd>←</kbd> and <kbd>→</kbd> stay within a band, and <kbd>Tab</kbd> reaches each band's header, where <kbd>↵</kbd> collapses or expands it, then its **+**.

## Flag a workspace

Flag a workspace to come back to it later, for example to continue tomorrow. **Flag…** is in its card's **⋯** menu (or right-click the card), in its [sidebar row](sidebar)'s menu, in the [workspace view](workspace-view)'s header and its **⋯**, and <kbd>{{key:flag}}</kbd> flags the workspace you're in or the card in focus. You can add a line on what to continue ("Check the Safari case, then write the e2e"); it's optional, and **Edit Flag Note…** in the same menus changes it later.

A flagged card shows a small flag in blue after its task id, and the line under its title, two lines at most; the **ⓘ** has the whole line. The card stays in the column its state puts it in, at the top of **Idle**, **Ready to ship** and **Merged**; **Needs you** and **Working** keep their own order. Its sidebar row shows the flag too, with the line in its tooltip.

**Flagged** at the right of the tabs, next to **Columns**, shows only flagged workspaces, on Home and in every project's view; click it again for all of them. It is off whenever {{app}} starts, so no workspace stays hidden behind it, and it turns itself off when nothing is flagged any more.

The flag stays, across restarts and [suspension](suspend), until you clear it: click the flag on the card, choose **Unflag** in a menu, or press <kbd>{{key:flag}}</kbd> again. **Unflagged · Undo** shows for 5 seconds; **Undo** puts the flag back with its line.

## Drag to delete

Drag a card and **Drop to delete** appears along the bottom. Drop it there to open [Delete workspace](delete-workspace) with everything deleting it would lose; nothing is deleted until you confirm. <kbd>Esc</kbd>, or dropping it anywhere else, cancels, and so does a dialog that opens while you drag.

## Quick reply

A card has a field to send Claude a message without opening the workspace: under Needs you it is always there, elsewhere the card unfolds to show it, with its buttons, when the pointer rests on it or you give it the focus, and folds back when you leave unless you've typed into it. <kbd>↵</kbd> sends it, as if you had typed it in the Claude tab; a [suspended](suspend) Claude resumes first. While Claude works, it reads the message after its current step.

Above the field, a line shows what you're replying to: the question Claude asked (**Claude asked:**), what it said at a workflow gate (**At Spec review, Claude:**, or just the gate's hint, like "Review and approve the spec", when Claude wrote nothing: the status above already names the gate), or the end of its last message (**Claude:**). Click the line to open the workspace with its [Responses](copy-response) panel at that answer, for the full text. A session that hasn't written anything yet shows no line.

When Claude asks you to choose (its question menu, with options to pick from), the card shows the question with each option as a button: click one to answer, as if you had picked it in the Claude tab. **Other…** opens the workspace to type your own answer. If Claude asked several questions at once, or lets you tick several options, the card offers **Open** instead.

There is no field where a message could answer something by accident:

- **Needs permission:** Claude shows its permission menu, which typed text would answer. The card offers **Open** instead, so you answer it in the Claude tab.
- **A question from Claude:** typed text would become your answer, so the card shows the options instead, as above.
- **An unsent prompt:** if you typed into the Claude tab and didn't send it, the card says **Has an unsent prompt; open it**. It goes away as soon as Claude's prompt is empty again.
- **Merged** workspaces, and workspaces whose Claude has exited.

## Keyboard on the Board

<kbd>↑</kbd> and <kbd>↓</kbd> move within a column, <kbd>←</kbd> and <kbd>→</kbd> to the next column, in the order the Board shows them. <kbd>↵</kbd> opens the workspace, <kbd>Tab</kbd> reaches the card's **ⓘ** (<kbd>↵</kbd> or <kbd>Space</kbd> shows its details, <kbd>Esc</kbd> closes them), then its **⋯**, field and buttons, <kbd>{{key:flag}}</kbd> flags or unflags it, and <kbd>Delete</kbd> or <kbd>{{mac}}⌫{{/mac}}{{other}}Backspace{{/other}}</kbd> opens Delete workspace. <kbd>Tab</kbd> from the Board reaches a column's **⋯** first; <kbd>↵</kbd> opens its menu.

## Terminal

The Terminal tab is the profile's Home terminal: a shell in your home folder that uses the profile's account, for anything that isn't a task. **Start Claude here** <kbd>{{key:startClaude}}</kbd> on Home switches to it and types `claude` there; see [Start Claude here](start-claude-here). If the shell exits, **Start again** starts a new one.
