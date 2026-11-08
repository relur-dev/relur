# Quitting and resuming

What happens to Claude and your terminals when you quit {{app}} or close its window, and how work that was cut off carries on.

## Quitting

Quitting while something runs asks first: **Stop n running sessions?** lists each one with its profile, task and state. Claude counts while it runs; a shell counts only while a command runs in it, not while it waits at its prompt, and so does a setup command. **Quit** has the focus, so <kbd>{{key:quit}}</kbd> again confirms; **Cancel** or <kbd>Esc</kbd> keeps everything running. With nothing running, {{app}} quits without asking.

<kbd>{{key:quit}}</kbd>{{mac}}, **Quit** in the {{app}} menu and **Quit** in the Dock's menu{{/mac}}{{other}} and **File › Quit**{{/other}} quit completely: every session stops and nothing of {{app}} keeps running in the background. Logging out or shutting down quits the same way, without asking. Panel sizes, which projects are expanded and the rest of what the window remembers are saved as you change them, so they last even when logging out ends {{app}} abruptly.

## Closing the window

{{mac}}On macOS, closing the window with <kbd>{{key:closeWindow}}</kbd> or its close button doesn't stop anything: {{app}} keeps running, so Claude finishes its work and notifications keep coming. Click {{app}} in the Dock to bring the window back. The first time you close it, {{app}} says so once, in **{{app}} keeps running**: **Close Window** closes it, **Cancel** keeps it open. The message never shows again.

To quit whenever the window closes, choose **Quit When the Window Closes** in the {{app}} menu (off at first). Closing the window then quits as <kbd>{{key:quit}}</kbd> does, asking first while something runs.{{/mac}}{{other}}On Linux, closing the window quits, asking first while something runs; **Cancel** keeps the window open.{{/other}}

## Starting again

The window opens where you left it: the same profile, or the Guide if it was open, and in it what you were looking at. That's Home on its Overview or Terminal tab, a project on its tab, or a workspace on its tab (Claude, a shell, the spec and so on) with its Changes and Responses panels open or closed as they were. A shell tab comes back as a new shell in the same folder. When something is gone by then, the window steps back: a deleted workspace opens its project, a removed project the profile's Home, and a removed profile the first profile. This holds after **Restart now** for an update and when interrupted work is continued at start, too: the workspaces that continue start as usual, and the window still shows where you were.

When {{app}} starts again, Claude continues the same conversation in each workspace where it was running, and starts there when you open the others. Terminal history isn't kept across restarts; Claude's conversation is.

In a profile that [suspends idle sessions](suspend), only the workspace you're looking at and those whose work is continued start right away; the others start suspended and resume when you open them.

## When there is nothing to resume

Claude saves a conversation only once you send its first prompt. If Claude stopped before that, there is no conversation to resume, so {{app}} starts a new one, and the Claude tab says so above the terminal: **There was no saved conversation to resume, so Claude started a new one.** Click × to hide it.

**Start Claude**, and <kbd>↵</kbd> in a Claude tab whose Claude has ended, start Claude again in that same tab, not in a new one.

## Work that was cut off

Quitting, logging out, an update (**Restart now**, or `install.sh`) or a crash stops Claude in the middle of its turn, together with any commands or background agents it had running. {{app}} remembers where that happened. A workspace counts as **unfinished** when Claude was:

- **Working**, including while it waited for its own background agents or commands;
- **interrupted with <kbd>Esc</kbd>** by you, just before the stop: it's never continued unless you choose so;
- **asking for permission**: never continued by itself; give the permission again in the workspace;
- **Done, with commands still running in the background** (the sidebar showed **1 running**: dev servers, or commands still running when {{app}} stopped waiting for them): quitting stops them. Claude may not have been waiting for them, so it's up to you: such a workspace is marked "1 background command was stopped" and never continued unless you choose it. Continuing tells Claude its commands were stopped, so it can run again what it needs.

Done without background commands, and Waiting for input, don't count. After a crash, a workspace that was still Working counts the same.

The quit dialog says what comes next: "They'll continue when {{app}} starts again" or "You'll be asked when {{app}} starts again".

## Continuing it

With **Continue interrupted work when {{app}} starts** on in [Edit profile › General](edit-profile) (off at first), {{app}} sends the profile's continue prompt to each workspace that was Working, once Claude has resumed there: one after another, a few seconds apart, and never while your [plan usage](plan-usage) is at its limit. A notice at the top of the view, **Continuing interrupted work:**, lists them and how far each got; **Stop** cancels the ones not sent yet, which stay unfinished. The default prompt tells Claude that {{app}} was closed while it worked, which stopped its commands and background agents, and to continue where it left off; you can edit it there.

Otherwise, and for anything else left unfinished, {{app}} asks once at start, after the sessions have resumed: **Claude didn't finish in n workspaces**, grouped by profile, with each workspace's task, project, last prompt and when it stopped. Working ones are ticked; ones you interrupted with <kbd>Esc</kbd>, and ones whose background commands were stopped, aren't; a permission request has no checkbox. **Continue selected** (<kbd>{{key:confirm}}</kbd>) sends the continue prompt to the ticked ones, the same way; it's disabled, with the reason, while plan usage is at its limit. **Not now** (<kbd>Esc</kbd>) leaves them as they are, and **Open** goes to that workspace.

## The Unfinished marker

An unfinished workspace shows **Unfinished** with two bars in its sidebar row; its tooltip reads "Claude didn't finish when {{app}} closed", with "1 background command was stopped" after it when that's why. It's listed under Home's **Needs you**, without a notification or sound, and doesn't count toward the badges. In the workspace, a bar under the tabs says why and offers **Continue**, which sends the continue prompt (not for a permission request, which you give again in the Claude tab), and **Dismiss**, which removes the marker and sends nothing. Sending any prompt yourself clears the marker too.
