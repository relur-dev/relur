# Home

Each profile has a Home <kbd>{{key:home}}</kbd>: the first thing you see, and where you go back to between tasks. It has two tabs, like a workspace: **Overview** and **Terminal**. {{mac}}<kbd>⌃1</kbd> and <kbd>⌃2</kbd> switch between them, as do <kbd>{{keys:cycleTabs}}</kbd>.{{/mac}}{{other}}<kbd>{{keys:cycleTabs}}</kbd> switches between them.{{/other}}

## Overview

The Overview shows the profile's workspaces as a [Board](#board), the default, or a List. The List has four sections, and only those that need something from you. It changes as Claude works.

![Home's Overview: two workspaces need you (a Spec review gate with Review and Approve spec, and a permission request), one is working with 1.5 GB of memory, and two are ready to ship with Commit… and Push. At a glance and Quick actions are on the right.](images/home-overview.webp)

- **Needs you:** workspaces that need permission (**Open** takes you to the Claude tab), are waiting for input (**Open**), or wait at a [workflow gate](workflows#when-the-skills-wait-for-you), with **Review**, which opens the spec, and the gate's answer button, such as **Approve spec**. Workspaces Claude didn't [finish](resume#the-unfinished-marker) are here too, with **Continue** and **Dismiss**. The oldest is first, in the order <kbd>{{key:nextNeedingYou}}</kbd> jumps through them.
- **Working now:** where Claude is working, for how long, how much of its work runs in the background, and how much [memory](memory) its sessions use.
- **Ready to ship:** Done workspaces with something left to [finish](finishing-work). **Commit…** opens the workspace with the Changes panel and its commit message in focus; **Push** pushes the branch (in a workspace with [linked repositories](tasks-across-repositories) it opens the Changes panel, where you push each one); **View PR** opens the pull request in your browser.
- **Clean up:** workspaces whose pull request is merged, or whose branch is [already in the base branch](delete-workspace#merged-branches), also when you merged it only in your local checkout ("Merged into your local main (not pushed yet)"). **Delete** on a row opens [Delete workspace](delete-workspace); **Delete n merged workspaces** opens one dialog with all of them, each with what deleting it would lose, and deletes them together.

A workspace shows in one section only. While Claude [waits for work in the background](status-glyphs#work-in-the-background), such as a long test run, the workspace stays under **Working now** with **1 in background**, however long that takes. A done workspace whose dev server still runs stays where it is, with a quiet **1 running** after its status. Each section shows five rows at most; **Show all** shows the rest. A workspace whose Claude is [suspended](suspend) to save memory shows **Suspended** on its row.

Next to the sections, **At a glance** lists the profile's projects with how many workspaces each has (and how many other projects' workspaces it is linked into); click one to open it. **Quick actions** has **New workspace**, **Add project** and the Guide. In a narrow window both move below the sections.

When nothing needs you, nothing runs and nothing is waiting to ship, the Overview says **All clear** and shows the quick actions. A profile without projects offers **Add your first project**.

### Keyboard

Click a row, or press <kbd>↵</kbd> on it, to open its workspace. <kbd>↑</kbd> and <kbd>↓</kbd> move between the rows of all sections, and <kbd>Tab</kbd> reaches a row's buttons. Buttons that show only when the mouse is over a row, such as **Open** under Working now and **Delete** under Clean up, show while the row has the focus too.

## Board

The Board shows the profile's workspaces as five columns: **Working**, **Idle**, **Needs you**, **Ready to ship** and **Merged**, in that order until you arrange them (see **Columns**, below). While something needs you, the Needs you column is tinted and its count takes the color of its most urgent card, as in the sidebar. **List | Board** at the right of Home's tabs switches between the Board and the List, and the choice is remembered for each profile. A workspace is in the same place as in the List; **Idle** holds the rest: interrupted, suspended or exited, or done with nothing to ship. A workspace whose Claude waits for its background work stays in **Working**, with **1 in background**; a done one with a dev server still running keeps its column and shows a quiet **1 running**.

![Home's Board: Working holds one workspace with its memory, Idle an interrupted and a suspended workspace, Needs you, tinted, a Spec review gate with a quick reply field and a permission request with Open, Ready to ship two workspaces with a file not committed and a commit not pushed, and Merged two workspaces whose pull requests are merged, with Delete 2 merged.](images/home-board.webp)

Cards move between the columns by themselves as Claude works; you can't drag them from one column to another. Click a card to open its workspace. Hover over it, or give it the focus, for its main action (such as **Open**, **Approve spec** or **Push**) and **Delete**. **Delete n merged** at the top of Merged deletes all of them in one dialog. In a narrow window the Board scrolls sideways, and each column scrolls on its own.

### Columns

Each profile keeps its own columns, also after a restart:

- **Move a column** by dragging its header; a line shows where it will land. Or use the **⋯** at the right of its header (it shows when you point at the header, and <kbd>Tab</kbd> reaches it), or right-click the header: **Move Left**, **Move Right** and **Hide Column**.
- **Hide or show columns** with **Columns** at the right of Home's tabs, next to **List | Board**: it lists every column in its order with a checkbox, and **Reset to default** brings back the five columns in their first order. One column always stays shown.

Hiding a column only changes the Board: its workspaces are still in the List and the sidebar, and the counts and badges stay the same. If you hide **Needs you** and something needs you, **Columns** shows a small dot in the Needs you color, so nothing waiting goes unseen.

### Drag to delete

Drag a card and **Drop to delete** appears along the bottom. Drop it there to open [Delete workspace](delete-workspace) with everything deleting it would lose; nothing is deleted until you confirm. <kbd>Esc</kbd>, or dropping it anywhere else, cancels.

### Quick reply

A card has a field to send Claude a message without opening the workspace: under Needs you it is always there, elsewhere the card unfolds to show it, with its buttons, when the pointer rests on it or you give it the focus, and folds back when you leave unless you've typed into it. <kbd>↵</kbd> sends it, as if you had typed it in the Claude tab; a [suspended](suspend) Claude resumes first. While Claude works, it reads the message after its current step.

There is no field where a message could answer something by accident:

- **Needs permission:** Claude shows its permission menu, which typed text would answer. The card offers **Open** instead, so you answer it in the Claude tab.
- **An unsent prompt:** if you typed into the Claude tab and didn't send it, the card says **Has an unsent prompt; open it**.
- **Merged** workspaces, and workspaces whose Claude has exited.

### Keyboard on the Board

<kbd>↑</kbd> and <kbd>↓</kbd> move within a column, <kbd>←</kbd> and <kbd>→</kbd> to the next column, in the order the Board shows them. <kbd>↵</kbd> opens the workspace, <kbd>Tab</kbd> reaches the card's field and buttons, and <kbd>Delete</kbd> or <kbd>{{mac}}⌫{{/mac}}{{other}}Backspace{{/other}}</kbd> opens Delete workspace. <kbd>Tab</kbd> from the Board reaches a column's **⋯** first; <kbd>↵</kbd> opens its menu.

## Terminal

The Terminal tab is the profile's Home terminal: a shell in your home folder that uses the profile's account, for anything that isn't a task. **Start Claude here** <kbd>{{key:startClaude}}</kbd> on Home switches to it and types `claude` there; see [Start Claude here](start-claude-here). If the shell exits, **Start again** starts a new one.
