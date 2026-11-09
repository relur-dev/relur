# Notifications and sounds

{{app}} tells you when Claude needs you or has finished.

- A notification when Claude needs permission, waits for input, asks a question or is done, titled with the profile and the task, like "[Work] ABC-123 needs permission" or "[Work] ABC-123 asked a question", with Claude's message below. None appears while that workspace's Claude tab is in front of you in the focused window. Clicking one brings the window to the front{{mac}} (opening it again if you closed it){{/mac}}, opens the profile, selects the workspace and puts its Claude tab in focus; a [suspended](suspend) workspace resumes. One for a workspace you deleted{{mac}}, or left in Notification Center from before {{app}} restarted,{{/mac}} only brings {{app}} to the front. When your skills stop at a [workflow gate](workflows#when-the-skills-wait-for-you), you get one notification, "waits for you", and no separate "is done". While Claude waits for its background agents or commands there's no "is done" yet; when only dev servers it started still run, "is done" comes at once and says so. A long command, such as a 20-minute test run, gets its "is done" only after Claude's turn that follows it (see [Work in the background](status-glyphs#work-in-the-background)).
- A short sound, only for the events you chose for the profile. All sounds are off until you turn them on: see [Sounds](notifications#sounds).
- **Do Not Disturb** in [Edit profile](edit-profile) › General silences both for that profile. Glyphs and badges still update.

## Badges

The profile tab shows how many of that profile's workspaces need you: Needs permission, Waiting for input, Asked a question or Awaiting approval. {{mac}}The badge on the Dock icon adds them up across all profiles, so you see it with the window hidden.{{/mac}}{{other}}The window title starts with the total across all profiles, as in `(2) Work — {{app}}`, so the taskbar and the window switcher show it. Docks that show badges (Ubuntu Dock, KDE Plasma, Dash to Dock, Dash to Panel, Plank) also put it on {{app}}'s icon once {{app}} is installed with its desktop entry; GNOME without Ubuntu's dock, Cinnamon and Xfce show no badges.{{/other}} See [Needs you](status-glyphs#needs-you).

## Sounds

In [Edit profile](edit-profile) › General, **Sounds** has a checkbox per event, for that profile. All are off to begin with. Ticking one plays its sound, so you know what it sounds like.

| Sound | When |
| --- | --- |
| Needs permission | Claude asks to use a tool (two rising notes) |
| Waiting for input | Claude waits for your reply, or asks you to choose in its question menu (two rising notes) |
| Awaiting approval | Your skills stop at a [workflow gate](workflows#when-the-skills-wait-for-you) (two rising notes) |
| Done | Claude has finished, with nothing it waits for still running in the background (one soft note) |
| Error | A workspace's setup or start failed (two falling notes). There's no notification for it |

Like notifications, a sound doesn't play while you're looking at that workspace's Claude tab, and **Do Not Disturb** silences all of them.

:::note Allow notifications
{{mac}}macOS asks the first time. If none appear, allow them for {{app}} in System Settings › Notifications. When you run {{app}} from its source code, macOS lists them under "Electron" instead.{{/mac}}{{other}}Linux desktops show them without asking. If none appear, check your desktop's notification settings for {{app}}, and that its do-not-disturb mode is off. Clicking one opens its workspace where the desktop's notifications support actions, as GNOME, KDE Plasma and Xfce do; with dunst or mako it depends on their configuration.{{/other}}
:::
