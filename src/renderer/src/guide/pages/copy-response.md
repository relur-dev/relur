# Copy responses

Every Claude tab has a **Responses** button at the right of its bar <kbd>{{key:responses}}</kbd>. It opens a panel beside the terminal with one entry for each prompt you sent in the conversation, oldest first and the newest at the bottom: the prompt, and everything Claude wrote in answer, until your next prompt. Each entry is shown formatted, as Markdown, and has its own **Copy**, which copies all of it exactly as Claude wrote it, Markdown included.

![The Responses panel beside the terminal: three entries, one for each prompt, each with its time and Copy; the last one is expanded with Claude's whole answer.](images/responses-panel.webp)

## Parts of an answer

While it works, Claude often writes a few lines, runs tools, then writes more. Those messages are the **parts** of one entry, in order, with a thin line between them where Claude worked. Prompts you didn't type yourself count too: a workflow's answer button, **Continue** and a [quick reply](home#board) from Home send a prompt for you, and it gets its own entry.

- **Copy** copies the whole entry, the parts separated by blank lines.
- **Copy last part**, under an expanded entry with more than one part, copies only Claude's last message: usually its summary at the end.
- When Claude only ran tools and wrote nothing, the entry says **No text response**.
- When you interrupt Claude with <kbd>Esc</kbd> (or turn down a permission), the entry keeps what Claude wrote until then and says **Interrupted** next to its time.
- The panel follows the conversation: while Claude works, the newest entry grows as each part arrives.
- When Claude asks you to choose (its question menu), the question is a part of its own under a small **Claude asked** label, with its options and, once you've answered, your answer. Clicking what Claude asked on a [Board card](home#board) opens the panel at that entry.
- When work Claude ran in the background finishes, Claude carries on by itself. You didn't send a prompt, so what it writes then joins the same entry, under a small **After background work** label.
- An entry whose prompt you sent from the workspace's [Notes](notes) says **from notes** in its header; click it to see those notes.
- A conversation you resumed lists its earlier entries too.
- <kbd>Esc</kbd> closes the panel while you're in it, and so do **×** and <kbd>{{key:responses}}</kbd>; the terminal gets the focus back.
- Before your first prompt, the panel says **No responses yet**.
- To copy only some of the text, select it in the panel and copy as usual.

## Expanding and collapsing

Each entry is a block with a header line: its number, your prompt, the time Claude last wrote in it, and **Copy**. Every entry starts collapsed to its first lines, fading out, the newest one too. Click a header, or press <kbd>↵</kbd> on it, to expand or collapse that entry; clicking a collapsed entry's text expands it too. **Expand all** and **Collapse all** at the top do it for every entry, even when there is only one. **Copy** is in the header, so it copies the whole entry even while it's collapsed.

## Size

Drag the panel's left edge to make it wider or narrower, from 320 pixels up to 70% of the workspace. It keeps that width the next time you open it, also after restarting {{app}}.

**Full view** in the panel's header, or <kbd>{{key:responsesFullView}}</kbd>, gives it the whole workspace area, with the terminal hidden for the moment, which is easier for reading long answers. **Side panel**, <kbd>{{key:responsesFullView}}</kbd> or <kbd>Esc</kbd> puts it back beside the terminal.

<kbd>{{key:copyResponse}}</kbd> copies the newest entry, all of its parts, without opening anything.

The panel and <kbd>{{key:copyResponse}}</kbd> work the same in both of Claude's display modes. They read the conversation from the transcript file Claude Code writes, never from the screen, so line wrapping and Claude's interface don't end up in the clipboard.

## In classic mode

In Claude's classic mode you also get:

- a small **Copy** button at the right of the line where each answer ends, as in Claude's chat apps. It scrolls with the text and copies exactly that answer (after background work, only what Claude wrote since).
- In the Responses panel beside the terminal, a click on an entry's text scrolls the terminal to where it ends and marks that line for a moment. One that isn't on the screen any more (for example after `/clear`) says **Not in the terminal**.

Full-screen mode redraws the whole screen, so nothing can be placed next to a response there: no inline Copy buttons, and a click in the panel doesn't scroll. Use the panel's Copy buttons instead.

## Classic or full-screen

Claude Code's display mode is its `tui` setting: `"default"` (classic) or `"fullscreen"`. To get the inline Copy buttons, type `/tui default` in a Claude tab; `/tui fullscreen` switches back. That Claude restarts in the new mode and resumes its conversation. The choice is saved in `settings.json` in the profile's account folder (see [Account folders](account-folders)), so every Claude of that profile started afterwards uses it; Claudes already running keep their mode until they restart.
