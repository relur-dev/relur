# Status glyphs

Each workspace shows its state as a glyph in the sidebar, on its Claude tab and on its card on the Board. The states come from Claude Code itself, through hooks {{app}} adds when it starts Claude.

:::glyphs
:::

A collapsed project in the sidebar shows the most urgent glyph among its workspaces and the ones linked into it, so nothing waits unseen; click it to open that workspace (see [The sidebar](sidebar#a-collapsed-project-still-tells-you)).

A workspace that is starting shows the spinner while Claude launches, then no glyph until Claude reports something. Pressing <kbd>Esc</kbd> while Claude works interrupts it; that shows no glyph either.

**Unfinished** isn't a state of Claude's: it marks a workspace where {{app}} stopped Claude mid-task, or stopped the commands Claude had left running, until you continue, dismiss it or send a prompt (see [The Unfinished marker](resume#the-unfinished-marker)).

## Work in the background

Claude can start work that goes on after its turn ends: background agents, or commands it runs in the background. Commands you run yourself in the workspace's Shell tabs don't count.

- **Background agents:** while one runs, the workspace stays **Working**, since Claude continues once the agents hand back their results. The sidebar row shows how many tasks run, like **2 in background**, and so do its tooltip ("Working · 2 in background") and its card on the Board. You get the Done notification and sound only once Claude has finished and nothing is pending.
- **Commands Claude waits for**, such as a long test run: the same. The workspace stays **Working**, with **1 in background**, for as long as the command runs, however long that is ({{app}} watches its process), and when the command ends Claude carries on by itself; you get one Done notification, after Claude's last turn.
- **Dev servers:** a command that looks like one (`npm run dev`, vite, `next dev`, runserver, `python3 -m http.server` and the like, the same ones the [memory](memory) panel calls "dev server") is left running on purpose, so the workspace is **Done** at once, with a note: **1 running** in the sidebar row and "1 still running in the background" in its tooltip and the notification.
- **When Claude doesn't carry on:** if the command has ended and Claude hasn't carried on within 2 minutes, the workspace becomes **Done** and you get the notification then. If {{app}} can't find the command's process, it waits 10 minutes instead, and a command still running after 2 hours makes it **Done** too, with "1 still running in the background". If Claude was waiting for it after all, it carries on when the command ends: Working again, then Done.

Quitting Claude ends its background work too. Quitting {{app}} while Claude works, or while its commands still run, marks the workspace **Unfinished**; see [Work that was cut off](resume#work-that-was-cut-off).

Answering a permission question in the Claude tab moves the workspace on at once: to Working after **Yes**, and to Waiting for input after **No** or <kbd>Esc</kbd>, since Claude then waits for you to say what to do instead.

When Claude asks you to choose (its question menu, with options to pick from), Claude Code reports it like a permission request. {{app}} tells the two apart and shows **Asked a question** with the pink **?**, in the sidebar, on Home and on the Board, not Needs permission. Picking an answer in the Claude tab moves it on to Working the same way.

## Needs you

Needs permission, Waiting for input, Asked a question and Awaiting approval (your skills wait at a [workflow gate](workflows#when-the-skills-wait-for-you)) count as needing you: the profile tab shows a badge with their number, the status bar says how many (**1 needs you**, next to **2 working** while Claude works in others), Home lists them under **Needs you** with the oldest first (with [unfinished](resume#the-unfinished-marker) workspaces, which don't count toward the badges), and <kbd>{{key:nextNeedingYou}}</kbd> jumps to the next one.
