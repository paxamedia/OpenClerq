/**
 * The commands, as a table. To add one (`github login` was added so), add an entry
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
    path: ['github', 'connect'],
    summary: 'Create a GitHub App for OpenClerq on GitHub, in your browser',
    args: [],
    options: [
      {
        name: 'org',
        kind: 'string',
        value: 'login',
        help: 'Create the app under this organisation instead of your own account.',
      },
      {
        name: 'name',
        kind: 'string',
        value: 'name',
        help: "The app's name on GitHub (at most 34 characters). Default OpenClerq-<six hex digits>.",
      },
      {
        name: 'no-browser',
        kind: 'boolean',
        help: 'Print the path of the page to open yourself, instead of opening it.',
      },
    ],
    examples: ['clerq github connect', 'clerq github connect --org acme --name "Acme Clerq"'],
    load: () => import('./cmd/github.js').then((m) => ({ run: m.runConnect })),
  },
  {
    path: ['github', 'import'],
    summary: 'Use a GitHub App you made yourself (its id, client ID and private key file)',
    args: [],
    options: [
      {
        name: 'app-id',
        kind: 'string',
        value: 'number',
        help: "The App ID, at the top of the app's settings page.",
      },
      { name: 'client-id', kind: 'string', value: 'id', help: 'The Client ID, on the same page.' },
      {
        name: 'private-key-file',
        kind: 'string',
        value: 'file',
        help: 'The .pem file GitHub gave you. Refused if any other user of the computer has access to it (chmod 600).',
      },
      {
        name: 'client-secret-file',
        kind: 'string',
        value: 'file',
        help: 'A file with the client secret: lets a sign-in be renewed and revoked.',
      },
    ],
    examples: [
      'clerq github import --app-id 123456 --client-id Iv23liXXXX --private-key-file ~/Downloads/my-app.pem',
    ],
    load: () => import('./cmd/github.js').then((m) => ({ run: m.runImport })),
  },
  {
    path: ['github', 'status'],
    summary: 'Show the GitHub App, where it is installed, and who is signed in',
    args: [],
    options: [
      { name: 'refresh', kind: 'boolean', help: 'Ask GitHub again where the app is installed.' },
    ],
    examples: ['clerq github status', 'clerq github status --refresh --json'],
    load: () => import('./cmd/github.js').then((m) => ({ run: m.runStatus })),
  },
  {
    path: ['github', 'disconnect'],
    summary: 'Forget the GitHub App and its key, and sign out (the app stays on GitHub)',
    args: [],
    options: [{ name: 'yes', kind: 'boolean', help: 'Do not ask first.' }],
    examples: ['clerq github disconnect', 'clerq github disconnect --yes'],
    load: () => import('./cmd/github.js').then((m) => ({ run: m.runDisconnect })),
  },
  {
    path: ['github', 'login'],
    summary: 'Sign in to GitHub as yourself, with a code you type on GitHub (no password here)',
    args: [],
    options: [
      {
        name: 'no-browser',
        kind: 'boolean',
        help: 'Only print the address and the code; open it on any computer.',
      },
    ],
    examples: ['clerq github login', 'clerq github login --no-browser'],
    load: () => import('./cmd/github.js').then((m) => ({ run: m.runLogin })),
  },
  {
    path: ['github', 'logout'],
    summary:
      "Sign out of GitHub, and revoke the sign-in on GitHub when the app's client secret allows",
    args: [],
    options: [],
    examples: ['clerq github logout'],
    load: () => import('./cmd/github.js').then((m) => ({ run: m.runLogout })),
  },
  {
    path: ['github', 'repos'],
    summary: 'List the repositories you reach through the app, or add one',
    args: [],
    options: [
      {
        name: 'add',
        kind: 'string',
        value: 'owner/name',
        help: 'Add this repository to OpenClerq (what `repo add github:owner/name` does).',
      },
    ],
    examples: ['clerq github repos', 'clerq github repos --add acme/app'],
    load: () => import('./cmd/github.js').then((m) => ({ run: m.runRepos })),
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
    path: ['skill', 'list'],
    summary: 'List the skills, whether you trust each, and what each declares',
    args: [],
    options: [],
    examples: ['clerq skill list', 'clerq skill list --json'],
    load: () => import('./cmd/skill.js').then((m) => ({ run: m.runList })),
  },
  {
    path: ['skill', 'show'],
    summary: 'Show one skill: its state, what it declares, its checksums and its instructions',
    args: [{ name: 'skill', required: true, help: 'Its slug, from `clerq skill list`.' }],
    options: [],
    examples: ['clerq skill show vat-core'],
    load: () => import('./cmd/skill.js').then((m) => ({ run: m.runShow })),
  },
  {
    path: ['skill', 'trust'],
    summary: 'Trust a skill as it is now: shows what it declares first, and asks',
    args: [{ name: 'skill', required: true, help: 'Its slug, from `clerq skill list`.' }],
    options: [{ name: 'yes', kind: 'boolean', help: 'Do not ask first.' }],
    examples: ['clerq skill trust vat-core', 'clerq skill trust vat-core --yes'],
    load: () => import('./cmd/skill.js').then((m) => ({ run: m.runTrust })),
  },
  {
    path: ['skill', 'block'],
    summary: 'Never use a skill, with enforcement on or off',
    args: [{ name: 'skill', required: true, help: 'Its slug, from `clerq skill list`.' }],
    options: [],
    examples: ['clerq skill block payroll-base'],
    load: () => import('./cmd/skill.js').then((m) => ({ run: m.runBlock })),
  },
  {
    path: ['skill', 'untrust'],
    summary: 'Forget what you decided about a skill (it is not trusted, and no longer blocked)',
    args: [{ name: 'skill', required: true, help: 'Its slug, from `clerq skill list`.' }],
    options: [],
    examples: ['clerq skill untrust vat-core'],
    load: () => import('./cmd/skill.js').then((m) => ({ run: m.runUntrust })),
  },
  {
    path: ['skill', 'checksum'],
    summary:
      "Print the checksum of a skill's folder, on this computer; --write puts it in SKILL.md",
    args: [{ name: 'dir', required: true, help: 'The skill folder, the one with SKILL.md in it.' }],
    options: [
      {
        name: 'write',
        kind: 'boolean',
        help: 'Write it into SKILL.md as a `checksum:` line, replacing one that is there.',
      },
    ],
    examples: ['clerq skill checksum ./my-skill', 'clerq skill checksum ./my-skill --write'],
    load: () => import('./cmd/skill.js').then((m) => ({ run: m.runChecksum })),
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
