/**
 * A light reading of an automation spec's YAML, for the editor's summary and
 * the schedule picker. The gateway is the judge of whether a spec is valid;
 * this only reads the few lines the screens show.
 */

export const TEMPLATE = `name: weekly-dependency-bumps
description: Patch and minor dependency updates, as a draft PR
on:
  schedule: '0 8 * * 1'   # Mondays 08:00, this computer's time zone
targets:
  repos: [local:~/code/my-app]
agent:
  driver: claude-code
  allowed_tools: ['Bash(pnpm install:*)', 'Bash(pnpm test:*)']
prompt: |
  Update dependencies with patch and minor releases only.
  Update the lockfile. Do not change source files.
sandbox:
  profile: native   # no isolation: the agent and gates run with your access
  timeout: 20m
gates:
  - run: pnpm install --frozen-lockfile
  - run: pnpm test
publish:
  pull_request: draft
budget:
  max_usd_per_run: 2
  max_usd_per_month: 20
approvals:
  push: manual
`;

function scalar(source: string, key: string): string | null {
  const m = new RegExp(`^\\s*${key}\\s*:\\s*(.+?)\\s*(#.*)?$`, 'm').exec(source);
  if (!m) return null;
  return m[1].replace(/^['"]|['"]$/g, '').trim() || null;
}

const SCHEDULE_LINE = /^(\s*schedule\s*:\s*)(['"]?)([^'"\n#]*?)\2(\s*(#.*)?)$/m;

export function scheduleOf(source: string): string | null {
  const m = SCHEDULE_LINE.exec(source);
  return m ? m[3].trim() || null : null;
}

/**
 * The spec with its schedule line set to `cron`. A comment on that line goes,
 * since it described the old schedule.
 */
export function withSchedule(source: string, cron: string): string {
  if (SCHEDULE_LINE.test(source)) {
    return source.replace(SCHEDULE_LINE, (_all, lead: string, quote: string) => {
      const q = quote || "'";
      return `${lead}${q}${cron}${q}`;
    });
  }
  // No schedule yet: add one under `on:`, or add the block.
  if (/^on\s*:\s*$/m.test(source))
    return source.replace(/^on\s*:\s*$/m, `on:\n  schedule: '${cron}'`);
  return `${source.trimEnd()}\non:\n  schedule: '${cron}'\n`;
}

export function gatesOf(source: string): string[] {
  const block = /^gates\s*:\s*\n((?:[ \t]+.*\n?)*)/m.exec(source);
  if (!block) return [];
  return [...block[1].matchAll(/-\s*run\s*:\s*(.+?)\s*$/gm)].map((m) =>
    m[1].replace(/^['"]|['"]$/g, '')
  );
}

export interface SpecSummary {
  name: string | null;
  repo: string | null;
  driver: string | null;
  schedule: string | null;
  gates: string[];
  pullRequest: string | null;
  push: string | null;
  perRun: string | null;
  perMonth: string | null;
  timeout: string | null;
}

export function summarize(source: string): SpecSummary {
  const repos =
    /repos\s*:\s*\[([^\]]*)\]/.exec(source)?.[1] ?? /repos\s*:\s*\n\s*-\s*(.+)/.exec(source)?.[1];
  return {
    name: scalar(source, 'name'),
    repo: repos
      ? repos
          .split(',')[0]
          .trim()
          .replace(/^['"]|['"]$/g, '')
          .replace(/^local:/, '')
      : null,
    driver: scalar(source, 'driver'),
    schedule: scheduleOf(source),
    gates: gatesOf(source),
    pullRequest: scalar(source, 'pull_request'),
    push: scalar(source, 'push'),
    perRun: scalar(source, 'max_usd_per_run'),
    perMonth: scalar(source, 'max_usd_per_month'),
    timeout: scalar(source, 'timeout'),
  };
}

/** Line numbers (from 1) that a check message points at, e.g. "at line 4, column 3". */
export function lineOf(message: string): number | null {
  const m = /\bline (\d+)/i.exec(message) ?? /\((\d+):\d+\)/.exec(message);
  return m ? Number(m[1]) : null;
}
