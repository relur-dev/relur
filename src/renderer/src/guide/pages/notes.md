# Notes

While Claude works, thoughts come up: something to add, something to check next, a detail you forgot to mention. Typing them into Claude's terminal would interrupt or wait in its input box. Write them in the workspace's **Notes** instead, and send each one when you're ready.

**Notes** <kbd>{{key:notes}}</kbd> at the right of the workspace's tab bar opens the panel, on any tab. The number beside it counts the notes you haven't sent yet; the panel's header says how many of them are queued. <kbd>{{key:addNote}}</kbd> opens it with its box ready for typing, from anywhere in the workspace.

![The Notes panel beside Claude's terminal: at the top two notes sent together as one prompt; one note queued for when Claude is done; two unsent notes; then All 2, as one prompt with Send now and Send when done; and at the bottom the box, with a thought being typed, a paper clip to add files, and When done, Send now and Add beside it.](images/notes-panel.webp)

## Writing notes

Notes are written in the box at the bottom of the panel, as in a chat. Press <kbd>{{mac}}↵{{/mac}}{{other}}Enter{{/other}}</kbd> to add what you typed as a new note; <kbd>{{mac}}⇧↵{{/mac}}{{other}}Shift+Enter{{/other}}</kbd> starts a new line instead. <kbd>{{key:noteSendNow}}</kbd> adds it and sends it to Claude now, and <kbd>{{key:noteQueue}}</kbd> adds it and queues it for when Claude is done (see [Sending](#sending)). The buttons beside the box, **Add**, **Send now** and **When done**, do the same. An empty box adds nothing.

To mention files, drop them on the box from {{mac}}Finder{{/mac}}{{other}}your file manager{{/other}}, or choose them with its paper clip, **Add files** (<kbd>{{key:addFiles}}</kbd> while you're typing there). Their paths go in where the caret is, the way [Claude's prompt would get them](add-files#what-claude-gets): a file in the workspace as `@src/app.ts`, which gives Claude the file when the note is sent, any other as its full path. Nothing goes to Claude until you send the note.

The box grows with what you type or paste, such as a log or an error, up to about 40% of the panel's height, then scrolls; it shrinks back once the note is added. What you've typed and not added yet stays in the box when you close the panel or switch workspaces, and after a restart.

The notes sit above the box in the order you wrote them, the newest right above it, and the list scrolls to each new one. From the top: **Sent**, then **Queued**, then the notes you haven't sent.

A note is plain text of any length. Click one to edit it in place; it's saved as you type, nothing to press. A note you empty goes away when you click elsewhere. A long note shows its first four lines; **Show more** shows all of it, and **Show less** folds it again. <kbd>Esc</kbd> in a note or the box leaves it; a second <kbd>Esc</kbd> closes the panel.

Notes are private until you send them: {{app}} keeps them in its own database, not in the worktree, so Claude can't read them. They stay across restarts and while Claude is [suspended](suspend), and they're deleted with the workspace. The **Delete** dialog tells you how many unsent notes would go with it.

## Sending

A note in the list shows two ways to go when you point at it or edit it, and a bin to delete it (the box's own keys and buttons do the same as it adds a note):

- **Send now** <kbd>{{key:noteSendNow}}</kbd> types it into Claude as a prompt, the way the Board's [quick reply](home#quick-reply) does. It never types into a permission request or Claude's question menu, and never over a prompt you've started typing in the terminal: the note says why it can't go, for example **There may be text in Claude's prompt: send it or clear it with Ctrl+C**, and stays. **Queue instead** then holds it for when Claude is done. A suspended Claude resumes first, and a new workspace's Claude takes a note as soon as it shows its prompt, before you've sent it anything. While Claude is working, Claude Code takes the note into its current turn after the step it's on.
- **When done** <kbd>{{key:noteQueue}}</kbd> (send when Claude is done) moves it to **Queued**, read-only, until Claude finishes its turn; then it's sent by itself. **Cancel** takes it back before then, and **Send now** (point at it) sends it without waiting.

To send several notes together, tick them: the checkboxes show when you point at a note. A bar above the box offers **Send now** and **Send when done** for the ticked ones, and **Clear**. With two or more notes unsent and none ticked, the same bar offers **All 2, as one prompt**, for all of them. They go as one prompt, a numbered list in the panel's order, each note its own point. Notes held separately go out together too, when Claude is done.

### When Claude isn't quite done

A held note waits for a finished turn that it won't answer by accident:

- When Claude **asks for permission** or **asks you a question** in its menu, it hasn't finished: answer it, and the notes go when that turn ends.
- When Claude **ends its turn with a question**, the note says **Waiting: Claude asked something**. Your note was written before the question, so it isn't sent as the answer. Answer Claude, and the notes go after its next turn; or press **Send now** to send them anyway.
- At a workflow gate, after you pressed <kbd>Esc</kbd>, or while you have something typed in Claude's prompt, the note waits too, and says why. Send or delete what you typed (<kbd>⌫</kbd>, <kbd>Ctrl+U</kbd>, <kbd>Ctrl+C</kbd>), and the note goes at once: {{app}} looks at Claude's prompt on the screen, so it sees the prompt empty however you deleted the text.
- A suspended Claude isn't woken up for a held note: it goes once you open the workspace and Claude is done.

## Sent notes

Sent notes move to **Sent**, at the top of the list in the order they went, quieter, with the time they went; notes that went as one prompt are grouped under **Sent together as one prompt**. Click **Sent** to fold the section away; each workspace remembers whether it's folded. **View response** opens the [Responses panel](copy-response) at Claude's answer to that prompt. In the Responses panel that entry says **from notes**; click it to come back to the notes it was sent from. A note sent while Claude was working leads to the turn that took it in.

**View response** waits until Claude Code has written the prompt to its conversation. When the conversation has moved on (after `/clear` or a new session), the note says **Not in Claude's current conversation** instead.

A long sent note shows two lines, with **Show more** for the rest. Point at a sent note to copy it, delete it, or move it back to the unsent notes with **Move back**, to edit and send again.

## On Home

On the Board, on Home and in the project view, a workspace with unsent notes shows a small notes mark with their number beside its name. Hover it to see how many are queued.

## Size

Drag the panel's left edge to make it wider or narrower; it keeps its width. In a narrow window, the Notes and Responses panels take turns: opening one closes the other. <kbd>Esc</kbd> in the panel, **×** or <kbd>{{key:notes}}</kbd> closes it.
