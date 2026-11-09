import { parseTask } from './tasks';

/** A workspace from an existing branch (spec §7.6). */

/**
 * Where an existing branch is checked out (spec §7.6): in a workspace, in a
 * git worktree no workspace uses, or in the project's main checkout.
 */
export type CheckedOut =
  | { kind: 'workspace'; workspaceId: string; name: string; path: string }
  | { kind: 'worktree'; path: string }
  | { kind: 'main'; path: string };

/** One branch of New workspace's Existing branch list (spec §7.6). */
export interface ExistingBranch {
  name: string;
  /** A local branch of that name exists. */
  local: boolean;
  /** The remotes with a remote-tracking branch of that name, the project's remote first. */
  remotes: string[];
  /** The last commit's author, ISO date and subject: the remote's when newer, else the local one's. */
  author: string;
  date: string;
  subject: string;
  /** Where it is checked out; null when nowhere. */
  checkedOut: CheckedOut | null;
  /** It is the project's base branch: a workspace can't use it. */
  base: boolean;
}

export interface ExistingBranchList {
  /** Most recently updated first. */
  branches: ExistingBranch[];
  /** Remotes whose fetch failed, with git's reason; the list is as of their last fetch. */
  fetchErrors: { remote: string; reason: string }[];
  /** Whether the remotes were fetched for this list. */
  fetched: boolean;
}

/** Which host a pull request URL belongs to, by its path's shape. */
export type PrHost = 'github' | 'gitlab' | 'bitbucket' | 'bitbucket-server';

/**
 * What a pasted URL names (spec §7.6): a branch (the candidates longest first,
 * since the path after it may be a file), or a pull request by number.
 * `host` and `repo` (its last path segment, lowercase) say which repository.
 */
export type BranchUrl =
  | { kind: 'branch'; candidates: string[]; host: string; repo: string }
  | { kind: 'pr'; number: number; prHost: PrHost; host: string; repo: string };

const decode = (part: string): string => {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
};

/** `a/b/c` → `a/b/c`, `a/b`, `a`: a branch may contain slashes, a path may follow it. */
const prefixes = (parts: string[]): string[] =>
  parts.map((_, i) => parts.slice(0, parts.length - i).join('/')).filter(Boolean);

/**
 * Hosts that are one site under another name (spec §7.6): Bitbucket Cloud
 * moves Git over SSH to ssh.bitbucket.org (from December 10, 2026), while
 * its web pages stay on bitbucket.org.
 */
const HOST_ALIASES: Record<string, string> = { 'ssh.bitbucket.org': 'bitbucket.org' };

/** A host to compare: lowercase, without `www.`, an alias as its site. */
const normalHost = (host: string) => {
  const name = host.toLowerCase().replace(/^www\./, '');
  return HOST_ALIASES[name] ?? name;
};
const repoName = (name: string | undefined) => (name ?? '').toLowerCase().replace(/\.git$/, '');

/**
 * A branch or pull request URL of GitHub, GitLab, Bitbucket Cloud or
 * Bitbucket Server (spec §7.6), or null when the text isn't one.
 *
 * - GitHub: `/<owner>/<repo>/tree/<branch>`, `/<owner>/<repo>/pull/<n>`
 * - GitLab: `/<group>/…/<repo>/-/tree/<branch>`, `/-/merge_requests/<n>`
 * - Bitbucket Cloud: `/<ws>/<repo>/branch/<branch>`, `/src/<branch>`, `/pull-requests/<n>`
 * - Bitbucket Server: `/projects/<P>/repos/<repo>/browse?at=refs/heads/<branch>`,
 *   `/pull-requests/<n>` (also under `/users/<u>/repos/<repo>`)
 */
export function parseBranchUrl(text: string): BranchUrl | null {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = normalHost(url.hostname);
  const parts = url.pathname.split('/').filter(Boolean).map(decode);

  // Bitbucket Server: …/(projects|users)/<key>/repos/<repo>/…
  const repos = parts.indexOf('repos');
  if (repos >= 2 && (parts[repos - 2] === 'projects' || parts[repos - 2] === 'users')) {
    const repo = repoName(parts[repos + 1]);
    const rest = parts.slice(repos + 2);
    if (rest[0] === 'pull-requests' && /^\d+$/.test(rest[1] ?? '')) {
      return { kind: 'pr', number: Number(rest[1]), prHost: 'bitbucket-server', host, repo };
    }
    const at = url.searchParams.get('at');
    if (at) {
      const branch = at.replace(/^refs\/heads\//, '');
      if (branch) return { kind: 'branch', candidates: [branch], host, repo };
    }
    return null;
  }

  // GitLab: <group>/…/<repo>/-/<what>/…
  const dash = parts.indexOf('-');
  if (dash >= 2) {
    const repo = repoName(parts[dash - 1]);
    const what = parts[dash + 1];
    const rest = parts.slice(dash + 2);
    if (what === 'merge_requests' && /^\d+$/.test(rest[0] ?? '')) {
      return { kind: 'pr', number: Number(rest[0]), prHost: 'gitlab', host, repo };
    }
    if ((what === 'tree' || what === 'commits') && rest.length > 0) {
      return { kind: 'branch', candidates: prefixes(rest), host, repo };
    }
    return null;
  }

  if (parts.length < 4) return null;
  const repo = repoName(parts[1]);
  const what = parts[2];
  const rest = parts.slice(3);
  const bitbucket = host === 'bitbucket.org';
  if (what === 'pull' && !bitbucket && /^\d+$/.test(rest[0] ?? '')) {
    return { kind: 'pr', number: Number(rest[0]), prHost: 'github', host, repo };
  }
  if (what === 'pull-requests' && /^\d+$/.test(rest[0] ?? '')) {
    return { kind: 'pr', number: Number(rest[0]), prHost: 'bitbucket', host, repo };
  }
  if ((what === 'tree' && !bitbucket) || (bitbucket && (what === 'branch' || what === 'src'))) {
    return { kind: 'branch', candidates: prefixes(rest), host, repo };
  }
  return null;
}

/**
 * The host and repository name of a remote's URL (`git@host:o/r.git`,
 * `ssh://git@host:7999/p/r.git`, `https://host/o/r`), or null for a local
 * path or `file://`, which can't be compared with a web URL.
 */
export function remoteRepo(remoteUrl: string): { host: string; repo: string } | null {
  const text = remoteUrl.trim();
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(text);
  if (scp?.[1] && scp[2] && !/^[a-z]:/i.test(text)) {
    return { host: normalHost(scp[1]), repo: repoName(scp[2].split('/').filter(Boolean).pop()) };
  }
  try {
    const url = new URL(text);
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol)) return null;
    const repo = repoName(url.pathname.split('/').filter(Boolean).pop());
    return repo ? { host: normalHost(url.hostname), repo } : null;
  } catch {
    return null;
  }
}

/**
 * The ref a host keeps a pull request's head under, for `git ls-remote`
 * (spec §7.6); null for Bitbucket Cloud, which doesn't give git one.
 */
export function prHeadRef(prHost: PrHost, number: number): string | null {
  switch (prHost) {
    case 'github':
      return `refs/pull/${number}/head`;
    case 'gitlab':
      return `refs/merge-requests/${number}/head`;
    case 'bitbucket-server':
      return `refs/pull-requests/${number}/from`;
    case 'bitbucket':
      return null;
  }
}

/** "pull request #42" or "merge request !42", as the host names it. */
export const prName = (prHost: PrHost, number: number) =>
  prHost === 'gitlab' ? `merge request !${number}` : `pull request #${number}`;

/**
 * Why a pull request's branch couldn't be told (spec §7.6): what to paste
 * instead. Bitbucket Cloud gives git no pull request refs, so there it is
 * the usual answer.
 */
export function prBranchUnknown(
  prHost: PrHost,
  number: number,
  reason: 'no-refs' | 'not-found' | 'fork',
): string {
  const pr = prName(prHost, number);
  const what =
    reason === 'no-refs'
      ? `Bitbucket Cloud doesn't tell git which branch ${pr} comes from`
      : reason === 'fork'
        ? `${pr[0]?.toUpperCase()}${pr.slice(1)} comes from a branch this repository's remotes don't have (a fork?)`
        : `Couldn't find ${pr} on the remote`;
  return `${what}. Copy the branch name shown at the top of the ${prHost === 'gitlab' ? 'merge' : 'pull'} request page and paste it here, or pick the branch from the list.`;
}

/**
 * A workspace's task from a branch name (spec §7.6, as §13.6): a leading key
 * is the id, the rest the title with dashes and underscores as spaces. A
 * folder-like prefix (`feature/`) isn't part of the title.
 */
export function taskFromBranch(branch: string): { id: string | null; title: string } {
  const last = branch.split('/').pop() ?? branch;
  const { id, title } = parseTask(last.replace(/_/g, '-'));
  return { id, title: title.replace(/[-_]+/g, ' ').trim() };
}

/** Why a branch can't get a new workspace because it is checked out (spec §7.6). */
export function checkedOutText(branch: string, at: CheckedOut, project: string): string {
  switch (at.kind) {
    case 'workspace':
      return `${branch} is open in the workspace ${at.name}`;
    case 'worktree':
      return `${branch} is checked out in a worktree at ${at.path}`;
    case 'main':
      return `${branch} is checked out in the main checkout of ${project} (${at.path}). Switch it to another branch there to make a workspace of it`;
  }
}

/** Whether `text` filters `branch` in the list: every word appears in the name. */
export function branchMatches(branch: ExistingBranch, text: string): boolean {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = `${branch.name} ${branch.author}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}
