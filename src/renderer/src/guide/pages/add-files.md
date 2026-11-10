# Add files to Claude's prompt

To point Claude at a file, a screenshot or a folder, drag it from {{mac}}Finder{{/mac}}{{other}}your file manager{{/other}} onto Claude's terminal. Its path goes into Claude's prompt where the cursor is, as if you had typed it, and nothing is sent: add your words around it and press <kbd>↵</kbd> when you're ready. Several files at once go in one after another.

While you drag files over the terminal, it's outlined and says **Add to Claude's prompt**. Anywhere else in the window a drop does nothing.

**Add files** <kbd>{{key:addFiles}}</kbd> at the right of the workspace's tab bar does the same with the system's file picker, where you can choose several files (and folders on macOS).

## What Claude gets

- **A file in the workspace** (its worktree, or a [linked repository's](tasks-across-repositories)) goes in as Claude Code's `@path`, relative to the workspace: `@src/app.ts`, or `@"my notes/plan.md"` when the path has spaces. When you send the prompt, Claude Code reads the file and gives it to Claude with your message. A folder goes in as `@src/`, and Claude gets its list of files.
- **A file elsewhere** goes in as its full path, in quotes when it has spaces: `'/Users/you/Desktop/screen shot.png'`. An image dropped this way becomes **[Image #1]** in Claude's prompt, attached as when you drag it into a normal terminal. Claude reads other files with its tools when it needs them.

## When it can't go in

Paths go into Claude's prompt only while it waits there or works, the same times a [quick reply](home#quick-reply) can go. While Claude asks for permission or asks you a question in its menu, a drop types nothing, so it can't pick an option by accident, and the terminal says why: **Claude is asking for permission: answer it, then add the files**. Answer Claude, then drop the files again. A [suspended](suspend) Claude resumes first.

## Shell tabs

Dropped on a shell tab, or on Home's or a project's terminal, files go in as their full paths, quoted when needed, as in any terminal. Nothing runs until you press <kbd>↵</kbd>.
