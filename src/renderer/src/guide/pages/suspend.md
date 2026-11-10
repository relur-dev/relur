# Suspending idle sessions

Every Claude session holds memory: Claude Code itself, its MCP servers and the shells of its tools. With many workspaces open, most of them just wait. {{app}} can stop Claude in a workspace you haven't looked at for a while and start it again, with the same conversation, as soon as you open it.

## The setting

It's on for every profile: Claude is suspended after **10 minutes**. In [Edit profile](edit-profile) › General, **Suspend idle sessions** changes that to **5** or **30 minutes**, or turns it **Off**. It applies to the profile's workspaces and to Claude started with [Start Claude here](start-claude-here).

Before version 0.4.2 it was off unless you turned it on. Profiles that never changed the setting get 10 minutes after the update, and {{app}} says so once, in a bar at the top of the window: **Settings** opens Edit profile for the profile you're looking at, **OK** closes the bar. A profile where you chose a time, or Off, keeps it.

## When Claude is suspended

Claude is suspended once all of this has held for the whole time you chose. If one of them stops holding, the time starts again.

- **You aren't looking at it:** no window shows the workspace, in any of its tabs. A minimized or hidden window doesn't count.
- **Claude is waiting:** Done, Waiting for input, Awaiting approval, interrupted with <kbd>Esc</kbd>, or resumed and waiting at its prompt. Never while it's Working, asks for permission or has asked a question.
- **Nothing runs in the background:** no background command or agent of Claude's (the sidebar's **1 running** or **2 in background**). A dev server Claude started keeps the workspace running.
- **You haven't started typing:** text typed into Claude's prompt and not yet sent keeps it running until you send it with <kbd>↵</kbd>, a prompt or a command such as `/model`. Arrow keys, <kbd>Esc</kbd> and the like don't count, nor does moving or clicking the mouse over the terminal. Text you typed and deleted again still counts until then.
- **There is a conversation to resume:** Claude saves its conversation when you send the first prompt. A Claude you haven't sent anything yet keeps running, as there would be nothing to resume.
- **It isn't kept running:** see below.

Suspending stops Claude and everything it started, as quitting does. The workspace keeps its state, so a Done workspace is still Done.

## Opening it again

Opening a suspended workspace, from the sidebar, Home or a notification, resumes Claude at once, with its conversation. The terminal shows **Resuming…** until Claude is ready, which takes a second or two.

Keys you type while it resumes aren't sent: the terminal says **Keys you type now aren't sent**. Type again once Claude is ready. Holding them back would be riskier: a starting Claude can ask its own questions, where a held <kbd>↵</kbd> would answer without you seeing them.

Buttons that type into Claude, such as **Continue**, a gate's answer or a [quick reply](home#quick-reply) on Home's Board, resume it first and type once it's ready.

## What a resume keeps and what it doesn't

| | After a resume |
| --- | --- |
| The conversation | Kept, printed again in the terminal |
| Permission mode you switched with <kbd>{{mac}}⇧⇥{{/mac}}{{other}}Shift+Tab{{/other}}</kbd> | Given back. A switch made since Claude's last action isn't known yet and is lost |
| Model you switched with `/model` | Given back |
| MCP servers | Started again. Anything a server held only in memory, such as a browser it was driving, is gone |
| Background commands and agents | Never affected: Claude isn't suspended while any runs |
| Claude's own shell | Starts in the workspace folder again; a `cd` or exported variables from earlier are gone |
| Approvals you gave "for this session" | Asked for again |
| A prompt you were typing | Never lost: Claude isn't suspended while you have unsent text |

The permission mode and model are given back only to a suspended session. After quitting {{app}}, Claude starts as described in [Quitting and resuming](resume).

## Keeping a workspace running

Right-click a workspace in the sidebar and choose **Keep Claude Running**. Its Claude is then never suspended, whatever the setting says. Choose it again to remove the checkmark. For a workspace whose MCP servers hold something you don't want to lose, this is the way.

For Claude started with **Start Claude here**, right-click its tab in the project view. That choice is remembered for the project.

## Where it shows

- **Sidebar:** the workspace keeps its status glyph and shows **Suspended**. Hover it: "Suspended to save memory; resumes when you open it".
- **Board:** **Suspended** on the workspace's card, on Home and in the project view.
- **Start Claude here** tabs: **Suspended** after the name.
- **Memory:** a suspended session uses none and isn't counted. The panel that opens from the status bar's **Memory** lists the suspended sessions by name, in every profile (with the profile's name when it isn't the one shown), and the project view says how many. See [Memory](memory).

![The card of ABC-133 on api-service's Board: Done (unread), then Suspended.](images/suspended-workspace.webp)

## Why one isn't suspended

Point at the **ⓘ** on a workspace's card on the Board, on Home or in the project view, or click it. While its Claude runs, its details say why it isn't suspended, for example "Not suspended: a draft in the prompt", or when it will be: "Suspended in 3 min if it stays idle". The reasons are the conditions above: shown in a window, Claude isn't idle, background work running, a draft in the prompt, no conversation yet, Keep Claude Running is on.

{{app}}'s log, `app.log` in its settings folder, has a line each time a session's clock starts, starts again (with the reason), and when it is suspended or resumed.

## When {{app}} starts

With the setting on, {{app}} doesn't start Claude in every workspace where it was running. It starts only the workspace you're looking at and those whose interrupted work it [continues](resume#continuing-it); the others start suspended and resume when you open them. With the setting Off, every one starts.
