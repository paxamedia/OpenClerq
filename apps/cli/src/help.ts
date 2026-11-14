/** The text `clerq help`, `clerq <command> --help` and a usage mistake print. */

import { GLOBAL_OPTIONS, type CommandDef, type OptionDef } from './args.js';
import { EXIT } from './errors.js';

const flagText = (o: OptionDef) =>
  `${o.short ? `-${o.short}, ` : '    '}--${o.name}${o.kind === 'string' ? ` <${o.value ?? 'value'}>` : ''}`;

function optionLines(options: OptionDef[]): string[] {
  const width = Math.max(...options.map((o) => flagText(o).length));
  return options.map((o) => `  ${flagText(o).padEnd(width)}  ${o.help}`);
}

const usageLine = (c: CommandDef) =>
  [
    'clerq',
    ...c.path,
    ...c.args.map(
      (a) => (a.required ? `<${a.name}>` : `[<${a.name}>]`) + (a.variadic ? '...' : '')
    ),
    ...(c.options.length > 0 ? ['[options]'] : []),
  ].join(' ');

const CONNECTION = `Connection (first match wins):
  address   --gateway, --profile, then CLERQ_GATEWAY_URL, then the profile "default"
            in ~/.clerq/cli.json, then http://127.0.0.1:18790
  token     --profile, then CLERQ_GATEWAY_TOKEN, then the profile "default", then
            ~/.clerq/gateway-token (only for the gateway on this computer)
  There is no --token option: it would stay in your shell history. Use \`clerq login\`.`;

const EXIT_CODES = `Exit codes:
  ${EXIT.ok}   done
  ${EXIT.failed}   it failed: a run failed or was cancelled, a spec has errors, the gateway refused
  ${EXIT.approval}   a run is waiting for an approval (run/logs --follow --stop-at-approval)
  ${EXIT.gateway}   the gateway cannot be used: nothing answers, or it speaks another API version
  ${EXIT.usage}  bad arguments or options (nothing was sent)`;

export function topHelp(table: CommandDef[], version: string): string {
  const rows = [
    ...table.map((c) => [
      [
        ...c.path,
        // A required option is part of how the command is written.
        ...(c.path.join(' ') === 'automation apply' ? ['-f <file>'] : []),
        ...c.args.map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`)),
      ].join(' '),
      c.summary,
    ]),
    ['help [command]', 'Show help for a command'],
  ];
  const width = Math.max(...rows.map((r) => r[0].length));
  return [
    `clerq ${version}: the OpenClerq command line`,
    '',
    'Usage: clerq <command> [options]',
    '',
    'Commands:',
    ...rows.map(([name, summary]) => `  ${name.padEnd(width)}  ${summary}`),
    '',
    'Options for every command:',
    ...optionLines(GLOBAL_OPTIONS),
    '',
    CONNECTION,
    '',
    EXIT_CODES,
    '',
    'Documentation: docs/CLI.md in the OpenClerq repository.',
    '',
  ].join('\n');
}

export function groupHelp(table: CommandDef[], group: string[]): string {
  const subs = table.filter((c) => c.path.length > group.length && c.path[0] === group[0]);
  const rows = subs.map((c) => [
    c.path
      .slice(group.length)
      .concat(c.args.map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`)))
      .join(' '),
    c.summary,
  ]);
  const width = Math.max(...rows.map((r) => r[0].length));
  return [
    `Usage: clerq ${group.join(' ')} <command> [options]`,
    '',
    'Commands:',
    ...rows.map(([name, summary]) => `  ${name.padEnd(width)}  ${summary}`),
    '',
    `Run \`clerq ${group.join(' ')} <command> --help\` for a command's options.`,
    '',
  ].join('\n');
}

export function commandHelp(c: CommandDef): string {
  const lines = [`Usage: ${usageLine(c)}`, '', c.summary, ''];
  if (c.args.length > 0) {
    const width = Math.max(...c.args.map((a) => a.name.length));
    lines.push('Arguments:', ...c.args.map((a) => `  ${a.name.padEnd(width)}  ${a.help}`), '');
  }
  if (c.options.length > 0) lines.push('Options:', ...optionLines(c.options), '');
  lines.push('Options for every command:', ...optionLines(GLOBAL_OPTIONS), '');
  if (c.examples.length > 0) lines.push('Examples:', ...c.examples.map((e) => `  ${e}`), '');
  return lines.join('\n');
}

/** Help for whatever was asked about: nothing (the top), a group, or a command. */
export function helpFor(table: CommandDef[], topic: string[], version: string): string | null {
  if (topic.length === 0) return topHelp(table, version);
  const command = table.find((c) => c.path.join(' ') === topic.join(' '));
  if (command) return commandHelp(command);
  if (
    table.some((c) => c.path.length > topic.length && c.path[0] === topic[0] && topic.length === 1)
  ) {
    return groupHelp(table, topic);
  }
  return null;
}
