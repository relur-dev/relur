# Updates and privacy

{{app}} runs on your machine. It has no telemetry, analytics or accounts, and stores no credentials. Your code reaches Anthropic the way it always does with Claude Code, and your git host when you push.

## Checking for new versions

{{app}} makes two kinds of requests on its own, and only when you allow them: the check for new versions, and the download of a new version when you click **Update**. On its first start a bar under the profile tabs asks, and nothing is sent until you answer: **Check for updates** or **No thanks**. If you agree, {{app}} asks GitHub for its latest release when it starts and once a day while it runs. The request carries {{app}}'s name and version and nothing else: no cookies, no identifiers, nothing about you or your work.

You can change your mind in the {{mac}}{{app}} menu{{/mac}}{{other}}Help menu{{/other}}: **Check for Updates Automatically** turns the daily check on or off, and **Check for Updates…** asks right away, whatever the setting, and says if something went wrong. Pre-releases are never offered.

## Updating

When a newer version is out, a bar under the profile tabs says so: **{{app}} 0.3.0 is available**, next to the version you have. It never opens a dialog or takes the focus.

- **Update** downloads the new version from the release on GitHub, with a progress bar and **Cancel**. Nothing is downloaded before you click it. {{app}} checks the download against the release's checksums and that it really is {{app}} at that version, then says **{{app}} 0.3.0 is ready**.
- **Restart now** quits {{app}} as <kbd>{{key:quit}}</kbd> does, asking first while sessions run, replaces it where it is installed and opens the new version, showing where you were (see [Starting again](resume#starting-again)). As after any quit, Claude's conversations resume afterwards, and work it hadn't finished is marked **Unfinished**; see [Quitting and resuming](resume#work-that-was-cut-off).
- **Later** keeps the bar; the new version is installed the next time you quit {{app}}. Logging out or shutting down leaves it for the quit after that.
- **Update in terminal** runs the install command in your terminal instead{{mac}}, the one you made the default for `.command` files{{/mac}}. It asks before it quits {{app}}, installs the new version and offers to open it again.
- **Release notes** opens the release page in your browser.
- **Skip this version** stops the bar for that version; the next one shows again. **Check for Updates…** shows a skipped version anyway.
- **×** hides the bar until the next check.

{{app}} replaces itself only where you can write without a password: {{mac}}`/Applications` or `~/Applications`{{/mac}}{{other}}the folder of your AppImage{{/other}}. It never asks for your password and never runs `sudo`. If replacing fails, the old version stays, opens again, and the bar says what went wrong, with **Update in terminal**.{{mac}} If {{app}} runs from the disk image, from a folder you can't write to, or from the temporary copy macOS makes of an app that wasn't moved to Applications, the bar says so and offers **Update in terminal**.{{/mac}}

If no terminal can be opened, **Update in terminal** shows the command with **Copy**, to run yourself.{{other}} If you installed the `.deb`, **Update** shows a link to the new `.deb` and the `apt` command that installs it, with **Copy**; `apt` asks for your password in your terminal.{{/other}} A {{app}} you built from source can't update itself: the bar says so; pull and build it again.
