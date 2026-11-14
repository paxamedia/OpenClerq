/**
 * Reading the command line: which command, its arguments and its options.
 *
 * Hand-written and small. A command is a word or two (`run`, `repo add`)
 * found in the command table (`commands.ts`); the options every command takes
 * (`--json`, `--gateway`, ...) may stand before or after it. Nothing here
 * touches the network or the disk, so every case is a plain test.
 */

export interface OptionDef {
  /** Without the dashes: `json` is `--json`. */
  name: string;
  short?: string;
  kind: 'boolean' | 'string';
  /** The placeholder in help: `--gateway <url>`. */
  value?: string;
  help: string;
}

export interface ArgDef {
  name: string;
  help: string;
  required?: boolean;
  /** Takes every remaining word. Only the last argument can. */
  variadic?: boolean;
}

/** What a command does when it is run: returns the exit code. */
export type CommandRun = (ctx: import('./context.js').Context, call: Call) => Promise<number>;

export interface CommandDef {
  /** `['repo', 'add']`. */
  path: string[];
  summary: string;
  args: ArgDef[];
  options: OptionDef[];
  examples: string[];
  /** Loaded when the command is used, so a quick one does not read the others. */
  load: () => Promise<{ run: CommandRun }>;
}

/** The options every command takes. */
export const GLOBAL_OPTIONS: OptionDef[] = [
  {
    name: 'json',
    kind: 'boolean',
    help: 'Machine-readable output on stdout; messages go to stderr.',
  },
  { name: 'gateway', kind: 'string', value: 'url', help: 'The gateway to use (see Connection).' },
  {
    name: 'profile',
    kind: 'string',
    value: 'name',
    help: 'A profile saved in ~/.clerq/cli.json by `clerq login`.',
  },
  {
    name: 'insecure',
    kind: 'boolean',
    help: 'Allow the token to cross plain http to another computer, for this command.',
  },
  { name: 'no-color', kind: 'boolean', help: 'No colour (NO_COLOR is honoured too).' },
  { name: 'help', short: 'h', kind: 'boolean', help: 'Show help for the command.' },
  { name: 'version', short: 'V', kind: 'boolean', help: 'Show the version.' },
];

export interface Call {
  command: CommandDef;
  /** The positional arguments, in order. */
  args: string[];
  /** Every option given, global and the command's own. */
  opts: Record<string, string | boolean>;
}

export type Parsed =
  | { kind: 'call'; call: Call }
  | { kind: 'help'; topic: string[] }
  | { kind: 'version' }
  | { kind: 'error'; message: string; topic: string[] };

const key = (words: string[]) => words.join(' ');

/** The words a command is spelled with, among the leading words typed. */
function findCommand(table: CommandDef[], words: string[]): CommandDef | undefined {
  return table.find((c) => key(c.path) === key(words));
}

/** True when the words are the start of some command's path (`repo` for `repo add`). */
const isGroup = (table: CommandDef[], words: string[]) =>
  table.some(
    (c) => c.path.length > words.length && key(c.path.slice(0, words.length)) === key(words)
  );

/** The closest command name, for a typo; undefined when nothing is near. */
function nearest(table: CommandDef[], word: string): string | undefined {
  const names = [...new Set(table.map((c) => c.path[0]))];
  let best: { name: string; d: number } | undefined;
  for (const name of names) {
    const d = distance(word, name);
    if (d <= 2 && (!best || d < best.d)) best = { name, d };
  }
  return best?.name;
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

const optionBy = (defs: OptionDef[], token: string): OptionDef | undefined => {
  if (token.startsWith('--')) return defs.find((o) => o.name === token.slice(2));
  return defs.find((o) => o.short !== undefined && `-${o.short}` === token);
};

export function parseArgs(argv: string[], table: CommandDef[]): Parsed {
  const tokens = [...argv];

  // The command's words: the first non-option words that spell a command.
  const words: string[] = [];
  const used = new Set<number>();
  let command: CommandDef | undefined;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '--') break;
    if (t.startsWith('-') && t !== '-') {
      const o = optionBy(GLOBAL_OPTIONS, t.split('=')[0]);
      if (o?.kind === 'string' && !t.includes('=')) i++;
      continue;
    }
    words.push(t);
    used.add(i);
    // `help` takes whatever words follow it, as the command to explain.
    if (words[0] === 'help') continue;
    command = findCommand(table, words);
    if (command || !isGroup(table, words)) break;
  }

  const globalHelp = tokens.some((t) => t === '--help' || t === '-h');
  const wantsVersion = tokens.some((t) => t === '--version' || t === '-V');

  if (words[0] === 'help' && !command) return { kind: 'help', topic: words.slice(1) };
  if (!command) {
    if (wantsVersion && words.length === 0) return { kind: 'version' };
    if (words.length === 0) return { kind: 'help', topic: [] };
    if (globalHelp && isGroup(table, words)) return { kind: 'help', topic: words };
    if (isGroup(table, words)) {
      const subs = table.filter((c) => key(c.path.slice(0, words.length)) === key(words));
      return {
        kind: 'error',
        message: `"clerq ${key(words)}" needs one of: ${subs.map((c) => c.path[words.length]).join(', ')}.`,
        topic: words,
      };
    }
    const guess = nearest(table, words[0]);
    return {
      kind: 'error',
      message: `Unknown command "${key(words)}".${guess ? ` Did you mean "${guess}"?` : ''}`,
      topic: [],
    };
  }

  const defs = [...GLOBAL_OPTIONS, ...command.options];
  const opts: Record<string, string | boolean> = {};
  const args: string[] = [];
  let rest = false;
  for (let i = 0; i < tokens.length; i++) {
    if (used.has(i)) continue;
    const t = tokens[i];
    if (rest || t === '-' || !t.startsWith('-')) {
      args.push(t);
      continue;
    }
    if (t === '--') {
      rest = true;
      continue;
    }
    const eq = t.startsWith('--') ? t.indexOf('=') : -1;
    const flag = eq === -1 ? t : t.slice(0, eq);
    const def = optionBy(defs, flag);
    const where = `clerq ${key(command.path)}`;
    if (!def) {
      return {
        kind: 'error',
        message: `Unknown option "${flag}" for "${where}".`,
        topic: command.path,
      };
    }
    if (def.kind === 'boolean') {
      if (eq !== -1) {
        return { kind: 'error', message: `"--${def.name}" takes no value.`, topic: command.path };
      }
      opts[def.name] = true;
      continue;
    }
    let value: string | undefined;
    if (eq !== -1) value = t.slice(eq + 1);
    else {
      const next = tokens[i + 1];
      if (next !== undefined && !used.has(i + 1)) {
        value = next;
        i++;
      }
    }
    if (value === undefined || value === '') {
      return {
        kind: 'error',
        message: `"--${def.name}" needs a value${def.value ? ` (<${def.value}>)` : ''}.`,
        topic: command.path,
      };
    }
    opts[def.name] = value;
  }

  if (opts.help === true) return { kind: 'help', topic: command.path };
  if (opts.version === true) return { kind: 'version' };

  const required = command.args.filter((a) => a.required).length;
  const variadic = command.args.some((a) => a.variadic);
  if (args.length < required) {
    const missing = command.args.filter((a) => a.required)[args.length];
    return {
      kind: 'error',
      message: `"clerq ${key(command.path)}" needs ${missing ? `<${missing.name}>` : 'more arguments'}.`,
      topic: command.path,
    };
  }
  if (!variadic && args.length > command.args.length) {
    return {
      kind: 'error',
      message: `"clerq ${key(command.path)}" does not take "${args[command.args.length]}".`,
      topic: command.path,
    };
  }
  return { kind: 'call', call: { command, args, opts } };
}

export const str = (call: Call, name: string): string | undefined => {
  const v = call.opts[name];
  return typeof v === 'string' ? v : undefined;
};
export const flag = (call: Call, name: string): boolean => call.opts[name] === true;
