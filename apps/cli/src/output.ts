/**
 * Where a command's words go.
 *
 * Plain words on stdout for a person; with `--json`, one JSON object per
 * result on stdout and every message on stderr, so a script can read stdout
 * without filtering. Colour only when the stream is a terminal, `NO_COLOR` is
 * unset and `--no-color` was not given. A secret registered with `hide()` is
 * replaced in everything written, as a last line of defence: no command puts
 * the token in a message on purpose.
 */

export interface Sink {
  write(chunk: string): unknown;
  isTTY?: boolean;
}

export interface Source {
  isTTY?: boolean;
  setRawMode?(raw: boolean): unknown;
  on(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
  resume(): unknown;
  pause(): unknown;
  setEncoding?(encoding: 'utf8'): unknown;
}

/** The three streams a command talks through. */
export interface Io {
  stdin: Source;
  stdout: Sink;
  stderr: Sink;
}

export type Env = Record<string, string | undefined>;

type Style = 'bold' | 'dim' | 'red' | 'green' | 'yellow';
const CODES: Record<Style, [number, number]> = {
  bold: [1, 22],
  dim: [2, 22],
  red: [31, 39],
  green: [32, 39],
  yellow: [33, 39],
};

/** Whether a stream gets colour: a terminal, and nobody said no. */
export function colorFor(sink: Sink, env: Env, noColorFlag: boolean): boolean {
  if (noColorFlag) return false;
  if ((env.NO_COLOR ?? '') !== '') return false;
  if (env.TERM === 'dumb') return false;
  return sink.isTTY === true;
}

export class Output {
  private readonly secrets = new Set<string>();
  private readonly colorOut: boolean;
  private readonly colorErr: boolean;

  constructor(
    readonly io: Io,
    readonly json: boolean,
    env: Env,
    noColorFlag = false
  ) {
    this.colorOut = colorFor(io.stdout, env, noColorFlag);
    this.colorErr = colorFor(io.stderr, env, noColorFlag);
  }

  /** Never write this value: it becomes `***` in everything. */
  hide(secret: string | null | undefined): void {
    if (secret && secret.length >= 8) this.secrets.add(secret);
  }

  private clean(text: string): string {
    let out = text;
    for (const s of this.secrets) out = out.split(s).join('***');
    return out;
  }

  private paint(on: boolean, style: Style, text: string): string {
    return on ? `\u001b[${CODES[style][0]}m${text}\u001b[${CODES[style][1]}m` : text;
  }

  bold = (t: string) => this.paint(this.colorOut, 'bold', t);
  dim = (t: string) => this.paint(this.colorOut, 'dim', t);
  green = (t: string) => this.paint(this.colorOut, 'green', t);
  red = (t: string) => this.paint(this.colorOut, 'red', t);
  yellow = (t: string) => this.paint(this.colorOut, 'yellow', t);

  /** A line of a command's result, for a person. Not written under `--json`. */
  say(text = ''): void {
    if (!this.json) this.io.stdout.write(`${this.clean(text)}\n`);
  }

  /**
   * A line of information (what was reached, what is happening). With
   * `--json` it goes to stderr, so stdout holds only data.
   */
  note(text: string): void {
    (this.json ? this.io.stderr : this.io.stdout).write(`${this.clean(text)}\n`);
  }

  /**
   * A line of information on stderr in either mode, for a command whose stdout is one value a
   * script reads (`clerq skill checksum`).
   */
  aside(text: string): void {
    this.io.stderr.write(`${this.clean(text)}\n`);
  }

  warn(text: string): void {
    this.io.stderr.write(
      `${this.paint(this.colorErr, 'yellow', 'Warning:')} ${this.clean(text)}\n`
    );
  }

  error(text: string): void {
    this.io.stderr.write(`${this.paint(this.colorErr, 'red', 'clerq:')} ${this.clean(text)}\n`);
  }

  /** Under `--json`: one result on stdout, on one line. */
  data(value: unknown): void {
    if (this.json) this.io.stdout.write(`${this.clean(JSON.stringify(value))}\n`);
  }

  /** Raw text on stdout, as it is (a spec's source, say), whatever the mode. */
  raw(text: string): void {
    this.io.stdout.write(this.clean(text.endsWith('\n') ? text : `${text}\n`));
  }
}
