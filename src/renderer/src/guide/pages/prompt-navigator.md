# Prompt navigator

In Claude's classic mode, each prompt you send gets its number in the left margin, in the profile's color, and a [Copy button](copy-response) appears where each response ends. Only prompts are numbered: when background work Claude started finishes and Claude carries on by itself, that isn't a prompt.

The navigator, at the top right of the Claude tab, reads **Prompt n of N** for the prompt you're looking at. Its **↑** and **↓**, or <kbd>{{keys:promptStep}}</kbd>, jump to the previous or next prompt and scroll it near the top. None of this takes the focus from the terminal.

A number goes only on the line where Claude shows the prompt you sent, `❯` and your text; never on Claude's answer, even when it repeats your words, nor on what you're typing. Prompts {{app}} sends for you, such as **Continue**, **Ask Claude to write it** or a quick reply from [Home](home#quick-reply), are numbered like the ones you type. After {{app}} restarts or a suspended workspace resumes, Claude prints the conversation again and the earlier prompts get their numbers back.

:::note When there's no navigator
It shows once a prompt has its number. Until then it's hidden: before your first prompt, in a conversation Claude didn't print again or that `/clear` erased, and in full-screen mode. A prompt whose line {{app}} can't find for certain gets no number rather than one on the wrong line.
:::

:::note Classic mode only
Claude Code's full-screen mode redraws the whole screen, so prompt numbers, the navigator and the Copy buttons can't be placed there; the [Responses panel](copy-response) lists every response, each with its own Copy. In full-screen mode they stay hidden, also when you come back to the tab from another workspace or profile. See [Classic or full-screen](copy-response#classic-or-full-screen).
:::
