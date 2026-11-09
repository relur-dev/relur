import { describe, expect, it } from 'vitest';
import { asking, isIdleNotification, runningBackgroundTasks, transition } from './transitions';

/** A Stop payload as Claude Code sends it (checked live). */
const stop = (...tasks: { type: string; status: string }[]) => ({
  last_assistant_message: 'Done for now.',
  background_tasks: tasks.map((t, i) => ({ id: `t${i}`, description: 'x', ...t })),
});
const agent = { type: 'subagent', status: 'running', agent_type: 'general-purpose' };
const shell = { type: 'shell', status: 'running', command: 'python3 -m http.server' };

describe('transition', () => {
  it('follows the hook events of spec §10.2', () => {
    expect(transition('starting', 'SessionStart', {})).toBeNull();
    expect(transition('starting', 'UserPromptSubmit', {})).toEqual({
      state: 'working',
      message: null,
      background: 0,
    });
    expect(transition('needs-permission', 'PostToolUse', {})?.state).toBe('working');
    expect(transition('working', 'Stop', {})).toEqual({
      state: 'done',
      message: null,
      background: 0,
    });
    expect(transition('done', 'SessionEnd', {})?.state).toBe('exited');
    expect(transition('working', 'Unknown', {})).toBeNull();
  });

  it('tells permission and idle notifications apart', () => {
    const permission = { message: 'Claude needs your permission to use Bash' };
    expect(transition('working', 'Notification', permission)).toEqual({
      state: 'needs-permission',
      message: 'Claude needs your permission to use Bash',
      background: 0,
    });
    const idle = { message: 'Claude is waiting for your input' };
    expect(transition('working', 'Notification', idle)?.state).toBe('needs-input');
    expect(transition('done', 'Notification', idle)).toBeNull();
    expect(transition('working', 'Notification', { message: 'Something new' })?.state).toBe(
      'needs-permission',
    );
    expect(isIdleNotification({ notification_type: 'idle_prompt', message: 'x' })).toBe(true);
    expect(
      isIdleNotification({ notification_type: 'permission_prompt', message: 'waiting for input' }),
    ).toBe(false);
  });

  it("shows Claude's question menu as a question, not a permission request", () => {
    // Claude Code 2.1.319 reports the menu as a permission prompt naming no tool.
    const notice = {
      notification_type: 'permission_prompt',
      message: 'Claude needs your permission',
    };
    expect(transition('working', 'Notification', notice, { asking: true })).toEqual({
      state: 'needs-answer',
      message: null,
      background: 0,
    });
    expect(transition('working', 'Notification', notice)?.state).toBe('needs-permission');
    // The idle notice stays Waiting for input.
    const idle = { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' };
    expect(transition('working', 'Notification', idle, { asking: true })?.state).toBe(
      'needs-input',
    );
    expect(transition('needs-answer', 'PostToolUse', {})?.state).toBe('working');
  });

  it('stays Working at Stop while background agents run, counting all running tasks', () => {
    expect(transition('working', 'Stop', stop(agent, agent, shell))).toEqual({
      state: 'working',
      message: null,
      background: 3,
    });
    // Agents that finished don't count.
    expect(transition('working', 'Stop', stop({ ...agent, status: 'completed' }))).toEqual({
      state: 'done',
      message: null,
      background: 0,
    });
  });

  it('is Done with a count when only dev servers still run', () => {
    expect(transition('working', 'Stop', stop(shell))).toEqual({
      state: 'done',
      message: null,
      background: 1,
    });
    const npm = { type: 'shell', status: 'running', command: 'cd web && npm run dev' };
    expect(transition('working', 'Stop', stop(shell, npm))?.state).toBe('done');
    expect(runningBackgroundTasks({ background_tasks: 'nonsense' })).toEqual([]);
  });

  it('holds Done for any other command, also next to a dev server', () => {
    const sleep = { type: 'shell', status: 'running', command: 'sleep 60 && echo finished' };
    expect(transition('working', 'Stop', stop(sleep))).toEqual({
      state: 'working',
      message: null,
      background: 1,
      held: true,
    });
    expect(transition('working', 'Stop', stop(shell, sleep))).toMatchObject({
      state: 'working',
      background: 2,
      held: true,
    });
    // Types it doesn't know count as commands; agents aren't held, they always hand back.
    expect(
      transition('working', 'Stop', stop({ type: 'monitor', status: 'running' })),
    ).toMatchObject({ state: 'working', held: true });
    expect(transition('working', 'Stop', stop(agent, sleep))?.held).toBeUndefined();
  });

  it('keeps the count through tool events and ignores the idle notice while waiting', () => {
    expect(transition('working', 'PreToolUse', {}, { background: 2, waiting: true })).toEqual({
      state: 'working',
      message: null,
      background: 2,
    });
    const idle = { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' };
    expect(
      transition('working', 'Notification', idle, { background: 2, waiting: true }),
    ).toBeNull();
    expect(transition('working', 'Notification', idle, { background: 2 })?.state).toBe(
      'needs-input',
    );
    expect(transition('working', 'SessionEnd', {}, { background: 2 })?.background).toBe(0);
  });
});

describe('asking', () => {
  const question = { tool_name: 'AskUserQuestion' };
  const bash = { tool_name: 'Bash' };

  it("is on from the question tool's PreToolUse until its PostToolUse", () => {
    expect(asking(false, 'PreToolUse', question)).toBe(true);
    expect(asking(true, 'Notification', { message: 'Claude needs your permission' })).toBe(true);
    expect(asking(true, 'PostToolUse', question)).toBe(false);
  });

  it("ignores other tools' events, which may be a background agent's", () => {
    expect(asking(false, 'PreToolUse', bash)).toBe(false);
    expect(asking(true, 'PreToolUse', bash)).toBe(true);
    expect(asking(true, 'PostToolUse', bash)).toBe(true);
  });

  it('ends with a new prompt, Stop or the end of the session', () => {
    for (const event of ['UserPromptSubmit', 'Stop', 'SessionEnd']) {
      expect(asking(true, event, {})).toBe(false);
    }
  });
});
