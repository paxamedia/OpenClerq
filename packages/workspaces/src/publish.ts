/**
 * Pull request creation.
 *
 * Draft by default. Binding rule 8 in SECURITY.md: push is not merge — nothing
 * here merges anything, and auto-merge is a decision for the automation spec,
 * not for this module.
 *
 * The HTTP call is injectable so the request shape can be tested without
 * reaching a real forge.
 */

export type Forge = 'github' | 'gitlab';

export interface PullRequestInput {
  forge: Forge;
  /** "owner/repo" for GitHub; project path or numeric id for GitLab. */
  project: string;
  title: string;
  body: string;
  /** Branch carrying the changes. */
  head: string;
  /** Branch to merge into. */
  base: string;
  draft?: boolean;
  token: string;
  /** Override for self-hosted instances. */
  apiBase?: string;
}

export interface PullRequestResult {
  url: string;
  number?: number;
}

export type Fetcher = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string }
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export class PublishError extends Error {
  readonly code = 'publish_error';
  constructor(message: string) {
    super(message);
    this.name = 'PublishError';
  }
}

/** Build the request without sending it. Exposed so tests can assert on shape. */
export function buildPullRequest(input: PullRequestInput): {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
} {
  if (!input.token) throw new PublishError('A forge token is required to open a pull request.');
  if (!input.head || !input.base)
    throw new PublishError('Both head and base branches are required.');
  if (input.head === input.base) {
    throw new PublishError(`head and base are both "${input.head}"; nothing to open.`);
  }

  const draft = input.draft !== false;

  if (input.forge === 'github') {
    const api = input.apiBase ?? 'https://api.github.com';
    return {
      url: `${api}/repos/${input.project}/pulls`,
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${input.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': 'OpenClerq',
      },
      body: JSON.stringify({
        title: input.title,
        body: input.body,
        head: input.head,
        base: input.base,
        draft,
      }),
    };
  }

  const api = input.apiBase ?? 'https://gitlab.com/api/v4';
  return {
    url: `${api}/projects/${encodeURIComponent(input.project)}/merge_requests`,
    method: 'POST',
    headers: {
      'PRIVATE-TOKEN': input.token,
      'Content-Type': 'application/json',
      'User-Agent': 'OpenClerq',
    },
    body: JSON.stringify({
      title: draft ? `Draft: ${input.title}` : input.title,
      description: input.body,
      source_branch: input.head,
      target_branch: input.base,
    }),
  };
}

/** Open a pull or merge request. Never merges. */
export async function openPullRequest(
  input: PullRequestInput,
  fetcher: Fetcher = globalThis.fetch as unknown as Fetcher
): Promise<PullRequestResult> {
  const req = buildPullRequest(input);
  const res = await fetcher(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body,
  });

  const text = await res.text();
  if (!res.ok) {
    // The token must never reach a log or an error surfaced to a user.
    throw new PublishError(
      `${input.forge} refused the pull request (${res.status}): ${text.slice(0, 300)}`
    );
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new PublishError(`${input.forge} returned a response that was not JSON.`);
  }

  const url =
    (typeof parsed.html_url === 'string' && parsed.html_url) ||
    (typeof parsed.web_url === 'string' && parsed.web_url) ||
    '';
  if (!url) throw new PublishError(`${input.forge} response carried no pull request URL.`);

  const number =
    typeof parsed.number === 'number'
      ? parsed.number
      : typeof parsed.iid === 'number'
        ? parsed.iid
        : undefined;

  return { url, number };
}

/**
 * Expand a branch template.
 * Supported placeholders: {{automation}}, {{date}}, {{time}}, {{run}}.
 * The result is sanitised to a valid git ref.
 */
export function renderBranchName(
  template: string,
  vars: { automation?: string; run?: string; now?: Date }
): string {
  const now = vars.now ?? new Date();
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19).replace(/:/g, '');

  const raw = template
    .replace(/\{\{\s*automation\s*\}\}/g, vars.automation ?? 'run')
    .replace(/\{\{\s*date\s*\}\}/g, date)
    .replace(/\{\{\s*time\s*\}\}/g, time)
    .replace(/\{\{\s*run\s*\}\}/g, vars.run ?? '');

  // git refs cannot contain spaces, ~ ^ : ? * [ \, consecutive dots, or a
  // trailing dot or slash; and cannot end with .lock
  const cleaned = raw
    .replace(/[\s~^:?*[\]\\]+/g, '-')
    .replace(/\.\.+/g, '.')
    .replace(/\/+/g, '/')
    .replace(/^[./]+/, '')
    .replace(/[./]+$/, '')
    .replace(/\.lock$/, '-lock');

  if (!cleaned) throw new PublishError(`Branch template "${template}" produced an empty name.`);
  return cleaned;
}
