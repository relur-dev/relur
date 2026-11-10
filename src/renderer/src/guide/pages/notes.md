# Notes

While Claude works, thoughts come up: something to add, something to check next, a detail you forgot to mention. Typing them into Claude's terminal would interrupt or wait in its input box. Write them in the workspace's **Notes** instead, and send each one when you're ready.

**Notes** <kbd>{{key:notes}}</kbd> at the right of the workspace's tab bar opens the panel, on any tab. The number beside it counts the notes you haven't sent yet; the panel's header says how many of them are queued. <kbd>{{key:addNote}}</kbd> opens it with a new note ready for typing, from anywhere in the workspace.

![The Notes panel beside Claude's terminal: two unsent notes, the first being edited with Send now and When done under it; one note queued for when Claude is done; two notes sent together as one prompt; and at the bottom, All 2, as one prompt with Send now and Send when done.](images/notes-panel.webp)

## Writing notes

The panel holds a list of notes. **Add note** starts a new one at the end. A note is plain text of any length, and it's saved as you type: nothing to press. Notes read as plain text until you point at one or click into it. A note you leave empty goes away when you click elsewhere.

There's room for long thoughts and pasted text, such as a log or an error: while you write, a note's box grows with it up to half the panel's height, then scrolls. When you're not editing it, a long note shows its first four lines and "…"; click it to edit it there. For more room, **⤢** on the note you're on, or <kbd>{{key:noteEditor}}</kbd> while you're in it, opens it in a large editor over the workspace, with **Send now** and **When done**. What you type there is saved as you type, as in the panel. **Done** or <kbd>Esc</kbd> takes you back. Queued and sent notes open there too, read-only, to read all of them; a sent one has **Copy**. <kbd>Esc</kbd> in a note leaves it; a second <kbd>Esc</kbd> closes the panel.

Notes are private until you send them: {{app}} keeps them in its own database, not in the worktree, so Claude can't read them. They stay across restarts and while Claude is [suspended](suspend), and they're deleted with the workspace. The **Delete** dialog tells you how many unsent notes would go with it.

## Sending

The note you're on (under the pointer, or the one you're typing in) shows two ways to go, and a bin to delete it:

- **Send now** <kbd>{{key:noteSendNow}}</kbd> types it into Claude as a prompt, the way the Board's [quick reply](home#quick-reply) does. It never types into a permission request or Claude's question menu, and never over a prompt you've started typing in the terminal: the note says why it can't go, for example **There may be text in Claude's prompt: send it or clear it with Ctrl+C**, and stays. **Queue instead** then holds it for when Claude is done. A suspended Claude resumes first, and a new workspace's Claude takes a note as soon as it shows its prompt, before you've sent it anything. While Claude is working, Claude Code takes the note into its current turn after the step it's on.
- **When done** <kbd>{{key:noteQueue}}</kbd> (send when Claude is done) moves it to **Queued**, read-only, until Claude finishes its turn; then it's sent by itself. **Cancel** takes it back before then, and **Send now** (point at it) sends it without waiting.

To send several notes together, tick them: the checkboxes show when you point at a note. A bar at the bottom offers **Send now** and **Send when done** for the ticked ones, and **Clear**. With two or more notes unsent and none ticked, the same bar offers **All 2, as one prompt**, for all of them. They go as one prompt, a numbered list in the panel's order, each note its own point. Notes held separately go out together too, when Claude is done.

### When Claude isn't quite done

A held note waits for a finished turn that it won't answer by accident:

- When Claude **asks for permission** or **asks you a question** in its menu, it hasn't finished: answer it, and the notes go when that turn ends.
- When Claude **ends its turn with a question**, the note says **Waiting: Claude asked something**. Your note was written before the question, so it isn't sent as the answer. Answer Claude, and the notes go after its next turn; or press **Send now** to send them anyway.
- At a workflow gate, after you pressed <kbd>Esc</kbd>, or while you have something typed in Claude's prompt, the note waits too, and says why. Send or delete what you typed (<kbd>⌫</kbd>, <kbd>Ctrl+U</kbd>, <kbd>Ctrl+C</kbd>), and the note goes at once: {{app}} looks at Claude's prompt on the screen, so it sees the prompt empty however you deleted the text.
- A suspended Claude isn't woken up for a held note: it goes once you open the workspace and Claude is done.

## Sent notes

Sent notes move to **Sent**, below the others, quieter, with the time they went; notes that went as one prompt are grouped under **Sent together as one prompt**. Click **Sent** to fold the section away; each workspace remembers whether it's folded. **View response** opens the [Responses panel](copy-response) at Claude's answer to that prompt. In the Responses panel that entry says **from notes**; click it to come back to the notes it was sent from. A note sent while Claude was working leads to the turn that took it in.

**View response** waits until Claude Code has written the prompt to its conversation. When the conversation has moved on (after `/clear` or a new session), the note says **Not in Claude's current conversation** instead.

Point at a sent note to copy it, delete it, or move it back to the unsent notes with **Move back**, to edit and send again.

## On Home

On the Board, on Home and in the project view, a workspace with unsent notes shows a small notes mark with their number beside its name. Hover it to see how many are queued.

## Size

Drag the panel's left edge to make it wider or narrower; it keeps its width. In a narrow window, the Notes and Responses panels take turns: opening one closes the other. <kbd>Esc</kbd> in the panel, **×** or <kbd>{{key:notes}}</kbd> closes it.
