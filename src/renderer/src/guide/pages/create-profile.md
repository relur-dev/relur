# Creating a profile

Click **+** after the profile tabs (on first launch, **Create your first profile**). The wizard has four steps: **Name & color**, **Claude account**, **Setup check** and **Done**.

1. **Name & color:** name the profile and pick one of twelve colors, in one row that scrolls sideways when it doesn't fit. It starts with the first color no other profile uses; colors other profiles use are dimmed, and you can still pick them. Hover a color for its name (and which profiles use it), or move through them with the arrow keys. Below, a preview of the tab bar shows the new profile's tab next to the others. You can change both later in [Edit profile](edit-profile).
2. **Claude account:** choose which account the profile uses (below), then **Create profile**. From here the profile exists.
3. **Setup check:** the [setup check](setup-check) runs for the new profile. **Continue** is enabled once every row passes; **Finish later** skips ahead, and the profile's projects and workspaces wait until the check passes.
4. **Done:** a summary, and for a profile with its own folder the optional [terminal shortcut](terminal-shortcut). **Open <profile>** switches to it.

## Account options

| Option | Folder | Use it when |
| --- | --- | --- |
| Use my default Claude login | `~/.claude` | You have one Claude account |
| Use an existing login | `~/.claude` or a `~/.claude-*` folder found in your home folder, or one you pick with **Choose another folder…** | You already use a second folder with Claude Code |
| Sign in to a new account | `~/.claude-<profile>`, made new | You want a second account |

Each folder shows whether it's signed in, and with which account. **Sign in to a new account** is refused if its folder already exists; choose that folder under **Use an existing login** instead.

A folder another profile already uses is marked **Used by <profile>**. You can still choose it, but both profiles then share one login, settings, history and plan usage, and signing out in one signs out both. See [Account folders](account-folders).

## Which account signs in

When you sign in, the browser decides which account it is: the one signed in at claude.ai. To sign in to a second account, sign out on claude.ai first, or open the login link in a private window.

The setup check runs the sign-in for you, in a terminal you can see. It's the same as typing:

```
CLAUDE_CONFIG_DIR=~/.claude-personal claude auth login
```

:::warning Plan
The free Claude plan doesn't include Claude Code.
:::
