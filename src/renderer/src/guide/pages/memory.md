# Memory

{{app}} shows how much memory your Claude sessions use, so you can find the workspace whose dev server or MCP servers grew and stop it.

## What counts

Each running Claude session is measured together with every process it started: MCP servers, the shells of its Bash tool, background commands and dev servers. The numbers are resident memory, what the processes hold in RAM right now.

- **Claude** is Claude Code's own process.
- **Other** is everything it started, named by process, such as **node dev server**, **node MCP server** or **zsh**.
- **This app** is {{app}} itself: its window and helper processes.

Shells you open yourself in a workspace's terminal tabs aren't counted, and neither is a process that detaches from Claude and keeps running on its own.

{{app}} measures every 10 seconds, and only while its window is visible. A minimized or hidden window measures nothing.

## In the status bar

**Memory** next to the plan usage has a small bar and a number such as **2.4 GB of 16 GB**:

- The first number is every running Claude session, in all profiles, plus {{app}}'s own memory.
- The second number is your machine's total RAM.
- The bar shows the first relative to the second. It turns amber at 80%.

Click it (or Tab to it and press Enter) for a panel with:

- the total split into **Claude sessions** and **This app**;
- the sessions that are [suspended](suspend), when any are, by name and in every profile; they use no memory until you open them;
- the five largest workspaces, each with its split into Claude and other, for example `Claude 300 MB, other 1.2 GB: node dev server`;
- one line on each term, and what isn't counted;
- **Learn more**, which opens this page.

Esc or a click outside closes the panel.

![The memory panel above the status bar: 2.4 GB of 16 GB, split into Claude sessions and this app, one session suspended, and the largest workspaces; ABC-142 uses 1.5 GB, most of it a node dev server.](images/memory-panel.webp)

## In the project view

A working workspace's card on the Board, on Home and in the project view, shows its memory; hover the number to see the split. Every card's tooltip has its memory while its Claude runs. The memory panel above lists the workspaces that use the most.

Above the tabs, **Memory** is the total of the project's running sessions, those in its workspaces and in its main checkout.

The **?** next to the column's header and next to **Memory** opens this page.

## Why the numbers are higher than Activity Monitor's

Each process is counted with all the memory it holds in RAM, including memory it shares with other processes: system libraries, and the code that several node processes load from the same files. Shared memory is counted once for every process that uses it, so the totals here run higher than Activity Monitor's **Memory** column on macOS (or a Linux system monitor's), which counts a process's own memory. Use the numbers to compare workspaces and to see which one grew, not as an exact figure.

:::tip
A dev server that Claude started keeps running after Claude has finished its turn. If a workspace is larger than you expect, look in its Claude tab for background commands, or stop Claude there.
:::
