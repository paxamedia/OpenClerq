/**
 * The commands, as a table. To add one (T11's `github login`, say), add an entry
 * here and a module with `run(ctx, call)` beside the others: parsing, help and
 * the `--help` text all read this table.
 */

import type { CommandDef, OptionDef } from './args.js';

const follow: OptionDef = {
  name: 'follow',
  short: 'f',
  kind: 'boolean',
  help: 'Keep watching until the run finishes.',
};

export const COMMANDS: CommandDef[] = [
  {
    path: ['login'],
    summary: 'Sign in to a gateway and save it as a profile',
    args: [
      {
        name: 'url',
        help: 'The gateway, e.g. https://clerq.example.com. Left out: the one on this computer.',
      },
    ],
    options: [
      { name: 'token-stdin', kind: 'boolean', help: 'Read the token from standard input.' },
      {
        name: 'token-file',
        kind: 'string',
        value: 'path',
        help: 'Keep the path of a file that holds the token, not the token.',
      },
    ],
    examples: [
      'clerq login',
      'clerq login https://clerq.example.com',
      'cat token.txt | clerq login https://clerq.example.com --profile work --token-stdin',
    ],
    load: () => import('./cmd/login.js'),
  },
  {
    path: ['logout'],
    summary: 'Remove a saved profile and its stored token',
    args: [],
    options: [],
    examples: ['clerq logout', 'clerq logout --profile work'],
    load: () => import('./cmd/login.js').then((m) => ({ run: m.runLogout })),
  },
  {
    path: ['status'],
    summary: 'Show the gateway in use, its versions, and whether the token is accepted',
    args: [],
    options: [],
    examples: ['clerq status', 'clerq status --json'],
    load: () => import('./cmd/status.js'),
  },
  {
    path: ['repo', 'add'],
    summary: 'Add a repository automations can target',
    args: [
      {
        name: 'target',
        required: true,
        help: 'A folder, local:<path>, github:owner/name, gitlab:group/name or an https URL on either.',
      },
    ],
    options: [
      {
        name: 'check',
        kind: 'boolean',
        help: 'For a remote: reach it first with the credential a run would use.',
      },
    ],
    examples: ['clerq repo add .', 'clerq repo add github:acme/app --check'],
    load: () => import('./cmd/repo.js').then((m) => ({ run: m.runAdd })),
  },
  {
    path: ['repo', 'list'],
    summary: 'List the repositories',
    args: [],
    options: [],
    examples: ['clerq repo list'],
    load: () => import('./cmd/repo.js').then((m) => ({ run: m.runList })),
  },
  {
    path: ['repo', 'show'],
    summary: 'Show one repository, its automations and latest runs',
    args: [
      { name: 'repo', required: true, help: 'Its id, or its name (acme/app, or the folder name).' },
    ],
    options: [],
    examples: ['clerq repo show acme/app'],
    load: () => import('./cmd/repo.js').then((m) => ({ run: m.runShow })),
  },
  {
    path: ['automation', 'apply'],
    summary: 'Check a spec file, then create the automation or update the one with the same name',
    args: [],
    options: [
      {
        name: 'file',
        short: 'f',
        kind: 'string',
        value: 'file',
        help: 'The YAML spec. - reads standard input.',
      },
      {
        name: 'enable',
        kind: 'boolean',
        help: 'Switch it on. A new automation stays off without this.',
      },
      {
        name: 'dry-run',
        kind: 'boolean',
        help: 'Check it and say what would change; change nothing.',
      },
    ],
    examples: [
      'clerq automation apply -f nightly-tidy.yaml',
      'clerq automation apply -f nightly-tidy.yaml --enable',
    ],
    load: () => import('./cmd/automation.js').then((m) => ({ run: m.runApply })),
  },
  {
    path: ['automation', 'list'],
    summary: 'List the automations',
    args: [],
    options: [],
    examples: ['clerq automation list'],
    load: () => import('./cmd/automation.js').then((m) => ({ run: m.runList })),
  },
  {
    path: ['automation', 'show'],
    summary: 'Show one automation',
    args: [{ name: 'automation', required: true, help: 'Its name or id.' }],
    options: [
      { name: 'source', kind: 'boolean', help: 'Print the spec as saved, and nothing else.' },
    ],
    examples: [
      'clerq automation show nightly-tidy',
      'clerq automation show nightly-tidy --source > nightly-tidy.yaml',
    ],
    load: () => import('./cmd/automation.js').then((m) => ({ run: m.runShow })),
  },
  {
    path: ['automation', 'enable'],
    summary: 'Switch an automation on',
    args: [{ name: 'automation', required: true, help: 'Its name or id.' }],
    options: [],
    examples: ['clerq automation enable nightly-tidy'],
    load: () => import('./cmd/automation.js').then((m) => ({ run: m.runEnable })),
  },
  {
    path: ['automation', 'disable'],
    summary: 'Switch an automation off',
    args: [{ name: 'automation', required: true, help: 'Its name or id.' }],
    options: [],
    examples: ['clerq automation disable nightly-tidy'],
    load: () => import('./cmd/automation.js').then((m) => ({ run: m.runDisable })),
  },
  {
    path: ['run'],
    summary: 'Start an automation now',
    args: [{ name: 'automation', required: true, help: 'Its name or id.' }],
    options: [
      {
        name: 'model',
        kind: 'string',
        value: 'provider/model',
        help: 'Run with this model. It is used as chosen: if it is unavailable the run fails, it does not fall back.',
      },
      follow,
      {
        name: 'stop-at-approval',
        kind: 'boolean',
        help: 'With --follow: stop and exit 2 when the run waits for an approval, instead of waiting.',
      },
    ],
    examples: [
      'clerq run nightly-tidy',
      'clerq run nightly-tidy --follow',
      'clerq run nightly-tidy --model anthropic/claude-sonnet-4-5 -f',
    ],
    load: () => import('./cmd/run.js'),
  },
  {
    path: ['logs'],
    summary: "Show a run's steps, tool calls and status",
    args: [{ name: 'run', required: true, help: 'The run id.' }],
    options: [
      follow,
      {
        name: 'stop-at-approval',
        kind: 'boolean',
        help: 'With --follow: stop and exit 2 when the run waits for an approval, instead of waiting.',
      },
    ],
    examples: ['clerq logs run_3f2a', 'clerq logs run_3f2a --follow'],
    load: () => import('./cmd/logs.js'),
  },
  {
    path: ['approvals'],
    summary: 'List what is waiting for an answer',
    args: [],
    options: [],
    examples: ['clerq approvals'],
    load: () => import('./cmd/approvals.js').then((m) => ({ run: m.runList })),
  },
  {
    path: ['approve'],
    summary: 'Approve one waiting request',
    args: [{ name: 'id', required: true, help: 'The approval number, from `clerq approvals`.' }],
    options: [],
    examples: ['clerq approve 7'],
    load: () => import('./cmd/approvals.js').then((m) => ({ run: m.runApprove })),
  },
  {
    path: ['deny'],
    summary: 'Refuse one waiting request',
    args: [{ name: 'id', required: true, help: 'The approval number, from `clerq approvals`.' }],
    options: [{ name: 'reason', kind: 'string', value: 'text', help: 'Kept with the decision.' }],
    examples: ['clerq deny 7', 'clerq deny 7 --reason "Not on a Friday"'],
    load: () => import('./cmd/approvals.js').then((m) => ({ run: m.runDeny })),
  },
];
