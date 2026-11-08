/**
 * End-to-end test of onboarding (spec §6.11): first launch, the New profile
 * wizard with each account choice, the setup check and its gate, Edit and
 * Remove profile, and the warning bar when Chromium's sandbox is off. Runs
 * with a throwaway HOME and a fake `claude`.
 *
 *   tsx scripts/e2e-onboarding.ts [--dev] [--screenshots=<dir>] [extra Electron args…]
 *
 * Never runs the real installer or a real `claude auth login`, and never
 * touches the user's own ~/.claude* folders: every directory of PATH that
 * holds a `claude` is left out, and the test asserts that the version it sees
 * is the fake's. The install step is checked up to its button, which isn't
 * clicked.
 */
import './lib/clean-env';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { appConfigDir } from '../src/main/paths';
import { createFixture } from '../src/main/test-support/git-fixtures';
import { BRAND } from '../src/shared/brand';
import {
  type Cdp,
  chooseFromNextContextMenu,
  clickButtonText,
  clickLabel,
  dialogText,
  launchApp,
  openContextMenu,
  pressKey,
  type RunningApp,
  screenshot,
  submitDialog,
  typeInField,
  withDisplayEnv,
} from './lib/app-driver';

const args = process.argv.slice(2);
const screenshotDir = args.find((a) => a.startsWith('--screenshots='))?.split('=')[1];
const devMode = args.includes('--dev');

/** The color grid of the open dialog (New profile, Edit profile). */
const swatches = `[...document.querySelectorAll('dialog[open] [data-color-grid] [role=radio]')]`;
const checkedColor = `document.querySelector('dialog[open] [data-color-grid] [aria-checked=true]')?.dataset.color`;
/** A color as the window computes it, the way `css` (a background) draws. */
const computedBackground = (css: string) => `(() => {
  const probe = document.body.appendChild(document.createElement('div'));
  probe.style.background = ${JSON.stringify(css)};
  const color = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return color;
})()`;
const electronArgs = args.filter((a) => !a.startsWith('--screenshots=') && a !== '--dev');

/** The version the fake prints; the real Claude Code never reports it. */
const FAKE_VERSION = '0.0.0-fake';

/**
 * A stand-in for Claude Code. A folder counts as signed in when it holds
 * `fake-login`, which `auth login` creates. Account values are made up.
 */
const FAKE_CLAUDE = `#!/bin/sh
dir="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
case "$1 $2" in
  "--version "*) echo '${FAKE_VERSION} (Claude Code)' ;;
  "auth status")
    if [ -f "$dir/fake-login" ]; then
      printf '{"loggedIn":true,"email":"test@example.com","subscriptionType":"pro","configDirectory":"%s"}\\n' "$dir"
    else
      printf '{"loggedIn":false,"authMethod":"none","configDirectory":"%s"}\\n' "$dir"
      exit 1
    fi ;;
  "auth login")
    echo "Opening your browser to sign in…"
    mkdir -p "$dir"; touch "$dir/.claude.json" "$dir/fake-login"
    echo "Login successful." ;;
  *) exec sleep 600 ;;
esac
`;

const dialogOpen = `!!document.querySelector('dialog[open]')`;
/** Text of the topmost open dialog (a nested one comes last in the DOM). */
const topDialogText = `([...document.querySelectorAll('dialog[open]')].at(-1)?.innerText ?? '')`;
const mainText = `(document.querySelector('main')?.innerText ?? '')`;

const clickRadioLabel = (page: Cdp, text: string) =>
  page.eval(
    `[...document.querySelectorAll('dialog[open] label')].find((l) => l.innerText.includes(${JSON.stringify(text)})).click()`,
  );

/** Selects a folder in the wizard's list of existing logins. */
const chooseFolder = (page: Cdp, folder: string) =>
  page.eval(
    `[...document.querySelectorAll('[data-account-folders] label')].find((l) => l.querySelector('.font-mono').textContent === ${JSON.stringify(folder)}).click()`,
  );

/** Clicks the first button in the open dialog whose text starts with `prefix`. */
const clickButtonStarting = (page: Cdp, prefix: string) =>
  page.eval(
    `[...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent.startsWith(${JSON.stringify(prefix)})).click()`,
  );

/** The setup check row's state: spin, ok, act, bad or wait. */
const rowState = (page: Cdp, row: string) =>
  page.eval<string | null>(
    `document.querySelector('[data-row=${JSON.stringify(row)}]')?.dataset.state ?? null`,
  );

async function main() {
  const fx = createFixture();
  let app: RunningApp | undefined;
  try {
    const home = fx.root;
    const bin = path.join(home, 'bin');
    fs.mkdirSync(bin);
    const pathDirs = (process.env.PATH ?? '')
      .split(path.delimiter)
      .filter((dir) => dir && !fs.existsSync(path.join(dir, 'claude')));
    const PATH = [bin, ...pathDirs].join(path.delimiter);
    // The login shell's startup files set PATH last, so system files (such as
    // macOS's path_helper) can't add back a folder with the real claude.
    const rcText = `export PATH='${PATH}'\n`;
    for (const rc of ['.zshrc', '.zprofile', '.bashrc', '.bash_profile', '.profile']) {
      fs.writeFileSync(path.join(home, rc), rcText);
    }
    // Account folders: the default one signed in, one signed out, one never used.
    fs.mkdirSync(path.join(home, '.claude'));
    fs.writeFileSync(path.join(home, '.claude.json'), '{}');
    fs.writeFileSync(path.join(home, '.claude', 'fake-login'), '');
    fs.mkdirSync(path.join(home, '.claude-side'));
    fs.writeFileSync(path.join(home, '.claude-side', '.claude.json'), '{}');
    fs.mkdirSync(path.join(home, '.claude-old'));
    const picked = path.join(home, 'logins', 'elsewhere');
    fs.mkdirSync(picked, { recursive: true });
    const repo = fx.localRepo('notes');

    const env = withDisplayEnv({ ...fx.env, PATH });
    // The app resolves claude the same way: stop before it can find a real one.
    const shell = process.env.SHELL || '/bin/sh';
    const found = execFileSync(shell, ['-ilc', 'command -v claude || true'], {
      env,
      cwd: home,
      encoding: 'utf8',
    }).trim();
    assert.equal(found, '', `the login shell finds a real claude (${found}); refusing to run`);
    const configFile = path.join(
      appConfigDir({ platform: process.platform, env: {}, homeDir: home }),
      'config.json',
    );
    const profiles = () => JSON.parse(fs.readFileSync(configFile, 'utf8')).profiles;

    // 1. First launch without Claude Code: the wizard opens by itself; Install
    // shows the official command verbatim (never clicked).
    app = await launchApp({ env, dev: devMode, electronArgs });
    let page = app.page;
    await page.waitFor(dialogOpen, 'the wizard on first launch');
    assert.match(await page.eval<string>(dialogText), /Create your first profile/);
    assert.deepEqual(profiles(), []);
    assert.match(await page.eval<string>(mainText), new RegExp(`Welcome to ${BRAND.displayName}`));
    await typeInField(page, '#profile-name', 'Work', false);
    // Twelve colors in one row, each named in its tooltip and label (spec §3.1).
    assert.deepEqual(
      await page.eval<string[][]>(
        `${swatches}.map((b) => [b.getAttribute('aria-label'), b.title])`,
      ),
      [
        'Blue',
        'Sky',
        'Teal',
        'Green',
        'Olive',
        'Graphite',
        'Indigo',
        'Slate',
        'Petrol',
        'Pine',
        'Plum',
        'Charcoal',
      ].map((name) => [name, name]),
    );
    assert.deepEqual(
      await page.eval<number[]>(
        `(() => { const b = ${swatches}; return [b[11].offsetTop === b[0].offsetTop, b[11].offsetLeft > b[6].offsetLeft].map(Number); })()`,
      ),
      [1, 1],
      'one row',
    );
    assert.equal(await page.eval<string>(checkedColor), 'blue', 'the first color');
    await screenshot(page, screenshotDir, 'o1-name.png');
    await submitDialog(page);
    await page.waitFor(`${dialogText}.includes('Use my default Claude login')`, 'the account step');
    await submitDialog(page); // the default login is preselected
    await page.waitFor(`!!document.querySelector('dialog[open] [data-setup-check]')`, 'the check');
    await page.waitFor(`${dialogText}.includes('Install')`, 'the install step');
    assert.equal(await rowState(page, 'Claude Code installed'), 'act');
    const commands = await page.eval<string[]>(
      `[...document.querySelectorAll('dialog[open] [data-command]')].map((c) => c.textContent)`,
    );
    assert.equal(commands[0], 'curl -fsSL https://claude.ai/install.sh | bash');
    for (const command of commands.slice(1))
      assert.equal(command, 'brew install --cask claude-code');
    assert.equal(await rowState(page, 'Signed in'), 'wait');
    await screenshot(page, screenshotDir, 'o2-not-installed.png');
    // A new profile gets the default suspend delay written (spec §9.8).
    assert.deepEqual(profiles(), [
      { id: 'work', name: 'Work', color: 'blue', env: {}, suspendIdleMin: 10 },
    ]);
    await clickButtonText(page, 'Finish later', `document.querySelector('dialog[open]')`);
    await page.waitFor(`${dialogText}.includes('Open Work')`, 'the done step');
    assert.doesNotMatch(await page.eval<string>(dialogText), /Terminal shortcut/);
    await submitDialog(page);
    await page.waitFor(`!${dialogOpen}`, 'the wizard to close');
    await page.waitFor(
      `document.querySelector('[data-setup-warning]')?.textContent.includes('claude not found')`,
      'the status bar warning',
    );
    // A new install never shows the notice that suspension is on by default (spec §9.8).
    assert.equal(await page.eval(`!!document.querySelector('[data-suspend-notice]')`), false);
    await app.stop();
    app = undefined;

    // 2. With Claude Code installed (the fake): Work's default login passes.
    fs.writeFileSync(path.join(bin, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
    app = await launchApp({ env, dev: devMode, electronArgs });
    page = app.page;
    let mainProcess = app.main;
    await page.waitFor(`!document.querySelector('[data-setup-warning]')`, 'Work to pass its check');
    // Chromium's sandbox is on: no warning bar (spec §15.6).
    assert.equal(
      await page.eval<boolean>(`!!document.querySelector('[data-sandbox-warning]')`),
      false,
    );

    // Choose another folder… goes through the native panel; only the panel is replaced.
    await mainProcess.eval(`(() => {
      const { dialog } = process.mainModule.require('electron');
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [${JSON.stringify(picked)}] });
    })()`);

    // 3. Existing login: lists ~/.claude* with their state, warns about a shared
    // folder, then signs in to the chosen one through claude auth login.
    await clickLabel(page, 'New profile');
    await page.waitFor(dialogOpen, 'the wizard');
    assert.match(await page.eval<string>(dialogText), /New profile/);
    await typeInField(page, '#profile-name', 'Personal', false);
    // The first color no other profile uses; Work's stays in its place, dimmed.
    assert.equal(await page.eval<string>(checkedColor), 'sky');
    assert.deepEqual(
      await page.eval(
        `(({ title, dataset }) => [title, dataset.used])(document.querySelector('dialog[open] [data-color=blue]'))`,
      ),
      ['Blue · used by Work', 'true'],
    );
    await submitDialog(page);
    await page.waitFor(`${dialogText}.includes('Use an existing login')`, 'the account step');
    await clickRadioLabel(page, 'Use an existing login');
    await page.waitFor(
      `document.querySelectorAll('[data-account-folders] [data-folder-state]').length === 3`,
      'the account folders',
    );
    const states = await page.eval<string[]>(
      `[...document.querySelectorAll('[data-account-folders] label')].map((l) => l.innerText.replace(/\\s+/g, ' ').trim())`,
    );
    assert.deepEqual(states, [
      '~/.claude ✓ Signed in test@example.com Used by Work',
      '~/.claude-old Not used yet',
      '~/.claude-side Not signed in',
    ]);
    assert.deepEqual(fs.readdirSync(path.join(home, '.claude-old')), [], 'nothing ran in it');
    await clickButtonStarting(page, 'Choose another folder');
    await page.waitFor(`${dialogText}.includes('~/logins/elsewhere')`, 'the picked folder');
    assert.deepEqual(fs.readdirSync(picked), [], 'nothing ran in the picked folder');
    await chooseFolder(page, '~/.claude');
    await page.waitFor(`${dialogText}.includes('is used by Work')`, 'the shared-account warning');
    await screenshot(page, screenshotDir, 'o3-existing.png');
    await chooseFolder(page, '~/.claude-side');
    await page.waitFor(`!${dialogText}.includes('is used by Work')`, 'no warning');
    await submitDialog(page);
    await page.waitFor(`${dialogText}.includes('auth login')`, 'the sign-in step');
    assert.equal(
      await page
        .eval<string>(`document.querySelector('[data-row="Claude Code installed"]').innerText`)
        .then((t) => t.includes(FAKE_VERSION)),
      true,
      'the fake claude is the one found',
    );
    await clickButtonText(page, 'Sign in', `document.querySelector('dialog[open]')`);
    await page.waitFor(
      `!document.querySelector('dialog[open] button[type=submit]').disabled`,
      'the check to pass',
    );
    assert.equal(await rowState(page, 'Ready'), 'ok');
    assert.match(await page.eval<string>(dialogText), /test@example\.com · pro/);
    await submitDialog(page);
    await page.waitFor(`${dialogText}.includes('Terminal shortcut')`, 'the done step');
    const aliasLine = "alias claude-personal='CLAUDE_CONFIG_DIR=~/.claude-side claude'";
    assert.match(await page.eval<string>(dialogText), /Add to ~\/\.(zshrc|bashrc)/);
    await clickButtonStarting(page, 'Add to ~/.');
    await page.waitFor(`${topDialogText}.includes('Add one line to')`, 'the confirmation');
    assert.equal(
      await page.eval<string>('document.activeElement.textContent'),
      'Cancel',
      'focus starts on Cancel',
    );
    assert.equal(
      await page.eval<string>(`document.querySelector('[data-alias-line]').textContent`),
      `+ ${aliasLine}`,
    );
    await screenshot(page, screenshotDir, 'o4-alias-confirm.png');
    await clickButtonText(page, 'Add line');
    await page.waitFor(`!!document.querySelector('[data-alias-added]')`, 'the added note');
    const sourceLine = await page.eval<string[]>(
      `[...document.querySelectorAll('dialog[open] [data-command]')].map((c) => c.textContent)`,
    );
    assert.match(sourceLine.at(-1) ?? '', /^source ~\/\.(zshrc|bashrc)$/, 'open terminals: source');
    // The login shell's startup file gets the line; the other one is untouched.
    const rcFiles = ['.zshrc', '.bashrc'].map((f) => fs.readFileSync(path.join(home, f), 'utf8'));
    assert.deepEqual(
      rcFiles.filter((text) => text !== rcText),
      [`${rcText}${aliasLine}\n`],
    );
    await submitDialog(page);
    await page.waitFor(`!${dialogOpen}`, 'the wizard to close');
    assert.deepEqual(profiles()[1], {
      id: 'personal',
      name: 'Personal',
      color: 'sky',
      env: { CLAUDE_CONFIG_DIR: '~/.claude-side' },
      suspendIdleMin: 10,
    });

    // 4. New account: creates an empty ~/.claude-<id>; Finish later leaves it gated.
    await clickLabel(page, 'New profile');
    await page.waitFor(dialogOpen, 'the wizard');
    await typeInField(page, '#profile-name', 'Third', false);
    await submitDialog(page);
    await page.waitFor(`${dialogText}.includes('~/.claude-third')`, 'the new folder');
    await clickRadioLabel(page, 'Sign in to a new account');
    await submitDialog(page);
    await page.waitFor(`${dialogText}.includes('auth login')`, 'the sign-in step');
    assert.deepEqual(fs.readdirSync(path.join(home, '.claude-third')), [], 'created empty');
    await clickButtonText(page, 'Finish later', `document.querySelector('dialog[open]')`);
    await page.waitFor(`${dialogText}.includes('Open Third')`, 'the done step');
    await submitDialog(page);
    await page.waitFor(`!${dialogOpen}`, 'the wizard to close');
    await page.waitFor(
      `document.querySelector('[data-setup-warning]')?.textContent.includes('not signed in')`,
      'the warning of Third',
    );

    // 5. Gate: Third's project opens the setup check instead, Start Claude here too;
    // the home shell still works. Signing in lifts the gate in place.
    await clickLabel(page, 'Add project to Third');
    await page.waitFor(dialogOpen, 'the Add project dialog');
    await typeInField(page, '#add-project-folder', repo, false);
    await page.waitFor(`${dialogText}.includes('Git repository')`, 'the detected details');
    await submitDialog(page);
    await page.waitFor(`!${dialogOpen}`, 'the dialog to close');
    await page.waitFor(`${mainText}.includes('Finish setting up Third to open notes')`, 'the gate');
    await screenshot(page, screenshotDir, 'o5-gate.png');
    // The sidebar's Home row.
    await page.eval(`document.querySelector('nav > button').click()`);
    await page.waitFor(`!!document.querySelector('[data-terminal]')`, 'the home terminal');
    await page.eval(`document.querySelector('[data-setup-warning]').click()`);
    await page.waitFor(
      `${mainText}.includes('Set up Third')`,
      'the setup check from the status bar',
    );
    await page.eval(
      `[...document.querySelectorAll('nav li button')].find((b) => b.textContent === 'notes').click()`,
    );
    await page.waitFor(`${mainText}.includes('Finish setting up Third to open notes')`, 'the gate');
    // New workspace shows the check too; once it passes, the dialog opens (spec §6.11).
    await clickLabel(page, 'New workspace in notes');
    await page.waitFor(
      `${mainText}.includes('Finish setting up Third to open New workspace')`,
      'the gate of New workspace',
    );
    await clickButtonText(page, 'Sign in', 'document.querySelector("main")');
    await page.waitFor(`${dialogText}.includes('New workspace')`, 'New workspace after the check');
    await page.eval(`document.querySelector('dialog[open]').close()`);
    await page.waitFor(`document.querySelector('h1')?.textContent === 'notes'`, 'the project view');
    assert.equal(
      await page.eval<boolean>(`!!document.querySelector('[data-setup-warning]')`),
      false,
    );

    // 6. Edit profile: name and color; Remove is refused while it has projects.
    const thirdTab = '[aria-label="Select Third"]';
    await chooseFromNextContextMenu(mainProcess, 'Edit profile…');
    await openContextMenu(page, thirdTab);
    await page.waitFor(`${dialogText}.includes('Edit profile')`, 'Edit profile');
    assert.match(
      await page.eval<string>(`document.querySelector('[data-statusline-hint]').textContent`),
      /^Only needed if you customized Claude Code's status line: .*statusLine setting.*leave it empty\.$/,
    );
    const menu = await mainProcess.eval<string[]>('globalThis.__lastMenu');
    assert.deepEqual(menu, [
      'Edit profile…',
      'Check setup',
      'Move Left',
      'Move Right',
      'Remove profile…',
      'Third still has 1 project',
    ]);
    assert.equal(
      await page.eval<boolean>(`document.querySelector('#edit-profile-folder').readOnly`),
      true,
    );
    assert.equal(
      await page.eval<string>(`document.querySelector('#edit-profile-folder').value`),
      '~/.claude-third',
    );
    assert.equal(
      await page.eval<boolean>(
        `[...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent === 'Remove profile…').disabled`,
      ),
      true,
    );
    // Its own folder: the terminal shortcut, as at the end of the wizard.
    assert.match(
      await page.eval<string>(
        `document.querySelector('dialog[open] [data-terminal-shortcut]').innerText`,
      ),
      /alias claude-third='CLAUDE_CONFIG_DIR=~\/\.claude-third claude'[\s\S]*Add to ~\/\./,
    );
    await typeInField(page, '#edit-profile-name', 'Side', false);
    await typeInField(page, '#edit-profile-pr-create', ' gh pr create --fill ', false);
    await clickLabel(page, 'Olive');
    await screenshot(page, screenshotDir, 'o6-edit.png');
    await submitDialog(page);
    await page.waitFor(`!${dialogOpen}`, 'the dialog to close');
    assert.deepEqual(profiles()[2], {
      id: 'third',
      name: 'Side',
      color: 'olive',
      env: { CLAUDE_CONFIG_DIR: '~/.claude-third' },
      suspendIdleMin: 10,
      pr: { createCommand: 'gh pr create --fill' },
    });

    // 7. Remove: once the project is gone; nothing on disk is deleted. The
    // project's menu names the profile: wait for the new name to reach the window.
    await page.waitFor(`!!document.querySelector('[aria-label="Select Side"]')`, 'the new name');
    await chooseFromNextContextMenu(mainProcess, 'Remove from Side…');
    await openContextMenu(page, '[data-project="notes"] button:not([aria-label])');
    await page.waitFor(dialogOpen, 'the Remove project dialog');
    await submitDialog(page);
    await page.waitFor(`!${dialogOpen}`, 'the project to be removed');
    // In Edit profile, Remove profile… asks inline.
    await chooseFromNextContextMenu(mainProcess, 'Edit profile…');
    await openContextMenu(page, '[aria-label="Select Side"]');
    await page.waitFor(`${dialogText}.includes('Edit profile')`, 'Edit profile');
    await page.waitFor(
      `![...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent === 'Remove profile…').disabled`,
      'Remove to be enabled',
    );
    await clickButtonText(page, 'Remove profile…', `document.querySelector('dialog[open]')`);
    await page.waitFor(`${dialogText}.includes('Nothing on disk is deleted')`, 'the confirmation');
    assert.equal(await page.eval<string>('document.activeElement.textContent'), 'Keep profile');
    await clickButtonText(
      page,
      `Remove from ${BRAND.displayName}`,
      `document.querySelector('dialog[open]')`,
    );
    await page.waitFor(`!${dialogOpen}`, 'the dialog to close');
    assert.deepEqual(
      profiles().map((p: { id: string }) => p.id),
      ['work', 'personal'],
    );
    assert.ok(fs.existsSync(path.join(home, '.claude-third', 'fake-login')), 'the login stays');

    // 7b. A color of the added six, chosen with the keyboard, is the tab's
    // color after a restart (spec §3.1).
    await chooseFromNextContextMenu(mainProcess, 'Edit profile…');
    await openContextMenu(page, '[aria-label="Select Personal"]');
    await page.waitFor(`${dialogText}.includes('Edit profile')`, 'Edit profile');
    assert.equal(await page.eval<string>(checkedColor), 'sky');
    assert.deepEqual(
      await page.eval<number[]>(`${swatches}.map((b) => b.tabIndex)`),
      [-1, 0, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
      'Tab reaches only the chosen color',
    );
    await page.eval(`document.querySelector('dialog[open] [aria-checked=true]').focus()`);
    const pressAndCheck = async (code: string, color: string) => {
      await pressKey(page, code);
      await page.waitFor(
        `${checkedColor} === '${color}' && document.activeElement.dataset.color === '${color}'`,
        `${code} to choose ${color}`,
      );
    };
    await pressAndCheck('End', 'charcoal');
    await pressAndCheck('Home', 'blue');
    await pressAndCheck('ArrowLeft', 'blue');
    await pressAndCheck('ArrowRight', 'sky');
    await pressAndCheck('ArrowDown', 'teal');
    await pressAndCheck('ArrowUp', 'sky');
    await pressAndCheck('End', 'charcoal');
    await pressAndCheck('ArrowRight', 'charcoal');
    await pressAndCheck('ArrowLeft', 'plum');
    assert.ok(
      await page.eval<boolean>(`!!document.querySelector('dialog[open] .bg-profile-plum.size-2')`),
      "the dialog's dot follows",
    );
    await screenshot(page, screenshotDir, 'o6b-plum.png');
    await submitDialog(page);
    await page.waitFor(`!${dialogOpen}`, 'the dialog to close');
    assert.equal(profiles()[1].color, 'plum');
    await app.stop();
    app = undefined;
    app = await launchApp({ env, dev: devMode, electronArgs });
    page = app.page;
    mainProcess = app.main;
    const personalTab = `document.querySelector('[aria-label="Select Personal"]')`;
    await page.waitFor(`!!${personalTab}`, 'the Personal tab');
    await page.eval(`${personalTab}.click()`);
    await page.waitFor(`${personalTab}.getAttribute('aria-selected') === 'true'`, 'Personal');
    const plum = await page.eval<string>(computedBackground('var(--color-profile-plum)'));
    assert.notEqual(plum, 'rgba(0, 0, 0, 0)', 'the theme has plum');
    assert.equal(
      await page.eval<string>(
        `getComputedStyle(${personalTab}.querySelector('.rounded-full')).backgroundColor`,
      ),
      plum,
      "the tab's dot",
    );
    assert.ok(
      (await page.eval<string>(`getComputedStyle(${personalTab}).boxShadow`)).includes(plum),
      "the tab's top edge",
    );
    assert.equal(await page.eval<string>('document.documentElement.dataset.profileColor'), 'plum');

    // 8. The tab menu's Remove profile… asks directly, not through Edit profile.
    // Removing every profile returns to the first-launch screen.
    for (const name of ['Personal', 'Work']) {
      await chooseFromNextContextMenu(mainProcess, 'Remove profile…');
      await openContextMenu(page, `[aria-label="Select ${name}"]`);
      await page.waitFor(
        `${dialogText}.includes('Remove ${name} from ${BRAND.displayName}?')`,
        'the confirmation',
      );
      assert.doesNotMatch(await page.eval<string>(dialogText), /Edit profile/);
      assert.match(await page.eval<string>('document.activeElement.textContent'), /^Keep profile/);
      await clickButtonText(
        page,
        `Remove from ${BRAND.displayName}`,
        `document.querySelector('dialog[open]')`,
      );
      await page.waitFor(`!${dialogOpen}`, 'the dialog to close');
    }
    await page.waitFor(
      `${mainText}.includes('Welcome to ${BRAND.displayName}')`,
      'the first-launch screen',
    );
    assert.deepEqual(profiles(), []);
    await screenshot(page, screenshotDir, 'o7-welcome-again.png');

    // 9. Started without Chromium's sandbox (as electron-builder's AppImage
    // launcher does when user namespaces are refused): the window says so, and
    // links to the Guide's sandbox section (spec §15.6).
    await app.stop();
    app = undefined;
    app = await launchApp({ env, dev: devMode, electronArgs: [...electronArgs, '--no-sandbox'] });
    page = app.page;
    const bar = `document.querySelector('[data-sandbox-warning]')`;
    await page.waitFor(
      `${bar}?.innerText.includes("Running without Chromium's sandbox")`,
      'the bar',
    );
    assert.match(await page.eval<string>(`${bar}.innerText`), /started with --no-sandbox/);
    await clickButtonText(page, 'How to turn it on', bar);
    await page.waitFor(
      `document.querySelector('[data-guide-article]')?.dataset.guideArticle === 'linux'`,
      "the Guide's Linux page",
    );
    assert.ok(await page.eval<boolean>(`!!document.querySelector('[data-sec="the-sandbox"]')`));
    await screenshot(page, screenshotDir, 'o8-no-sandbox.png');

    console.log(`e2e onboarding test passed (${devMode ? 'dev server' : 'production build'})`);
  } catch (error) {
    if (app) await screenshot(app.page, screenshotDir, 'onboarding-failure.png').catch(() => {});
    console.error('e2e onboarding test failed:', error);
    process.exitCode = 1;
  } finally {
    await app?.stop();
    fx.cleanup();
  }
}

void main();
